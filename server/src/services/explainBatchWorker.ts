/**
 * 讲解专题流水线：解析 PPT → LLM 拆知识点 → 用户确认后 fan-out 自动子任务。
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { ExplainBatchService, type ExplainKnowledgePoint } from './explainBatchService';
import { ExplainJobService } from './explainJobService';
import { LlmService } from './llmService';
import { extractDocumentText } from './extractDocumentText';
import {
  ExplainGenSettingsService,
  EXPLAIN_GEN_DEFAULTS,
} from './explainGenSettings';
import { pumpExplainQueue, setExplainJobTerminalHook } from './explainWorker';

export interface ExplainBatchPipelineDeps {
  batches: ExplainBatchService;
  jobs: ExplainJobService;
  llm: LlmService;
  genSettings: ExplainGenSettingsService;
}

let deps: ExplainBatchPipelineDeps | null = null;
let pumping = false;

function extractJsonBlock(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    const a0 = text.indexOf('[');
    const a1 = text.lastIndexOf(']');
    if (a0 >= 0 && a1 > a0) return JSON.parse(text.slice(a0, a1 + 1));
    throw new Error('模型未返回合法 JSON');
  }
}

export function initExplainBatchPipeline(d: ExplainBatchPipelineDeps) {
  deps = d;
  d.batches.recoverStaleAnalyzing();
  setExplainJobTerminalHook(onExplainJobTerminal);
  void pumpExplainBatchQueue();
}

export function pumpExplainBatchQueue() {
  if (!deps || pumping) return;
  pumping = true;
  void (async () => {
    try {
      while (true) {
        if (!deps) break;
        if (deps.batches.hasAnalyzing()) break;
        const batch = deps.batches.claimNextQueued();
        if (!batch) break;
        await runBatchAnalyze(batch.id);
      }
    } finally {
      pumping = false;
    }
  })();
}

async function runBatchAnalyze(batchId: string) {
  if (!deps) return;
  const { batches, llm, genSettings } = deps;
  try {
    if (batches.isCancelRequested(batchId)) throw new Error('任务已取消');
    let batch = batches.get(batchId);
    if (!batch) return;

    batches.update(batchId, {
      status: 'analyzing',
      stage: 'analyzing',
      progress: 15,
      message: '正在解析 PPT 全文…',
    });

    let topic = (batch.topic_text || '').trim();
    if ((!topic || topic.length < 20) && batch.source_file_path && fs.existsSync(batch.source_file_path)) {
      topic = await extractDocumentText(batch.source_file_path, batch.source_file_name || '');
      batches.update(batchId, { topic_text: topic.slice(0, 80000) });
    }
    if (!topic || topic.length < 40) {
      throw new Error('无法从课件提取足够文本，请上传可读的 PPTX');
    }
    if (batches.isCancelRequested(batchId)) throw new Error('任务已取消');

    batches.update(batchId, {
      progress: 40,
      message: 'LLM 正在拆分适合动画讲解的知识点…',
    });

    const gen = genSettings.getForUser(batch.user_id) || { ...EXPLAIN_GEN_DEFAULTS };
    const cfg = llm.resolveConfig({ userId: batch.user_id, module: 'explain' });
    if (!cfg) throw new Error('未配置大模型，请先在设置中添加 LLM 配置');

    const raw = await llm.chat(
      [
        {
          role: 'system',
          content:
            '你是教学设计师。阅读课件全文，找出适合做成「短讲解动画」（约 40–90 秒、可视化因果/流程/对比）的知识点。只输出 JSON，不要 Markdown。',
        },
        {
          role: 'user',
          content: `课件内容：
${topic.slice(0, 24000)}

请输出 JSON：
{
  "points": [
    {
      "title": "知识点短标题",
      "coreQuestion": "观众看完要理解的核心问题（一句）",
      "summary": "2–4 句说明为何适合动画讲解、讲什么",
      "sourcePages": "对应页码或章节（可估计）",
      "priority": 1
    }
  ]
}
要求：
- 选出 3–8 个最有动画价值的点（避免纯定义罗列）
- priority 数字越小越优先
- title 简洁、互不重复
- 每个点必须能独立成片`,
        },
      ],
      {
        userId: batch.user_id,
        module: 'explain',
        temperature: 0.45,
        maxTokens: Math.max(4000, gen.maxTokensRecommend),
        reasoningEffort: gen.reasoningEffort,
      },
    );

    if (batches.isCancelRequested(batchId)) throw new Error('任务已取消');
    const parsed = extractJsonBlock(raw);
    const list = Array.isArray(parsed?.points) ? parsed.points : (Array.isArray(parsed) ? parsed : []);
    if (!list.length) throw new Error('未识别出可用知识点，请换一份内容更完整的课件');

    const points: ExplainKnowledgePoint[] = list.slice(0, 10).map((p: any, idx: number) => ({
      id: uuidv4(),
      title: String(p.title || `知识点 ${idx + 1}`).slice(0, 80),
      coreQuestion: String(p.coreQuestion || p.core_question || '').slice(0, 200),
      summary: String(p.summary || '').slice(0, 600),
      sourcePages: String(p.sourcePages || p.source_pages || '').slice(0, 80) || undefined,
      priority: Number(p.priority) || idx + 1,
      selected: true,
      jobId: null,
    }));

    batches.setPoints(batchId, points);
    batches.update(batchId, {
      status: 'await_points',
      stage: 'await_points',
      progress: 100,
      message: `已找出 ${points.length} 个知识点，请确认后开始生成`,
      error: null,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    const cancelled = /取消/.test(msg);
    batches.update(batchId, {
      status: cancelled ? 'cancelled' : 'failed',
      stage: cancelled ? 'cancelled' : 'failed',
      progress: 100,
      message: cancelled ? '已取消' : '课件分析失败',
      error: msg.slice(0, 2000),
      finished_at: new Date().toISOString(),
    });
  } finally {
    pumpExplainBatchQueue();
  }
}

/** User confirms selected knowledge points → create auto-mode child explain jobs. */
export function startBatchGeneration(
  batchId: string,
  userId: string,
  selectedPointIds?: string[],
): { ok: true; batch: ReturnType<ExplainBatchService['publicRow']> } | { ok: false; message: string } {
  if (!deps) return { ok: false, message: '专题流水线未初始化' };
  const { batches, jobs } = deps;
  const batch = batches.getOwned(batchId, userId);
  if (!batch) return { ok: false, message: '专题不存在' };
  if (batch.status === 'generating') return { ok: false, message: '专题已在生成中' };
  if (batch.status !== 'await_points') {
    return { ok: false, message: '当前状态不可开始生成（需先完成知识点分析）' };
  }

  if (batch.voiceover !== 'none' && (!batch.selected_voice_id || !batch.selected_model_id)) {
    return { ok: false, message: '请先为专题选定音色与配音模型' };
  }

  let points = batches.parsePoints(batch);
  if (!points.length) return { ok: false, message: '没有知识点可生成' };

  const selectedSet = selectedPointIds?.length
    ? new Set(selectedPointIds)
    : null;
  points = points.map((p) => ({
    ...p,
    selected: selectedSet ? selectedSet.has(p.id) : (p.selected !== false),
  }));

  const toRun = points.filter((p) => p.selected);
  if (!toRun.length) return { ok: false, message: '请至少选择一个知识点' };

  // Skip points that already have a non-failed job
  const existing = batches.listChildJobs(batchId);
  const byKp = new Map(existing.map((j) => [j.knowledge_point_id, j]));

  for (const p of toRun) {
    const prev = byKp.get(p.id);
    if (prev && prev.status !== 'failed' && prev.status !== 'cancelled') {
      p.jobId = prev.id;
      continue;
    }
    const topicParts = [
      `【知识点】${p.title}`,
      p.coreQuestion ? `【核心问题】${p.coreQuestion}` : '',
      p.summary ? `【讲解要点】${p.summary}` : '',
      p.sourcePages ? `【课件位置】${p.sourcePages}` : '',
      '',
      '【课件相关摘录】',
      (batch.topic_text || '').slice(0, 6000),
    ].filter(Boolean);
    const child = jobs.createJob({
      userId: batch.user_id,
      name: `${batch.name} · ${p.title}`.slice(0, 120),
      topicText: topicParts.join('\n'),
      sourceType: 'text',
      batchId: batch.id,
      knowledgePointId: p.id,
      voiceover: batch.voiceover,
      voiceId: batch.selected_voice_id,
      modelId: batch.selected_model_id,
      subtitles: !!batch.subtitles,
      autoMode: true,
    });
    p.jobId = child.id;
  }

  batches.setPoints(batchId, points);
  batches.update(batchId, {
    status: 'generating',
    stage: 'generating',
    progress: 5,
    message: `已启动 ${toRun.length} 个自动讲解动画任务`,
    error: null,
    finished_at: null,
    cancel_requested: 0,
  });
  pumpExplainQueue();
  return { ok: true, batch: batches.publicRow(batches.get(batchId)!) };
}

export function onExplainJobTerminal(jobId: string) {
  if (!deps) return;
  const job = deps.jobs.getJob(jobId);
  if (!job?.batch_id) return;
  deps.batches.refreshFromChildren(job.batch_id);
}

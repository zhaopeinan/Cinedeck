/**
 * 讲解专题流水线：解析 PPT → LLM 拆知识点 → 用户确认后 fan-out 自动子任务。
 */
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { ExplainBatchService, type ExplainKnowledgePoint } from './explainBatchService';
import { ExplainJobService } from './explainJobService';
import { LlmService } from './llmService';
import {
  extractDocumentText,
  extractPptxDocument,
  sliceTopicByPageRange,
} from './extractDocumentText';
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

/** Run PPT → knowledge-point analysis for a batch (also used by MOOC auto-insert). */
export async function analyzeBatchNow(batchId: string): Promise<void> {
  await runBatchAnalyze(batchId);
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
      message: '正在按页解析 PPT…',
    });

    let topic = (batch.topic_text || '').trim();
    let totalPages = 0;
    let pageOutline = '';

    if (batch.source_file_path && fs.existsSync(batch.source_file_path)) {
      const ext = String(batch.source_file_name || batch.source_file_path).toLowerCase();
      if (ext.endsWith('.pptx')) {
        const doc = await extractPptxDocument(batch.source_file_path);
        totalPages = doc.totalPages;
        topic = doc.text.slice(0, 80000);
        pageOutline = doc.pages.map((p) => {
          const body = (p.text || p.notes || '（本页几乎无文字）').slice(0, 400);
          return `第${p.page}页：${body.replace(/\s+/g, ' ')}`;
        }).join('\n');
        batches.update(batchId, { topic_text: topic });
      } else if (!topic || topic.length < 20) {
        topic = await extractDocumentText(batch.source_file_path, batch.source_file_name || '');
        batches.update(batchId, { topic_text: topic.slice(0, 80000) });
      }
    }
    if (!topic || topic.length < 40) {
      throw new Error('无法从课件提取足够文本，请上传可读的 PPTX');
    }
    if (!totalPages) {
      const hits = [...topic.matchAll(/【第\s*(\d+)\s*页】/g)].map((m) => Number(m[1]));
      totalPages = hits.length ? Math.max(...hits) : 0;
    }
    if (batches.isCancelRequested(batchId)) throw new Error('任务已取消');

    batches.update(batchId, {
      progress: 40,
      message: 'LLM 正在按页聚类可动画化的知识点…',
    });

    const gen = genSettings.getForUser(batch.user_id) || { ...EXPLAIN_GEN_DEFAULTS };
    const cfg = llm.resolveConfig({ userId: batch.user_id, module: 'explain' });
    if (!cfg) throw new Error('未配置大模型，请先在设置中添加 LLM 配置');

    const outlineForPrompt = (pageOutline || topic).slice(0, 28000);
    const raw = await llm.chat(
      [
        {
          role: 'system',
          content:
            '你是教学设计师兼课件剪辑顾问。先通读课件每一页，再把连续相关页聚类成若干「可独立成片的讲解动画单元」。只输出 JSON，不要 Markdown。',
        },
        {
          role: 'user',
          content: `课件共 ${totalPages || '未知'} 页。下面是按页摘要（或全文大纲）：
${outlineForPrompt}

任务：找出多个彼此独立、适合做成短讲解动画（约 40–90 秒，可视化因果/流程/对比/结构）的知识点。
相邻页若讲同一件事，必须聚类成一个单元（例如第 2–4 页一起做一个动画），不要每页硬拆。

请输出 JSON：
{
  "totalPages": ${totalPages || 'null'},
  "points": [
    {
      "title": "知识点短标题",
      "coreQuestion": "观众看完要理解的核心问题（一句）",
      "summary": "2–4 句：讲什么、为何适合动画",
      "pageStart": 2,
      "pageEnd": 4,
      "insertAfterPage": 4,
      "priority": 1
    }
  ]
}

硬性要求：
- 通常输出 2–8 个独立动画单元；课件内容足够时禁止只返回 1 个（除非全文只有一个主题）
- pageStart/pageEnd 为闭区间页码，必须来自真实页；同一页可只属于一个主单元
- insertAfterPage = 建议插入位置：讲完该页后再播放此动画（一般取 pageEnd；封面导入类可用 0 表示第 1 页前）
- 单元之间主题不重复；跳过纯目录/致谢/作业布置页
- priority 越小越优先；title 简洁互不重复`,
        },
      ],
      {
        userId: batch.user_id,
        module: 'explain',
        temperature: 0.35,
        maxTokens: Math.max(5000, gen.maxTokensRecommend),
        reasoningEffort: gen.reasoningEffort,
      },
    );

    if (batches.isCancelRequested(batchId)) throw new Error('任务已取消');
    const parsed = extractJsonBlock(raw);
    const list = Array.isArray(parsed?.points) ? parsed.points : (Array.isArray(parsed) ? parsed : []);
    if (!list.length) throw new Error('未识别出可用知识点，请换一份内容更完整的课件');

    const points: ExplainKnowledgePoint[] = list.slice(0, 12).map((p: any, idx: number) => {
      let pageStart = Number(p.pageStart ?? p.page_start);
      let pageEnd = Number(p.pageEnd ?? p.page_end);
      if (!Number.isFinite(pageStart) || pageStart < 1) {
        const m = String(p.sourcePages || p.source_pages || '').match(/(\d+)/);
        pageStart = m ? Number(m[1]) : idx + 1;
      }
      if (!Number.isFinite(pageEnd) || pageEnd < pageStart) pageEnd = pageStart;
      if (totalPages > 0) {
        pageStart = Math.min(Math.max(1, pageStart), totalPages);
        pageEnd = Math.min(Math.max(pageStart, pageEnd), totalPages);
      }
      let insertAfterPage = Number(p.insertAfterPage ?? p.insert_after_page);
      if (!Number.isFinite(insertAfterPage)) insertAfterPage = pageEnd;
      insertAfterPage = Math.max(0, Math.min(insertAfterPage, totalPages || insertAfterPage));
      const sourcePages = pageStart === pageEnd
        ? `第 ${pageStart} 页`
        : `第 ${pageStart}–${pageEnd} 页`;
      return {
        id: uuidv4(),
        title: String(p.title || `知识点 ${idx + 1}`).slice(0, 80),
        coreQuestion: String(p.coreQuestion || p.core_question || '').slice(0, 200),
        summary: String(p.summary || '').slice(0, 600),
        sourcePages,
        pageStart,
        pageEnd,
        insertAfterPage,
        priority: Number(p.priority) || idx + 1,
        selected: true,
        jobId: null,
      };
    });

    // Prefer more than one unit when the deck is long enough
    if (points.length < 2 && totalPages >= 6) {
      batches.update(batchId, {
        message: '仅识别到 1 个单元，正在要求模型按页再拆…',
        progress: 70,
      });
      const retryRaw = await llm.chat(
        [
          {
            role: 'system',
            content: '把课件拆成至少 2 个互不重叠的动画单元。只输出 JSON。',
          },
          {
            role: 'user',
            content: `课件 ${totalPages} 页。上一次你只给了 1 个单元，这不够。
请按页聚类，至少给出 2 个独立动画（若确有 3+ 更好）。
大纲：
${outlineForPrompt.slice(0, 20000)}

输出与之前相同的 JSON 结构（points 含 pageStart/pageEnd/insertAfterPage）。`,
          },
        ],
        {
          userId: batch.user_id,
          module: 'explain',
          temperature: 0.4,
          maxTokens: Math.max(5000, gen.maxTokensRecommend),
          reasoningEffort: 'low',
        },
      );
      const retryParsed = extractJsonBlock(retryRaw);
      const retryList = Array.isArray(retryParsed?.points) ? retryParsed.points : [];
      if (retryList.length >= 2) {
        points.length = 0;
        for (let idx = 0; idx < Math.min(12, retryList.length); idx++) {
          const p = retryList[idx];
          let pageStart = Number(p.pageStart ?? p.page_start) || idx + 1;
          let pageEnd = Number(p.pageEnd ?? p.page_end) || pageStart;
          if (pageEnd < pageStart) pageEnd = pageStart;
          if (totalPages > 0) {
            pageStart = Math.min(Math.max(1, pageStart), totalPages);
            pageEnd = Math.min(Math.max(pageStart, pageEnd), totalPages);
          }
          let insertAfterPage = Number(p.insertAfterPage ?? p.insert_after_page);
          if (!Number.isFinite(insertAfterPage)) insertAfterPage = pageEnd;
          points.push({
            id: uuidv4(),
            title: String(p.title || `知识点 ${idx + 1}`).slice(0, 80),
            coreQuestion: String(p.coreQuestion || p.core_question || '').slice(0, 200),
            summary: String(p.summary || '').slice(0, 600),
            sourcePages: pageStart === pageEnd ? `第 ${pageStart} 页` : `第 ${pageStart}–${pageEnd} 页`,
            pageStart,
            pageEnd,
            insertAfterPage: Math.max(0, insertAfterPage),
            priority: Number(p.priority) || idx + 1,
            selected: true,
            jobId: null,
          });
        }
      }
    }

    batches.setPoints(batchId, points);
    batches.update(batchId, {
      status: 'await_points',
      stage: 'await_points',
      progress: 100,
      message: `已聚类出 ${points.length} 个独立动画单元，请确认后开始生成`,
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
    const pageStart = Number(p.pageStart) || 1;
    const pageEnd = Number(p.pageEnd) || pageStart;
    const insertAfterPage = Number.isFinite(Number(p.insertAfterPage))
      ? Number(p.insertAfterPage)
      : pageEnd;
    const clustered = sliceTopicByPageRange(batch.topic_text || '', pageStart, pageEnd);
    const topicParts = [
      `【知识点】${p.title}`,
      p.coreQuestion ? `【核心问题】${p.coreQuestion}` : '',
      p.summary ? `【讲解要点】${p.summary}` : '',
      `【课件页码】第 ${pageStart}${pageEnd !== pageStart ? `–${pageEnd}` : ''} 页`,
      `【建议插入位置】讲完第 ${insertAfterPage} 页之后播放本动画`,
      '',
      '【本单元对应课件原文】',
      clustered || (batch.topic_text || '').slice(0, 6000),
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
    message: `已启动 ${toRun.length} 个独立讲解动画（按页聚类）`,
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

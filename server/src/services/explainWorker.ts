import fs from 'fs';
import path from 'path';
import { ExplainJobService, type ExplainJobRow } from './explainJobService';
import { LlmService } from './llmService';
import {
  getExplainStyle,
  styleCatalogForPrompt,
} from './explainStyleCatalog';
import { extractDocumentText } from './extractDocumentText';

export interface ExplainPipelineDeps {
  jobs: ExplainJobService;
  llm: LlmService;
}

let deps: ExplainPipelineDeps | null = null;
let pumping = false;

export function initExplainPipeline(d: ExplainPipelineDeps) {
  deps = d;
  d.jobs.recoverStaleRunning();
  void pumpExplainQueue();
}

export function pumpExplainQueue() {
  if (!deps || pumping) return;
  pumping = true;
  void (async () => {
    try {
      while (true) {
        if (!deps) break;
        if (deps.jobs.hasRunning()) break;
        const job = deps.jobs.claimNextQueued();
        if (!job) break;
        await runExplainJob(job.id);
      }
    } finally {
      pumping = false;
    }
  })();
}

function extractJsonBlock(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    const a0 = text.indexOf('[');
    const a1 = text.lastIndexOf(']');
    if (a0 >= 0 && a1 > a0) return JSON.parse(text.slice(a0, a1 + 1));
    throw new Error('模型未返回合法 JSON');
  }
}

function extractHtml(raw: string): string {
  const fenced = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  let html = (fenced ? fenced[1] : raw).trim();
  const i = html.toLowerCase().indexOf('<!doctype');
  const j = html.toLowerCase().indexOf('<html');
  const start = i >= 0 ? i : j;
  if (start > 0) html = html.slice(start);
  const end = html.toLowerCase().lastIndexOf('</html>');
  if (end >= 0) html = html.slice(0, end + 7);
  if (!/<html[\s>]/i.test(html)) {
    html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>讲解动画</title></head><body>${html}</body></html>`;
  }
  return html;
}

/** Reject skeleton HTML where the model abbreviated CSS/JS with "..." */
function assertUsableHtml(html: string, mode: 'sample' | 'final') {
  const minBytes = mode === 'sample' ? 2500 : 4000;
  if (!html || html.length < minBytes) {
    throw new Error(`模型返回的 HTML 过短（${html?.length || 0} 字节），疑似骨架/截断`);
  }
  if (/<(style|script)[^>]*>\s*\.{2,}\s*<\/\1>/i.test(html) || />\s*\.\.\.\s*</.test(html)) {
    throw new Error('模型返回了带省略号的骨架 HTML，缺少真实 CSS/JS');
  }
  if (!/<style[\s>]/i.test(html) || !/<script[\s>]/i.test(html)) {
    throw new Error('模型返回的 HTML 缺少 <style> 或 <script>');
  }
}

async function runExplainJob(jobId: string) {
  if (!deps) return;
  const { jobs, llm } = deps;
  const throwIfCancel = () => {
    if (jobs.isCancelRequested(jobId)) throw new Error('任务已取消');
  };

  try {
    let job = jobs.getJob(jobId);
    if (!job) return;

    // 1) Extract topic
    jobs.updateJob(jobId, { stage: 'extracting', progress: 8, message: '整理选题…' });
    let topic = (job.topic_text || '').trim();
    // PPTX / binary leftovers from older buggy uploads start with ZIP magic
    const looksLikeBinaryZip = /^PK[\x03\x04\x05\x06]/.test(topic) || topic.includes('[Content_Types].xml');
    if ((!topic || looksLikeBinaryZip) && job.source_file_path && fs.existsSync(job.source_file_path)) {
      jobs.updateJob(jobId, { message: '正在解析 PPT / 文档…', progress: 10 });
      topic = await extractDocumentText(job.source_file_path, job.source_file_name || '');
      jobs.updateJob(jobId, { topic_text: topic.slice(0, 50000) });
    }
    if (!topic || topic.length < 4 || topic.includes('[Content_Types].xml') || /^PK[\x03\x04]/.test(topic)) {
      throw new Error('请提供选题文本，或上传可读的 PPTX / TXT / MD 文件');
    }
    throwIfCancel();

    // 2) Recommend 3 styles
    jobs.updateJob(jobId, { stage: 'recommending', progress: 20, message: '正在用 LLM 推荐风格…' });
    const catalog = styleCatalogForPrompt();
    const llmOpts = llmChatOpts(llm, job.user_id);
    const recRaw = await llm.chat(
      [
        {
          role: 'system',
          content:
            '你是讲解动画风格导演。根据用户选题，从风格目录中挑选 3 种视觉差异明显的风格。只输出 JSON，不要 Markdown。',
        },
        {
          role: 'user',
          content: `选题/素材：
${topic.slice(0, 8000)}

风格目录：
${catalog}

请输出 JSON：
{
  "coreQuestion": "观众看完要理解的核心问题（一句）",
  "recommendations": [
    { "id": 数字, "reason": "贴合选题的一句中文理由", "recommended": true|false }
  ]
}
要求恰好 3 条，recommended 仅一条为 true，且 id 必须来自目录。`,
        },
      ],
      { ...llmOpts, temperature: 0.6, maxTokens: 4000, reasoningEffort: 'low' },
    );
    throwIfCancel();
    const rec = extractJsonBlock(recRaw);
    const picks = Array.isArray(rec.recommendations) ? rec.recommendations : [];
    if (picks.length < 3) throw new Error('风格推荐不足 3 个，请重试');
    const recommendations = picks.slice(0, 3).map((p: any, idx: number) => {
      const id = Number(p.id);
      const style = getExplainStyle(id);
      if (!style) throw new Error(`推荐了未知风格 #${id}`);
      return {
        id: style.id,
        name: style.name,
        nameZh: style.nameZh,
        family: style.family,
        description: style.description,
        reason: String(p.reason || ''),
        recommended: !!p.recommended || idx === 0,
        variants: style.variants || null,
      };
    });
    // ensure one recommended
    if (!recommendations.some((r: any) => r.recommended)) recommendations[0].recommended = true;

    jobs.updateJob(jobId, {
      status: 'await_style',
      stage: 'await_style',
      progress: 35,
      message: '请选择风格与是否配音',
      recommendations_json: JSON.stringify({
        coreQuestion: rec.coreQuestion || '',
        recommendations,
      }),
    });
    // wait for user — resume via resumeExplainJob after select-style
  } catch (err: any) {
    const msg = err?.message || String(err);
    const cancelled = /取消/.test(msg);
    jobs.updateJob(jobId, {
      status: cancelled ? 'cancelled' : 'failed',
      stage: 'failed',
      progress: 100,
      message: cancelled ? '已取消' : '处理失败',
      error: msg.slice(0, 2000),
      finished_at: new Date().toISOString(),
    });
  }
}

/** After user selects style — continue sample generation */
export async function continueExplainAfterStyle(jobId: string) {
  if (!deps) return;
  const { jobs, llm } = deps;
  const job = jobs.getJob(jobId);
  if (!job || job.status !== 'running') return;

  try {
    if (jobs.isCancelRequested(jobId)) throw new Error('任务已取消');
    const styleId = Number(job.selected_style_id);
    const style = getExplainStyle(styleId);
    if (!style) throw new Error('未找到所选风格');

    let script: any = null;
    try {
      if (job.script_json) script = JSON.parse(job.script_json);
    } catch { /* regenerate */ }
    if (!script || !Array.isArray(script.nodes) || script.nodes.length < 2) {
      jobs.updateJob(jobId, { stage: 'scripting', progress: 45, message: '撰写极简分镜…' });
      const scriptRaw = await llm.chat(
        [
          {
            role: 'system',
            content: '你是讲解动画编剧。输出 JSON，不要 Markdown。默认中文、面向普通观众。',
          },
          {
            role: 'user',
            content: `选题：
${(job.topic_text || '').slice(0, 8000)}

选定风格：#${style.id} ${style.nameZh} / ${style.name}
视觉：${style.description}
动效：${style.motionNotes}
讲解手法：${style.explainerNotes}
配音：${job.voiceover === 'none' ? '不加旁白（纯动画示意）' : job.voiceover === 'zh' ? '中文旁白（稍后接入）' : '英文旁白（稍后接入）'}

输出 JSON：
{
  "title": "作品标题",
  "coreQuestion": "核心问题",
  "nodes": [
    { "id": 1, "narration": "一句解说", "visual": "一句画面动作", "seconds": 3 }
  ],
  "sampleFocus": "样片对应哪几个节点（如 2-4）",
  "colorSystem": { "bg": "#0a0f2c", "fg": "#e8f0ff", "accent": "#00e5ff" }
}
nodes 4–6 个，总时长约 18–40 秒。`,
          },
        ],
        { ...llmChatOpts(llm, job.user_id), temperature: 0.55, maxTokens: 6000, reasoningEffort: 'low' },
      );
      script = extractJsonBlock(scriptRaw);
      jobs.updateJob(jobId, { script_json: JSON.stringify(script) });
    }

    jobs.updateJob(jobId, {
      stage: 'generating_sample',
      progress: 60,
      message: '生成约 20 秒 HTML 样片…',
    });

    const sampleHtml = await generateHtmlAnimation({
      llm,
      llmOpts: llmChatOpts(llm, job.user_id),
      topic: job.topic_text,
      style,
      script,
      mode: 'sample',
      voiceover: job.voiceover,
      durationHint: '约 18–22 秒可循环播放',
    });

    const workDir = job.work_dir || path.join(path.resolve(process.cwd(), '..', 'data', 'explain-jobs'), job.id);
    fs.mkdirSync(workDir, { recursive: true });
    const samplePath = path.join(workDir, 'sample', 'index.html');
    fs.mkdirSync(path.dirname(samplePath), { recursive: true });
    fs.writeFileSync(samplePath, sampleHtml, 'utf-8');

    jobs.updateJob(jobId, {
      status: 'await_sample',
      stage: 'await_sample',
      progress: 75,
      message: '请预览样片并确认是否扩展全片',
      sample_path: samplePath,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    const cancelled = /取消/.test(msg);
    jobs.updateJob(jobId, {
      status: cancelled ? 'cancelled' : 'failed',
      stage: 'failed',
      progress: 100,
      message: cancelled ? '已取消' : '样片生成失败',
      error: msg.slice(0, 2000),
      finished_at: new Date().toISOString(),
    });
  } finally {
    pumpExplainQueue();
  }
}

export async function continueExplainAfterSampleApprove(jobId: string) {
  if (!deps) return;
  const { jobs, llm } = deps;
  const job = jobs.getJob(jobId);
  if (!job || job.status !== 'running') return;

  try {
    if (jobs.isCancelRequested(jobId)) throw new Error('任务已取消');
    const style = getExplainStyle(Number(job.selected_style_id));
    if (!style) throw new Error('未找到所选风格');
    let script: any = {};
    try { script = JSON.parse(job.script_json || '{}'); } catch { /* ignore */ }

    jobs.updateJob(jobId, {
      stage: 'generating_final',
      progress: 85,
      message: '正在扩展完整 HTML 动画…',
    });

    const finalHtml = await generateHtmlAnimation({
      llm,
      llmOpts: llmChatOpts(llm, job.user_id),
      topic: job.topic_text,
      style,
      script,
      mode: 'final',
      voiceover: job.voiceover,
      durationHint: '按内容完整展开，通常 40–90 秒，可循环',
    });

    const workDir = job.work_dir!;
    const finalPath = path.join(workDir, 'final', 'index.html');
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, finalHtml, 'utf-8');

    jobs.updateJob(jobId, {
      status: 'completed',
      stage: 'done',
      progress: 100,
      message: '讲解动画已完成',
      final_path: finalPath,
      finished_at: new Date().toISOString(),
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    jobs.updateJob(jobId, {
      status: /取消/.test(msg) ? 'cancelled' : 'failed',
      stage: 'failed',
      progress: 100,
      message: '全片生成失败',
      error: msg.slice(0, 2000),
      finished_at: new Date().toISOString(),
    });
  } finally {
    pumpExplainQueue();
  }
}

function llmChatOpts(llm: LlmService, userId: string): { userId?: string; module: 'explain' } {
  const cfg = llm.resolveConfig({ userId, module: 'explain' });
  if (!cfg) throw new Error('未配置大模型，请先在设置中添加 LLM 配置');
  return { userId, module: 'explain' };
}

async function generateHtmlAnimation(opts: {
  llm: LlmService;
  llmOpts: { userId?: string; configId?: string };
  topic: string;
  style: NonNullable<ReturnType<typeof getExplainStyle>>;
  script: any;
  mode: 'sample' | 'final';
  voiceover: string;
  durationHint: string;
}): Promise<string> {
  const { llm, llmOpts, topic, style, script, mode, voiceover, durationHint } = opts;
  const system = `你是资深 motion graphics 工程师，只输出完整可运行的单文件 HTML（内含全部 CSS+JS），不要 Markdown，不要解释。
硬性要求：
- 必须写出完整 <style>…</style> 与 <script>…</script> 实装代码；严禁用 "..." / "…" / 注释占位省略
- 16:9，深色或风格匹配背景，中文文案清晰可读
- 用 requestAnimationFrame 驱动连续动效，解释因果关系（物体变化、传递、转场），禁止仅静态轮播
- 自带简易播放器（播放/暂停/进度条）
- 不依赖外网 CDN、不引用外部字体 URL
- ${durationHint}
- ${mode === 'sample' ? '样片控制在可完整输出的体量：优先 120–220 行，但代码必须可运行' : '全片可更长，仍须一次输出完整可运行文件'}`;

  const user = `模式：${mode === 'sample' ? '约20秒样片' : '完整成片'}
选题：
${topic.slice(0, 6000)}

风格 #${style.id} ${style.nameZh}（${style.name}）
${style.description}
动效：${style.motionNotes}
讲解：${style.explainerNotes}

分镜 JSON：
${JSON.stringify(script).slice(0, 6000)}

配音偏好：${voiceover}（本次可不嵌入人声音频，可用字幕示意）

请直接输出以 <!DOCTYPE html> 开头的完整 HTML。`;

  // Reasoning models need headroom for thinking + final HTML.
  // sample≈20s page; final longer. Keep below common 32k completion caps.
  const maxTokens = mode === 'sample' ? 24000 : 32000;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await llm.chat(
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content: attempt === 1
              ? user
              : `${user}\n\n上一次你输出了带省略号的骨架或过短文件。本次必须给出完整可运行 CSS/JS，禁止任何 "..." 占位。`,
          },
        ],
        {
          ...llmOpts,
          temperature: attempt === 1 ? 0.4 : 0.25,
          maxTokens,
          // Prefer light reasoning for planning; budget is large enough for content after thinking
          reasoningEffort: attempt === 1 ? 'low' : 'none',
        },
      );
      const html = extractHtml(raw);
      assertUsableHtml(html, mode);
      return html;
    } catch (err: any) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt === 2) break;
      // Only retry skeleton / short output; network errors bubble after one retry too
    }
  }
  throw lastErr || new Error('HTML 生成失败');
}

/** Re-queue job into running for next stage */
export function resumeExplainJob(job: ExplainJobRow, next: 'sample' | 'final') {
  if (!deps) return;
  deps.jobs.updateJob(job.id, {
    status: 'running',
    stage: next === 'sample' ? 'scripting' : 'generating_final',
    progress: next === 'sample' ? 40 : 80,
    message: next === 'sample' ? '继续生成样片…' : '继续生成全片…',
    error: null,
    finished_at: null,
  });
  if (next === 'sample') void continueExplainAfterStyle(job.id);
  else void continueExplainAfterSampleApprove(job.id);
}

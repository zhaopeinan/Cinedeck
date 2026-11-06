import fs from 'fs';
import path from 'path';
import { ExplainJobService, type ExplainJobRow } from './explainJobService';
import { LlmService } from './llmService';
import {
  getExplainStyle,
  styleCatalogForPrompt,
} from './explainStyleCatalog';
import { extractDocumentText } from './extractDocumentText';
import {
  ExplainGenSettingsService,
  EXPLAIN_GEN_DEFAULTS,
  type ExplainGenSettings,
} from './explainGenSettings';
import { VoiceboxAdapter } from './voiceboxAdapter';
import {
  applySubtitlePreference,
  buildNarrationText,
  injectNarrationAudio,
  synthesizeExplainNarration,
} from './explainNarration';
import {
  evaluateExplainConcurrency,
  getExplainConcurrencyStatus,
  getExplainMaxConcurrent,
  noteExplainGenStage,
  noteExplainJobFinished,
} from './explainConcurrency';

export { getExplainMaxConcurrent, getExplainConcurrencyStatus };

export interface ExplainPipelineDeps {
  jobs: ExplainJobService;
  llm: LlmService;
  genSettings: ExplainGenSettingsService;
  voicebox: VoiceboxAdapter;
}

function genSettingsFor(userId: string): ExplainGenSettings {
  return deps?.genSettings.getForUser(userId) || { ...EXPLAIN_GEN_DEFAULTS };
}

let deps: ExplainPipelineDeps | null = null;
let pumping = false;
let terminalHook: ((jobId: string) => void) | null = null;

export function getExplainMaxRetries(): number {
  const n = Number(process.env.EXPLAIN_MAX_RETRIES || 3);
  if (!Number.isFinite(n)) return 3;
  return Math.max(0, Math.min(10, Math.floor(n)));
}

export function setExplainJobTerminalHook(fn: (jobId: string) => void) {
  terminalHook = fn;
}

function notifyTerminal(jobId: string) {
  try { terminalHook?.(jobId); } catch { /* ignore */ }
}

/**
 * Mark failed, or auto-requeue when under retry budget.
 * Infrastructure cancels (e.g. Voicebox "Generation cancelled") are retried;
 * explicit user cancel is not.
 */
function markFailedOrRetry(jobId: string, message: string, error: string): 'retried' | 'failed' | 'cancelled' {
  if (!deps) return 'failed';
  const { jobs } = deps;
  const job = jobs.getJob(jobId);
  if (!job) return 'failed';

  const userCancel = jobs.isCancelRequested(jobId)
    || /任务已取消|用户取消|已取消/.test(error)
    || /任务已取消|用户取消/.test(message);
  if (userCancel) {
    jobs.updateJob(jobId, {
      status: 'cancelled',
      stage: 'failed',
      progress: 100,
      message: '已取消',
      error: error.slice(0, 2000),
      finished_at: new Date().toISOString(),
    });
    noteExplainJobFinished(false);
    notifyTerminal(jobId);
    return 'cancelled';
  }

  const cfg = jobs.parseConfig(job);
  const retryCount = Number(cfg.retryCount || 0);
  const maxRetries = Number(cfg.maxRetries != null ? cfg.maxRetries : getExplainMaxRetries());
  if (retryCount < maxRetries) {
    const next = retryCount + 1;
    let resumeFrom: 'start' | 'sample' | 'final' = 'start';
    if (job.selected_style_id && job.sample_path && fs.existsSync(job.sample_path)) {
      resumeFrom = 'final';
    } else if (job.selected_style_id && job.script_json) {
      resumeFrom = 'sample';
    }
    jobs.mergeConfig(jobId, {
      retryCount: next,
      maxRetries,
      resumeFrom,
      lastError: error.slice(0, 500),
    });
    jobs.updateJob(jobId, {
      status: 'queued',
      stage: 'queued',
      progress: Math.min(30, Number(job.progress) || 0),
      message: `自动重试 ${next}/${maxRetries}（${message}）`,
      error: null,
      finished_at: null,
      cancel_requested: 0,
    });
    // Refresh batch progress without treating as terminal failure
    try { terminalHook?.(jobId); } catch { /* ignore */ }
    noteExplainJobFinished(false);
    console.warn(`[Explain] job ${jobId.slice(0, 8)} retry ${next}/${maxRetries} from=${resumeFrom}: ${error.slice(0, 120)}`);
    return 'retried';
  }

  jobs.updateJob(jobId, {
    status: 'failed',
    stage: 'failed',
    progress: 100,
    message,
    error: error.slice(0, 2000),
    finished_at: new Date().toISOString(),
  });
  noteExplainJobFinished(false);
  notifyTerminal(jobId);
  return 'failed';
}

/** Re-queue previously failed jobs that still have retry budget (e.g. after deploy). */
export function requeueRetriableFailedExplainJobs(): number {
  if (!deps) return 0;
  const { jobs } = deps;
  let n = 0;
  for (const job of jobs.listRetriableFailed(50)) {
    const cfg = jobs.parseConfig(job);
    const retryCount = Number(cfg.retryCount || 0);
    const maxRetries = Number(cfg.maxRetries != null ? cfg.maxRetries : getExplainMaxRetries());
    let resumeFrom: 'start' | 'sample' | 'final' = 'start';
    if (job.selected_style_id && job.sample_path && fs.existsSync(job.sample_path)) {
      resumeFrom = 'final';
    } else if (job.selected_style_id && job.script_json) {
      resumeFrom = 'sample';
    }
    jobs.mergeConfig(job.id, {
      retryCount: retryCount + 1,
      maxRetries,
      resumeFrom,
      lastError: (job.error || '').slice(0, 500),
    });
    jobs.updateJob(job.id, {
      status: 'queued',
      stage: 'queued',
      progress: 5,
      message: `自动重试 ${retryCount + 1}/${maxRetries}（恢复失败任务）`,
      error: null,
      finished_at: null,
      cancel_requested: 0,
    });
    n += 1;
    try { terminalHook?.(job.id); } catch { /* ignore */ }
  }
  if (n) console.log(`[Explain] requeued ${n} failed job(s) for retry`);
  return n;
}

export function initExplainPipeline(d: ExplainPipelineDeps) {
  deps = d;
  d.jobs.recoverStaleRunning();
  requeueRetriableFailedExplainJobs();
  void pumpExplainQueue();
}

export function pumpExplainQueue() {
  if (!deps || pumping) return;
  pumping = true;
  try {
    while (true) {
      if (!deps) break;
      const running = deps.jobs.countRunning();
      const queued = deps.jobs.countQueued();
      const max = evaluateExplainConcurrency({ queuedHint: queued, runningHint: running });
      if (running >= max) break;
      const job = deps.jobs.claimNextQueued();
      if (!job) break;
      void runExplainJob(job.id).finally(() => {
        pumpExplainQueue();
      });
    }
  } finally {
    pumping = false;
  }
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

    // Resume after auto-retry: skip completed stages when possible
    const resumeFrom = String(jobs.parseConfig(job).resumeFrom || '');
    if (resumeFrom === 'final' || resumeFrom === 'sample') {
      jobs.mergeConfig(jobId, { resumeFrom: null });
      if (resumeFrom === 'final') {
        jobs.updateJob(jobId, {
          status: 'running',
          stage: 'generating_final',
          progress: 80,
          message: '重试：继续生成全片…',
          error: null,
          finished_at: null,
        });
        void continueExplainAfterSampleApprove(jobId);
        return;
      }
      jobs.updateJob(jobId, {
        status: 'running',
        stage: 'scripting',
        progress: 45,
        message: '重试：继续生成样片…',
        error: null,
        finished_at: null,
      });
      void continueExplainAfterStyle(jobId);
      return;
    }

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
      {
        ...llmOpts,
        temperature: 0.6,
        maxTokens: genSettingsFor(job.user_id).maxTokensRecommend,
        reasoningEffort: genSettingsFor(job.user_id).reasoningEffort,
      },
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

    const recPayload = {
      coreQuestion: rec.coreQuestion || '',
      recommendations,
    };

    // 专题自动模式：LLM 已标 recommended 的风格直接开跑，不再等人选
    if (jobs.isAutoMode(job)) {
      const pick = recommendations.find((r: any) => r.recommended) || recommendations[0];
      jobs.updateJob(jobId, {
        recommendations_json: JSON.stringify(recPayload),
        selected_style_id: Number(pick.id),
        status: 'running',
        stage: 'scripting',
        progress: 40,
        message: `自动选用风格：${pick.nameZh || pick.name}`,
      });
      void continueExplainAfterStyle(jobId);
      return;
    }

    jobs.updateJob(jobId, {
      status: 'await_style',
      stage: 'await_style',
      progress: 35,
      message: '请选择风格与是否配音',
      recommendations_json: JSON.stringify(recPayload),
    });
    // wait for user — resume via resumeExplainJob after select-style
  } catch (err: any) {
    const msg = err?.message || String(err);
    markFailedOrRetry(jobId, /任务已取消/.test(msg) ? '已取消' : '处理失败', msg);
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
      const tScript = Date.now();
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
配音：${job.voiceover === 'none'
              ? '不加旁白（纯动画示意）'
              : job.voiceover === 'zh'
                ? '中文旁白（稍后用选定音色合成真人旁白，分镜 narration 必须适合口播）'
                : '英文旁白（稍后用选定音色合成真人旁白，分镜 narration 用英文口播句）'}
画面字幕：${deps.jobs.getSubtitles(job)
              ? '需要底部字幕条，与口播/解说同步'
              : '不要画面字幕（避免遮挡主体画面与图表）'}

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
        {
          ...llmChatOpts(llm, job.user_id),
          temperature: 0.55,
          maxTokens: genSettingsFor(job.user_id).maxTokensScript,
          reasoningEffort: genSettingsFor(job.user_id).reasoningEffort,
        },
      );
      noteExplainGenStage('scripting', Date.now() - tScript);
      script = extractJsonBlock(scriptRaw);
      jobs.updateJob(jobId, { script_json: JSON.stringify(script) });
    }

    jobs.updateJob(jobId, {
      stage: 'generating_sample',
      progress: 60,
      message: '生成约 20 秒 HTML 样片…',
    });

    const sampleSubtitles = jobs.getSubtitles(job);
    const tSample = Date.now();
    let sampleHtml = await generateHtmlAnimation({
      llm,
      llmOpts: llmChatOpts(llm, job.user_id),
      topic: job.topic_text,
      style,
      script,
      mode: 'sample',
      voiceover: job.voiceover,
      subtitles: sampleSubtitles,
      durationHint: '约 18–22 秒可循环播放',
      gen: genSettingsFor(job.user_id),
    });
    noteExplainGenStage('generating_sample', Date.now() - tSample);
    sampleHtml = applySubtitlePreference(sampleHtml, sampleSubtitles);

    const workDir = job.work_dir || path.join(path.resolve(process.cwd(), '..', 'data', 'explain-jobs'), job.id);
    fs.mkdirSync(workDir, { recursive: true });
    const sampleDir = path.join(workDir, 'sample');
    fs.mkdirSync(sampleDir, { recursive: true });

    if (job.voiceover !== 'none' && job.selected_voice_id && job.selected_model_id && deps.voicebox) {
      jobs.updateJob(jobId, { progress: 68, message: '正在用选定音色合成样片旁白…' });
      const narration = buildNarrationText(script, 'sample');
      const wavPath = path.join(sampleDir, 'narration.wav');
      await synthesizeExplainNarration({
        voicebox: deps.voicebox,
        text: narration,
        voiceId: job.selected_voice_id,
        modelId: job.selected_model_id,
        language: job.voiceover === 'en' ? 'en' : 'zh',
        outPath: wavPath,
      });
      sampleHtml = injectNarrationAudio(sampleHtml, wavPath);
    }

    const samplePath = path.join(sampleDir, 'index.html');
    fs.writeFileSync(samplePath, sampleHtml, 'utf-8');

    // 专题自动模式：由 LLM 审样片，通过则直接进全片
    if (jobs.isAutoMode(job)) {
      jobs.updateJob(jobId, {
        sample_path: samplePath,
        progress: 72,
        message: 'LLM 正在审阅样片…',
        status: 'running',
        stage: 'generating_sample',
      });
      const review = await reviewSampleWithLlm({
        llm,
        userId: job.user_id,
        topic: job.topic_text,
        script,
        html: sampleHtml,
      });
      jobs.mergeConfig(jobId, {
        sampleReview: {
          ok: review.ok,
          reason: review.reason,
          at: new Date().toISOString(),
        },
      });
      if (!review.ok) {
        const cfg = jobs.parseConfig(jobs.getJob(jobId)!);
        const attempts = Number(cfg.sampleReviewAttempts || 0) + 1;
        jobs.mergeConfig(jobId, { sampleReviewAttempts: attempts });
        if (attempts < 2) {
          jobs.updateJob(jobId, {
            message: `样片未过审（${review.reason.slice(0, 80)}），正在重做…`,
            progress: 55,
            script_json: null,
          });
          // Clear sample and regenerate once
          try { fs.rmSync(sampleDir, { recursive: true, force: true }); } catch { /* ignore */ }
          void continueExplainAfterStyle(jobId);
          return;
        }
        markFailedOrRetry(jobId, '样片未通过 LLM 审阅', review.reason.slice(0, 2000));
        return;
      }
      jobs.updateJob(jobId, {
        status: 'running',
        stage: 'generating_final',
        progress: 80,
        message: `样片已通过：${review.reason.slice(0, 60)}，开始生成全片…`,
      });
      void continueExplainAfterSampleApprove(jobId);
      return;
    }

    jobs.updateJob(jobId, {
      status: 'await_sample',
      stage: 'await_sample',
      progress: 75,
      message: '请预览样片并确认是否扩展全片',
      sample_path: samplePath,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    markFailedOrRetry(jobId, /任务已取消/.test(msg) ? '已取消' : '样片生成失败', msg);
  } finally {
    pumpExplainQueue();
  }
}

async function reviewSampleWithLlm(opts: {
  llm: LlmService;
  userId: string;
  topic: string;
  script: any;
  html: string;
}): Promise<{ ok: boolean; reason: string }> {
  const cfg = opts.llm.resolveConfig({ userId: opts.userId, module: 'explain' });
  if (!cfg) return { ok: true, reason: '无 LLM 配置，默认通过' };
  const htmlSnippet = opts.html
    .replace(/<script[\s\S]*?<\/script>/gi, '<script>…</script>')
    .replace(/<style[\s\S]*?<\/style>/gi, '<style>…</style>')
    .slice(0, 5000);
  try {
    const raw = await opts.llm.chat(
      [
        {
          role: 'system',
          content:
            '你是讲解动画质检员。根据选题、分镜与样片 HTML 结构判断是否值得扩展成全片。只输出 JSON：{"ok":true|false,"reason":"一句中文理由"}。',
        },
        {
          role: 'user',
          content: `选题：
${(opts.topic || '').slice(0, 3000)}

分镜：
${JSON.stringify(opts.script || {}).slice(0, 3000)}

样片 HTML 摘要：
${htmlSnippet}

判定标准：
- 通过：有清晰核心问题、动效不是纯静态轮播、文案可读、结构完整
- 不通过：明显骨架/空洞、文不对题、无法解释概念
宁可稍宽松通过，避免无谓重做。`,
        },
      ],
      {
        userId: opts.userId,
        module: 'explain',
        temperature: 0.2,
        maxTokens: 400,
        reasoningEffort: 'none',
      },
    );
    const parsed = extractJsonBlock(raw);
    return {
      ok: parsed?.ok !== false && parsed?.ok !== 'false',
      reason: String(parsed?.reason || (parsed?.ok === false ? '未通过' : '通过')).slice(0, 300),
    };
  } catch {
    return { ok: true, reason: '审阅异常，默认通过' };
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

    const finalSubtitles = jobs.getSubtitles(job);
    const tFinal = Date.now();
    let finalHtml = await generateHtmlAnimation({
      llm,
      llmOpts: llmChatOpts(llm, job.user_id),
      topic: job.topic_text,
      style,
      script,
      mode: 'final',
      voiceover: job.voiceover,
      subtitles: finalSubtitles,
      durationHint: '按内容完整展开，通常 40–90 秒，可循环',
      gen: genSettingsFor(job.user_id),
    });
    noteExplainGenStage('generating_final', Date.now() - tFinal);
    finalHtml = applySubtitlePreference(finalHtml, finalSubtitles);

    const workDir = job.work_dir!;
    const finalDir = path.join(workDir, 'final');
    fs.mkdirSync(finalDir, { recursive: true });

    if (job.voiceover !== 'none' && job.selected_voice_id && job.selected_model_id && deps.voicebox) {
      jobs.updateJob(jobId, { progress: 90, message: '正在用选定音色合成全片旁白…' });
      const narration = buildNarrationText(script, 'final');
      const wavPath = path.join(finalDir, 'narration.wav');
      await synthesizeExplainNarration({
        voicebox: deps.voicebox,
        text: narration,
        voiceId: job.selected_voice_id,
        modelId: job.selected_model_id,
        language: job.voiceover === 'en' ? 'en' : 'zh',
        outPath: wavPath,
      });
      finalHtml = injectNarrationAudio(finalHtml, wavPath);
    }

    const finalPath = path.join(finalDir, 'index.html');
    fs.writeFileSync(finalPath, finalHtml, 'utf-8');

    // Full piece is ready — drop sample assets to save space / avoid confusion
    try {
      const sampleDir = path.join(workDir, 'sample');
      if (fs.existsSync(sampleDir)) fs.rmSync(sampleDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    jobs.updateJob(jobId, {
      status: 'completed',
      stage: 'done',
      progress: 100,
      message: '讲解动画已完成',
      final_path: finalPath,
      sample_path: null,
      finished_at: new Date().toISOString(),
    });
    noteExplainJobFinished(true);
    notifyTerminal(jobId);
  } catch (err: any) {
    const msg = err?.message || String(err);
    markFailedOrRetry(jobId, /任务已取消/.test(msg) ? '已取消' : '全片生成失败', msg);
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
  subtitles: boolean;
  durationHint: string;
  gen: ExplainGenSettings;
}): Promise<string> {
  const { llm, llmOpts, topic, style, script, mode, voiceover, subtitles, durationHint, gen } = opts;
  const system = `你是资深 motion graphics 工程师，只输出完整可运行的单文件 HTML（内含全部 CSS+JS），不要 Markdown，不要解释。
硬性要求：
- 必须写出完整 <style>…</style> 与 <script>…</script> 实装代码；严禁用 "..." / "…" / 注释占位省略
- 16:9，深色或风格匹配背景，中文文案清晰可读
- 用 requestAnimationFrame 驱动连续动效，解释因果关系（物体变化、传递、转场），禁止仅静态轮播
- 自带简易播放器（播放/暂停/进度条）
- 不依赖外网 CDN、不引用外部字体 URL
- ${durationHint}
- ${mode === 'sample' ? '样片控制在可完整输出的体量：优先 120–220 行，但代码必须可运行' : '全片可更长，仍须一次输出完整可运行文件'}
- ${subtitles
    ? '需要底部字幕条（class 或 id 含 subtitle/caption），与分镜 narration 同步，勿遮挡关键图表'
    : '严禁底部字幕条/口播字幕/caption 叠加层；标题与图内标签可以保留，但不要大段旁白字幕遮画面'}`;

  const user = `模式：${mode === 'sample' ? '约20秒样片' : '完整成片'}
选题：
${topic.slice(0, 6000)}

风格 #${style.id} ${style.nameZh}（${style.name}）
${style.description}
动效：${style.motionNotes}
讲解：${style.explainerNotes}

分镜 JSON：
${JSON.stringify(script).slice(0, 6000)}

配音偏好：${voiceover === 'none'
    ? '无旁白'
    : '真人旁白将在之后用选定音色单独合成并注入；页面需有播放/暂停控件，旁白会挂到页面播放器上'}
画面字幕：${subtitles ? '加入底部字幕' : '不要画面字幕（避免遮挡）'}

请直接输出以 <!DOCTYPE html> 开头的完整 HTML。`;

  const maxTokens = mode === 'sample' ? gen.maxTokensSample : gen.maxTokensFinal;
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
          // First try with user preference; retry skeleton failures with thinking off
          reasoningEffort: attempt === 1 ? gen.reasoningEffort : 'none',
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

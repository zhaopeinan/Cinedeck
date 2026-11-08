/**
 * MOOC ↔ 讲解动画桥接：全自动拆知识点 → 生成 → 导出 MP4 → 写出 insert 清单。
 * 失败策略：空点/部分失败不阻断 MOOC，仍可继续普通成片。
 */
import fs from 'fs';
import path from 'path';
import type { ExplainBatchService } from './explainBatchService';
import { EXPLAIN_UPLOAD_DIR, type ExplainJobService } from './explainJobService';
import {
  analyzeBatchNow,
  startBatchGeneration,
} from './explainBatchWorker';
import {
  getExplainExportJob,
  prepareAndEnqueueExplainExport,
} from './explainExportQueue';
import type { ExplainExportQuality } from './explainExport';
import type { MoocJobConfig, MoocJobService } from './moocJobService';
import { qcExplainAnimationMp4, qcSpeechAudio } from '../utils/mediaQuality';
import { markExplainMediaQc } from './explainInsertRepair';

/** Reject frozen/broken exports (and optional bad narration) before inserting into MOOC. */
async function assertInsertMediaOk(
  explainJobs: ExplainJobService,
  explainJobId: string,
  videoPath: string,
  audioPath: string | null,
): Promise<void> {
  const motion = await qcExplainAnimationMp4({ filePath: videoPath });
  if (!motion.ok) {
    const reason = motion.reasons.join('；') || '讲解画面质检未通过';
    markExplainMediaQc(explainJobs, explainJobId, { ok: false, reason, path: videoPath });
    throw new Error(reason);
  }
  if (audioPath && fs.existsSync(audioPath)) {
    const audio = await qcSpeechAudio({ filePath: audioPath, minDurationSec: 0.8 });
    if (!audio.ok) {
      const reason = audio.reasons.join('；') || '讲解旁白质检未通过';
      markExplainMediaQc(explainJobs, explainJobId, { ok: false, reason, path: videoPath });
      throw new Error(reason);
    }
  }
  markExplainMediaQc(explainJobs, explainJobId, { ok: true, reason: 'ok', path: videoPath });
}

export interface ExplainInsertClip {
  afterPage: number;
  videoPath: string;
  title: string;
  explainJobId: string;
  /** 旁白 wav（叠数字人用），通常与 export 同目录 */
  audioPath?: string | null;
}

export interface MoocExplainBridgeResult {
  batchId: string | null;
  inserts: ExplainInsertClip[];
  summary: string;
  skipped: number;
  failed: number;
}

export interface MoocExplainBridgeDeps {
  moocJobs: MoocJobService;
  batches: ExplainBatchService;
  explainJobs: ExplainJobService;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function writeInsertsJson(projectDir: string, inserts: ExplainInsertClip[], summary: string) {
  const out = path.join(projectDir, 'explain_inserts.json');
  fs.writeFileSync(out, JSON.stringify({
    summary,
    inserts: inserts.map((c) => ({
      afterPage: c.afterPage,
      videoPath: c.videoPath,
      title: c.title,
      explainJobId: c.explainJobId,
      audioPath: c.audioPath || null,
    })),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  return out;
}

function readExistingInserts(projectDir: string): ExplainInsertClip[] | null {
  const p = path.join(projectDir, 'explain_inserts.json');
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = Array.isArray(raw?.inserts) ? raw.inserts : [];
    const clips: ExplainInsertClip[] = list
      .map((x: any) => ({
        afterPage: Number(x.afterPage),
        videoPath: String(x.videoPath || ''),
        title: String(x.title || ''),
        explainJobId: String(x.explainJobId || ''),
        audioPath: x.audioPath && fs.existsSync(x.audioPath) ? String(x.audioPath) : null,
      }))
      .filter((c: ExplainInsertClip) =>
        Number.isFinite(c.afterPage) && c.videoPath && fs.existsSync(c.videoPath));
    return clips;
  } catch {
    return null;
  }
}

function patchMoocConfig(
  moocJobs: MoocJobService,
  jobId: string,
  patch: Partial<MoocJobConfig>,
) {
  const job = moocJobs.getJob(jobId);
  if (!job) return;
  const cfg = moocJobs.parseConfig(job);
  Object.assign(cfg, patch);
  moocJobs.updateJob(jobId, { config_json: JSON.stringify(cfg) });
}

async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number; isCancelled: () => boolean },
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    if (opts.isCancelled()) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
    if (await pred()) return;
    await sleep(opts.intervalMs);
  }
  throw new Error('等待讲解动画超时');
}

/**
 * Full auto: analyze → generate all points → export MP4s → explain_inserts.json
 */
export async function runMoocExplainInsert(opts: {
  deps: MoocExplainBridgeDeps;
  moocJobId: string;
  userId: string;
  projectId: string;
  projectDir: string;
  pptxPath: string;
  pptxName: string;
  voiceId: string;
  modelId: string;
  quality: ExplainExportQuality;
  isCancelled: () => boolean;
  onProgress?: (stage: 'explain_points' | 'explain_gen', progress: number, message: string) => void;
}): Promise<MoocExplainBridgeResult> {
  const { deps } = opts;
  const { moocJobs, batches, explainJobs } = deps;

  // Resume: reuse finished inserts file
  const existing = readExistingInserts(opts.projectDir);
  if (existing && existing.length) {
    const summary = `复用已导出的 ${existing.length} 段知识点动画`;
    return {
      batchId: moocJobs.parseConfig(moocJobs.getJob(opts.moocJobId)!)?.explainBatchId || null,
      inserts: existing,
      summary,
      skipped: 0,
      failed: 0,
    };
  }

  let config = moocJobs.parseConfig(moocJobs.getJob(opts.moocJobId)!);
  let batchId = config.explainBatchId || null;
  let batch = batchId ? batches.get(batchId) : null;

  // Create batch if needed
  if (!batch) {
    if (!fs.existsSync(opts.pptxPath)) {
      return {
        batchId: null,
        inserts: [],
        summary: '课件文件缺失，跳过知识点插入',
        skipped: 0,
        failed: 0,
      };
    }
    // Copy pptx into explain upload area so batch owns a stable path
    fs.mkdirSync(EXPLAIN_UPLOAD_DIR, { recursive: true });
    const destName = `mooc_${opts.moocJobId}_${path.basename(opts.pptxName)}`;
    const destPath = path.join(EXPLAIN_UPLOAD_DIR, destName);
    if (!fs.existsSync(destPath)) fs.copyFileSync(opts.pptxPath, destPath);

    batch = batches.create({
      userId: opts.userId,
      name: `MOOC · ${path.basename(opts.pptxName, path.extname(opts.pptxName))}`.slice(0, 120),
      sourceFileName: opts.pptxName,
      sourceFilePath: destPath,
      voiceover: 'zh',
      voiceId: opts.voiceId,
      modelId: opts.modelId,
      subtitles: false,
    });
    batchId = batch.id;
    patchMoocConfig(moocJobs, opts.moocJobId, { explainBatchId: batchId });
  }

  opts.onProgress?.('explain_points', 72, '正在分析课件知识点…');

  // Analyze if no points yet (mark analyzing so batch queue won't double-claim)
  const pointsNow = batches.parsePoints(batch);
  if (!pointsNow.length && batch.status !== 'await_points' && batch.status !== 'generating' && batch.status !== 'completed') {
    batches.update(batch.id, {
      status: 'analyzing',
      stage: 'analyzing',
      progress: 5,
      message: 'MOOC 自动分析知识点…',
      error: null,
      cancel_requested: 0,
      finished_at: null,
      started_at: new Date().toISOString(),
    });
    try {
      await analyzeBatchNow(batch.id);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const summary = `知识点分析失败，按普通讲解成片：${msg.slice(0, 120)}`;
      writeInsertsJson(opts.projectDir, [], summary);
      patchMoocConfig(moocJobs, opts.moocJobId, { explainInsertSummary: summary });
      return { batchId, inserts: [], summary, skipped: 0, failed: 0 };
    }
    batch = batches.get(batch.id)!;
  }

  if (opts.isCancelled()) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });

  let points = batches.parsePoints(batch);
  if (!points.length) {
    const summary = '未识别到可插入知识点，按普通讲解成片';
    writeInsertsJson(opts.projectDir, [], summary);
    patchMoocConfig(moocJobs, opts.moocJobId, { explainInsertSummary: summary });
    return { batchId, inserts: [], summary, skipped: 0, failed: 0 };
  }

  opts.onProgress?.('explain_points', 78, `已识别 ${points.length} 个知识点，开始生成动画…`);

  // Fan-out child jobs if needed
  batch = batches.get(batch.id)!;
  if (batch.status === 'await_points' || batch.status === 'queued') {
    const started = startBatchGeneration(batch.id, opts.userId);
    if (!started.ok) {
      const summary = `未能启动讲解动画：${started.message}`;
      writeInsertsJson(opts.projectDir, [], summary);
      patchMoocConfig(moocJobs, opts.moocJobId, { explainInsertSummary: summary });
      return { batchId, inserts: [], summary, skipped: 0, failed: 0 };
    }
  } else if (batch.status === 'failed' || batch.status === 'cancelled') {
    // Re-open generation from existing points
    batches.update(batch.id, {
      status: 'await_points',
      stage: 'await_points',
      progress: 100,
      message: 'MOOC 重新启动知识点生成',
      error: null,
      cancel_requested: 0,
      finished_at: null,
    });
    const started = startBatchGeneration(batch.id, opts.userId);
    if (!started.ok) {
      const summary = `未能重启讲解动画：${started.message}`;
      writeInsertsJson(opts.projectDir, [], summary);
      patchMoocConfig(moocJobs, opts.moocJobId, { explainInsertSummary: summary });
      return { batchId, inserts: [], summary, skipped: 0, failed: 0 };
    }
  }

  opts.onProgress?.('explain_gen', 80, '讲解动画生成中…');

  // Wait for all child jobs to finish
  await waitUntil(
    () => {
      if (opts.isCancelled()) {
        batches.requestCancel(batch!.id, opts.userId);
        return true;
      }
      batches.refreshFromChildren(batch!.id);
      const children = batches.listChildJobs(batch!.id);
      if (!children.length) return false;
      const active = children.some((j) =>
        j.status === 'queued'
        || j.status === 'running'
        || j.status === 'await_style'
        || j.status === 'await_sample');
      if (!active) return true;
      const done = children.filter((j) => j.status === 'completed').length;
      opts.onProgress?.(
        'explain_gen',
        80 + Math.min(8, Math.round((done / children.length) * 8)),
        `讲解动画 ${done}/${children.length} 完成`,
      );
      return false;
    },
    { timeoutMs: 6 * 60 * 60 * 1000, intervalMs: 3000, isCancelled: opts.isCancelled },
  );

  if (opts.isCancelled()) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });

  points = batches.parsePoints(batches.get(batch.id)!);
  const children = batches.listChildJobs(batch.id);
  const byId = new Map(children.map((j) => [j.id, j]));

  const inserts: ExplainInsertClip[] = [];
  let failed = 0;
  let skipped = 0;

  const resolveNarration = (finalDir: string) => {
    const wav = path.join(finalDir, 'narration.wav');
    return fs.existsSync(wav) ? wav : null;
  };

  for (const p of points.filter((x) => x.selected !== false)) {
    if (opts.isCancelled()) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
    const jobId = p.jobId;
    if (!jobId) {
      skipped += 1;
      continue;
    }
    const child = byId.get(jobId) || explainJobs.getJob(jobId);
    if (!child || child.status !== 'completed' || !child.final_path || !fs.existsSync(child.final_path)) {
      failed += 1;
      continue;
    }

    const quality = opts.quality;
    const finalDir = path.dirname(child.final_path);
    const outPath = path.join(finalDir, `export_${quality}.mp4`);
    const audioPath = resolveNarration(finalDir);
    // Prefer pageEnd so the clip always follows the cluster it was generated from.
    const pageEnd = Number(p.pageEnd) || Number(p.pageStart) || 0;
    const afterPage = Number.isFinite(Number(p.insertAfterPage))
      ? Number(p.insertAfterPage)
      : pageEnd;

    // Reuse existing export only if it still passes visual/audio QC
    const tryReuse = async (candidate: string): Promise<boolean> => {
      try {
        await assertInsertMediaOk(explainJobs, child.id, candidate, audioPath);
        if (candidate === outPath) explainJobs.updateJob(child.id, { video_path: outPath });
        inserts.push({
          afterPage,
          videoPath: candidate,
          title: p.title || child.name,
          explainJobId: child.id,
          audioPath,
        });
        return true;
      } catch (err: any) {
        console.warn(`[MOOC-Explain] reuse QC fail ${child.id}:`, err?.message || err);
        try { if (fs.existsSync(candidate)) fs.unlinkSync(candidate); } catch { /* ignore */ }
        if (child.video_path === candidate) {
          try { explainJobs.updateJob(child.id, { video_path: null as any }); } catch { /* ignore */ }
        }
        return false;
      }
    };

    if (child.video_path && fs.existsSync(child.video_path)) {
      const preferred = fs.existsSync(outPath) ? outPath : child.video_path;
      if (await tryReuse(preferred)) continue;
    } else if (fs.existsSync(outPath)) {
      if (await tryReuse(outPath)) continue;
    }

    opts.onProgress?.('explain_gen', 88, `导出讲解动画：${p.title || child.name}`);
    try {
      const exportJob = await prepareAndEnqueueExplainExport({
        explainJobs,
        explainJobId: child.id,
        userId: opts.userId,
        quality,
      });
      await waitUntil(
        () => {
          const ej = getExplainExportJob(exportJob.id);
          if (!ej) return false;
          if (ej.status === 'completed' || ej.status === 'failed' || ej.status === 'cancelled') return true;
          opts.onProgress?.(
            'explain_gen',
            88 + Math.min(4, Math.round((ej.progress || 0) / 25)),
            `导出 ${p.title || ''} ${ej.progress || 0}%`,
          );
          return false;
        },
        { timeoutMs: 3 * 60 * 60 * 1000, intervalMs: 2500, isCancelled: opts.isCancelled },
      );
      const ej = getExplainExportJob(exportJob.id);
      const videoPath = (ej?.status === 'completed' && fs.existsSync(outPath))
        ? outPath
        : (explainJobs.getJob(child.id)?.video_path || null);
      if (!videoPath || !fs.existsSync(videoPath)) {
        markExplainMediaQc(explainJobs, child.id, {
          ok: false,
          reason: ej?.error || ej?.message || '导出失败或无成品',
        });
        failed += 1;
        continue;
      }
      await assertInsertMediaOk(explainJobs, child.id, videoPath, audioPath);
      inserts.push({
        afterPage,
        videoPath,
        title: p.title || child.name,
        explainJobId: child.id,
        audioPath,
      });
    } catch (err: any) {
      console.warn(`[MOOC-Explain] export failed for ${child.id}:`, err?.message || err);
      try {
        markExplainMediaQc(explainJobs, child.id, {
          ok: false,
          reason: String(err?.message || err).slice(0, 400),
        });
      } catch { /* ignore */ }
      failed += 1;
    }
  }

  // Sort by insert position for stable timeline
  inserts.sort((a, b) => a.afterPage - b.afterPage || a.title.localeCompare(b.title));

  let summary: string;
  if (!inserts.length) {
    summary = failed
      ? `知识点动画全部失败（${failed}），按普通讲解成片`
      : '未识别到可插入知识点，按普通讲解成片';
  } else if (failed || skipped) {
    summary = `已插入 ${inserts.length} 段知识点动画` +
      (failed ? `，跳过失败 ${failed}` : '') +
      (skipped ? `，跳过 ${skipped}` : '');
  } else {
    summary = `已插入 ${inserts.length} 段知识点动画`;
  }

  writeInsertsJson(opts.projectDir, inserts, summary);
  patchMoocConfig(moocJobs, opts.moocJobId, { explainInsertSummary: summary, explainBatchId: batchId });

  return { batchId, inserts, summary, skipped, failed };
}

/**
 * Repair a single MOOC explain-insert child after media QC failure,
 * then patch explain_inserts.json and re-queue MOOC compose.
 */
import fs from 'fs';
import path from 'path';
import type { ExplainJobService, ExplainJobRow } from './explainJobService';
import type { ExplainBatchService } from './explainBatchService';
import type { MoocJobService } from './moocJobService';
import type { ProjectService } from './projectService';
import {
  getExplainExportJob,
  prepareAndEnqueueExplainExport,
} from './explainExportQueue';
import { pumpExplainQueue } from './explainWorker';
import { assertExplainAnimationMp4Ok, assertSpeechAudioOk, MediaQualityError } from '../utils/mediaQuality';
import { attachAvatarsToExplainInserts } from './moocExplainAvatar';
import type { VideoComposerService } from './videoComposer';

type ExplainInsertClip = {
  afterPage: number;
  videoPath: string;
  title: string;
  explainJobId: string;
  audioPath?: string | null;
};

export type ExplainMediaQc = {
  ok: boolean;
  reason?: string;
  at?: string;
  path?: string | null;
};

export function readExplainMediaQc(job: ExplainJobRow): ExplainMediaQc | null {
  try {
    const cfg = JSON.parse(job.config_json || '{}');
    const qc = cfg?.mediaQc;
    if (!qc || typeof qc !== 'object') return null;
    return {
      ok: !!qc.ok,
      reason: qc.reason ? String(qc.reason) : undefined,
      at: qc.at ? String(qc.at) : undefined,
      path: qc.path ?? null,
    };
  } catch {
    return null;
  }
}

export function markExplainMediaQc(
  explainJobs: ExplainJobService,
  jobId: string,
  qc: { ok: boolean; reason?: string; path?: string | null },
): void {
  explainJobs.mergeConfig(jobId, {
    mediaQc: {
      ok: !!qc.ok,
      reason: qc.reason ? String(qc.reason).slice(0, 500) : (qc.ok ? 'ok' : '质检未通过'),
      at: new Date().toISOString(),
      path: qc.path || null,
    },
  });
}

function waitUntil(
  pred: () => boolean,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<void> {
  const interval = opts.intervalMs ?? 2000;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (pred()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > opts.timeoutMs) {
        return reject(new Error('等待超时'));
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

function readInserts(projectDir: string): { summary: string; inserts: ExplainInsertClip[] } {
  const p = path.join(projectDir, 'explain_inserts.json');
  if (!fs.existsSync(p)) return { summary: '', inserts: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      summary: String(raw.summary || ''),
      inserts: (Array.isArray(raw.inserts) ? raw.inserts : [])
        .filter((c: any) => c?.videoPath)
        .map((c: any) => ({
          afterPage: Number(c.afterPage) || 0,
          videoPath: String(c.videoPath),
          title: String(c.title || ''),
          explainJobId: String(c.explainJobId || ''),
          audioPath: c.audioPath ? String(c.audioPath) : null,
        })),
    };
  } catch {
    return { summary: '', inserts: [] };
  }
}

function writeInserts(projectDir: string, inserts: ExplainInsertClip[], summary: string) {
  const p = path.join(projectDir, 'explain_inserts.json');
  fs.writeFileSync(p, JSON.stringify({
    summary,
    inserts,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function resolveAfterPage(
  batches: ExplainBatchService,
  batchId: string,
  child: ExplainJobRow,
): number {
  try {
    const points = batches.parsePoints(batches.get(batchId)!);
    const hit = points.find((x) => x.jobId === child.id);
    if (hit) {
      if (Number.isFinite(Number(hit.insertAfterPage))) return Number(hit.insertAfterPage);
      return Number(hit.pageEnd) || Number(hit.pageStart) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

export async function repairExplainChildForMooc(opts: {
  moocJobId: string;
  childId: string;
  userId: string;
  mode: 'reexport' | 'regenerate';
  moocJobs: MoocJobService;
  explainJobs: ExplainJobService;
  batches: ExplainBatchService;
  projectService: ProjectService;
  videoComposer: VideoComposerService;
  db: import('better-sqlite3').Database;
}): Promise<{ started: boolean; mode: string; message: string }> {
  const mooc = opts.moocJobs.getJob(opts.moocJobId);
  if (!mooc || mooc.user_id !== opts.userId) {
    throw Object.assign(new Error('MOOC 任务不存在'), { code: '404' });
  }
  if (mooc.status === 'running' || mooc.status === 'queued') {
    throw Object.assign(new Error('MOOC 任务进行中，请稍后再修复知识点'), { code: '400' });
  }
  if (!mooc.project_id) {
    throw Object.assign(new Error('缺少项目，无法修复'), { code: '400' });
  }

  const child = opts.explainJobs.getOwned(opts.childId, opts.userId);
  if (!child) {
    throw Object.assign(new Error('知识点任务不存在'), { code: '404' });
  }

  const cfg = opts.moocJobs.parseConfig(mooc);
  const batchId = cfg.explainBatchId || child.batch_id;
  if (!batchId || child.batch_id !== batchId) {
    // still allow if child belongs to user and mooc has no batch recorded
    if (batchId && child.batch_id && child.batch_id !== batchId) {
      throw Object.assign(new Error('该知识点不属于当前 MOOC 任务'), { code: '400' });
    }
  }

  const project = opts.projectService.getProject(mooc.project_id) as any;
  if (!project?.file_path) {
    throw Object.assign(new Error('项目文件缺失'), { code: '400' });
  }
  const projectDir = path.dirname(project.file_path);
  const quality = (['720p', '1080p', '1440p'].includes(String(cfg.explainExportQuality))
    ? cfg.explainExportQuality
    : '1080p') as '720p' | '1080p' | '1440p';

  // Mark repair in-flight on explain job
  opts.explainJobs.mergeConfig(child.id, {
    repair: {
      moocJobId: mooc.id,
      mode: opts.mode,
      status: 'running',
      at: new Date().toISOString(),
    },
  });

  // Fire-and-forget long work; API returns immediately
  void (async () => {
    try {
      let job = opts.explainJobs.getJob(child.id)!;

      if (opts.mode === 'regenerate') {
        opts.explainJobs.mergeConfig(job.id, {
          retryCount: 0,
          resumeFrom: 'start',
          lastError: null,
          mediaQc: null,
        });
        opts.explainJobs.updateJob(job.id, {
          status: 'queued',
          stage: 'queued',
          progress: 0,
          message: '质检未通过，手动重新生成中…',
          error: null,
          cancel_requested: 0,
          finished_at: null,
          recommendations_json: null,
          selected_style_id: null,
          sample_path: null,
          final_path: null,
          video_path: null,
        });
        pumpExplainQueue();
        await waitUntil(() => {
          const j = opts.explainJobs.getJob(job.id);
          return !!j && (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled');
        }, { timeoutMs: 3 * 60 * 60 * 1000, intervalMs: 3000 });
        job = opts.explainJobs.getJob(job.id)!;
        if (job.status !== 'completed' || !job.final_path || !fs.existsSync(job.final_path)) {
          markExplainMediaQc(opts.explainJobs, job.id, {
            ok: false,
            reason: job.error || '重新生成失败',
          });
          opts.explainJobs.mergeConfig(job.id, {
            repair: { moocJobId: mooc.id, mode: opts.mode, status: 'failed', at: new Date().toISOString() },
          });
          return;
        }
      }

      // Clear old exports
      job = opts.explainJobs.getJob(job.id)!;
      if (!job.final_path || !fs.existsSync(job.final_path)) {
        markExplainMediaQc(opts.explainJobs, job.id, { ok: false, reason: '缺少全片 HTML，请选择重生' });
        opts.explainJobs.mergeConfig(job.id, {
          repair: { moocJobId: mooc.id, mode: opts.mode, status: 'failed', at: new Date().toISOString() },
        });
        return;
      }
      const finalDir = path.dirname(job.final_path);
      for (const q of ['720p', '1080p', '1440p']) {
        const f = path.join(finalDir, `export_${q}.mp4`);
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
      }
      opts.explainJobs.updateJob(job.id, { video_path: null });

      const exportJob = await prepareAndEnqueueExplainExport({
        explainJobs: opts.explainJobs,
        explainJobId: job.id,
        userId: opts.userId,
        quality,
      });
      await waitUntil(() => {
        const ej = getExplainExportJob(exportJob.id);
        return !!ej && (ej.status === 'completed' || ej.status === 'failed' || ej.status === 'cancelled');
      }, { timeoutMs: 2 * 60 * 60 * 1000, intervalMs: 2500 });

      const ej = getExplainExportJob(exportJob.id);
      const outPath = path.join(finalDir, `export_${quality}.mp4`);
      const videoPath = (ej?.status === 'completed' && fs.existsSync(outPath))
        ? outPath
        : (opts.explainJobs.getJob(job.id)?.video_path || null);
      if (!videoPath || !fs.existsSync(videoPath)) {
        markExplainMediaQc(opts.explainJobs, job.id, {
          ok: false,
          reason: ej?.error || ej?.message || '导出失败',
        });
        opts.explainJobs.mergeConfig(job.id, {
          repair: { moocJobId: mooc.id, mode: opts.mode, status: 'failed', at: new Date().toISOString() },
        });
        return;
      }

      const audioPath = path.join(finalDir, 'narration.wav');
      try {
        if (fs.existsSync(audioPath)) {
          await assertSpeechAudioOk({ filePath: audioPath, minDurationSec: 0.8 });
        }
        await assertExplainAnimationMp4Ok({ filePath: videoPath });
      } catch (e: any) {
        const reason = e instanceof MediaQualityError
          ? e.message
          : (e?.message || '质检未通过');
        markExplainMediaQc(opts.explainJobs, job.id, { ok: false, reason, path: videoPath });
        try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch { /* ignore */ }
        opts.explainJobs.updateJob(job.id, { video_path: null });
        opts.explainJobs.mergeConfig(job.id, {
          repair: { moocJobId: mooc.id, mode: opts.mode, status: 'failed', at: new Date().toISOString() },
        });
        return;
      }

      markExplainMediaQc(opts.explainJobs, job.id, { ok: true, reason: 'ok', path: videoPath });
      opts.explainJobs.updateJob(job.id, { video_path: videoPath });

      // Patch inserts list
      const afterPage = resolveAfterPage(
        opts.batches,
        String(batchId || child.batch_id || ''),
        job,
      );
      let clip: ExplainInsertClip = {
        afterPage,
        videoPath,
        title: job.name,
        explainJobId: job.id,
        audioPath: fs.existsSync(audioPath) ? audioPath : null,
      };

      if (cfg.enableAvatar) {
        try {
          const av = await attachAvatarsToExplainInserts({
            projectId: mooc.project_id!,
            userId: opts.userId,
            projectDir,
            inserts: [clip],
            projectService: opts.projectService,
            videoComposer: opts.videoComposer,
            db: opts.db,
            chromaSimilarity: cfg.chromaSimilarity ?? 0.28,
            isCancelled: () => false,
          });
          if (av.inserts?.[0]) clip = av.inserts[0];
        } catch (err: any) {
          console.warn('[ExplainRepair] avatar overlay soft-fail:', err?.message || err);
        }
      }

      const cur = readInserts(projectDir);
      const next = cur.inserts.filter((c) => c.explainJobId !== job.id);
      next.push(clip);
      next.sort((a, b) => a.afterPage - b.afterPage || a.title.localeCompare(b.title));
      const summary = `已插入 ${next.length} 段知识点动画（含修复补片）`;
      writeInserts(projectDir, next, summary);

      opts.moocJobs.updateJob(mooc.id, {
        config_json: JSON.stringify({
          ...opts.moocJobs.parseConfig(opts.moocJobs.getJob(mooc.id)!),
          enableExplainInsert: true,
          explainInsertSummary: summary,
          explainBatchId: batchId || child.batch_id || cfg.explainBatchId,
        }),
      });

      const queued = opts.moocJobs.queueRecomposeOnly(mooc.id, opts.userId, {
        message: `知识点「${job.name}」已修复，排队重合成`,
      });
      if (!queued) {
        opts.explainJobs.mergeConfig(job.id, {
          repair: {
            moocJobId: mooc.id,
            mode: opts.mode,
            status: 'failed',
            at: new Date().toISOString(),
            error: '插片已更新，但无法排队重合成（任务可能仍在运行）',
          },
        });
        return;
      }

      const { pumpMoocQueue } = await import('./moocPipelineWorker');
      pumpMoocQueue();

      opts.explainJobs.mergeConfig(job.id, {
        repair: {
          moocJobId: mooc.id,
          mode: opts.mode,
          status: 'done',
          at: new Date().toISOString(),
        },
      });
      opts.explainJobs.updateJob(job.id, {
        message: '质检通过，已补进成片并排队重合成',
      });
    } catch (err: any) {
      console.error('[ExplainRepair] failed:', err?.message || err);
      try {
        markExplainMediaQc(opts.explainJobs, opts.childId, {
          ok: false,
          reason: err?.message || '修复失败',
        });
        opts.explainJobs.mergeConfig(opts.childId, {
          repair: {
            moocJobId: opts.moocJobId,
            mode: opts.mode,
            status: 'failed',
            at: new Date().toISOString(),
            error: String(err?.message || err).slice(0, 300),
          },
        });
      } catch { /* ignore */ }
    }
  })();

  return {
    started: true,
    mode: opts.mode,
    message: opts.mode === 'regenerate'
      ? '已开始重新生成该知识点，通过质检后会自动补进成片并重合成'
      : '已开始重新导出该知识点，通过质检后会自动补进成片并重合成',
  };
}

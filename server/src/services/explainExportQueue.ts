/**
 * Serial queue for explain HTML → MP4 exports. Surfaced in the unified task center.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ExplainJobService } from './explainJobService';
import {
  estimateExplainDurationSec,
  exportExplainHtmlToMp4,
  probeAudioDurationSec,
  type ExplainExportQuality,
} from './explainExport';

export type ExplainExportJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ExplainExportJob {
  id: string;
  explainJobId: string;
  userId: string;
  title: string;
  quality: ExplainExportQuality;
  status: ExplainExportJobStatus;
  progress: number;
  message: string;
  error: string | null;
  htmlPath: string;
  outPath: string;
  audioPath: string | null;
  durationSec: number;
  cancelRequested: boolean;
  abort?: AbortController;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const jobs = new Map<string, ExplainExportJob>();
let pumping = false;
let explainJobsRef: ExplainJobService | null = null;

function nowIso() {
  return new Date().toISOString();
}

export function initExplainExportQueue(explainJobs: ExplainJobService) {
  explainJobsRef = explainJobs;
}

export function getExplainExportJob(id: string): ExplainExportJob | null {
  return jobs.get(id) || null;
}

export function listExplainExportJobsForUser(userId: string, limit = 40): ExplainExportJob[] {
  return Array.from(jobs.values())
    .filter((j) => j.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

export function listExplainExportRunningOrQueued(): ExplainExportJob[] {
  return Array.from(jobs.values()).filter((j) => j.status === 'queued' || j.status === 'running');
}

export function getExplainExportQueuePosition(jobId: string): number | null {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'queued') return null;
  const queued = Array.from(jobs.values())
    .filter((j) => j.status === 'queued')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const idx = queued.findIndex((j) => j.id === jobId);
  return idx >= 0 ? idx + 1 : null;
}

function patchJob(id: string, patch: Partial<ExplainExportJob>): ExplainExportJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: nowIso() });
  jobs.set(id, job);
  syncParentExplainJob(job);
  return job;
}

function syncParentExplainJob(job: ExplainExportJob) {
  if (!explainJobsRef) return;
  const parent = explainJobsRef.getJob(job.explainJobId);
  if (!parent) return;
  let cfg: any = {};
  try { cfg = JSON.parse(parent.config_json || '{}'); } catch { cfg = {}; }
  cfg.export = {
    status: job.status === 'completed' ? 'done' : job.status,
    quality: job.quality,
    exportJobId: job.id,
    progress: job.progress,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  };
  const message =
    job.status === 'queued' ? `MP4 导出已排队（${job.quality}）…`
      : job.status === 'running' ? (job.message || `正在导出 ${job.quality} MP4…`)
        : job.status === 'completed' ? `MP4 已导出（${job.quality}）`
          : job.status === 'cancelled' ? 'MP4 导出已取消'
            : `MP4 导出失败：${(job.error || '').slice(0, 120)}`;
  explainJobsRef.updateJob(job.explainJobId, {
    config_json: JSON.stringify(cfg),
    message,
    ...(job.status === 'completed' ? { video_path: job.outPath } : {}),
  });
}

export function requestCancelExplainExportJob(id: string, userId: string): ExplainExportJob | null {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) return null;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return job;
  }
  job.cancelRequested = true;
  job.updatedAt = nowIso();
  try { job.abort?.abort(); } catch { /* ignore */ }
  if (job.status === 'queued') {
    return patchJob(id, {
      status: 'cancelled',
      progress: 100,
      message: '已取消',
      finishedAt: nowIso(),
    });
  }
  return patchJob(id, { message: '正在取消导出…' });
}

export async function enqueueExplainExport(input: {
  explainJobId: string;
  userId: string;
  title: string;
  quality: ExplainExportQuality;
  htmlPath: string;
  outPath: string;
  audioPath: string | null;
  durationSec: number;
}): Promise<ExplainExportJob> {
  const active = Array.from(jobs.values()).find(
    (j) =>
      j.explainJobId === input.explainJobId
      && (j.status === 'queued' || j.status === 'running'),
  );
  if (active) {
    const err: any = new Error('该讲解动画已有导出任务在排队或进行中');
    err.code = '409';
    err.job = active;
    throw err;
  }

  const job: ExplainExportJob = {
    id: randomUUID(),
    explainJobId: input.explainJobId,
    userId: input.userId,
    title: input.title,
    quality: input.quality,
    status: 'queued',
    progress: 0,
    message: `已加入导出队列（${input.quality}，约 ${Math.ceil(input.durationSec)} 秒）`,
    error: null,
    htmlPath: input.htmlPath,
    outPath: input.outPath,
    audioPath: input.audioPath,
    durationSec: input.durationSec,
    cancelRequested: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(job.id, job);
  syncParentExplainJob(job);
  void pumpExplainExportQueue();
  return job;
}

export async function prepareAndEnqueueExplainExport(opts: {
  explainJobs: ExplainJobService;
  explainJobId: string;
  userId: string;
  quality: ExplainExportQuality;
}): Promise<ExplainExportJob> {
  initExplainExportQueue(opts.explainJobs);
  const job = opts.explainJobs.getOwned(opts.explainJobId, opts.userId);
  if (!job) {
    const err: any = new Error('任务不存在');
    err.code = '404';
    throw err;
  }
  if (!job.final_path || !fs.existsSync(job.final_path)) {
    const err: any = new Error('请先完成全片 HTML 后再导出 MP4');
    err.code = '400';
    throw err;
  }
  const finalDir = path.dirname(job.final_path);
  const audioPath = path.join(finalDir, 'narration.wav');
  const outPath = path.join(finalDir, `export_${opts.quality}.mp4`);
  const audioDur = await probeAudioDurationSec(audioPath);
  const durationSec = audioDur || estimateExplainDurationSec(job.script_json, audioPath);
  return enqueueExplainExport({
    explainJobId: job.id,
    userId: opts.userId,
    title: job.name || job.id.slice(0, 8),
    quality: opts.quality,
    htmlPath: job.final_path,
    outPath,
    audioPath: fs.existsSync(audioPath) ? audioPath : null,
    durationSec,
  });
}

export async function pumpExplainExportQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const next = Array.from(jobs.values())
        .filter((j) => j.status === 'queued')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
      if (!next) break;
      await runOneExport(next.id);
    }
  } finally {
    pumping = false;
  }
}

async function runOneExport(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job || job.status !== 'queued') return;
  if (job.cancelRequested) {
    patchJob(id, {
      status: 'cancelled',
      progress: 100,
      message: '已取消',
      finishedAt: nowIso(),
    });
    return;
  }

  const abort = new AbortController();
  job.abort = abort;
  patchJob(id, {
    status: 'running',
    progress: 5,
    message: `正在导出 ${job.quality} MP4…`,
    startedAt: nowIso(),
    error: null,
  });

  try {
    await exportExplainHtmlToMp4({
      htmlPath: job.htmlPath,
      outPath: job.outPath,
      quality: job.quality,
      audioPath: job.audioPath,
      durationSec: job.durationSec,
      signal: abort.signal,
      onLog: (line) => {
        const m = String(line).match(/frame\s+(\d+)\s*\/\s*(\d+)/i);
        if (m) {
          const cur = Number(m[1]);
          const total = Math.max(1, Number(m[2]));
          // Frames ~5–90%, encode leftover
          const pct = Math.min(90, Math.max(8, Math.round(5 + (cur / total) * 85)));
          patchJob(id, {
            progress: pct,
            message: `录制画面 ${cur}/${total}（${job.quality}）`,
          });
          return;
        }
        if (/ffmpeg/i.test(line)) {
          patchJob(id, { progress: Math.max(job.progress, 92), message: `正在编码 MP4（${job.quality}）…` });
        }
      },
    });

    if (job.cancelRequested || abort.signal.aborted) {
      patchJob(id, {
        status: 'cancelled',
        progress: 100,
        message: '已取消',
        finishedAt: nowIso(),
      });
      try { if (fs.existsSync(job.outPath)) fs.unlinkSync(job.outPath); } catch { /* ignore */ }
      return;
    }

    patchJob(id, {
      status: 'completed',
      progress: 100,
      message: `MP4 已导出（${job.quality}）`,
      finishedAt: nowIso(),
      error: null,
    });
  } catch (err: any) {
    if (job.cancelRequested || abort.signal.aborted || /取消|abort/i.test(String(err?.message || err))) {
      patchJob(id, {
        status: 'cancelled',
        progress: 100,
        message: '已取消',
        finishedAt: nowIso(),
      });
      return;
    }
    patchJob(id, {
      status: 'failed',
      progress: 100,
      message: `导出失败：${String(err?.message || err).slice(0, 120)}`,
      error: String(err?.message || err).slice(0, 500),
      finishedAt: nowIso(),
    });
  } finally {
    job.abort = undefined;
  }
}

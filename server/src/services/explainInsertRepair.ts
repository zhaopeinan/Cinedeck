/**
 * Repair a single MOOC explain-insert child after media QC failure,
 * then patch explain_inserts.json and re-queue MOOC compose.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
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

export type ExplainWorkMode = 'approve' | 'reexport' | 'regenerate';

export type ExplainWorkItem = {
  id: string;
  childId: string;
  mode: ExplainWorkMode;
  title: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

type WorkDeps = {
  moocJobs: MoocJobService;
  explainJobs: ExplainJobService;
  batches: ExplainBatchService;
  projectService: ProjectService;
  videoComposer: VideoComposerService;
  db: import('better-sqlite3').Database;
};

const workDrainLocks = new Map<string, Promise<void>>();

const MODE_LABEL: Record<ExplainWorkMode, string> = {
  approve: '入片',
  reexport: '重导',
  regenerate: '重生',
};

function writeMoocConfig(moocJobs: MoocJobService, moocId: string, patch: (cfg: any) => void): any {
  const job = moocJobs.getJob(moocId);
  if (!job) return null;
  const cfg: any = { ...moocJobs.parseConfig(job) };
  patch(cfg);
  moocJobs.updateJob(moocId, { config_json: JSON.stringify(cfg) });
  return cfg;
}

function normalizeWorkQueue(cfg: any): ExplainWorkItem[] {
  const out: ExplainWorkItem[] = [];
  const seen = new Set<string>();
  const raw = Array.isArray(cfg?.explainWorkQueue) ? cfg.explainWorkQueue : [];
  for (const item of raw) {
    if (!item?.id || !item?.childId) continue;
    const mode = (['approve', 'reexport', 'regenerate'].includes(item.mode) ? item.mode : 'approve') as ExplainWorkMode;
    const status = (['queued', 'running', 'done', 'failed', 'cancelled'].includes(item.status)
      ? item.status
      : 'queued') as ExplainWorkItem['status'];
    out.push({
      id: String(item.id),
      childId: String(item.childId),
      mode,
      title: String(item.title || ''),
      status,
      enqueuedAt: String(item.enqueuedAt || new Date().toISOString()),
      startedAt: item.startedAt ? String(item.startedAt) : undefined,
      finishedAt: item.finishedAt ? String(item.finishedAt) : undefined,
      error: item.error ? String(item.error) : undefined,
    });
    seen.add(`${mode}:${item.childId}:${status}`);
  }
  // Migrate legacy pendingExplainApproves
  const legacy = Array.isArray(cfg?.pendingExplainApproves) ? cfg.pendingExplainApproves : [];
  for (const childId of legacy) {
    const id = String(childId);
    if (!id) continue;
    if (out.some((x) => x.childId === id && x.mode === 'approve' && (x.status === 'queued' || x.status === 'running'))) {
      continue;
    }
    out.push({
      id: randomUUID(),
      childId: id,
      mode: 'approve',
      title: '',
      status: 'queued',
      enqueuedAt: new Date().toISOString(),
    });
  }
  return out;
}

export function listExplainWorkQueue(moocJobs: MoocJobService, moocId: string): ExplainWorkItem[] {
  const job = moocJobs.getJob(moocId);
  if (!job) return [];
  return normalizeWorkQueue(moocJobs.parseConfig(job));
}

function enqueueWorkItems(
  deps: WorkDeps,
  moocId: string,
  items: Array<{ childId: string; mode: ExplainWorkMode; title: string }>,
): ExplainWorkItem[] {
  const added: ExplainWorkItem[] = [];
  writeMoocConfig(deps.moocJobs, moocId, (cfg) => {
    const queue = normalizeWorkQueue(cfg);
    for (const it of items) {
      const dup = queue.find(
        (x) => x.childId === it.childId
          && x.mode === it.mode
          && (x.status === 'queued' || x.status === 'running'),
      );
      if (dup) {
        added.push(dup);
        continue;
      }
      const row: ExplainWorkItem = {
        id: randomUUID(),
        childId: it.childId,
        mode: it.mode,
        title: it.title,
        status: 'queued',
        enqueuedAt: new Date().toISOString(),
      };
      queue.push(row);
      added.push(row);
    }
    cfg.explainWorkQueue = queue.slice(-80);
    delete cfg.pendingExplainApproves;
  });
  for (const row of added) {
    if (row.status !== 'queued') continue;
    const patch: Record<string, any> = {
      repair: {
        moocJobId: moocId,
        mode: row.mode,
        status: 'queued',
        workId: row.id,
        at: row.enqueuedAt,
      },
    };
    if (row.mode === 'approve') patch.userReview = null;
    deps.explainJobs.mergeConfig(row.childId, patch);
    deps.explainJobs.updateJob(row.childId, {
      message: `已加入${MODE_LABEL[row.mode]}队列`,
    });
  }
  return added;
}

async function exportAndBuildClip(opts: {
  job: ExplainJobRow;
  userId: string;
  quality: '720p' | '1080p' | '1440p';
  batchId: string;
  projectDir: string;
  enableAvatar: boolean;
  chromaSimilarity?: number;
  projectId: string;
  projectService: ProjectService;
  videoComposer: VideoComposerService;
  db: import('better-sqlite3').Database;
  explainJobs: ExplainJobService;
  batches: ExplainBatchService;
  forceReexport?: boolean;
}): Promise<ExplainInsertClip> {
  let job = opts.job;
  if (!job.final_path || !fs.existsSync(job.final_path)) {
    throw new Error('缺少全片 HTML，请先重生该知识点');
  }
  const finalDir = path.dirname(job.final_path);
  const outPath = path.join(finalDir, `export_${opts.quality}.mp4`);
  const audioPath = path.join(finalDir, 'narration.wav');

  let videoPath: string | null = null;
  if (!opts.forceReexport) {
    if (job.video_path && fs.existsSync(job.video_path)) videoPath = job.video_path;
    else if (fs.existsSync(outPath)) videoPath = outPath;
  }

  if (videoPath) {
    try {
      if (fs.existsSync(audioPath)) {
        await assertSpeechAudioOk({ filePath: audioPath, minDurationSec: 0.8 });
      }
      await assertExplainAnimationMp4Ok({ filePath: videoPath });
    } catch {
      try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch { /* ignore */ }
      videoPath = null;
      opts.explainJobs.updateJob(job.id, { video_path: null });
    }
  }

  if (!videoPath) {
    for (const q of ['720p', '1080p', '1440p']) {
      const f = path.join(finalDir, `export_${q}.mp4`);
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
    opts.explainJobs.updateJob(job.id, { video_path: null });
    const exportJob = await prepareAndEnqueueExplainExport({
      explainJobs: opts.explainJobs,
      explainJobId: job.id,
      userId: opts.userId,
      quality: opts.quality,
    });
    await waitUntil(() => {
      const ej = getExplainExportJob(exportJob.id);
      return !!ej && (ej.status === 'completed' || ej.status === 'failed' || ej.status === 'cancelled');
    }, { timeoutMs: 2 * 60 * 60 * 1000, intervalMs: 2500 });

    const ej = getExplainExportJob(exportJob.id);
    videoPath = (ej?.status === 'completed' && fs.existsSync(outPath))
      ? outPath
      : (opts.explainJobs.getJob(job.id)?.video_path || null);
    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error(ej?.error || ej?.message || '导出失败');
    }
    if (fs.existsSync(audioPath)) {
      await assertSpeechAudioOk({ filePath: audioPath, minDurationSec: 0.8 });
    }
    await assertExplainAnimationMp4Ok({ filePath: videoPath });
  }

  markExplainMediaQc(opts.explainJobs, job.id, { ok: true, reason: 'ok', path: videoPath });
  opts.explainJobs.updateJob(job.id, { video_path: videoPath });
  opts.explainJobs.mergeConfig(job.id, {
    userReview: { decision: 'approved', at: new Date().toISOString() },
  });

  let clip: ExplainInsertClip = {
    afterPage: resolveAfterPage(opts.batches, opts.batchId, job),
    videoPath,
    title: job.name,
    explainJobId: job.id,
    audioPath: fs.existsSync(audioPath) ? audioPath : null,
  };

  if (opts.enableAvatar) {
    try {
      const av = await attachAvatarsToExplainInserts({
        projectId: opts.projectId,
        userId: opts.userId,
        projectDir: opts.projectDir,
        inserts: [clip],
        projectService: opts.projectService,
        videoComposer: opts.videoComposer,
        db: opts.db,
        chromaSimilarity: opts.chromaSimilarity ?? 0.28,
        isCancelled: () => false,
        force: true,
      });
      if (av.inserts?.[0]) clip = av.inserts[0];
    } catch (err: any) {
      console.warn('[ExplainWork] avatar overlay soft-fail:', err?.message || err);
    }
  }
  return clip;
}

function patchWorkItem(
  moocJobs: MoocJobService,
  moocId: string,
  workId: string,
  patch: Partial<ExplainWorkItem>,
) {
  writeMoocConfig(moocJobs, moocId, (cfg) => {
    const queue = normalizeWorkQueue(cfg);
    cfg.explainWorkQueue = queue.map((x) => (x.id === workId ? { ...x, ...patch } : x));
    delete cfg.pendingExplainApproves;
  });
}

function isWorkCancelled(moocJobs: MoocJobService, moocId: string, workId: string): boolean {
  const item = listExplainWorkQueue(moocJobs, moocId).find((x) => x.id === workId);
  return !item || item.status === 'cancelled';
}

async function runOneWorkItem(
  deps: WorkDeps & { userId: string },
  moocId: string,
  item: ExplainWorkItem,
): Promise<ExplainInsertClip | null> {
  const mooc = deps.moocJobs.getJob(moocId);
  if (!mooc?.project_id) throw new Error('缺少项目');
  const project = deps.projectService.getProject(mooc.project_id) as any;
  if (!project?.file_path) throw new Error('项目文件缺失');
  const projectDir = path.dirname(project.file_path);
  const cfg: any = deps.moocJobs.parseConfig(mooc);
  const quality = (['720p', '1080p', '1440p'].includes(String(cfg.explainExportQuality))
    ? cfg.explainExportQuality
    : '1080p') as '720p' | '1080p' | '1440p';

  let child = deps.explainJobs.getJob(item.childId);
  if (!child) throw new Error('知识点不存在');

  deps.explainJobs.mergeConfig(child.id, {
    repair: {
      moocJobId: moocId,
      mode: item.mode,
      status: 'running',
      workId: item.id,
      at: new Date().toISOString(),
    },
  });

  if (item.mode === 'regenerate') {
    deps.explainJobs.mergeConfig(child.id, {
      retryCount: 0,
      resumeFrom: 'start',
      lastError: null,
      mediaQc: null,
    });
    deps.explainJobs.updateJob(child.id, {
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: '队列重生中…',
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
      if (isWorkCancelled(deps.moocJobs, moocId, item.id)) return true;
      const j = deps.explainJobs.getJob(child!.id);
      return !!j && (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled');
    }, { timeoutMs: 3 * 60 * 60 * 1000, intervalMs: 3000 });
    if (isWorkCancelled(deps.moocJobs, moocId, item.id)) return null;
    child = deps.explainJobs.getJob(child.id)!;
    if (child.status !== 'completed' || !child.final_path || !fs.existsSync(child.final_path)) {
      throw new Error(child.error || '重新生成失败');
    }
  }

  if (isWorkCancelled(deps.moocJobs, moocId, item.id)) return null;

  const batchId = String(cfg.explainBatchId || child.batch_id || '');
  const clip = await exportAndBuildClip({
    job: child,
    userId: deps.userId,
    quality,
    batchId,
    projectDir,
    enableAvatar: !!cfg.enableAvatar,
    chromaSimilarity: cfg.chromaSimilarity,
    projectId: mooc.project_id,
    projectService: deps.projectService,
    videoComposer: deps.videoComposer,
    db: deps.db,
    explainJobs: deps.explainJobs,
    batches: deps.batches,
    forceReexport: item.mode === 'reexport' || item.mode === 'regenerate',
  });
  deps.explainJobs.mergeConfig(child.id, {
    repair: {
      moocJobId: moocId,
      mode: item.mode,
      status: 'done',
      workId: item.id,
      at: new Date().toISOString(),
    },
  });
  deps.explainJobs.updateJob(child.id, {
    message: item.mode === 'approve'
      ? '用户已通过，已加入插片清单'
      : '已修复并加入插片清单',
  });
  return clip;
}

/**
 * After process restart the in-memory drain locks are gone. Re-queue orphaned
 * "running" work items and restart drains so approve/repair/regen don't sit forever.
 */
export function resumeExplainWorkQueues(deps: WorkDeps): number {
  const jobs = deps.moocJobs.listJobsWithPendingExplainWork();
  let resumed = 0;
  for (const row of jobs) {
    writeMoocConfig(deps.moocJobs, row.id, (cfg) => {
      const queue = normalizeWorkQueue(cfg);
      let changed = false;
      cfg.explainWorkQueue = queue.map((x) => {
        if (x.status !== 'running') return x;
        changed = true;
        return {
          ...x,
          status: 'queued',
          startedAt: undefined,
          error: '服务重启，已重新排队',
        };
      });
      if (changed && String(cfg?.repairInProgress?.kind || '').startsWith('explain_')) {
        delete cfg.repairInProgress;
      }
      if (!changed) cfg.explainWorkQueue = queue;
    });
    ensureExplainWorkDrain({ ...deps, moocJobId: row.id, userId: row.user_id });
    resumed += 1;
  }
  if (resumed > 0) {
    console.log(`[ExplainWork] resumed ${resumed} MOOC work queue(s) after restart`);
  }
  return resumed;
}

function ensureExplainWorkDrain(deps: WorkDeps & { moocJobId: string; userId: string }) {
  const moocId = deps.moocJobId;
  if (workDrainLocks.has(moocId)) return;

  const work = (async () => {
    try {
      // Reclaim orphaned "running" rows left by a crashed previous drain.
      writeMoocConfig(deps.moocJobs, moocId, (cfg) => {
        const queue = normalizeWorkQueue(cfg);
        if (!queue.some((x) => x.status === 'running')) return;
        cfg.explainWorkQueue = queue.map((x) => (
          x.status === 'running'
            ? { ...x, status: 'queued', startedAt: undefined, error: '中断后重新排队' }
            : x
        ));
      });

      while (true) {
        const job = deps.moocJobs.getJob(moocId);
        if (!job) return;
        let cfg: any = deps.moocJobs.parseConfig(job);
        let queue = normalizeWorkQueue(cfg);

        // Wait out unrelated pipeline; allow our repair banner
        const repairingUs = String(cfg?.repairInProgress?.kind || '').startsWith('explain_');
        // Failed work items used to clear repairInProgress while leaving status=running,
        // which made this drain busy-wait forever and blocked the whole MOOC queue.
        if (job.status === 'running' && !repairingUs) {
          const now = new Date().toISOString();
          writeMoocConfig(deps.moocJobs, moocId, (c) => { delete c.repairInProgress; });
          deps.moocJobs.updateJob(moocId, {
            status: 'success',
            stage: 'done',
            message: '入片/修复队列继续处理中',
            error: null,
            finished_at: now,
          });
          continue;
        }
        const busy = (job.status === 'running' || job.status === 'queued') && !repairingUs;
        const hasQueued = queue.some((x) => x.status === 'queued');
        if (!hasQueued) {
          if (repairingUs || job.status === 'running') {
            const now = new Date().toISOString();
            writeMoocConfig(deps.moocJobs, moocId, (c) => { delete c.repairInProgress; });
            if (job.status === 'running') {
              deps.moocJobs.updateJob(moocId, {
                status: 'success',
                stage: 'done',
                message: '入片/修复队列已空闲',
                error: null,
                finished_at: now,
              });
            }
          }
          return;
        }
        if (busy) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }

        // Claim next queued item
        const next = queue.find((x) => x.status === 'queued');
        if (!next) return;

        patchWorkItem(deps.moocJobs, moocId, next.id, {
          status: 'running',
          startedAt: new Date().toISOString(),
          error: undefined,
        });
        try {
          deps.moocJobs.markRepairInProgress(moocId, deps.userId, {
            kind: `explain_${next.mode}`,
            message: `队列${MODE_LABEL[next.mode]}：${next.title || next.childId.slice(0, 8)}`,
          });
        } catch { /* ignore */ }

        const okClips: ExplainInsertClip[] = [];
        try {
          if (isWorkCancelled(deps.moocJobs, moocId, next.id)) {
            continue;
          }
          const clip = await runOneWorkItem(deps, moocId, next);
          if (clip) okClips.push(clip);
          patchWorkItem(deps.moocJobs, moocId, next.id, {
            status: clip ? 'done' : 'cancelled',
            finishedAt: new Date().toISOString(),
          });

          // Opportunistically drain consecutive approve items before recompose
          while (true) {
            const q2 = listExplainWorkQueue(deps.moocJobs, moocId);
            const more = q2.find((x) => x.status === 'queued' && x.mode === 'approve');
            if (!more) break;
            patchWorkItem(deps.moocJobs, moocId, more.id, {
              status: 'running',
              startedAt: new Date().toISOString(),
            });
            try {
              const c2 = await runOneWorkItem(deps, moocId, more);
              if (c2) okClips.push(c2);
              patchWorkItem(deps.moocJobs, moocId, more.id, {
                status: c2 ? 'done' : 'cancelled',
                finishedAt: new Date().toISOString(),
              });
            } catch (err: any) {
              const reason = String(err?.message || err).slice(0, 300);
              markExplainMediaQc(deps.explainJobs, more.childId, { ok: false, reason });
              deps.explainJobs.mergeConfig(more.childId, {
                repair: {
                  moocJobId: moocId,
                  mode: more.mode,
                  status: 'failed',
                  workId: more.id,
                  at: new Date().toISOString(),
                  error: reason,
                },
              });
              patchWorkItem(deps.moocJobs, moocId, more.id, {
                status: 'failed',
                finishedAt: new Date().toISOString(),
                error: reason,
              });
            }
          }
        } catch (err: any) {
          const reason = String(err?.message || err).slice(0, 300);
          markExplainMediaQc(deps.explainJobs, next.childId, { ok: false, reason });
          deps.explainJobs.mergeConfig(next.childId, {
            repair: {
              moocJobId: moocId,
              mode: next.mode,
              status: 'failed',
              workId: next.id,
              at: new Date().toISOString(),
              error: reason,
            },
          });
          patchWorkItem(deps.moocJobs, moocId, next.id, {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: reason,
          });
        }

        if (okClips.length && job.project_id) {
          const project = deps.projectService.getProject(job.project_id) as any;
          if (project?.file_path) {
            const projectDir = path.dirname(project.file_path);
            const cur = readInserts(projectDir);
            const keep = cur.inserts.filter((c) => !okClips.some((n) => n.explainJobId === c.explainJobId));
            const merged = [...keep, ...okClips]
              .sort((a, b) => a.afterPage - b.afterPage || a.title.localeCompare(b.title));
            const summary = `已插入 ${merged.length} 段知识点动画（队列处理）`;
            writeInserts(projectDir, merged, summary);
            writeMoocConfig(deps.moocJobs, moocId, (c) => {
              c.enableExplainInsert = true;
              c.explainInsertSummary = summary;
            });
            const queued = deps.moocJobs.queueRecomposeOnly(moocId, deps.userId, {
              message: `队列已入片 ${okClips.length} 个知识点，排队重合成`,
            });
            if (queued) {
              const { ensureMoocQueueAwake } = await import('../utils/wakeMoocQueue');
              await ensureMoocQueueAwake({ reason: 'explain_work_queue' });
              for (let i = 0; i < 7200; i++) {
                const j = deps.moocJobs.getJob(moocId);
                if (!j) break;
                if (j.status !== 'running' && j.status !== 'queued') break;
                const c: any = deps.moocJobs.parseConfig(j);
                if (String(c?.repairInProgress?.kind || '').startsWith('explain_')) break;
                await new Promise((r) => setTimeout(r, 1000));
              }
            }
          }
        } else {
          // No new clips this round — release the side-channel "running" lock so
          // other MOOC jobs (and our own next items) are not blocked forever.
          const now = new Date().toISOString();
          writeMoocConfig(deps.moocJobs, moocId, (c) => {
            if (String(c?.repairInProgress?.kind || '').startsWith('explain_')) {
              delete c.repairInProgress;
            }
          });
          const cur = deps.moocJobs.getJob(moocId);
          if (cur?.status === 'running') {
            deps.moocJobs.updateJob(moocId, {
              status: 'success',
              stage: 'done',
              message: '入片/修复项已处理（本轮无需重合成）',
              error: null,
              finished_at: now,
            });
          }
        }
      }
    } catch (err: any) {
      console.error('[ExplainWork] drain failed:', err?.message || err);
    } finally {
      workDrainLocks.delete(moocId);
      try {
        const j = deps.moocJobs.getJob(moocId);
        if (j && normalizeWorkQueue(deps.moocJobs.parseConfig(j)).some((x) => x.status === 'queued')) {
          ensureExplainWorkDrain(deps);
        }
      } catch { /* ignore */ }
    }
  })();

  workDrainLocks.set(moocId, work);
}

/** Repair/reexport/regenerate — always enqueue (never reject when busy). */
export async function repairExplainChildForMooc(opts: {
  moocJobId: string;
  childId: string;
  userId: string;
  mode: 'reexport' | 'regenerate';
} & WorkDeps): Promise<{ started: boolean; mode: string; message: string; queued: boolean; workId?: string }> {
  const mooc = opts.moocJobs.getJob(opts.moocJobId);
  if (!mooc || mooc.user_id !== opts.userId) {
    throw Object.assign(new Error('MOOC 任务不存在'), { code: '404' });
  }
  if (!mooc.project_id) {
    throw Object.assign(new Error('缺少项目，无法修复'), { code: '400' });
  }
  const child = opts.explainJobs.getOwned(opts.childId, opts.userId);
  if (!child) {
    throw Object.assign(new Error('知识点任务不存在'), { code: '404' });
  }
  if (opts.mode === 'reexport' && (!child.final_path || !fs.existsSync(child.final_path))) {
    throw Object.assign(new Error('缺少全片 HTML，请选择重生'), { code: '400' });
  }

  const busy = mooc.status === 'running' || mooc.status === 'queued' || workDrainLocks.has(mooc.id);
  const added = enqueueWorkItems(opts, mooc.id, [{
    childId: child.id,
    mode: opts.mode,
    title: child.name,
  }]);
  ensureExplainWorkDrain({ ...opts, moocJobId: mooc.id });
  const workId = added[0]?.id;
  return {
    started: true,
    queued: busy,
    mode: opts.mode,
    workId,
    message: busy
      ? `已加入${MODE_LABEL[opts.mode]}队列，空闲后自动处理`
      : `已开始${MODE_LABEL[opts.mode]}「${child.name}」`,
  };
}

/** Approve insert — enqueue (batch ok). */
export async function approveExplainChildrenForMooc(opts: {
  moocJobId: string;
  childIds: string[];
  userId: string;
} & WorkDeps): Promise<{ started: boolean; message: string; count: number; queued: boolean }> {
  const mooc = opts.moocJobs.getJob(opts.moocJobId);
  if (!mooc || mooc.user_id !== opts.userId) {
    throw Object.assign(new Error('MOOC 任务不存在'), { code: '404' });
  }
  if (!mooc.project_id) {
    throw Object.assign(new Error('缺少项目，无法入片'), { code: '400' });
  }
  const ids = [...new Set((opts.childIds || []).map(String).filter(Boolean))];
  if (!ids.length) {
    throw Object.assign(new Error('请选择要入片的知识点'), { code: '400' });
  }

  const items: Array<{ childId: string; mode: ExplainWorkMode; title: string }> = [];
  for (const id of ids) {
    const child = opts.explainJobs.getOwned(id, opts.userId);
    if (!child) {
      throw Object.assign(new Error(`知识点不存在：${id.slice(0, 8)}`), { code: '404' });
    }
    if (child.status !== 'completed' || !child.final_path || !fs.existsSync(child.final_path)) {
      throw Object.assign(new Error(`「${child.name}」尚未完成动画，无法入片`), { code: '400' });
    }
    items.push({ childId: child.id, mode: 'approve', title: child.name });
  }

  const busy = mooc.status === 'running' || mooc.status === 'queued' || workDrainLocks.has(mooc.id);
  enqueueWorkItems(opts, mooc.id, items);
  ensureExplainWorkDrain({ ...opts, moocJobId: mooc.id });
  const pending = listExplainWorkQueue(opts.moocJobs, mooc.id)
    .filter((x) => x.status === 'queued' || x.status === 'running').length;
  return {
    started: true,
    queued: busy,
    count: items.length,
    message: busy
      ? `已加入入片队列（${items.length} 个），当前队列 ${pending} 项，空闲后自动处理`
      : `已开始处理入片（${items.length} 个）`,
  };
}

/** Cancel a queued (not running) work item. */
export function cancelExplainWorkForMooc(opts: {
  moocJobId: string;
  workId: string;
  userId: string;
  moocJobs: MoocJobService;
  explainJobs: ExplainJobService;
}): { ok: boolean; message: string } {
  const mooc = opts.moocJobs.getJob(opts.moocJobId);
  if (!mooc || mooc.user_id !== opts.userId) {
    throw Object.assign(new Error('MOOC 任务不存在'), { code: '404' });
  }
  const item = listExplainWorkQueue(opts.moocJobs, mooc.id).find((x) => x.id === opts.workId);
  if (!item) {
    throw Object.assign(new Error('队列任务不存在'), { code: '404' });
  }
  if (item.status === 'running') {
    throw Object.assign(new Error('正在执行中，无法取消（可等结束后再操作）'), { code: '400' });
  }
  if (item.status !== 'queued') {
    throw Object.assign(new Error('该任务已结束，无需取消'), { code: '400' });
  }
  patchWorkItem(opts.moocJobs, mooc.id, item.id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
  });
  try {
    const child = opts.explainJobs.getJob(item.childId);
    if (child) {
      const cfg = JSON.parse(child.config_json || '{}');
      if (cfg?.repair?.workId === item.id) {
        opts.explainJobs.mergeConfig(child.id, { repair: null });
        opts.explainJobs.updateJob(child.id, {
          message: `已取消${MODE_LABEL[item.mode]}队列任务`,
        });
      }
    }
  } catch { /* ignore */ }
  return { ok: true, message: `已取消：${item.title || MODE_LABEL[item.mode]}` };
}

/** Mark a completed-but-not-inserted explain child as user-skipped. */
export function skipExplainChildForMooc(opts: {
  moocJobId: string;
  childId: string;
  userId: string;
  moocJobs: MoocJobService;
  explainJobs: ExplainJobService;
}): { ok: boolean; message: string } {
  const mooc = opts.moocJobs.getJob(opts.moocJobId);
  if (!mooc || mooc.user_id !== opts.userId) {
    throw Object.assign(new Error('MOOC 任务不存在'), { code: '404' });
  }
  const child = opts.explainJobs.getOwned(opts.childId, opts.userId);
  if (!child) {
    throw Object.assign(new Error('知识点任务不存在'), { code: '404' });
  }
  // Also cancel any queued approve/repair for this child
  const queue = listExplainWorkQueue(opts.moocJobs, mooc.id);
  for (const item of queue) {
    if (item.childId === child.id && item.status === 'queued') {
      patchWorkItem(opts.moocJobs, mooc.id, item.id, {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
      });
    }
  }
  opts.explainJobs.mergeConfig(child.id, {
    userReview: {
      decision: 'skipped',
      reason: '用户选择不入片',
      at: new Date().toISOString(),
    },
    repair: null,
  });
  opts.explainJobs.updateJob(child.id, {
    message: '用户选择不入片',
  });
  return { ok: true, message: '已标记为不入片' };
}

/**
 * Remove an already-inserted explain clip from the final video inserts list,
 * then recompose. The HTML/animation job itself is kept for later re-approve.
 */
export async function removeExplainInsertForMooc(opts: {
  moocJobId: string;
  childId: string;
  userId: string;
  moocJobs: MoocJobService;
  explainJobs: ExplainJobService;
  projectService: ProjectService;
}): Promise<{ ok: boolean; message: string; recomposing: boolean }> {
  const mooc = opts.moocJobs.getJob(opts.moocJobId);
  if (!mooc || mooc.user_id !== opts.userId) {
    throw Object.assign(new Error('MOOC 任务不存在'), { code: '404' });
  }
  if (!mooc.project_id) {
    throw Object.assign(new Error('缺少项目'), { code: '400' });
  }
  const child = opts.explainJobs.getOwned(opts.childId, opts.userId);
  if (!child) {
    throw Object.assign(new Error('知识点任务不存在'), { code: '404' });
  }

  const project = opts.projectService.getProject(mooc.project_id) as any;
  if (!project?.file_path) {
    throw Object.assign(new Error('项目文件缺失'), { code: '400' });
  }
  const projectDir = path.dirname(project.file_path);
  const cur = readInserts(projectDir);
  const before = cur.inserts.length;
  const next = cur.inserts.filter((c) => c.explainJobId !== child.id);
  if (next.length === before) {
    throw Object.assign(new Error('该知识点当前不在成片插片清单中'), { code: '400' });
  }
  const summary = next.length
    ? `已插入 ${next.length} 段知识点动画（已移出「${child.name}」）`
    : '已清空知识点插片';
  writeInserts(projectDir, next, summary);

  // Cancel queued work for this child; leave HTML for re-approve
  for (const item of listExplainWorkQueue(opts.moocJobs, mooc.id)) {
    if (item.childId === child.id && item.status === 'queued') {
      patchWorkItem(opts.moocJobs, mooc.id, item.id, {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
      });
    }
  }

  opts.explainJobs.mergeConfig(child.id, {
    userReview: null,
    repair: null,
  });
  opts.explainJobs.updateJob(child.id, {
    message: '已从成片移出，可重新审核入片或重生',
  });

  writeMoocConfig(opts.moocJobs, mooc.id, (cfg) => {
    cfg.explainInsertSummary = summary;
  });

  const queued = opts.moocJobs.queueRecomposeOnly(mooc.id, opts.userId, {
    message: `已移出知识点「${child.name}」，排队重合成`,
  });
  if (queued) {
    const { ensureMoocQueueAwake } = await import('../utils/wakeMoocQueue');
    await ensureMoocQueueAwake({ reason: 'explain_remove_insert' });
  }
  return {
    ok: true,
    recomposing: !!queued,
    message: queued
      ? '已从成片移出该知识点，正在重合成'
      : '已从插片清单移出（当前无法排队重合成，请稍后点继续）',
  };
}

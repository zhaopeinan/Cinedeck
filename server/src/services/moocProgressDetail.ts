/**
 * Build rich progress payload for MOOC job list/detail UI.
 */
import fs from 'fs';
import path from 'path';
import type { MoocJobConfig, MoocJobRow, MoocCheckpoint } from './moocJobService';

function pathDirnameSafe(p: string) {
  return path.dirname(p);
}
function pathJoinSafe(...parts: string[]) {
  return path.join(...parts);
}
import { STAGE_LABEL_CN } from './moocJobService';
import type { ExplainBatchService } from './explainBatchService';
import {
  EXPLAIN_STAGE_LABEL,
  type ExplainJobService,
  type ExplainJobRow,
} from './explainJobService';
import type { ProjectService } from './projectService';
import { getExplainConcurrencyStatus } from './explainConcurrency';

const CHECKPOINT_ORDER: MoocCheckpoint[] = [
  'none', 'created', 'parsed', 'scripted', 'dubbed', 'avatar',
  'explain_points', 'explain_ready', 'composed',
];

const PIPELINE_STEPS: Array<{
  id: string;
  label: string;
  checkpoint: MoocCheckpoint;
  stages: string[];
}> = [
  { id: 'creating', label: '创建项目', checkpoint: 'created', stages: ['creating'] },
  { id: 'parsing', label: '解析 PPT', checkpoint: 'parsed', stages: ['parsing'] },
  { id: 'script', label: '生成解说词', checkpoint: 'scripted', stages: ['script'] },
  { id: 'dubbing', label: '生成配音', checkpoint: 'dubbed', stages: ['dubbing'] },
  { id: 'avatar', label: '生成数字人', checkpoint: 'avatar', stages: ['avatar'] },
  { id: 'explain_points', label: '分析知识点', checkpoint: 'explain_points', stages: ['explain_points'] },
  { id: 'explain_gen', label: '生成讲解动画', checkpoint: 'explain_ready', stages: ['explain_gen'] },
  { id: 'compose', label: '合成成片', checkpoint: 'composed', stages: ['compose'] },
];

function checkpointAtLeast(current: string | null | undefined, target: MoocCheckpoint): boolean {
  return CHECKPOINT_ORDER.indexOf((current as MoocCheckpoint) || 'none')
    >= CHECKPOINT_ORDER.indexOf(target);
}

function secBetween(a?: string | null, b?: string | null): number | null {
  if (!a) return null;
  const t0 = Date.parse(a);
  const t1 = b ? Date.parse(b) : Date.now();
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return null;
  return Math.round((t1 - t0) / 1000);
}

function formatDuration(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function shortTitle(name: string): string {
  const parts = String(name || '').split(' · ');
  return (parts[parts.length - 1] || name || '').slice(0, 40);
}

function childPublic(c: ExplainJobRow, extras?: {
  insertedIds?: Set<string>;
  /**
   * True while any sibling is still running/queued, or parent is mid explain_gen.
   * Missing inserts then means "not exported yet", not QC failure.
   */
  explainStillGenerating?: boolean;
}) {
  const cfg = (() => {
    try { return JSON.parse(c.config_json || '{}'); } catch { return {}; }
  })();
  const startedAt = c.started_at || null;
  const finishedAt = c.status === 'completed' || c.status === 'failed' || c.status === 'cancelled'
    ? (c.finished_at || c.updated_at)
    : null;
  const durationSec = secBetween(startedAt, finishedAt || (['running', 'queued'].includes(c.status) ? null : c.updated_at));
  const elapsedSec = startedAt && !finishedAt ? secBetween(startedAt, null) : durationSec;
  const hasFinal = !!(c.final_path && fs.existsSync(c.final_path));
  const hasSample = !!(c.sample_path && fs.existsSync(c.sample_path));
  const hasVideo = !!(c.video_path && fs.existsSync(c.video_path));
  const mediaQc = cfg.mediaQc && typeof cfg.mediaQc === 'object' ? cfg.mediaQc : null;
  const repair = cfg.repair && typeof cfg.repair === 'object' ? cfg.repair : null;
  const userReview = cfg.userReview && typeof cfg.userReview === 'object' ? cfg.userReview : null;
  const inInserts = !!(extras?.insertedIds && extras.insertedIds.has(c.id));
  const explainStillGenerating = !!extras?.explainStillGenerating;
  const userSkipped = userReview?.decision === 'skipped';

  // pending_review = HTML done, waiting for human approve-to-insert
  // failed = real media QC failure (or generation failure)
  let qcStatus: 'ok' | 'failed' | 'pending' | 'pending_review' | 'skipped' | 'repairing' | null = null;
  let qcReason: string | null = null;
  if (repair?.status === 'running' || repair?.status === 'queued') {
    qcStatus = 'repairing';
    if (repair.mode === 'approve') {
      qcReason = repair.status === 'queued' ? '已在入片队列中…' : '正在导出并入片…';
    } else if (repair.mode === 'regenerate') {
      qcReason = '正在重新生成…';
    } else {
      qcReason = '正在重新导出…';
    }
  } else if (userSkipped && !inInserts) {
    qcStatus = 'skipped';
    qcReason = String(userReview?.reason || '用户选择不入片');
  } else if (mediaQc && mediaQc.ok === false) {
    qcStatus = 'failed';
    qcReason = String(mediaQc.reason || '质检未通过');
  } else if (c.status === 'completed' && inInserts) {
    qcStatus = 'ok';
  } else if (mediaQc && mediaQc.ok === true && !inInserts) {
    // Exported & QC-ok but not yet in inserts.json (rare race)
    qcStatus = 'pending_review';
    qcReason = '已导出，等待确认入片';
  } else if (c.status === 'completed' && hasFinal && !inInserts) {
    if (explainStillGenerating) {
      qcStatus = 'pending';
      qcReason = 'HTML 已完成，等待整批处理';
    } else {
      qcStatus = 'pending_review';
      qcReason = '动画已完成，请预览后决定是否入片';
    }
  } else if (c.status === 'completed') {
    qcStatus = 'pending';
  }

  const canApprove = c.status === 'completed'
    && hasFinal
    && !inInserts
    && !explainStillGenerating
    && qcStatus !== 'repairing'
    && qcStatus !== 'skipped';

  const canRepair = c.status === 'failed' || c.status === 'cancelled'
    || qcStatus === 'failed'
    || canApprove;

  const canSkip = canApprove;

  return {
    id: c.id,
    title: shortTitle(c.name),
    name: c.name,
    status: c.status,
    stage: c.stage,
    stageLabel: EXPLAIN_STAGE_LABEL[c.stage] || c.stage,
    progress: c.progress || 0,
    message: c.message,
    error: c.error || (qcStatus === 'failed' ? qcReason : null),
    retryCount: Number(cfg.retryCount || 0),
    maxRetries: Number(cfg.maxRetries != null ? cfg.maxRetries : 3),
    hasFinal,
    hasSample,
    hasVideo,
    inInserts,
    qcStatus,
    qcReason,
    canRepair,
    canApprove,
    canSkip,
    repairStatus: repair?.status || null,
    startedAt,
    finishedAt,
    updatedAt: c.updated_at,
    durationSec,
    elapsedSec,
    durationLabel: formatDuration(finishedAt ? durationSec : elapsedSec),
  };
}

export function buildMoocProgressDetail(opts: {
  job: MoocJobRow;
  config: MoocJobConfig;
  projectService: ProjectService;
  explainBatches?: ExplainBatchService | null;
  explainJobs?: ExplainJobService | null;
  /** include full explain children (detail view) */
  includeChildren?: boolean;
}) {
  const { job, config } = opts;
  const enableExplain = !!config.enableExplainInsert;
  const enableAvatar = !!config.enableAvatar;
  const checkpoint = (job.checkpoint || 'none') as MoocCheckpoint;
  const stageLog: any[] = Array.isArray((config as any).stageLog) ? (config as any).stageLog : [];
  const logById = new Map(stageLog.map((x: any) => [x.id, x]));

  const steps = PIPELINE_STEPS
    .filter((s) => {
      if (s.id === 'avatar' && !enableAvatar) return false;
      if ((s.id === 'explain_points' || s.id === 'explain_gen') && !enableExplain) return false;
      return true;
    })
    .map((s) => {
      const log = logById.get(s.id);
      const done = checkpointAtLeast(checkpoint, s.checkpoint)
        || (job.status === 'success' && s.checkpoint === 'composed')
        || log?.status === 'done';
      const isCurrent = s.stages.includes(job.stage)
        && (job.status === 'running' || job.status === 'queued');
      let status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' = 'pending';
      if (job.status === 'failed' && s.stages.includes(job.failed_stage || job.stage)) {
        status = 'failed';
      } else if (done && !isCurrent) {
        status = 'done';
      } else if (isCurrent) {
        status = 'running';
      } else if (log?.status === 'skipped') {
        status = 'skipped';
      }

      const startedAt = log?.startedAt || null;
      const finishedAt = log?.finishedAt || (status === 'done' ? (log?.finishedAt || null) : null);
      const durationSec = log?.durationSec
        ?? secBetween(startedAt, finishedAt || (status === 'running' ? null : undefined));

      return {
        id: s.id,
        label: s.label,
        status,
        startedAt,
        finishedAt,
        durationSec,
        durationLabel: formatDuration(
          status === 'running' ? secBetween(startedAt, null) : durationSec,
        ),
        summary: log?.summary || null,
      };
    });

  let explain: any = null;
  const batchId = config.explainBatchId || null;
  if (enableExplain && batchId && opts.explainBatches) {
    const batch = opts.explainBatches.get(batchId);
    const children = opts.explainBatches.listChildJobs(batchId);
    const insertedIds = new Set<string>();
    try {
      const project = job.project_id ? opts.projectService.getProject(job.project_id) as any : null;
      if (project?.file_path) {
        const insertsPath = pathJoinSafe(pathDirnameSafe(project.file_path), 'explain_inserts.json');
        if (fs.existsSync(insertsPath)) {
          const raw = JSON.parse(fs.readFileSync(insertsPath, 'utf8'));
          for (const c of (Array.isArray(raw.inserts) ? raw.inserts : [])) {
            if (c?.explainJobId) insertedIds.add(String(c.explainJobId));
          }
        }
      }
    } catch { /* ignore */ }

    const siblingsStillOpen = children.some((c) => c.status === 'running' || c.status === 'queued');
    const explainStillGenerating = siblingsStillOpen
      || ((job.status === 'running' || job.status === 'failed')
        && (job.stage === 'explain_gen' || job.stage === 'explain_points')
        && children.some((c) => c.status !== 'completed' && c.status !== 'failed' && c.status !== 'cancelled'));
    const childRows = children.map((c) => childPublic(c, { insertedIds, explainStillGenerating }));
    const stats = {
      total: children.length,
      completed: children.filter((c) => c.status === 'completed').length,
      running: children.filter((c) => c.status === 'running').length,
      queued: children.filter((c) => c.status === 'queued').length,
      failed: children.filter((c) => c.status === 'failed' || c.status === 'cancelled').length,
      qcFailed: childRows.filter((c) => c.qcStatus === 'failed').length,
      pendingReview: childRows.filter((c) => c.qcStatus === 'pending_review').length,
      skipped: childRows.filter((c) => c.qcStatus === 'skipped').length,
      inserted: childRows.filter((c) => c.inInserts).length,
      repairing: childRows.filter((c) => c.qcStatus === 'repairing').length,
      retrying: children.filter((c) => c.status === 'queued' && /自动重试|重新生成|重新导出/.test(String(c.message || ''))).length,
    };
    const doneDurations = children
      .filter((c) => c.status === 'completed')
      .map((c) => secBetween(c.started_at, c.finished_at || c.updated_at))
      .filter((n): n is number => n != null && n > 0);
    const avgDoneSec = doneDurations.length
      ? Math.round(doneDurations.reduce((a, b) => a + b, 0) / doneDurations.length)
      : null;
    const remaining = Math.max(0, stats.total - stats.completed);
    const conc = getExplainConcurrencyStatus().current || 1;
    const etaSec = avgDoneSec != null && remaining > 0
      ? Math.round((avgDoneSec * remaining) / Math.max(1, Math.min(conc, Math.max(1, stats.running || 1))))
      : null;

    const workQueue = (() => {
      try {
        // listExplainWorkQueue needs MoocJobService; fall back to config parse
        const raw = Array.isArray((config as any).explainWorkQueue) ? (config as any).explainWorkQueue : [];
        const legacy = Array.isArray((config as any).pendingExplainApproves)
          ? (config as any).pendingExplainApproves
          : [];
        const items = raw.map((x: any) => ({
          id: String(x.id || ''),
          childId: String(x.childId || ''),
          mode: x.mode || 'approve',
          title: String(x.title || ''),
          status: x.status || 'queued',
          enqueuedAt: x.enqueuedAt || null,
          error: x.error || null,
        })).filter((x: any) => x.id && x.childId);
        for (const childId of legacy) {
          if (items.some((x: any) => x.childId === String(childId) && (x.status === 'queued' || x.status === 'running'))) {
            continue;
          }
          items.push({
            id: `legacy-${childId}`,
            childId: String(childId),
            mode: 'approve',
            title: childRows.find((c) => c.id === String(childId))?.title || '',
            status: 'queued',
            enqueuedAt: null,
            error: null,
          });
        }
        // Enrich titles from children
        for (const it of items) {
          if (!it.title) {
            it.title = childRows.find((c) => c.id === it.childId)?.title || it.title;
          }
        }
        return {
          items: opts.includeChildren ? items.slice(-40) : undefined,
          active: items.filter((x: any) => x.status === 'queued' || x.status === 'running'),
          queuedCount: items.filter((x: any) => x.status === 'queued').length,
          runningCount: items.filter((x: any) => x.status === 'running').length,
        };
      } catch {
        return { items: [], active: [], queuedCount: 0, runningCount: 0 };
      }
    })();

    explain = {
      batchId,
      batchStatus: batch?.status || null,
      batchMessage: batch?.message || null,
      stats,
      workQueue,
      concurrency: conc,
      avgDoneSec,
      avgDoneLabel: formatDuration(avgDoneSec),
      etaSec,
      etaLabel: formatDuration(etaSec),
      children: opts.includeChildren ? childRows : undefined,
    };

    // Enrich explain_gen step summary
    const genStep = steps.find((x) => x.id === 'explain_gen');
    if (genStep) {
      const msg = String(job.message || '');
      if (/^导出/.test(msg)) {
        genStep.summary = `HTML ${stats.completed}/${stats.total} · ${msg}`;
      } else {
        genStep.summary = `完成 ${stats.completed}/${stats.total}`
          + (stats.running ? ` · 进行中 ${stats.running}` : '')
          + (stats.queued ? ` · 排队 ${stats.queued}` : '')
          + (stats.failed ? ` · 失败 ${stats.failed}` : '')
          + (stats.pendingReview ? ` · 待审核 ${stats.pendingReview}` : '')
          + (stats.qcFailed ? ` · 质检未过 ${stats.qcFailed}` : '')
          + (stats.retrying ? ` · 重试 ${stats.retrying}` : '')
          + (conc ? ` · 并发 ${conc}` : '');
      }
    }
  }

  // If a later step is running/done, mark earlier pending steps as done (resume jobs
  // may lack stageLog for early stages even though checkpoint advanced).
  const activeIdx = steps.findIndex((s) => s.status === 'running' || s.status === 'failed');
  const lastDoneIdx = steps.reduce((acc, s, i) => (s.status === 'done' || s.status === 'skipped' ? i : acc), -1);
  const forceDoneUntil = Math.max(activeIdx < 0 ? -1 : activeIdx - 1, lastDoneIdx);
  if (forceDoneUntil >= 0) {
    for (let i = 0; i <= forceDoneUntil; i++) {
      if (steps[i].status === 'pending') steps[i].status = 'done';
    }
  }

  const elapsedSec = secBetween(job.started_at, job.finished_at || null);
  const progressSummary = buildProgressSummary(job, steps, explain, config);

  return {
    progressSummary,
    elapsedSec,
    elapsedLabel: formatDuration(elapsedSec),
    pipeline: steps,
    explain,
  };
}

function buildProgressSummary(job: MoocJobRow, steps: any[], explain: any, cfg?: any): string {
  if (job.status === 'success' && !cfg?.repairInProgress) return '已完成';
  if (job.status === 'cancelled') return '已取消';
  if (job.status === 'failed') {
    return `失败于${STAGE_LABEL_CN[job.failed_stage || job.stage] || job.stage}`;
  }
  if (job.status === 'queued') {
    const queuedMsg = String(job.message || '').trim();
    // Prefer the concrete reason (e.g. 排队重合成) over a generic wait label.
    if (queuedMsg && queuedMsg !== '排队等待中') return queuedMsg;
    return '排队等待中';
  }

  const current = steps.find((s) => s.status === 'running');
  const msg = String(job.message || '');
  if (cfg?.repairInProgress) {
    return msg || (typeof cfg.repairInProgress === 'object' && cfg.repairInProgress.message)
      || '正在修复知识点插片…';
  }
  // Export / avatar-on-insert phases after HTML children finish
  if (/^导出/.test(msg) || /叠数字人|知识点插片/.test(msg) || /合成讲解视频/.test(msg)) {
    return msg;
  }
  if (explain && (job.stage === 'explain_gen' || job.stage === 'explain_points')) {
    const s = explain.stats;
    if (s.completed >= s.total && s.total > 0 && !s.running && !s.queued) {
      return msg && !/^讲解动画/.test(msg)
        ? msg
        : `讲解 HTML 已完成 ${s.completed}/${s.total}，正在导出插片…`;
    }
    const parts = [
      `讲解动画 ${s.completed}/${s.total} 完成`,
    ];
    if (s.running) parts.push(`进行中 ${s.running}`);
    if (s.queued) parts.push(`排队 ${s.queued}`);
    if (s.failed) parts.push(`失败 ${s.failed}`);
    if (explain.etaLabel) parts.push(`预计剩余 ${explain.etaLabel}`);
    return parts.join(' · ');
  }
  if (current?.durationLabel) {
    return `${current.label} · 已用 ${current.durationLabel}`;
  }
  return job.message || current?.label || STAGE_LABEL_CN[job.stage] || job.stage;
}

/** Persist stage start/end into mooc config.stageLog */
export function recordMoocStageEvent(
  moocJobs: { getJob: (id: string) => MoocJobRow | null; parseConfig: (j: MoocJobRow) => MoocJobConfig; updateJob: (id: string, patch: any) => any },
  jobId: string,
  stageId: string,
  event: 'start' | 'end' | 'skip',
  summary?: string | null,
) {
  const job = moocJobs.getJob(jobId);
  if (!job) return;
  const cfg: any = { ...moocJobs.parseConfig(job) };
  const log: any[] = Array.isArray(cfg.stageLog) ? [...cfg.stageLog] : [];
  let entry = log.find((x) => x.id === stageId);
  if (!entry) {
    entry = {
      id: stageId,
      label: STAGE_LABEL_CN[stageId] || stageId,
    };
    log.push(entry);
  }
  const now = new Date().toISOString();
  if (event === 'start') {
    if (!entry.startedAt) entry.startedAt = now;
    entry.status = 'running';
    entry.finishedAt = null;
    entry.durationSec = null;
  } else if (event === 'skip') {
    entry.status = 'skipped';
    entry.finishedAt = now;
    if (entry.startedAt) entry.durationSec = secBetween(entry.startedAt, now);
  } else {
    entry.status = 'done';
    entry.finishedAt = now;
    if (!entry.startedAt) entry.startedAt = now;
    entry.durationSec = secBetween(entry.startedAt, now);
  }
  if (summary != null) entry.summary = summary;
  cfg.stageLog = log;
  moocJobs.updateJob(jobId, { config_json: JSON.stringify(cfg) });
}

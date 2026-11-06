/**
 * Build rich progress payload for MOOC job list/detail UI.
 */
import fs from 'fs';
import type { MoocJobConfig, MoocJobRow, MoocCheckpoint } from './moocJobService';
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

function childPublic(c: ExplainJobRow) {
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
  return {
    id: c.id,
    title: shortTitle(c.name),
    name: c.name,
    status: c.status,
    stage: c.stage,
    stageLabel: EXPLAIN_STAGE_LABEL[c.stage] || c.stage,
    progress: c.progress || 0,
    message: c.message,
    error: c.error,
    retryCount: Number(cfg.retryCount || 0),
    maxRetries: Number(cfg.maxRetries != null ? cfg.maxRetries : 3),
    hasFinal,
    hasSample,
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
        || job.status === 'success' && s.checkpoint === 'composed';
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
    const stats = {
      total: children.length,
      completed: children.filter((c) => c.status === 'completed').length,
      running: children.filter((c) => c.status === 'running').length,
      queued: children.filter((c) => c.status === 'queued').length,
      failed: children.filter((c) => c.status === 'failed' || c.status === 'cancelled').length,
      retrying: children.filter((c) => c.status === 'queued' && /自动重试/.test(String(c.message || ''))).length,
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

    explain = {
      batchId,
      batchStatus: batch?.status || null,
      batchMessage: batch?.message || null,
      stats,
      concurrency: conc,
      avgDoneSec,
      avgDoneLabel: formatDuration(avgDoneSec),
      etaSec,
      etaLabel: formatDuration(etaSec),
      children: opts.includeChildren ? children.map(childPublic) : undefined,
    };

    // Enrich explain_gen step summary
    const genStep = steps.find((x) => x.id === 'explain_gen');
    if (genStep) {
      genStep.summary = `完成 ${stats.completed}/${stats.total}`
        + (stats.running ? ` · 进行中 ${stats.running}` : '')
        + (stats.queued ? ` · 排队 ${stats.queued}` : '')
        + (stats.failed ? ` · 失败 ${stats.failed}` : '')
        + (stats.retrying ? ` · 重试 ${stats.retrying}` : '')
        + (conc ? ` · 并发 ${conc}` : '');
    }
  }

  const elapsedSec = secBetween(job.started_at, job.finished_at || null);
  const progressSummary = buildProgressSummary(job, steps, explain);

  return {
    progressSummary,
    elapsedSec,
    elapsedLabel: formatDuration(elapsedSec),
    pipeline: steps,
    explain,
  };
}

function buildProgressSummary(job: MoocJobRow, steps: any[], explain: any): string {
  if (job.status === 'success') return '已完成';
  if (job.status === 'cancelled') return '已取消';
  if (job.status === 'failed') {
    return `失败于${STAGE_LABEL_CN[job.failed_stage || job.stage] || job.stage}`;
  }
  if (job.status === 'queued') return '排队等待中';

  const current = steps.find((s) => s.status === 'running');
  if (explain && (job.stage === 'explain_gen' || job.stage === 'explain_points')) {
    const s = explain.stats;
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

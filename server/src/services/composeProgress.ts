export type ComposeJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ComposeMode = 'preview' | 'export';

export interface ComposeLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ComposeJob {
  id: string;
  userId: string;
  mode: ComposeMode;
  status: ComposeJobStatus;
  stage: string;
  message: string;
  progress: number;
  error: string | null;
  backgroundPath: string;
  greenscreenPath: string;
  layout: ComposeLayout;
  chromaSimilarity: number;
  chromaBlend: number;
  outputPath: string | null;
  cancelRequested?: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const jobs = new Map<string, ComposeJob>();

function nowIso() {
  return new Date().toISOString();
}

export function getComposeJob(id: string): ComposeJob | null {
  return jobs.get(id) || null;
}

export function createComposeJob(input: {
  id: string;
  userId: string;
  mode: ComposeMode;
  backgroundPath: string;
  greenscreenPath: string;
  layout: ComposeLayout;
  chromaSimilarity: number;
  chromaBlend: number;
}): ComposeJob {
  const job: ComposeJob = {
    id: input.id,
    userId: input.userId,
    mode: input.mode,
    status: 'queued',
    stage: 'queued',
    message: input.mode === 'preview' ? '预览已入队' : '导出已入队',
    progress: 0,
    error: null,
    backgroundPath: input.backgroundPath,
    greenscreenPath: input.greenscreenPath,
    layout: input.layout,
    chromaSimilarity: input.chromaSimilarity,
    chromaBlend: input.chromaBlend,
    outputPath: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(job.id, job);
  return job;
}

export function updateComposeJob(
  id: string,
  patch: Partial<
    Omit<ComposeJob, 'id' | 'userId' | 'backgroundPath' | 'greenscreenPath' | 'createdAt' | 'mode'>
  >,
): ComposeJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: nowIso() });
  jobs.set(id, job);
  return job;
}

export function listComposeRunningOrQueued(): ComposeJob[] {
  return Array.from(jobs.values()).filter((j) => j.status === 'queued' || j.status === 'running');
}

export function listComposeJobsForUser(userId: string, limit = 50): ComposeJob[] {
  return Array.from(jobs.values())
    .filter((j) => j.userId === userId && !j.userId.startsWith('open:'))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

/** 1-based position among queued compose jobs; null if not queued. */
export function getComposeQueuePosition(jobId: string): number | null {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'queued') return null;
  const queued = Array.from(jobs.values())
    .filter((j) => j.status === 'queued')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const idx = queued.findIndex((j) => j.id === jobId);
  return idx >= 0 ? idx + 1 : null;
}

export function requestCancelComposeJob(id: string): ComposeJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return job;
  }
  job.cancelRequested = true;
  job.updatedAt = nowIso();
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.stage = 'cancelled';
    job.message = '已取消';
    job.progress = 100;
    job.finishedAt = nowIso();
  }
  jobs.set(id, job);
  return job;
}

export function isComposeJobCancelRequested(id: string): boolean {
  const job = jobs.get(id);
  return !!(job && job.cancelRequested);
}

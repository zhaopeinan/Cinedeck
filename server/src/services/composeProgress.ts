export type ComposeJobStatus = 'queued' | 'running' | 'completed' | 'failed';
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

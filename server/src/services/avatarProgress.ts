export type AvatarJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
/** photo=静照口型；video=参考视频驱动（可保留肢体动作） */
export type AvatarDriveMode = 'photo' | 'video';

export interface AvatarJob {
  id: string;
  userId: string;
  driveMode: AvatarDriveMode;
  status: AvatarJobStatus;
  stage: string;
  message: string;
  progress: number;
  error: string | null;
  photoPath: string | null;
  templatePath: string | null;
  /** 选用的用户私有参考视频 id（可选） */
  refVideoId: string | null;
  audioPath: string;
  outputPath: string | null;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const jobs = new Map<string, AvatarJob>();

function nowIso() {
  return new Date().toISOString();
}

export function getAvatarJob(id: string): AvatarJob | null {
  return jobs.get(id) || null;
}

export function createAvatarJob(input: {
  id: string;
  userId: string;
  driveMode: AvatarDriveMode;
  photoPath: string | null;
  templatePath: string | null;
  refVideoId: string | null;
  audioPath: string;
}): AvatarJob {
  const job: AvatarJob = {
    id: input.id,
    userId: input.userId,
    driveMode: input.driveMode,
    status: 'queued',
    stage: 'queued',
    message: '已入队，等待 GPU',
    progress: 0,
    error: null,
    photoPath: input.photoPath,
    templatePath: input.templatePath,
    refVideoId: input.refVideoId,
    audioPath: input.audioPath,
    outputPath: null,
    cancelRequested: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(job.id, job);
  return job;
}

export function updateAvatarJob(
  id: string,
  patch: Partial<
    Omit<
      AvatarJob,
      'id' | 'userId' | 'photoPath' | 'templatePath' | 'refVideoId' | 'audioPath' | 'createdAt' | 'driveMode'
    >
  >,
): AvatarJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: nowIso() });
  jobs.set(id, job);
  return job;
}

export function requestCancelAvatarJob(id: string): AvatarJob | null {
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

export function isAvatarJobCancelRequested(id: string): boolean {
  const job = jobs.get(id);
  return !!(job && job.cancelRequested);
}

export function listRunningOrQueued(): AvatarJob[] {
  return Array.from(jobs.values()).filter((j) => j.status === 'queued' || j.status === 'running');
}

export function listAvatarJobsForUser(userId: string, limit = 50): AvatarJob[] {
  return Array.from(jobs.values())
    .filter((j) => j.userId === userId && !j.userId.startsWith('open:'))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

/** 1-based position among queued jobs (FIFO by createdAt); null if not queued. */
export function getAvatarQueuePosition(jobId: string): number | null {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'queued') return null;
  const queued = Array.from(jobs.values())
    .filter((j) => j.status === 'queued')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const idx = queued.findIndex((j) => j.id === jobId);
  return idx >= 0 ? idx + 1 : null;
}

export function listAllAvatarJobs(limit = 100): AvatarJob[] {
  return Array.from(jobs.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

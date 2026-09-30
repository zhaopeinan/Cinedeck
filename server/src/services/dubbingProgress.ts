export type DubbingProgressStatus = 'idle' | 'running' | 'completed' | 'cancelled';

export interface DubbingLogEntry {
  time: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface DubbingProgress {
  status: DubbingProgressStatus;
  currentPageIndex: number | null;
  activePages: number[];
  concurrency: number;
  stage: string;
  message: string;
  startedAt: string | null;
  updatedAt: string;
  completedCount: number;
  failedCount: number;
  totalToGenerate: number;
  taskId: string | null;
  waitSeconds: number;
  cancelled: boolean;
  logs: DubbingLogEntry[];
}

const MAX_LOGS = 80;
const progressMap = new Map<string, DubbingProgress>();

function nowIso() {
  return new Date().toISOString();
}

function createEmpty(): DubbingProgress {
  return {
    status: 'idle',
    currentPageIndex: null,
    activePages: [],
    concurrency: 1,
    stage: 'idle',
    message: '',
    startedAt: null,
    updatedAt: nowIso(),
    completedCount: 0,
    failedCount: 0,
    totalToGenerate: 0,
    taskId: null,
    waitSeconds: 0,
    cancelled: false,
    logs: [],
  };
}

export function getDubbingProgress(projectId: string): DubbingProgress | null {
  return progressMap.get(projectId) || null;
}

export function startDubbingProgress(
  projectId: string,
  totalToGenerate: number,
  concurrency = 1,
): DubbingProgress {
  const mode = concurrency > 1 ? `并发 ${concurrency}` : '串行';
  const progress: DubbingProgress = {
    ...createEmpty(),
    status: 'running',
    stage: 'starting',
    concurrency,
    message: `开始生成配音，共 ${totalToGenerate} 页（${mode}）`,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    totalToGenerate,
    logs: [],
  };
  progressMap.set(projectId, progress);
  appendDubbingLog(projectId, progress.message, 'info');
  return progress;
}

export function appendDubbingLog(
  projectId: string,
  message: string,
  level: DubbingLogEntry['level'] = 'info',
) {
  const progress = progressMap.get(projectId) || createEmpty();
  progress.logs.push({ time: nowIso(), level, message });
  if (progress.logs.length > MAX_LOGS) {
    progress.logs = progress.logs.slice(-MAX_LOGS);
  }
  progress.updatedAt = nowIso();
  progressMap.set(projectId, progress);
}

export function updateDubbingProgress(
  projectId: string,
  patch: Partial<Omit<DubbingProgress, 'logs'>>,
) {
  const progress = progressMap.get(projectId) || createEmpty();
  Object.assign(progress, patch, { updatedAt: nowIso() });
  progressMap.set(projectId, progress);
  return progress;
}

export function setActivePage(projectId: string, pageIndex: number, active: boolean) {
  const progress = progressMap.get(projectId) || createEmpty();
  const set = new Set(progress.activePages);
  if (active) set.add(pageIndex);
  else set.delete(pageIndex);
  progress.activePages = Array.from(set).sort((a, b) => a - b);
  progress.currentPageIndex = progress.activePages[0] ?? null;
  if (progress.activePages.length > 0) {
    progress.message = `并行生成中：第 ${progress.activePages.join('、')} 页`;
    progress.stage = 'waiting_voicebox';
  }
  progress.updatedAt = nowIso();
  progressMap.set(projectId, progress);
  return progress;
}

export function markDubbingCancelled(projectId: string) {
  const progress = progressMap.get(projectId);
  if (!progress) {
    progressMap.set(projectId, {
      ...createEmpty(),
      status: 'cancelled',
      stage: 'cancelled',
      message: '已取消配音生成',
      cancelled: true,
      updatedAt: nowIso(),
    });
    return;
  }
  progress.cancelled = true;
  progress.status = 'cancelled';
  progress.stage = 'cancelled';
  progress.message = '已取消配音生成';
  progress.activePages = [];
  progress.updatedAt = nowIso();
  appendDubbingLog(projectId, '用户取消了配音生成', 'warn');
}

export function isDubbingCancelled(projectId: string): boolean {
  return !!progressMap.get(projectId)?.cancelled;
}

export function finishDubbingProgress(
  projectId: string,
  opts: { completedCount: number; failedCount: number; cancelled?: boolean },
) {
  const progress = progressMap.get(projectId) || createEmpty();
  progress.completedCount = opts.completedCount;
  progress.failedCount = opts.failedCount;
  progress.currentPageIndex = null;
  progress.activePages = [];
  progress.taskId = null;
  progress.waitSeconds = 0;
  progress.updatedAt = nowIso();
  if (opts.cancelled || progress.cancelled) {
    progress.status = 'cancelled';
    progress.stage = 'cancelled';
    progress.message = '配音生成已取消';
  } else if (opts.failedCount > 0) {
    progress.status = 'completed';
    progress.stage = 'finished_with_errors';
    progress.message = `配音生成结束：成功 ${opts.completedCount} 页，失败 ${opts.failedCount} 页`;
    appendDubbingLog(projectId, progress.message, 'warn');
  } else {
    progress.status = 'completed';
    progress.stage = 'finished';
    progress.message = `全部完成：成功生成 ${opts.completedCount} 页`;
    appendDubbingLog(projectId, progress.message, 'success');
  }
  progressMap.set(projectId, progress);
}

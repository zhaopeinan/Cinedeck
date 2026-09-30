export type ProjectAvatarPageState =
  | 'pending'
  | 'caching'
  | 'queued'
  | 'running'
  | 'generated'
  | 'failed'
  | 'skipped';

export interface ProjectAvatarPageProgress {
  pageIndex: number;
  status: ProjectAvatarPageState;
  message: string;
  error?: string | null;
  /** 0–100 for this page (segment-aware) */
  percent?: number;
}

export interface ProjectAvatarProgress {
  projectId: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  message: string;
  total: number;
  completed: number;
  failed: number;
  /** 0–100 overall estimate (pages × Duix segment progress) */
  percent: number;
  currentPage: number | null;
  pages: ProjectAvatarPageProgress[];
  updatedAt: string;
}

const map = new Map<string, ProjectAvatarProgress>();

export function getProjectAvatarProgress(projectId: string): ProjectAvatarProgress {
  return (
    map.get(projectId) || {
      projectId,
      status: 'idle',
      message: '',
      total: 0,
      completed: 0,
      failed: 0,
      percent: 0,
      currentPage: null,
      pages: [],
      updatedAt: new Date().toISOString(),
    }
  );
}

export function setProjectAvatarProgress(projectId: string, patch: Partial<ProjectAvatarProgress>) {
  const cur = getProjectAvatarProgress(projectId);
  const next = { ...cur, ...patch, projectId, updatedAt: new Date().toISOString() };
  map.set(projectId, next);
  return next;
}

export function patchProjectAvatarPage(
  projectId: string,
  pageIndex: number,
  patch: Partial<ProjectAvatarPageProgress>,
) {
  const cur = getProjectAvatarProgress(projectId);
  const pages = cur.pages.slice();
  const idx = pages.findIndex((p) => p.pageIndex === pageIndex);
  if (idx >= 0) {
    pages[idx] = { ...pages[idx], ...patch, pageIndex };
  } else {
    pages.push({
      pageIndex,
      status: 'pending',
      message: '',
      error: null,
      ...patch,
    });
  }
  pages.sort((a, b) => a.pageIndex - b.pageIndex);
  return setProjectAvatarProgress(projectId, { pages });
}

/**
 * Read-only aggregation of GPU / long-running jobs for the current user.
 * Open-platform keys (userId open:*) are excluded from the normal task center.
 */
import type { Database } from 'better-sqlite3';
import {
  listAvatarJobsForUser,
  getAvatarQueuePosition,
  listRunningOrQueued as listAvatarPending,
} from './avatarProgress';
import {
  listComposeJobsForUser,
  getComposeQueuePosition,
  listComposeRunningOrQueued,
} from './composeProgress';
import { getDubbingProgress } from './dubbingProgress';
import { getProjectAvatarProgress } from './projectAvatarProgress';
import { isDuixGpuBusy } from './avatarWorker';
import { getVoiceboxGpuQueueStatus } from './voiceboxGpuQueue';
import type { VideoComposerService } from './videoComposer';
import type { ProjectService } from './projectService';

export type JobKind =
  | 'tts_dubbing'
  | 'transcribe'
  | 'dialogue'
  | 'avatar'
  | 'compose'
  | 'project_avatar'
  | 'video_compose'
  | 'mooc'
  | 'hyperframe'
  | 'explain';

export type UnifiedJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface UnifiedJob {
  id: string;
  kind: JobKind;
  title: string;
  status: UnifiedJobStatus;
  progress: number;
  message: string | null;
  queuePosition: number | null;
  createdAt: string;
  updatedAt: string;
  href?: string;
  cancellable: boolean;
}

export interface JobsSummary {
  activeCount: number;
  queuedCount: number;
  byKind: Partial<Record<JobKind, number>>;
  gpu: {
    voicebox: ReturnType<typeof getVoiceboxGpuQueueStatus>;
    duixBusy: boolean;
    avatarPending: number;
    composePending: number;
  };
}

function mapDbStatus(s: string): UnifiedJobStatus {
  if (s === 'queued' || s === 'running' || s === 'completed' || s === 'failed' || s === 'cancelled') {
    return s;
  }
  if (s === 'success' || s === 'review') return s === 'review' ? 'running' : 'completed';
  return 'failed';
}

function isActiveStatus(s: UnifiedJobStatus) {
  return s === 'queued' || s === 'running';
}

function queuePosAmong(
  rows: { id: string; status: string; created_at: string }[],
  id: string,
): number | null {
  const queued = rows
    .filter((r) => r.status === 'queued')
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const idx = queued.findIndex((r) => r.id === id);
  return idx >= 0 ? idx + 1 : null;
}

export interface JobRegistryDeps {
  db: Database;
  projectService: ProjectService;
  videoComposer: VideoComposerService;
}

export class JobRegistry {
  constructor(private deps: JobRegistryDeps) {}

  listForUser(
    userId: string,
    opts: { status?: string; limit?: number } = {},
  ): UnifiedJob[] {
    const limit = Math.min(Math.max(opts.limit || 80, 1), 200);
    const filterStatus = opts.status?.trim() || '';
    const items: UnifiedJob[] = [];

    items.push(...this.fromTranscribe(userId));
    items.push(...this.fromMooc(userId));
    items.push(...this.fromHyperframe(userId));
    items.push(...this.fromDialogue(userId));
    items.push(...this.fromAvatar(userId));
    items.push(...this.fromCompose(userId));
    items.push(...this.fromExplain(userId));
    items.push(...this.fromProjectDubbing(userId));
    items.push(...this.fromProjectAvatar(userId));
    items.push(...this.fromVideoCompose(userId));

    let filtered = items;
    if (filterStatus === 'active') {
      filtered = items.filter((j) => isActiveStatus(j.status));
    } else if (filterStatus) {
      filtered = items.filter((j) => j.status === filterStatus);
    } else {
      // Default: all active + recent terminal (keep completed/failed/cancelled within list)
      const active = items.filter((j) => isActiveStatus(j.status));
      const terminal = items
        .filter((j) => !isActiveStatus(j.status))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, 30);
      filtered = [...active, ...terminal];
    }

    filtered.sort((a, b) => {
      const aActive = isActiveStatus(a.status) ? 0 : 1;
      const bActive = isActiveStatus(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });

    return filtered.slice(0, limit);
  }

  summaryForUser(userId: string): JobsSummary {
    const jobs = this.listForUser(userId, { status: 'active', limit: 200 });
    const byKind: Partial<Record<JobKind, number>> = {};
    let queuedCount = 0;
    let activeCount = 0;
    for (const j of jobs) {
      byKind[j.kind] = (byKind[j.kind] || 0) + 1;
      if (j.status === 'queued') queuedCount += 1;
      if (isActiveStatus(j.status)) activeCount += 1;
    }
    return {
      activeCount,
      queuedCount,
      byKind,
      gpu: {
        voicebox: getVoiceboxGpuQueueStatus(),
        duixBusy: isDuixGpuBusy(),
        avatarPending: listAvatarPending().length,
        composePending: listComposeRunningOrQueued().length,
      },
    };
  }

  private fromTranscribe(userId: string): UnifiedJob[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, file_name, status, progress, message, created_at, updated_at
         FROM transcribe_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 40`,
      )
      .all(userId) as Array<{
      id: string;
      file_name: string;
      status: string;
      progress: number;
      message: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const allQueued = this.deps.db
      .prepare(`SELECT id, status, created_at FROM transcribe_jobs WHERE status IN ('queued','running')`)
      .all() as Array<{ id: string; status: string; created_at: string }>;

    return rows.map((r) => {
      const status = mapDbStatus(r.status);
      return {
        id: r.id,
        kind: 'transcribe' as const,
        title: `转写 · ${r.file_name || r.id.slice(0, 8)}`,
        status,
        progress: Number(r.progress) || 0,
        message: r.message,
        queuePosition: status === 'queued' ? queuePosAmong(allQueued, r.id) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        href: '/transcribe',
        cancellable: false,
      };
    });
  }

  private fromMooc(userId: string): UnifiedJob[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, name, status, progress, message, created_at, updated_at
         FROM mooc_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 40`,
      )
      .all(userId) as Array<{
      id: string;
      name: string;
      status: string;
      progress: number;
      message: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const allQueued = this.deps.db
      .prepare(`SELECT id, status, created_at FROM mooc_jobs WHERE status IN ('queued','running')`)
      .all() as Array<{ id: string; status: string; created_at: string }>;

    return rows.map((r) => {
      const status = mapDbStatus(r.status);
      return {
        id: r.id,
        kind: 'mooc' as const,
        title: `慕课 · ${r.name || r.id.slice(0, 8)}`,
        status,
        progress: Number(r.progress) || 0,
        message: r.message,
        queuePosition: status === 'queued' ? queuePosAmong(allQueued, r.id) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        href: '/mooc',
        cancellable: status === 'queued' || status === 'running',
      };
    });
  }

  private fromHyperframe(userId: string): UnifiedJob[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, name, status, progress, message, created_at, updated_at
         FROM hyperframe_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 40`,
      )
      .all(userId) as Array<{
      id: string;
      name: string;
      status: string;
      progress: number;
      message: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const allQueued = this.deps.db
      .prepare(`SELECT id, status, created_at FROM hyperframe_jobs WHERE status IN ('queued','running')`)
      .all() as Array<{ id: string; status: string; created_at: string }>;

    return rows.map((r) => {
      const status = mapDbStatus(r.status);
      return {
        id: r.id,
        kind: 'hyperframe' as const,
        title: `HyperFrame · ${r.name || r.id.slice(0, 8)}`,
        status,
        progress: Number(r.progress) || 0,
        message: r.message,
        queuePosition: status === 'queued' ? queuePosAmong(allQueued, r.id) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        href: '/hyperframe',
        cancellable: false,
      };
    });
  }

  private fromDialogue(userId: string): UnifiedJob[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, name, status, progress, message, created_at, updated_at
         FROM dialogue_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 40`,
      )
      .all(userId) as Array<{
      id: string;
      name: string;
      status: string;
      progress: number;
      message: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const allQueued = this.deps.db
      .prepare(`SELECT id, status, created_at FROM dialogue_jobs WHERE status IN ('queued','running')`)
      .all() as Array<{ id: string; status: string; created_at: string }>;

    return rows.map((r) => {
      const status = mapDbStatus(r.status);
      return {
        id: r.id,
        kind: 'dialogue' as const,
        title: `对话 · ${r.name || r.id.slice(0, 8)}`,
        status,
        progress: Number(r.progress) || 0,
        message: r.message,
        queuePosition: status === 'queued' ? queuePosAmong(allQueued, r.id) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        href: '/voice-factory',
        cancellable: status === 'queued' || status === 'running',
      };
    });
  }

  private fromExplain(userId: string): UnifiedJob[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, name, status, progress, message, created_at, updated_at
         FROM explain_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 40`,
      )
      .all(userId) as Array<{
      id: string;
      name: string;
      status: string;
      progress: number;
      message: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const allQueued = this.deps.db
      .prepare(`SELECT id, status, created_at FROM explain_jobs WHERE status IN ('queued','running')`)
      .all() as Array<{ id: string; status: string; created_at: string }>;

    return rows.map((r) => {
      let status = mapDbStatus(r.status);
      if (r.status === 'await_style' || r.status === 'await_sample') status = 'running';
      return {
        id: r.id,
        kind: 'explain' as const,
        title: `讲解动画 · ${r.name || r.id.slice(0, 8)}`,
        status,
        progress: Number(r.progress) || 0,
        message: r.message,
        queuePosition: r.status === 'queued' ? queuePosAmong(allQueued, r.id) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        href: '/explain',
        cancellable: ['queued', 'running', 'await_style', 'await_sample'].includes(r.status),
      };
    });
  }

  private fromAvatar(userId: string): UnifiedJob[] {
    return listAvatarJobsForUser(userId, 40).map((j) => {
      const status = mapDbStatus(j.status);
      return {
        id: j.id,
        kind: 'avatar' as const,
        title: `数字人 · ${j.driveMode === 'video' ? '视频驱动' : '静照口型'} · ${j.id.slice(0, 8)}`,
        status,
        progress: Number(j.progress) || 0,
        message: j.message,
        queuePosition: status === 'queued' ? getAvatarQueuePosition(j.id) : null,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        href: '/avatar',
        cancellable: status === 'queued' || status === 'running',
      };
    });
  }

  private fromCompose(userId: string): UnifiedJob[] {
    return listComposeJobsForUser(userId, 40).map((j) => {
      const status = mapDbStatus(j.status);
      return {
        id: j.id,
        kind: 'compose' as const,
        title: '绿幕叠底导出',
        status,
        progress: Number(j.progress) || 0,
        message: j.message,
        queuePosition: status === 'queued' ? getComposeQueuePosition(j.id) : null,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        href: '/avatar/compose',
        cancellable: status === 'queued' || status === 'running',
      };
    });
  }

  private fromProjectDubbing(userId: string): UnifiedJob[] {
    const projects = this.deps.projectService.listProjects(userId) as Array<{
      id: string;
      name: string;
      updated_at?: string;
      created_at?: string;
    }>;
    const out: UnifiedJob[] = [];
    for (const p of projects) {
      const prog = getDubbingProgress(p.id);
      if (!prog || prog.status !== 'running') continue;
      const pct =
        prog.totalToGenerate > 0
          ? Math.round((prog.completedCount / prog.totalToGenerate) * 100)
          : 0;
      out.push({
        id: `dubbing:${p.id}`,
        kind: 'tts_dubbing',
        title: `配音 · ${p.name || p.id.slice(0, 8)}`,
        status: 'running',
        progress: pct,
        message: prog.message || prog.stage,
        queuePosition: null,
        createdAt: prog.startedAt || prog.updatedAt,
        updatedAt: prog.updatedAt,
        href: `/project/${p.id}/dubbing`,
        cancellable: true,
      });
    }
    return out;
  }

  private fromProjectAvatar(userId: string): UnifiedJob[] {
    const projects = this.deps.projectService.listProjects(userId) as Array<{
      id: string;
      name: string;
    }>;
    const out: UnifiedJob[] = [];
    for (const p of projects) {
      const prog = getProjectAvatarProgress(p.id);
      if (prog.status !== 'running') continue;
      out.push({
        id: `project_avatar:${p.id}`,
        kind: 'project_avatar',
        title: `项目数字人 · ${p.name || p.id.slice(0, 8)}`,
        status: 'running',
        progress: Number(prog.percent) || 0,
        message: prog.message,
        queuePosition: null,
        createdAt: prog.updatedAt,
        updatedAt: prog.updatedAt,
        href: `/project/${p.id}/avatar`,
        cancellable: true,
      });
    }
    return out;
  }

  private fromVideoCompose(userId: string): UnifiedJob[] {
    const projects = this.deps.projectService.listProjects(userId) as Array<{
      id: string;
      name: string;
      video_status?: string;
      updated_at?: string;
      created_at?: string;
    }>;
    const out: UnifiedJob[] = [];
    for (const p of projects) {
      if (p.video_status !== 'generating') continue;
      const prog = this.deps.videoComposer.getProgress(p.id);
      const pct =
        prog && prog.totalPages > 0
          ? Math.round((prog.currentPage / prog.totalPages) * 100)
          : 5;
      out.push({
        id: `video:${p.id}`,
        kind: 'video_compose',
        title: `视频合成 · ${p.name || p.id.slice(0, 8)}`,
        status: 'running',
        progress: Math.min(99, Math.max(0, pct)),
        message: prog?.stage || '合成中…',
        queuePosition: null,
        createdAt: p.created_at || p.updated_at || new Date().toISOString(),
        updatedAt: prog?.updatedAt || p.updated_at || new Date().toISOString(),
        href: `/project/${p.id}/preview`,
        cancellable: false,
      });
    }
    return out;
  }
}

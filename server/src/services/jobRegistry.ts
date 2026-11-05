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
import {
  getExplainExportQueuePosition,
  listExplainExportJobsForUser,
} from './explainExportQueue';
import type { VoiceTtsJobService } from './voiceTtsJobService';

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
  | 'explain'
  | 'explain_export'
  | 'voice_tts';

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
  /** When the worker actually started (falls back to createdAt when unknown). */
  startedAt?: string | null;
  /** When the job reached a terminal state. */
  finishedAt?: string | null;
  /** Elapsed ms: finishedAt-startedAt, or now-startedAt while active. */
  durationMs?: number | null;
  href?: string;
  cancellable: boolean;
}

function withTiming(job: Omit<UnifiedJob, 'durationMs'> & { durationMs?: number | null }): UnifiedJob {
  const startedAt = job.startedAt || job.createdAt || null;
  const finishedAt = job.finishedAt || (
    job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
      ? job.updatedAt
      : null
  );
  let durationMs = job.durationMs ?? null;
  if (durationMs == null && startedAt) {
    const start = Date.parse(startedAt);
    const end = finishedAt ? Date.parse(finishedAt) : Date.now();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durationMs = end - start;
    }
  }
  return { ...job, startedAt, finishedAt, durationMs };
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
  voiceTtsJobs?: VoiceTtsJobService;
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
    items.push(...this.fromVoiceTts(userId));
    items.push(...this.fromAvatar(userId));
    items.push(...this.fromCompose(userId));
    items.push(...this.fromExplain(userId));
    items.push(...this.fromExplainExport(userId));
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

    return filtered.slice(0, limit).map((j) => withTiming(j));
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

  private fromVoiceTts(userId: string): UnifiedJob[] {
    const rows = this.deps.voiceTtsJobs?.listForUser(userId, 40)
      || (this.deps.db.prepare(
        `SELECT * FROM voice_tts_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 40`,
      ).all(userId) as Array<{
        id: string;
        text: string;
        voice_name: string | null;
        model_name: string | null;
        duration: number | null;
        status: string;
        error: string | null;
        created_at: string;
        updated_at: string;
        finished_at: string | null;
      }>);

    const allQueued = this.deps.db
      .prepare(`SELECT id, status, created_at FROM voice_tts_jobs WHERE status IN ('queued','running')`)
      .all() as Array<{ id: string; status: string; created_at: string }>;

    return rows.map((r: any) => {
      const status = mapDbStatus(r.status);
      const voice = r.voice_name || r.voiceName || '音色';
      const preview = String(r.text || '').replace(/\s+/g, ' ').slice(0, 24);
      const dur = r.duration != null ? `${Number(r.duration).toFixed(1)}s` : null;
      return {
        id: r.id,
        kind: 'voice_tts' as const,
        title: `造声 · ${voice}${preview ? ` · ${preview}${preview.length >= 24 ? '…' : ''}` : ''}`,
        status,
        progress: status === 'completed' ? 100 : status === 'running' ? 50 : status === 'queued' ? 5 : 100,
        message: status === 'completed'
          ? (dur ? `已完成 · ${dur}` : '已完成')
          : status === 'failed' ? (r.error || '生成失败')
            : status === 'running' ? 'Voicebox 合成中…'
              : '排队中',
        queuePosition: status === 'queued' ? queuePosAmong(allQueued, r.id) : null,
        createdAt: r.created_at || r.createdAt,
        updatedAt: r.updated_at || r.updatedAt,
        startedAt: r.created_at || r.createdAt,
        finishedAt: r.finished_at || r.finishedAt || null,
        href: '/voice-factory',
        cancellable: status === 'queued' || status === 'running',
      };
    });
  }

  private fromExplain(userId: string): UnifiedJob[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, name, status, progress, message, created_at, updated_at, started_at, finished_at, config_json
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
      started_at: string | null;
      finished_at: string | null;
      config_json: string;
    }>;
    const allQueued = this.deps.db
      .prepare(`SELECT id, status, created_at FROM explain_jobs WHERE status IN ('queued','running')`)
      .all() as Array<{ id: string; status: string; created_at: string }>;

    return rows.map((r) => {
      let status = mapDbStatus(r.status);
      if (r.status === 'await_style' || r.status === 'await_sample') status = 'running';
      // Export progress belongs to explain_export cards — don't duplicate on parent
      let message = r.message;
      if (status === 'completed' && message && /导出|MP4/i.test(message)) {
        message = '讲解动画已完成';
      }
      return {
        id: r.id,
        kind: 'explain' as const,
        title: `讲解动画 · ${r.name || r.id.slice(0, 8)}`,
        status,
        progress: Number(r.progress) || 0,
        message,
        queuePosition: r.status === 'queued' ? queuePosAmong(allQueued, r.id) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        href: '/explain',
        cancellable: ['queued', 'running', 'await_style', 'await_sample'].includes(r.status),
      };
    });
  }

  private fromExplainExport(userId: string): UnifiedJob[] {
    const fromMem = listExplainExportJobsForUser(userId, 40).map((j) => {
      const status = mapDbStatus(j.status);
      return {
        id: j.id,
        kind: 'explain_export' as const,
        title: `讲解导出 · ${j.title} · ${j.quality}`,
        status,
        progress: Number(j.progress) || 0,
        message: j.message,
        queuePosition: status === 'queued' ? getExplainExportQueuePosition(j.id) : null,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        href: '/explain',
        cancellable: status === 'queued' || status === 'running',
      };
    });
    const memExplainIds = new Set(
      listExplainExportJobsForUser(userId, 200).map((j) => j.explainJobId),
    );

    // Persist recent exports from explain_jobs.config_json (survives restarts)
    const rows = this.deps.db
      .prepare(
        `SELECT id, name, config_json, created_at, updated_at
         FROM explain_jobs WHERE user_id = ? ORDER BY updated_at DESC LIMIT 40`,
      )
      .all(userId) as Array<{
      id: string;
      name: string;
      config_json: string;
      created_at: string;
      updated_at: string;
    }>;

    const fromDb: UnifiedJob[] = [];
    for (const r of rows) {
      if (memExplainIds.has(r.id)) continue;
      let exp: any = null;
      try { exp = JSON.parse(r.config_json || '{}')?.export; } catch { /* ignore */ }
      if (!exp || !exp.status) continue;
      const raw = String(exp.status);
      const status: UnifiedJobStatus =
        raw === 'done' || raw === 'completed' ? 'completed'
          : raw === 'queued' ? 'queued'
            : raw === 'running' ? 'running'
              : raw === 'cancelled' ? 'cancelled'
                : 'failed';
      // Skip ancient completed/failed if no timestamps (noise)
      if (!isActiveStatus(status) && !exp.finishedAt && !exp.startedAt) continue;
      const quality = exp.quality || '1080p';
      fromDb.push({
        id: exp.exportJobId || `explain-export:${r.id}`,
        kind: 'explain_export',
        title: `讲解导出 · ${r.name || r.id.slice(0, 8)} · ${quality}`,
        status,
        progress: Number(exp.progress) || (status === 'completed' ? 100 : status === 'running' ? 5 : 0),
        message:
          status === 'queued' ? `MP4 导出排队中（${quality}）`
            : status === 'running' ? (exp.message || `正在导出 ${quality} MP4…`)
              : status === 'completed' ? `MP4 已导出（${quality}）`
                : status === 'cancelled' ? 'MP4 导出已取消'
                  : (exp.error || 'MP4 导出失败'),
        queuePosition: null,
        createdAt: exp.startedAt || r.updated_at || r.created_at,
        updatedAt: exp.finishedAt || r.updated_at,
        startedAt: exp.startedAt || null,
        finishedAt: exp.finishedAt || null,
        href: '/explain',
        cancellable: false,
      });
    }

    return [...fromMem, ...fromDb];
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

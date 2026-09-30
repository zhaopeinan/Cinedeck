import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
export const HYPERFRAME_UPLOAD_DIR = path.join(DATA_DIR, 'hyperframe-uploads');
export const HYPERFRAME_COMPOSE_DIR = path.join(DATA_DIR, 'hyperframe-compositions');

fs.mkdirSync(HYPERFRAME_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(HYPERFRAME_COMPOSE_DIR, { recursive: true });

export type HfStatus = 'queued' | 'running' | 'review' | 'success' | 'failed' | 'cancelled';
export type HfStage =
  | 'queued'
  | 'creating'
  | 'parsing'
  | 'analyzing'
  | 'review'
  | 'dubbing'
  | 'composing'
  | 'exporting'
  | 'done'
  | 'failed';
export type HfCheckpoint = 'none' | 'created' | 'parsed' | 'scripted' | 'dubbed' | 'composed';

export interface HfPageScript {
  pageIndex: number;
  note: string;
  analysis: string;
  lecture: string;
  durationSec?: number;
  audioPath?: string | null;
}

/** Accept camelCase / snake_case from API body or legacy DB rows. */
export function normalizeHfPageScript(raw: any): HfPageScript {
  const pageIndex = Number(raw?.pageIndex ?? raw?.page_index);
  return {
    pageIndex: Number.isFinite(pageIndex) ? pageIndex : 0,
    note: String(raw?.note ?? ''),
    analysis: String(raw?.analysis ?? ''),
    lecture: String(raw?.lecture ?? ''),
    durationSec: (() => {
      const n = Number(raw?.durationSec ?? raw?.duration_sec);
      return Number.isFinite(n) ? n : undefined;
    })(),
    audioPath: (raw?.audioPath ?? raw?.audio_path ?? null) as string | null,
  };
}

export function normalizeHfPageScripts(raw: any): HfPageScript[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeHfPageScript).filter((s) => s.pageIndex > 0);
}

export interface HfJobConfig {
  selectedVoiceId?: string | null;
  selectedModelId?: string | null;
  useExistingNote?: boolean;
  targetDurationMin?: number;
  /** Pages to dub + compose; empty/undefined = all scripts */
  selectedPageIndexes?: number[];
}

export interface HyperframeJobRow {
  id: string;
  user_id: string;
  project_id: string | null;
  name: string;
  file_name: string;
  file_path: string;
  status: HfStatus;
  stage: HfStage;
  progress: number;
  message: string | null;
  error: string | null;
  config_json: string;
  scripts_json: string | null;
  composition_dir: string | null;
  video_path: string | null;
  checkpoint: HfCheckpoint;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const HF_STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  creating: '创建项目',
  parsing: '解析 PPT',
  analyzing: '多模态生成讲义',
  review: '确认讲义',
  dubbing: 'Voicebox 配音',
  composing: '生成 HyperFrames',
  exporting: '导出视频',
  done: '已完成',
  failed: '失败',
};

export function publicHyperframeJob(row: HyperframeJobRow) {
  let scripts: HfPageScript[] = [];
  let config: HfJobConfig = {};
  try { scripts = normalizeHfPageScripts(JSON.parse(row.scripts_json || '[]')); } catch { /* ignore */ }
  try { config = JSON.parse(row.config_json || '{}'); } catch { /* ignore */ }
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    fileName: row.file_name,
    status: row.status,
    stage: row.stage,
    stageLabel: HF_STAGE_LABEL[row.stage] || row.stage,
    progress: row.progress,
    message: row.message,
    error: row.error,
    config,
    scripts,
    compositionDir: row.composition_dir,
    videoPath: row.video_path,
    videoUrl: row.video_path && row.id
      ? `/data/hyperframe-compositions/${row.id}/lecture.mp4`
      : null,
    checkpoint: row.checkpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class HyperframeJobService {
  constructor(private db: Database.Database) {}

  createJob(input: {
    id?: string;
    userId: string;
    name: string;
    fileName: string;
    filePath: string;
    config?: HfJobConfig;
  }): HyperframeJobRow {
    const now = new Date().toISOString();
    const id = input.id || uuidv4();
    const row: HyperframeJobRow = {
      id,
      user_id: input.userId,
      project_id: null,
      name: input.name,
      file_name: input.fileName,
      file_path: input.filePath,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: '排队等待中',
      error: null,
      config_json: JSON.stringify(input.config || { useExistingNote: true }),
      scripts_json: null,
      composition_dir: null,
      video_path: null,
      checkpoint: 'none',
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    };
    this.db.prepare(`
      INSERT INTO hyperframe_jobs (
        id, user_id, project_id, name, file_name, file_path,
        status, stage, progress, message, error, config_json, scripts_json,
        composition_dir, video_path, checkpoint,
        created_at, updated_at, started_at, finished_at
      ) VALUES (
        @id, @user_id, @project_id, @name, @file_name, @file_path,
        @status, @stage, @progress, @message, @error, @config_json, @scripts_json,
        @composition_dir, @video_path, @checkpoint,
        @created_at, @updated_at, @started_at, @finished_at
      )
    `).run(row);
    return row;
  }

  getJob(id: string): HyperframeJobRow | null {
    return (this.db.prepare('SELECT * FROM hyperframe_jobs WHERE id = ?').get(id) as HyperframeJobRow | undefined) || null;
  }

  listJobs(userId: string, isAdmin = false, limit = 50): HyperframeJobRow[] {
    if (isAdmin) {
      return this.db.prepare('SELECT * FROM hyperframe_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as HyperframeJobRow[];
    }
    return this.db.prepare(
      'SELECT * FROM hyperframe_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as HyperframeJobRow[];
  }

  parseConfig(job: HyperframeJobRow): HfJobConfig {
    try {
      const raw = JSON.parse(job.config_json || '{}') || {};
      const pages = raw.selectedPageIndexes ?? raw.selected_page_indexes;
      return {
        selectedVoiceId: raw.selectedVoiceId ?? raw.selected_voice_id ?? null,
        selectedModelId: raw.selectedModelId ?? raw.selected_model_id ?? null,
        useExistingNote: raw.useExistingNote ?? raw.use_existing_note,
        targetDurationMin: raw.targetDurationMin ?? raw.target_duration_min,
        selectedPageIndexes: Array.isArray(pages)
          ? pages.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
          : undefined,
      };
    } catch {
      return {};
    }
  }

  parseScripts(job: HyperframeJobRow): HfPageScript[] {
    try {
      return normalizeHfPageScripts(JSON.parse(job.scripts_json || '[]'));
    } catch {
      return [];
    }
  }

  updateJob(id: string, patch: Partial<HyperframeJobRow>): HyperframeJobRow | null {
    const allowed = [
      'project_id', 'status', 'stage', 'progress', 'message', 'error',
      'config_json', 'scripts_json', 'composition_dir', 'video_path', 'checkpoint',
      'started_at', 'finished_at',
    ] as const;
    const sets: string[] = [];
    const values: any[] = [];
    for (const key of allowed) {
      if ((patch as any)[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push((patch as any)[key]);
      }
    }
    if (!sets.length) return this.getJob(id);
    sets.push('updated_at = ?');
    values.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE hyperframe_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  claimNextQueued(): HyperframeJobRow | null {
    const row = this.db.prepare(
      `SELECT * FROM hyperframe_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    ).get() as HyperframeJobRow | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE hyperframe_jobs
      SET status = 'running', progress = CASE WHEN progress < 1 THEN 1 ELSE progress END,
          message = '任务开始', started_at = COALESCE(started_at, ?), updated_at = ?,
          error = NULL, finished_at = NULL
      WHERE id = ? AND status = 'queued'
    `).run(now, now, row.id);
    if (result.changes === 0) return null;
    return this.getJob(row.id);
  }

  hasRunning(): boolean {
    return !!this.db.prepare(`SELECT id FROM hyperframe_jobs WHERE status = 'running' LIMIT 1`).get();
  }

  markReview(id: string, scripts: HfPageScript[], message = '讲义已生成，请确认后选择音色生成动画') {
    const normalized = normalizeHfPageScripts(scripts);
    return this.updateJob(id, {
      status: 'review',
      stage: 'review',
      progress: 55,
      checkpoint: 'scripted',
      scripts_json: JSON.stringify(normalized),
      message,
      finished_at: null,
    });
  }

  queueProduce(id: string, userId: string, config: HfJobConfig): HyperframeJobRow | null {
    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return null;
    if (job.status !== 'review' && job.status !== 'failed' && job.status !== 'success') return null;
    if (!job.scripts_json) return null;
    const allScripts = this.parseScripts(job);
    if (!allScripts.length) return null;

    const rawSelected = Array.isArray(config.selectedPageIndexes)
      ? config.selectedPageIndexes.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    const selectedPageIndexes = rawSelected.length
      ? [...new Set(rawSelected)].sort((a, b) => a - b)
      : allScripts.map((s) => s.pageIndex);
    if (!selectedPageIndexes.length) return null;
    const selectedSet = new Set(selectedPageIndexes);
    if (!allScripts.some((s) => selectedSet.has(s.pageIndex))) return null;

    // Drop stale audio only for pages that will be re-produced
    const scripts = allScripts.map((s) => (
      selectedSet.has(s.pageIndex) ? { ...s, audioPath: null } : s
    ));
    const merged = {
      ...this.parseConfig(job),
      ...config,
      selectedPageIndexes,
    };
    return this.updateJob(id, {
      status: 'queued',
      stage: 'queued',
      checkpoint: 'scripted',
      config_json: JSON.stringify(merged),
      scripts_json: JSON.stringify(scripts),
      message: `讲义已确认，将生成 ${selectedPageIndexes.length} 页动画`,
      error: null,
      finished_at: null,
    });
  }

  saveScripts(id: string, userId: string, scripts: HfPageScript[]): HyperframeJobRow | null {
    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return null;
    if (job.status !== 'review' && job.status !== 'failed') return null;
    const normalized = normalizeHfPageScripts(scripts);
    if (!normalized.length) return null;
    return this.updateJob(id, {
      scripts_json: JSON.stringify(normalized),
      message: '讲义已更新',
      updated_at: new Date().toISOString(),
    } as any);
  }

  deleteJob(id: string): HyperframeJobRow | null {
    const row = this.getJob(id);
    if (!row) return null;
    this.db.prepare('DELETE FROM hyperframe_jobs WHERE id = ?').run(id);
    return row;
  }

  recoverStaleRunning(message = '服务重启，任务中断。可重新确认讲义或重试') {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE hyperframe_jobs
      SET status = CASE WHEN checkpoint IN ('scripted','dubbed','composed') THEN 'review' ELSE 'failed' END,
          stage = CASE WHEN checkpoint IN ('scripted','dubbed','composed') THEN 'review' ELSE stage END,
          message = ?, error = ?, finished_at = ?, updated_at = ?
      WHERE status = 'running'
    `).run(message, message, now, now);
  }

  /** Requeue/fail jobs stuck in running with no heartbeat (alive process, hung step). */
  recoverHungRunning(maxIdleMs = 20 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxIdleMs).toISOString();
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE hyperframe_jobs
      SET status = CASE WHEN checkpoint IN ('scripted','dubbed','composed') THEN 'review' ELSE 'failed' END,
          stage = CASE WHEN checkpoint IN ('scripted','dubbed','composed') THEN 'review' ELSE 'failed' END,
          message = ?, error = ?, finished_at = NULL, updated_at = ?
      WHERE status = 'running' AND updated_at < ?
    `).run(
      '任务长时间无进度，已中断。可重新确认讲义或重试',
      `超过 ${Math.round(maxIdleMs / 60000)} 分钟无进度更新`,
      now,
      cutoff,
    );
    return result.changes;
  }

}

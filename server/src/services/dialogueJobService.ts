import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
export const DIALOGUE_JOBS_DIR = path.join(DATA_DIR, 'dialogue-jobs');

export type DialogueJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type DialogueJobStage = 'queued' | 'synthesizing' | 'concat' | 'done' | 'failed';

export interface DialogueJobRow {
  id: string;
  user_id: string;
  name: string;
  status: DialogueJobStatus;
  stage: DialogueJobStage;
  progress: number;
  message: string | null;
  error: string | null;
  script_text: string;
  cast_json: string;
  model_id: string;
  language: string;
  instruct: string | null;
  gap_ms: number;
  max_chunk_chars: number;
  segment_count: number;
  completed_segments: number;
  duration_sec: number | null;
  output_path: string | null;
  work_dir: string | null;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

fs.mkdirSync(DIALOGUE_JOBS_DIR, { recursive: true });

export class DialogueJobService {
  constructor(private db: Database.Database) {}

  createJob(input: {
    userId: string;
    name?: string;
    scriptText: string;
    cast: Record<string, string>;
    modelId: string;
    language?: string;
    instruct?: string | null;
    gapMs?: number;
    maxChunkChars?: number;
    segmentCount: number;
  }): DialogueJobRow {
    const id = uuidv4();
    const now = new Date().toISOString();
    const workDir = path.join(DIALOGUE_JOBS_DIR, id);
    fs.mkdirSync(workDir, { recursive: true });
    const name = (input.name || '').trim() || `多人对话 ${now.slice(0, 16).replace('T', ' ')}`;
    const gapMs = Math.min(2000, Math.max(0, Math.round(
      Number.isFinite(Number(input.gapMs)) ? Number(input.gapMs) : 600,
    )));
    const maxChunkChars = Math.min(5000, Math.max(100, Math.round(
      Number.isFinite(Number(input.maxChunkChars)) ? Number(input.maxChunkChars) : 150,
    )));

    this.db.prepare(`
      INSERT INTO dialogue_jobs (
        id, user_id, name, status, stage, progress, message, error,
        script_text, cast_json, model_id, language, instruct, gap_ms, max_chunk_chars,
        segment_count, completed_segments, duration_sec, output_path, work_dir,
        cancel_requested, created_at, updated_at, started_at, finished_at
      ) VALUES (
        ?, ?, ?, 'queued', 'queued', 0, '排队等待中', NULL,
        ?, ?, ?, ?, ?, ?, ?,
        ?, 0, NULL, NULL, ?,
        0, ?, ?, NULL, NULL
      )
    `).run(
      id,
      input.userId,
      name,
      input.scriptText,
      JSON.stringify(input.cast || {}),
      input.modelId,
      input.language || 'zh-CN',
      input.instruct || null,
      gapMs,
      maxChunkChars,
      input.segmentCount,
      workDir,
      now,
      now,
    );

    return this.getJob(id)!;
  }

  getJob(id: string): DialogueJobRow | null {
    return (this.db.prepare('SELECT * FROM dialogue_jobs WHERE id = ?').get(id) as DialogueJobRow | undefined) || null;
  }

  getOwned(id: string, userId: string): DialogueJobRow | null {
    const row = this.getJob(id);
    if (!row || row.user_id !== userId) return null;
    return row;
  }

  listJobs(userId: string, limit = 50): DialogueJobRow[] {
    return this.db.prepare(
      'SELECT * FROM dialogue_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as DialogueJobRow[];
  }

  parseCast(job: DialogueJobRow): Record<string, string> {
    try {
      const obj = JSON.parse(job.cast_json || '{}');
      if (!obj || typeof obj !== 'object') return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      return out;
    } catch {
      return {};
    }
  }

  updateJob(id: string, patch: Partial<{
    status: DialogueJobStatus;
    stage: DialogueJobStage;
    progress: number;
    message: string | null;
    error: string | null;
    completed_segments: number;
    duration_sec: number | null;
    output_path: string | null;
    cancel_requested: number;
    started_at: string | null;
    finished_at: string | null;
  }>) {
    const allowed = [
      'status', 'stage', 'progress', 'message', 'error',
      'completed_segments', 'duration_sec', 'output_path',
      'cancel_requested', 'started_at', 'finished_at',
    ] as const;
    const sets: string[] = [];
    const values: any[] = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(patch[key]);
      }
    }
    if (!sets.length) return this.getJob(id);
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE dialogue_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  claimNextQueued(): DialogueJobRow | null {
    const row = this.db.prepare(
      `SELECT * FROM dialogue_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    ).get() as DialogueJobRow | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE dialogue_jobs
      SET status = 'running', stage = 'synthesizing', message = '开始合成…',
          started_at = COALESCE(started_at, ?), updated_at = ?, cancel_requested = 0
      WHERE id = ? AND status = 'queued'
    `).run(now, now, row.id);
    return this.getJob(row.id);
  }

  hasRunning(): boolean {
    return !!this.db.prepare(`SELECT id FROM dialogue_jobs WHERE status = 'running' LIMIT 1`).get();
  }

  isCancelRequested(id: string): boolean {
    const row = this.db.prepare('SELECT cancel_requested FROM dialogue_jobs WHERE id = ?').get(id) as
      | { cancel_requested: number } | undefined;
    return !!(row && Number(row.cancel_requested));
  }

  requestCancel(id: string, userId: string): DialogueJobRow | null {
    const job = this.getOwned(id, userId);
    if (!job) return null;
    if (job.status === 'queued') {
      return this.updateJob(id, {
        status: 'cancelled',
        stage: 'failed',
        message: '已取消（未开始）',
        finished_at: new Date().toISOString(),
        cancel_requested: 1,
      });
    }
    if (job.status === 'running') {
      return this.updateJob(id, {
        cancel_requested: 1,
        message: '正在请求取消…',
      });
    }
    return job;
  }

  recoverStaleRunning(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE dialogue_jobs
      SET status = 'failed', stage = 'failed',
          message = '服务重启，任务中断',
          error = '进程重启导致任务中断，请重新提交',
          finished_at = ?, updated_at = ?
      WHERE status = 'running'
    `).run(now, now);
  }

  deleteJob(id: string, userId: string): boolean {
    const job = this.getOwned(id, userId);
    if (!job) return false;
    if (job.status === 'running') return false;
    this.db.prepare('DELETE FROM dialogue_jobs WHERE id = ?').run(id);
    if (job.work_dir) {
      try { fs.rmSync(job.work_dir, { recursive: true, force: true }); } catch { /* ignore */ }
    } else if (job.output_path) {
      try { fs.unlinkSync(job.output_path); } catch { /* ignore */ }
    }
    return true;
  }

  publicRow(job: DialogueJobRow) {
    return {
      id: job.id,
      name: job.name,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: job.message,
      error: job.error,
      cast: this.parseCast(job),
      modelId: job.model_id,
      language: job.language,
      instruct: job.instruct,
      gapMs: job.gap_ms,
      maxChunkChars: job.max_chunk_chars,
      segmentCount: job.segment_count,
      completedSegments: job.completed_segments,
      durationSec: job.duration_sec,
      hasAudio: !!(job.output_path && fs.existsSync(job.output_path)),
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    };
  }
}

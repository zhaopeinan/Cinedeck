import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
export const TRANSCRIBE_UPLOAD_DIR = path.join(DATA_DIR, 'transcribe-uploads');

export type TranscribeStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type TranscribeStage = 'queued' | 'extracting' | 'transcribing' | 'done' | 'failed';

export interface TranscribeJobRow {
  id: string;
  user_id: string;
  file_name: string;
  file_path: string;
  audio_path: string | null;
  language: string | null;
  model: string;
  status: TranscribeStatus;
  stage: TranscribeStage;
  progress: number;
  message: string | null;
  error: string | null;
  text: string | null;
  duration_sec: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

fs.mkdirSync(TRANSCRIBE_UPLOAD_DIR, { recursive: true });

import { decodeUploadFilename } from '../utils/uploadFilename';
import { shouldSimplifyTranscript, toSimplifiedChinese } from '../utils/toSimplifiedChinese';

export function publicTranscribeJob(row: TranscribeJobRow) {
  const rawText = row.text || null;
  const text = rawText && shouldSimplifyTranscript(row.language)
    ? toSimplifiedChinese(rawText)
    : rawText;
  return {
    id: row.id,
    fileName: decodeUploadFilename(row.file_name),
    language: row.language,
    model: row.model,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    message: row.message,
    error: row.error,
    text,
    durationSec: row.duration_sec,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class TranscribeJobService {
  constructor(private db: Database.Database) {}

  createJob(input: {
    id?: string;
    userId: string;
    fileName: string;
    filePath: string;
    language?: string | null;
    model?: string;
  }): TranscribeJobRow {
    const now = new Date().toISOString();
    const id = input.id || uuidv4();
    const row: TranscribeJobRow = {
      id,
      user_id: input.userId,
      file_name: input.fileName,
      file_path: input.filePath,
      audio_path: null,
      language: input.language || null,
      model: input.model || 'base',
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: '排队中',
      error: null,
      text: null,
      duration_sec: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    };
    this.db.prepare(`
      INSERT INTO transcribe_jobs (
        id, user_id, file_name, file_path, audio_path, language, model,
        status, stage, progress, message, error, text, duration_sec,
        created_at, updated_at, started_at, finished_at
      ) VALUES (
        @id, @user_id, @file_name, @file_path, @audio_path, @language, @model,
        @status, @stage, @progress, @message, @error, @text, @duration_sec,
        @created_at, @updated_at, @started_at, @finished_at
      )
    `).run(row);
    return row;
  }

  get(id: string): TranscribeJobRow | null {
    return (this.db.prepare('SELECT * FROM transcribe_jobs WHERE id = ?').get(id) as TranscribeJobRow | undefined) || null;
  }

  listByUser(userId: string, isAdmin: boolean, limit = 50): TranscribeJobRow[] {
    if (isAdmin) {
      return this.db.prepare('SELECT * FROM transcribe_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as TranscribeJobRow[];
    }
    return this.db.prepare(
      'SELECT * FROM transcribe_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as TranscribeJobRow[];
  }

  nextQueued(): TranscribeJobRow | null {
    return (this.db.prepare(
      `SELECT * FROM transcribe_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    ).get() as TranscribeJobRow | undefined) || null;
  }

  hasRunning(): boolean {
    const row = this.db.prepare(
      `SELECT id FROM transcribe_jobs WHERE status = 'running' LIMIT 1`,
    ).get();
    return !!row;
  }

  /** After process restart, in-memory workers are gone — requeue orphaned running jobs. */
  recoverStaleRunning(message = '服务重启，任务中断，已重新排队'): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE transcribe_jobs
      SET status = 'queued', stage = 'queued',
          message = ?, error = NULL, finished_at = NULL, updated_at = ?
      WHERE status = 'running'
    `).run(message, now);
    return result.changes;
  }

  /**
   * Requeue jobs stuck in running with no progress heartbeat.
   * Covers hung Whisper calls where the process is alive but the worker loop is blocked.
   */
  recoverHungRunning(maxIdleMs = 12 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxIdleMs).toISOString();
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE transcribe_jobs
      SET status = 'queued', stage = 'queued',
          message = ?, error = ?, finished_at = NULL, updated_at = ?
      WHERE status = 'running' AND updated_at < ?
    `).run(
      '识别长时间无进度，已自动重新排队（将从断点续跑）',
      `超过 ${Math.round(maxIdleMs / 60000)} 分钟无进度更新`,
      now,
      cutoff,
    );
    return result.changes;
  }

  /** Force unlock a stuck running/queued job so the user can resume or delete. */
  forceRequeue(id: string, message = '已强制重新排队'): TranscribeJobRow | null {
    const row = this.get(id);
    if (!row) return null;
    if (row.status !== 'running' && row.status !== 'queued' && row.status !== 'failed' && row.status !== 'cancelled') {
      return null;
    }
    this.update(id, {
      status: 'queued',
      stage: 'queued',
      message,
      error: null,
      finished_at: null,
    });
    return this.get(id);
  }

  update(id: string, patch: Partial<TranscribeJobRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return;
    const nowPatch = { ...patch, updated_at: new Date().toISOString() };
    const allKeys = Object.keys(nowPatch);
    const set = allKeys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE transcribe_jobs SET ${set} WHERE id = @id`).run({ ...nowPatch, id });
  }

  delete(id: string): TranscribeJobRow | null {
    const row = this.get(id);
    if (!row) return null;
    this.db.prepare('DELETE FROM transcribe_jobs WHERE id = ?').run(id);
    return row;
  }
}

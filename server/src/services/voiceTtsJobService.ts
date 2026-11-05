/**
 * Persist造声工厂单人 TTS 生成记录（刷新后仍可见，并进入任务中心）。
 */
import type Database from 'better-sqlite3';

export type VoiceTtsStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface VoiceTtsJobRow {
  id: string;
  user_id: string;
  text: string;
  voice_id: string | null;
  voice_name: string | null;
  model_id: string | null;
  model_name: string | null;
  language: string | null;
  duration: number | null;
  status: VoiceTtsStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export class VoiceTtsJobService {
  constructor(private db: Database.Database) {}

  create(input: {
    id: string;
    userId: string;
    text: string;
    voiceId?: string | null;
    voiceName?: string | null;
    modelId?: string | null;
    modelName?: string | null;
    language?: string | null;
  }): VoiceTtsJobRow {
    const now = new Date().toISOString();
    const row: VoiceTtsJobRow = {
      id: input.id,
      user_id: input.userId,
      text: String(input.text || '').slice(0, 8000),
      voice_id: input.voiceId || null,
      voice_name: input.voiceName || null,
      model_id: input.modelId || null,
      model_name: input.modelName || null,
      language: input.language || null,
      duration: null,
      status: 'running',
      error: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO voice_tts_jobs (
        id, user_id, text, voice_id, voice_name, model_id, model_name, language,
        duration, status, error, created_at, updated_at, finished_at
      ) VALUES (
        @id, @user_id, @text, @voice_id, @voice_name, @model_id, @model_name, @language,
        @duration, @status, @error, @created_at, @updated_at, @finished_at
      )
    `).run(row);
    return row;
  }

  getOwned(id: string, userId: string): VoiceTtsJobRow | null {
    const row = this.db.prepare(
      `SELECT * FROM voice_tts_jobs WHERE id = ? AND user_id = ?`,
    ).get(id, userId) as VoiceTtsJobRow | undefined;
    return row || null;
  }

  get(id: string): VoiceTtsJobRow | null {
    const row = this.db.prepare(`SELECT * FROM voice_tts_jobs WHERE id = ?`).get(id) as VoiceTtsJobRow | undefined;
    return row || null;
  }

  updateStatus(
    id: string,
    patch: Partial<Pick<VoiceTtsJobRow, 'status' | 'duration' | 'error' | 'voice_name' | 'model_name' | 'text'>>,
  ): VoiceTtsJobRow | null {
    const cur = this.get(id);
    if (!cur) return null;
    const now = new Date().toISOString();
    const status = patch.status ?? cur.status;
    const finished =
      status === 'completed' || status === 'failed' || status === 'cancelled'
        ? (cur.finished_at || now)
        : null;
    this.db.prepare(`
      UPDATE voice_tts_jobs SET
        status = ?, duration = ?, error = ?, voice_name = ?, model_name = ?, text = ?,
        updated_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      status,
      patch.duration !== undefined ? patch.duration : cur.duration,
      patch.error !== undefined ? patch.error : cur.error,
      patch.voice_name !== undefined ? patch.voice_name : cur.voice_name,
      patch.model_name !== undefined ? patch.model_name : cur.model_name,
      patch.text !== undefined ? patch.text : cur.text,
      now,
      finished,
      id,
    );
    return this.get(id);
  }

  listForUser(userId: string, limit = 40): VoiceTtsJobRow[] {
    return this.db.prepare(
      `SELECT * FROM voice_tts_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(userId, Math.min(100, Math.max(1, limit))) as VoiceTtsJobRow[];
  }

  listActive(): VoiceTtsJobRow[] {
    return this.db.prepare(
      `SELECT * FROM voice_tts_jobs WHERE status IN ('queued','running') ORDER BY created_at ASC`,
    ).all() as VoiceTtsJobRow[];
  }

  /** Used when importing Voicebox history so sort order matches original time. */
  setTimestamps(id: string, createdAt: string, finishedAt?: string | null): void {
    const ts = createdAt || new Date().toISOString();
    this.db.prepare(
      `UPDATE voice_tts_jobs SET created_at = ?, updated_at = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`,
    ).run(ts, ts, finishedAt || ts, id);
  }

  publicRow(row: VoiceTtsJobRow) {
    return {
      id: row.id,
      text: row.text,
      voiceId: row.voice_id,
      voiceName: row.voice_name,
      modelId: row.model_id,
      modelName: row.model_name,
      language: row.language,
      duration: row.duration,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      hasAudio: row.status === 'completed',
    };
  }
}

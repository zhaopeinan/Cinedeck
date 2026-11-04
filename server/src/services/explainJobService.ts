import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
export const EXPLAIN_UPLOAD_DIR = path.join(DATA_DIR, 'explain-uploads');
export const EXPLAIN_WORK_DIR = path.join(DATA_DIR, 'explain-jobs');

fs.mkdirSync(EXPLAIN_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(EXPLAIN_WORK_DIR, { recursive: true });

export type ExplainStatus =
  | 'queued'
  | 'running'
  | 'await_style'
  | 'await_sample'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExplainStage =
  | 'queued'
  | 'extracting'
  | 'recommending'
  | 'await_style'
  | 'scripting'
  | 'generating_sample'
  | 'await_sample'
  | 'generating_final'
  | 'done'
  | 'failed';

export interface ExplainJobRow {
  id: string;
  user_id: string;
  name: string;
  source_type: 'text' | 'file';
  source_file_name: string | null;
  source_file_path: string | null;
  topic_text: string;
  status: ExplainStatus;
  stage: ExplainStage;
  progress: number;
  message: string | null;
  error: string | null;
  recommendations_json: string | null;
  selected_style_id: number | null;
  selected_variant: string | null;
  voiceover: 'none' | 'zh' | 'en';
  script_json: string | null;
  work_dir: string | null;
  sample_path: string | null;
  final_path: string | null;
  config_json: string;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const EXPLAIN_STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  extracting: '解析素材',
  recommending: '推荐风格',
  await_style: '等待选择风格',
  scripting: '撰写分镜',
  generating_sample: '生成样片',
  await_sample: '等待确认样片',
  generating_final: '生成全片',
  done: '已完成',
  failed: '失败',
};

export class ExplainJobService {
  constructor(private db: Database.Database) {}

  createJob(input: {
    userId: string;
    name: string;
    topicText?: string;
    sourceType?: 'text' | 'file';
    sourceFileName?: string | null;
    sourceFilePath?: string | null;
  }): ExplainJobRow {
    const id = uuidv4();
    const now = new Date().toISOString();
    const workDir = path.join(EXPLAIN_WORK_DIR, id);
    fs.mkdirSync(workDir, { recursive: true });
    const row: ExplainJobRow = {
      id,
      user_id: input.userId,
      name: input.name.slice(0, 120) || '讲解动画',
      source_type: input.sourceType || 'text',
      source_file_name: input.sourceFileName || null,
      source_file_path: input.sourceFilePath || null,
      topic_text: (input.topicText || '').trim(),
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: '已入队',
      error: null,
      recommendations_json: null,
      selected_style_id: null,
      selected_variant: null,
      voiceover: 'none',
      script_json: null,
      work_dir: workDir,
      sample_path: null,
      final_path: null,
      config_json: '{}',
      cancel_requested: 0,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    };
    this.db.prepare(`
      INSERT INTO explain_jobs (
        id, user_id, name, source_type, source_file_name, source_file_path, topic_text,
        status, stage, progress, message, error, recommendations_json,
        selected_style_id, selected_variant, voiceover, script_json, work_dir,
        sample_path, final_path, config_json, cancel_requested,
        created_at, updated_at, started_at, finished_at
      ) VALUES (
        @id, @user_id, @name, @source_type, @source_file_name, @source_file_path, @topic_text,
        @status, @stage, @progress, @message, @error, @recommendations_json,
        @selected_style_id, @selected_variant, @voiceover, @script_json, @work_dir,
        @sample_path, @final_path, @config_json, @cancel_requested,
        @created_at, @updated_at, @started_at, @finished_at
      )
    `).run(row);
    return row;
  }

  getJob(id: string): ExplainJobRow | null {
    return (this.db.prepare('SELECT * FROM explain_jobs WHERE id = ?').get(id) as ExplainJobRow | undefined) || null;
  }

  getOwned(id: string, userId: string): ExplainJobRow | null {
    const row = this.getJob(id);
    if (!row || row.user_id !== userId) return null;
    return row;
  }

  listJobs(userId: string, limit = 50): ExplainJobRow[] {
    return this.db.prepare(
      'SELECT * FROM explain_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as ExplainJobRow[];
  }

  updateJob(id: string, patch: Partial<ExplainJobRow>) {
    const allowed = [
      'name', 'topic_text', 'status', 'stage', 'progress', 'message', 'error',
      'recommendations_json', 'selected_style_id', 'selected_variant', 'voiceover',
      'script_json', 'work_dir', 'sample_path', 'final_path', 'config_json',
      'cancel_requested', 'started_at', 'finished_at',
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
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE explain_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  claimNextQueued(): ExplainJobRow | null {
    const row = this.db.prepare(
      `SELECT * FROM explain_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    ).get() as ExplainJobRow | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    const r = this.db.prepare(`
      UPDATE explain_jobs
      SET status = 'running', stage = 'extracting', progress = 5, message = '开始处理…',
          started_at = COALESCE(started_at, ?), updated_at = ?, error = NULL
      WHERE id = ? AND status = 'queued'
    `).run(now, now, row.id);
    if (r.changes === 0) return null;
    return this.getJob(row.id);
  }

  hasRunning(): boolean {
    return !!this.db.prepare(
      `SELECT id FROM explain_jobs WHERE status = 'running' LIMIT 1`,
    ).get();
  }

  isCancelRequested(id: string): boolean {
    const row = this.db.prepare('SELECT cancel_requested FROM explain_jobs WHERE id = ?').get(id) as
      | { cancel_requested: number } | undefined;
    return !!(row && Number(row.cancel_requested));
  }

  requestCancel(id: string, userId: string): ExplainJobRow | null {
    const job = this.getOwned(id, userId);
    if (!job) return null;
    if (job.status === 'queued' || job.status === 'await_style' || job.status === 'await_sample') {
      return this.updateJob(id, {
        status: 'cancelled',
        stage: 'failed',
        message: '已取消',
        cancel_requested: 1,
        finished_at: new Date().toISOString(),
        progress: 100,
      });
    }
    if (job.status === 'running') {
      return this.updateJob(id, { cancel_requested: 1, message: '正在请求取消…' });
    }
    return job;
  }

  deleteJob(id: string, userId: string): boolean {
    const job = this.getOwned(id, userId);
    if (!job) return false;
    if (job.status === 'running') return false;
    this.db.prepare('DELETE FROM explain_jobs WHERE id = ?').run(id);
    for (const p of [job.work_dir, job.source_file_path]) {
      try {
        if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    return true;
  }

  recoverStaleRunning(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE explain_jobs
      SET status = 'failed', stage = 'failed',
          message = '服务重启，任务中断',
          error = '进程重启导致任务中断，请重新提交',
          finished_at = ?, updated_at = ?
      WHERE status = 'running'
    `).run(now, now);
  }

  publicRow(job: ExplainJobRow) {
    let recommendations: any = { coreQuestion: '', recommendations: [] };
    try {
      const parsed = JSON.parse(job.recommendations_json || '{}');
      if (Array.isArray(parsed)) recommendations = { coreQuestion: '', recommendations: parsed };
      else if (parsed && typeof parsed === 'object') recommendations = parsed;
    } catch { /* ignore */ }
    let script: any = null;
    try { script = job.script_json ? JSON.parse(job.script_json) : null; } catch { /* ignore */ }
    return {
      id: job.id,
      name: job.name,
      sourceType: job.source_type,
      sourceFileName: job.source_file_name,
      topicText: job.topic_text,
      status: job.status,
      stage: job.stage,
      stageLabel: EXPLAIN_STAGE_LABEL[job.stage] || job.stage,
      progress: job.progress,
      message: job.message,
      error: job.error,
      recommendations,
      selectedStyleId: job.selected_style_id,
      selectedVariant: job.selected_variant,
      voiceover: job.voiceover,
      script,
      hasSample: !!(job.sample_path && fs.existsSync(job.sample_path)),
      hasFinal: !!(job.final_path && fs.existsSync(job.final_path)),
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    };
  }
}

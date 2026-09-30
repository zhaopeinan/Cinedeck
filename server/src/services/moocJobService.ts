import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const MOOC_UPLOAD_DIR = path.join(DATA_DIR, 'mooc-uploads');

export type MoocJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export type MoocJobStage =
  | 'queued'
  | 'creating'
  | 'parsing'
  | 'script'
  | 'dubbing'
  | 'avatar'
  | 'compose'
  | 'done'
  | 'failed';

/** Last successfully completed pipeline step (for resume). */
export type MoocCheckpoint =
  | 'none'
  | 'created'
  | 'parsed'
  | 'scripted'
  | 'dubbed'
  | 'avatar'
  | 'composed';

export const STAGE_LABEL_CN: Record<string, string> = {
  queued: '排队中',
  creating: '创建项目',
  parsing: '解析 PPT',
  script: '生成解说词',
  dubbing: '生成配音',
  avatar: '生成数字人',
  compose: '合成视频',
  done: '已完成',
  failed: '失败',
};

export interface AvatarLayoutConfig {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MoocJobConfig {
  targetDurationMin: number;
  useExistingNote: boolean;
  selectedVoiceId: string;
  selectedModelId: string;
  enableAvatar: boolean;
  avatarDriveMode: 'photo' | 'video';
  avatarRefVideoId?: string | null;
  avatarPhotoPath?: string | null;
  avatarPageIndexes?: number[] | null;
  /** 批量模式：每个 PPT 只在第 1 页生成数字人（页数各不相同时复用同一布局） */
  avatarFirstPageOnly?: boolean;
  avatarLayout?: AvatarLayoutConfig | null;
  allowSilentPages: boolean;
  defaultSilentPageDuration: number;
  pauseDuration: number;
  /** 出错后自动重试次数（不含首次），默认 5；0 表示不自动重试 */
  maxRetries: number;
}

export interface MoocJobRow {
  id: string;
  user_id: string;
  project_id: string | null;
  name: string;
  file_name: string;
  file_path: string;
  status: MoocJobStatus;
  stage: MoocJobStage;
  progress: number;
  message: string | null;
  error: string | null;
  config_json: string;
  checkpoint: MoocCheckpoint;
  failed_stage: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

fs.mkdirSync(MOOC_UPLOAD_DIR, { recursive: true });

export function getMoocUploadDir() {
  return MOOC_UPLOAD_DIR;
}

const DEFAULT_CONFIG: MoocJobConfig = {
  targetDurationMin: 0,
  useExistingNote: true,
  selectedVoiceId: '',
  selectedModelId: '',
  enableAvatar: false,
  avatarDriveMode: 'video',
  avatarRefVideoId: null,
  avatarPhotoPath: null,
  avatarPageIndexes: null,
  avatarFirstPageOnly: false,
  avatarLayout: { x: 0.72, y: 0.52, w: 0.25, h: 0.444 },
  allowSilentPages: true,
  defaultSilentPageDuration: 5,
  pauseDuration: 2,
  maxRetries: 5,
};

export class MoocJobService {
  constructor(private db: Database.Database) {}

  createJob(input: {
    userId: string;
    fileName: string;
    filePath: string;
    name?: string;
    config: MoocJobConfig;
  }): MoocJobRow {
    const id = uuidv4();
    const now = new Date().toISOString();
    const name = input.name || path.basename(input.fileName, path.extname(input.fileName));

    const jobDir = path.join(MOOC_UPLOAD_DIR, id);
    fs.mkdirSync(jobDir, { recursive: true });
    const destPath = path.join(jobDir, input.fileName);
    fs.copyFileSync(input.filePath, destPath);
    try { fs.unlinkSync(input.filePath); } catch { /* ignore */ }

    const config = { ...input.config };
    if (config.avatarPhotoPath && fs.existsSync(config.avatarPhotoPath)) {
      const photoName = path.basename(config.avatarPhotoPath);
      const photoDest = path.join(jobDir, photoName.startsWith('photo') ? photoName : `photo_${photoName}`);
      fs.copyFileSync(config.avatarPhotoPath, photoDest);
      try { fs.unlinkSync(config.avatarPhotoPath); } catch { /* ignore */ }
      config.avatarPhotoPath = photoDest;
    }

    this.db.prepare(`
      INSERT INTO mooc_jobs (
        id, user_id, project_id, name, file_name, file_path,
        status, stage, progress, message, error, config_json,
        checkpoint, failed_stage, retry_count,
        created_at, updated_at, started_at, finished_at
      ) VALUES (?, ?, NULL, ?, ?, ?, 'queued', 'queued', 0, '排队等待中', NULL, ?, 'none', NULL, 0, ?, ?, NULL, NULL)
    `).run(id, input.userId, name, input.fileName, destPath, JSON.stringify(config), now, now);

    return this.getJob(id)!;
  }

  getJob(id: string): MoocJobRow | null {
    const row = this.db.prepare('SELECT * FROM mooc_jobs WHERE id = ?').get(id) as MoocJobRow | undefined;
    if (!row) return null;
    if (!(row as any).checkpoint) (row as any).checkpoint = 'none';
    if ((row as any).retry_count == null) (row as any).retry_count = 0;
    return row;
  }

  listJobs(userId: string, limit = 50): MoocJobRow[] {
    return this.db.prepare(
      'SELECT * FROM mooc_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as MoocJobRow[];
  }

  parseConfig(job: MoocJobRow): MoocJobConfig {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(job.config_json || '{}') };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  updateJob(id: string, patch: Partial<{
    project_id: string | null;
    status: MoocJobStatus;
    stage: MoocJobStage;
    progress: number;
    message: string | null;
    error: string | null;
    checkpoint: MoocCheckpoint;
    failed_stage: string | null;
    retry_count: number;
    started_at: string | null;
    finished_at: string | null;
    config_json: string;
  }>) {
    const allowed = [
      'project_id', 'status', 'stage', 'progress', 'message', 'error',
      'checkpoint', 'failed_stage', 'retry_count',
      'started_at', 'finished_at', 'config_json',
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
    this.db.prepare(`UPDATE mooc_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  claimNextQueued(): MoocJobRow | null {
    const row = this.db.prepare(
      `SELECT * FROM mooc_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    ).get() as MoocJobRow | undefined;
    if (!row) return null;

    const now = new Date().toISOString();
    // Do not reset stage/checkpoint here — resume keeps them; fresh jobs start at creating in worker
    const result = this.db.prepare(`
      UPDATE mooc_jobs
      SET status = 'running', progress = CASE WHEN progress < 1 THEN 1 ELSE progress END,
          message = '任务开始', started_at = COALESCE(started_at, ?), updated_at = ?,
          error = NULL, failed_stage = NULL, finished_at = NULL
      WHERE id = ? AND status = 'queued'
    `).run(now, now, row.id);

    if (result.changes === 0) return null;
    return this.getJob(row.id);
  }

  hasRunning(): boolean {
    return !!this.db.prepare(`SELECT id FROM mooc_jobs WHERE status = 'running' LIMIT 1`).get();
  }

  /** Mark queued jobs with a human-readable wait hint while another job runs. */
  annotateQueuedWaiting(): void {
    const running = this.db.prepare(
      `SELECT id, name, stage FROM mooc_jobs WHERE status = 'running' LIMIT 1`,
    ).get() as { id: string; name: string; stage: string } | undefined;
    if (!running) return;
    const stageLabel = STAGE_LABEL_CN[running.stage as MoocJobStage] || running.stage;
    const hint = `排队中：等待前序任务「${(running.name || running.id).slice(0, 24)}」完成（当前：${stageLabel}）`;
    this.db.prepare(`
      UPDATE mooc_jobs
      SET message = ?, updated_at = ?
      WHERE status = 'queued'
        AND (
          message IS NULL
          OR message = '排队等待中'
          OR message LIKE '断点续跑%'
          OR message LIKE '全部重跑%'
          OR message LIKE '排队中：等待前序%'
        )
    `).run(hint, new Date().toISOString());
  }

  cancelJob(id: string, userId: string): MoocJobRow | null {
    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return null;
    if (job.status === 'queued') {
      return this.updateJob(id, {
        status: 'cancelled',
        message: '已取消（未开始）',
        finished_at: new Date().toISOString(),
      });
    }
    if (job.status === 'running') {
      return this.updateJob(id, { message: '正在请求取消…' });
    }
    return job;
  }

  isCancelRequested(id: string): boolean {
    const job = this.getJob(id);
    if (!job) return true;
    if (job.status === 'cancelled') return true;
    return !!(job.message && job.message.includes('请求取消'));
  }

  markCancelled(id: string, message = '已取消') {
    return this.updateJob(id, {
      status: 'cancelled',
      message,
      finished_at: new Date().toISOString(),
    });
  }

  /**
   * On pipeline failure: auto re-queue from checkpoint if retries remain.
   * @returns true if auto-retried (re-queued), false if permanently failed.
   */
  handleFailureWithRetry(jobId: string, stage: MoocJobStage, errorDetail: string): boolean {
    const job = this.getJob(jobId);
    if (!job) return false;
    const config = this.parseConfig(job);
    const maxRetries = Math.max(0, Math.min(20, Number(config.maxRetries ?? 5) || 0));
    const used = Number(job.retry_count) || 0;
    const label = STAGE_LABEL_CN[stage] || stage;
    const short = errorDetail.length > 180 ? `${errorDetail.slice(0, 180)}…` : errorDetail;

    if (used < maxRetries) {
      const next = used + 1;
      this.updateJob(jobId, {
        status: 'queued',
        stage: 'queued',
        retry_count: next,
        failed_stage: stage,
        error: errorDetail,
        message: `【${label}】失败，自动重试 ${next}/${maxRetries}：${short}`,
        finished_at: null,
      });
      console.log(`[MOOC] Job ${jobId} auto-retry ${next}/${maxRetries} after ${stage}`);
      return true;
    }

    this.updateJob(jobId, {
      status: 'failed',
      stage,
      failed_stage: stage,
      error: errorDetail,
      message: `【${label}】已重试 ${used}/${maxRetries} 次仍失败：${short}`,
      finished_at: new Date().toISOString(),
    });
    console.log(`[MOOC] Job ${jobId} gave up after ${used} retries at ${stage}`);
    return false;
  }

  /** Resume from checkpoint (keep project). */
  queueResume(id: string, userId: string): MoocJobRow | null {
    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return null;
    if (job.status === 'running' || job.status === 'queued') return null;
    if (!job.project_id && job.checkpoint === 'none') {
      // nothing to resume — fall back to full restart semantics
      return this.queueRestart(id, userId);
    }
    if (job.project_id) {
      // project must still exist
      const p = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(job.project_id);
      if (!p) {
        return this.queueRestart(id, userId);
      }
    }
    return this.updateJob(id, {
      status: 'queued',
      stage: 'queued',
      retry_count: 0,
      message: `断点续跑（已完成：${job.checkpoint || 'none'}）`,
      error: null,
      failed_stage: null,
      finished_at: null,
    });
  }

  /** Full restart from scratch (new project). */
  queueRestart(id: string, userId: string): MoocJobRow | null {
    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return null;
    if (job.status === 'running' || job.status === 'queued') return null;
    if (!fs.existsSync(job.file_path)) return null;
    return this.updateJob(id, {
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: '全部重跑，排队等待中',
      error: null,
      project_id: null,
      checkpoint: 'none',
      failed_stage: null,
      retry_count: 0,
      started_at: null,
      finished_at: null,
    });
  }

  deleteJob(id: string, userId: string): boolean {
    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return false;
    if (job.status === 'running') return false;
    const jobDir = path.join(MOOC_UPLOAD_DIR, id);
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
    this.db.prepare('DELETE FROM mooc_jobs WHERE id = ?').run(id);
    return true;
  }

  recoverStaleRunning(message = '服务重启，任务中断。可点「继续」从断点续跑') {
    const now = new Date().toISOString();
    // Keep stage/checkpoint so resume knows where to continue
    this.db.prepare(`
      UPDATE mooc_jobs
      SET status = 'failed',
          failed_stage = CASE WHEN stage IN ('queued','done','failed') THEN failed_stage ELSE stage END,
          message = ?, error = ?, finished_at = ?, updated_at = ?
      WHERE status = 'running'
    `).run(message, message, now, now);
  }
}

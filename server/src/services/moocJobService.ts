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
  | 'explain_points'
  | 'explain_gen'
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
  | 'explain_points'
  | 'explain_ready'
  | 'composed';

export const STAGE_LABEL_CN: Record<string, string> = {
  queued: '排队中',
  creating: '创建项目',
  parsing: '解析 PPT',
  script: '生成解说词',
  dubbing: '生成配音',
  avatar: '生成数字人',
  explain_points: '分析知识点',
  explain_gen: '生成讲解动画',
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
  /**
   * 绿幕抠图强度（chromakey similarity），仅绿幕参考视频生效。
   * 默认 0.28，范围约 0.05–0.6。
   */
  chromaSimilarity: number;
  /** 拆知识点并插入讲解动画到成片（默认关） */
  enableExplainInsert: boolean;
  /** 讲解动画导出清晰度 */
  explainExportQuality: '720p' | '1080p' | '1440p';
  /** 运行时关联的讲解专题 ID（断点续跑） */
  explainBatchId?: string | null;
  /** 成功插入段数 / 跳过说明（运行时写入） */
  explainInsertSummary?: string | null;
  /** 各流水线阶段起止时间（运行时写入，供进度详情） */
  stageLog?: Array<{
    id: string;
    label?: string;
    status?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    durationSec?: number | null;
    summary?: string | null;
  }>;
  /**
   * 更换数字人优化：保留已有讲解 HTML/插片，仅重新叠数字人后合成。
   * 运行时消费后清除。
   */
  avatarOptimizeKeepExplain?: boolean;
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
  chromaSimilarity: 0.28,
  enableExplainInsert: false,
  explainExportQuality: '1080p',
  explainBatchId: null,
  explainInsertSummary: null,
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

  /**
   * Re-compose only: keep explain_inserts.json, roll checkpoint to explain_ready.
   * Used after repairing a single knowledge-point insert.
   */
  queueRecomposeOnly(
    id: string,
    userId: string,
    opts?: { message?: string },
  ): MoocJobRow | null {
    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return null;
    const cfg0: any = this.parseConfig(job);
    const repairing = !!(cfg0?.repairInProgress);
    // Allow recompose while a repair/reexport marked the parent as running.
    if (job.status === 'queued') return null;
    if (job.status === 'running' && !repairing) return null;
    if (!job.project_id) return null;
    const p = this.db.prepare('SELECT id, file_path FROM projects WHERE id = ?').get(job.project_id) as
      { id: string; file_path?: string } | undefined;
    if (!p?.file_path) return null;
    const insertsPath = path.join(path.dirname(p.file_path), 'explain_inserts.json');
    if (!fs.existsSync(insertsPath)) return null;

    const cfg: any = { ...cfg0 };
    cfg.enableExplainInsert = true;
    delete cfg.avatarOptimizeKeepExplain;
    delete cfg.repairInProgress;
    if (Array.isArray(cfg.stageLog)) {
      cfg.stageLog = cfg.stageLog.filter((x: any) => x?.id !== 'compose');
    }

    return this.updateJob(id, {
      status: 'queued',
      stage: 'queued',
      progress: 88,
      checkpoint: 'explain_ready',
      message: opts?.message || '插片已更新，排队重新合成成片',
      error: null,
      failed_stage: null,
      retry_count: 0,
      finished_at: null,
      config_json: JSON.stringify(cfg),
    });
  }

  /** Mark parent MOOC job as in-progress repair/reexport (UI should not show 已完成). */
  markRepairInProgress(
    id: string,
    userId: string,
    opts: { message: string; kind?: string },
  ): MoocJobRow | null {
    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return null;
    if (job.status === 'queued') return null;
    const cfg: any = { ...this.parseConfig(job) };
    cfg.repairInProgress = {
      kind: opts.kind || 'repair',
      at: new Date().toISOString(),
      message: opts.message,
    };
    return this.updateJob(id, {
      status: 'running',
      stage: 'explain_gen',
      progress: Math.max(Number(job.progress) || 0, 88),
      message: opts.message,
      error: null,
      failed_stage: null,
      finished_at: null,
      config_json: JSON.stringify(cfg),
    });
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

  /**
   * Optimize a finished job by adding knowledge-point explain inserts, then re-compose.
   * Keeps project + earlier artifacts (parse/script/dubbing/avatar); rolls checkpoint back to avatar.
   */
  queueOptimizeExplain(
    id: string,
    userId: string,
    opts?: { explainExportQuality?: '720p' | '1080p' | '1440p'; force?: boolean },
  ): MoocJobRow | null {
    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return null;
    if (job.status === 'running' || job.status === 'queued') return null;
    if (!job.project_id) return null;
    const p = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(job.project_id);
    if (!p) return null;
    if (!fs.existsSync(job.file_path)) return null;

    const cfg: any = { ...this.parseConfig(job) };
    const already = !!cfg.enableExplainInsert && !!cfg.explainInsertSummary;
    if (already && !opts?.force) {
      // Still allow — caller may want to regenerate; force defaults true for optimize endpoint
    }
    cfg.enableExplainInsert = true;
    if (opts?.explainExportQuality && ['720p', '1080p', '1440p'].includes(opts.explainExportQuality)) {
      cfg.explainExportQuality = opts.explainExportQuality;
    } else if (!cfg.explainExportQuality) {
      cfg.explainExportQuality = '1080p';
    }
    // Fresh explain batch / inserts
    cfg.explainBatchId = null;
    cfg.explainInsertSummary = null;
    if (Array.isArray(cfg.stageLog)) {
      cfg.stageLog = cfg.stageLog.filter((x: any) =>
        x?.id !== 'explain_points' && x?.id !== 'explain_gen' && x?.id !== 'compose');
    }
    try {
      const proj = this.db.prepare('SELECT file_path FROM projects WHERE id = ?').get(job.project_id) as
        { file_path?: string } | undefined;
      if (proj?.file_path) {
        const insertsPath = path.join(path.dirname(proj.file_path), 'explain_inserts.json');
        if (fs.existsSync(insertsPath)) fs.unlinkSync(insertsPath);
      }
    } catch { /* ignore */ }

    // Roll back past explain+compose so worker re-enters those stages only
    return this.updateJob(id, {
      status: 'queued',
      stage: 'queued',
      progress: 70,
      checkpoint: 'avatar',
      message: '一键优化：排队补知识点讲解并重新合成',
      error: null,
      failed_stage: null,
      retry_count: 0,
      finished_at: null,
      config_json: JSON.stringify(cfg),
    });
  }

  /**
   * Re-run avatar (and re-compose) for a finished job with new avatar settings.
   * Keeps parse/script/dubbing. If explain inserts exist, keeps HTML and only re-overlays avatar.
   */
  queueOptimizeAvatar(
    id: string,
    userId: string,
    avatarPatch: Partial<MoocJobConfig>,
  ): MoocJobRow | null {
    return this.queueOptimize(id, userId, {
      changeAvatar: true,
      addExplain: false,
      avatarPatch,
    });
  }

  /**
   * Unified post-finish optimize: change avatar and/or (re)generate explain inserts.
   * - explain only → checkpoint avatar
   * - avatar only → checkpoint dubbed; keep existing explain HTML and re-overlay if present
   * - both → checkpoint dubbed; fresh explain after new avatar (no keep-explain)
   */
  queueOptimize(
    id: string,
    userId: string,
    opts: {
      changeAvatar?: boolean;
      addExplain?: boolean;
      avatarPatch?: Partial<MoocJobConfig>;
      explainExportQuality?: '720p' | '1080p' | '1440p';
    },
  ): MoocJobRow | null {
    const changeAvatar = !!opts.changeAvatar;
    const addExplain = !!opts.addExplain;
    if (!changeAvatar && !addExplain) return null;

    if (changeAvatar && addExplain) {
      // Combined path below
    } else if (addExplain && !changeAvatar) {
      return this.queueOptimizeExplain(id, userId, {
        explainExportQuality: opts.explainExportQuality,
        force: true,
      });
    }

    const job = this.getJob(id);
    if (!job || job.user_id !== userId) return null;
    if (job.status === 'running' || job.status === 'queued') return null;
    if (!job.project_id) return null;
    const p = this.db.prepare('SELECT id, file_path FROM projects WHERE id = ?').get(job.project_id) as
      { id: string; file_path?: string } | undefined;
    if (!p) return null;
    if (!fs.existsSync(job.file_path)) return null;

    const cfg: any = { ...this.parseConfig(job), ...(opts.avatarPatch || {}) };
    cfg.enableAvatar = true;

    // Fresh explain when user asked to add/redo; otherwise keep+reoverlay if inserts exist
    let keepExplain = false;
    if (addExplain) {
      cfg.enableExplainInsert = true;
      if (opts.explainExportQuality && ['720p', '1080p', '1440p'].includes(opts.explainExportQuality)) {
        cfg.explainExportQuality = opts.explainExportQuality;
      } else if (!cfg.explainExportQuality) {
        cfg.explainExportQuality = '1080p';
      }
      cfg.explainBatchId = null;
      cfg.explainInsertSummary = null;
      cfg.avatarOptimizeKeepExplain = false;
      try {
        if (p.file_path) {
          const insertsPath = path.join(path.dirname(p.file_path), 'explain_inserts.json');
          if (fs.existsSync(insertsPath)) fs.unlinkSync(insertsPath);
        }
      } catch { /* ignore */ }
    } else {
      try {
        if (p.file_path) {
          const insertsPath = path.join(path.dirname(p.file_path), 'explain_inserts.json');
          keepExplain = !!(cfg.enableExplainInsert && fs.existsSync(insertsPath));
        }
      } catch { /* ignore */ }
      cfg.avatarOptimizeKeepExplain = keepExplain;
    }

    if (Array.isArray(cfg.stageLog)) {
      cfg.stageLog = cfg.stageLog.filter((x: any) => {
        if (x?.id === 'avatar' || x?.id === 'compose') return false;
        if (addExplain && (x?.id === 'explain_points' || x?.id === 'explain_gen')) return false;
        if (!addExplain && keepExplain && x?.id === 'explain_gen') return false;
        return true;
      });
    }

    try {
      this.db.prepare(`
        UPDATE slides
        SET avatar_status = 'pending',
            avatar_video_path = NULL,
            avatar_error = NULL,
            avatar_enabled = 1,
            updated_at = ?
        WHERE project_id = ?
          AND dubbing_status = 'generated'
      `).run(new Date().toISOString(), job.project_id);
    } catch (err: any) {
      console.warn('[MOOC] reset slide avatars failed:', err?.message || err);
    }

    let message: string;
    if (addExplain) {
      message = '成片优化：排队更换数字人、生成知识点讲解并重合成';
    } else if (keepExplain) {
      message = '更换数字人：排队重跑数字人、重叠讲解插片并重合成';
    } else {
      message = '更换数字人：排队重跑数字人并重合成';
    }

    return this.updateJob(id, {
      status: 'queued',
      stage: 'queued',
      progress: 70,
      checkpoint: 'dubbed',
      message,
      error: null,
      failed_stage: null,
      retry_count: 0,
      finished_at: null,
      config_json: JSON.stringify(cfg),
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

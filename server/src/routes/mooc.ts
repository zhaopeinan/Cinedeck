import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { MoocJobService, STAGE_LABEL_CN, getMoocUploadDir, type MoocJobConfig } from '../services/moocJobService';
import { clampChromaSimilarity } from '../services/avatarComposeService';
import { pumpMoocQueue, requestMoocJobCancel } from '../services/moocPipelineWorker';
import { ProjectService } from '../services/projectService';
import { PptParserService } from '../services/pptParser';
import { buildMoocProgressDetail } from '../services/moocProgressDetail';
import type { ExplainBatchService } from '../services/explainBatchService';
import type { ExplainJobService } from '../services/explainJobService';
import type { VideoComposerService } from '../services/videoComposer';
import type Database from 'better-sqlite3';
import {
  repairExplainChildForMooc,
  approveExplainChildrenForMooc,
  skipExplainChildForMooc,
} from '../services/explainInsertRepair';

const PREVIEW_DIR = path.join(getMoocUploadDir(), 'previews');
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

const upload = multer({
  dest: getMoocUploadDir(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

/** previewId → owner userId */
const previewOwners = new Map<string, string>();

function getUserId(req: Request): string {
  return (req as any).user?.id || '';
}

function serializeJob(
  job: any,
  projectService?: ProjectService,
  extras?: {
    explainBatches?: ExplainBatchService | null;
    explainJobs?: ExplainJobService | null;
    detail?: boolean;
  },
) {
  let config: any = {};
  try { config = JSON.parse(job.config_json || '{}'); } catch { /* ignore */ }
  // Don't leak absolute server paths for photo
  const safeConfig = {
    ...config,
    avatarPhotoPath: config.avatarPhotoPath ? true : null,
    hasAvatarPhoto: !!(config.avatarPhotoPath && fs.existsSync(config.avatarPhotoPath)),
  };
  delete safeConfig.avatarPhotoPath;

  let project: any = null;
  if (job.project_id && projectService) {
    const p = projectService.getProject(job.project_id);
    if (p) {
      project = {
        id: p.id,
        name: p.name,
        parseStatus: p.parse_status,
        videoStatus: p.video_status,
        videoFilePath: p.video_file_path || null,
      };
    }
  }

  const failedStage = job.failed_stage || (job.status === 'failed' ? job.stage : null);
  const base: any = {
    id: job.id,
    userId: job.user_id,
    projectId: job.project_id,
    name: job.name,
    fileName: job.file_name,
    status: job.status,
    stage: job.stage,
    stageLabel: STAGE_LABEL_CN[job.stage] || job.stage,
    failedStage,
    failedStageLabel: failedStage ? (STAGE_LABEL_CN[failedStage] || failedStage) : null,
    checkpoint: job.checkpoint || 'none',
    canResume: !!(job.project_id && job.checkpoint && job.checkpoint !== 'none'),
    retryCount: job.retry_count || 0,
    maxRetries: (() => {
      try {
        const c = JSON.parse(job.config_json || '{}');
        const n = Number(c.maxRetries ?? c.max_retries ?? 5);
        return Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : 5;
      } catch {
        return 5;
      }
    })(),
    progress: job.progress,
    message: job.message,
    error: job.error,
    config: safeConfig,
    /** Top-level flag so UI can show「修复中」even if nested config is ignored. */
    repairInProgress: !!(config && config.repairInProgress),
    project,
    pptAvailable: !!(job.file_path && fs.existsSync(job.file_path)),
    /** Finished/failed job with project can add explain inserts then re-compose */
    canOptimizeExplain: !!(
      job.project_id
      && (job.status === 'success' || job.status === 'failed' || job.status === 'cancelled')
    ),
    canOptimizeAvatar: !!(
      job.project_id
      && (job.status === 'success' || job.status === 'failed' || job.status === 'cancelled')
    ),
    hasExplainInsert: !!(config.enableExplainInsert && (config.explainInsertSummary || config.explainBatchId)),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };

  if (projectService) {
    try {
      const detail = buildMoocProgressDetail({
        job,
        config: { ...config },
        projectService,
        explainBatches: extras?.explainBatches,
        explainJobs: extras?.explainJobs,
        includeChildren: !!extras?.detail,
      });
      base.progressSummary = detail.progressSummary;
      base.elapsedLabel = detail.elapsedLabel;
      base.elapsedSec = detail.elapsedSec;
      if (extras?.detail) {
        base.pipeline = detail.pipeline;
        base.explain = detail.explain;
      } else if (detail.explain?.stats) {
        base.explainStats = detail.explain.stats;
        base.explainEtaLabel = detail.explain.etaLabel;
        base.explainConcurrency = detail.explain.concurrency;
      }
    } catch (err: any) {
      console.warn('[MOOC] progress detail failed:', err?.message || err);
    }
  }

  return base;
}

export function createMoocRouter(
  moocJobs: MoocJobService,
  projectService: ProjectService,
  pptParser: PptParserService,
  explainBatches?: ExplainBatchService,
  explainJobs?: ExplainJobService,
  extras?: {
    videoComposer?: VideoComposerService;
    db?: Database.Database;
  },
): Router {
  const router = Router();
  const progressExtras = { explainBatches, explainJobs };
  const videoComposer = extras?.videoComposer;
  const db = extras?.db;

  /**
   * Upload PPTX and render real slide images for layout preview.
   * Returns previewId + page list; images via GET /preview/:id/pages/:pageIndex
   */
  router.post('/preview-slides', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.name === 'MulterError' && (err as any).code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false, data: null,
            error: { code: '1002', message: '文件大小超过限制(200MB)' },
          });
        }
        return res.status(400).json({
          success: false, data: null,
          error: { code: '1001', message: err.message },
        });
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    const tmpPath = req.file?.path;
    try {
      if (!req.file || !tmpPath) {
        return res.status(400).json({
          success: false, data: null,
          error: { code: '1001', message: '请上传 PPTX 文件' },
        });
      }
      const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      if (path.extname(originalName).toLowerCase() !== '.pptx') {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        return res.status(400).json({
          success: false, data: null,
          error: { code: '1001', message: '仅支持 PPTX 文件' },
        });
      }

      const userId = getUserId(req);
      const previewId = uuidv4();
      const dir = path.join(PREVIEW_DIR, previewId);
      fs.mkdirSync(dir, { recursive: true });
      const pptxPath = path.join(dir, originalName);
      fs.copyFileSync(tmpPath, pptxPath);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

      const imagesDir = path.join(dir, 'images');
      const pageCount = await pptParser.renderPptToImages(pptxPath, imagesDir);
      if (!pageCount) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        return res.status(500).json({
          success: false, data: null,
          error: { code: '5001', message: '未能从 PPT 导出幻灯片图片' },
        });
      }

      previewOwners.set(previewId, userId);
      // Auto-expire preview after 2 hours
      setTimeout(() => {
        previewOwners.delete(previewId);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }, 2 * 60 * 60 * 1000);

      const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
      res.json({
        success: true,
        data: {
          previewId,
          pageCount,
          pages,
          fileName: originalName,
        },
        error: null,
      });
    } catch (error: any) {
      if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      res.status(500).json({
        success: false, data: null,
        error: { code: '5001', message: error.message || '预览生成失败' },
      });
    }
  });

  // Serve a rendered preview slide image
  router.get('/preview/:previewId/pages/:pageIndex', (req: Request, res: Response) => {
    const previewId = String(req.params.previewId);
    const pageIndex = parseInt(String(req.params.pageIndex), 10);
    const userId = getUserId(req);
    const owner = previewOwners.get(previewId);
    // Allow if owner matches, or if folder exists and was created this session map missed after restart —
    // still require auth; after restart map is empty so also allow if dir exists under user's recent uploads is hard.
    // Fallback: if map missing but dir exists, allow any authenticated user (preview ids are UUIDs).
    if (owner && owner !== userId) {
      return res.status(403).json({
        success: false, data: null,
        error: { code: '403', message: '无权访问该预览' },
      });
    }
    if (!Number.isFinite(pageIndex) || pageIndex < 1) {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '页码无效' },
      });
    }
    const imgPath = path.join(PREVIEW_DIR, previewId, 'images', `slide_${pageIndex}.png`);
    if (!fs.existsSync(imgPath)) {
      return res.status(404).json({
        success: false, data: null,
        error: { code: '404', message: '预览图不存在，请重新生成' },
      });
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(imgPath);
  });

  // List jobs for current user
  router.get('/jobs', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const jobs = moocJobs.listJobs(userId);
    res.json({
      success: true,
      data: {
        jobs: jobs.map((j) => serializeJob(j, projectService, progressExtras)),
        queue: {
          hasRunning: moocJobs.hasRunning(),
          queuedCount: jobs.filter((j) => j.status === 'queued').length,
        },
      },
      error: null,
    });
  });

  // Get single job (full pipeline + explain children)
  router.get('/jobs/:id', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = moocJobs.getJob(String(req.params.id));
    if (!job || job.user_id !== userId) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    }
    res.json({
      success: true,
      data: serializeJob(job, projectService, { ...progressExtras, detail: true }),
      error: null,
    });
  });

  // Download original uploaded PPTX
  router.get('/jobs/:id/ppt', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = moocJobs.getJob(String(req.params.id));
    if (!job || job.user_id !== userId) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    }
    if (!job.file_path || !fs.existsSync(job.file_path)) {
      return res.status(404).json({
        success: false, data: null,
        error: { code: '404', message: '原始 PPT 文件不存在或已删除' },
      });
    }
    const filename = job.file_name || path.basename(job.file_path);
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_') || 'presentation.pptx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.sendFile(job.file_path);
  });

  // Create job: multipart with file + optional photo + JSON fields
  router.post('/jobs', (req, res, next) => {
    upload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'photo', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        if (err.name === 'MulterError' && (err as any).code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false, data: null,
            error: { code: '1002', message: '文件大小超过限制(200MB)' },
          });
        }
        return res.status(400).json({
          success: false, data: null,
          error: { code: '1001', message: err.message },
        });
      }
      next();
    });
  }, (req: Request, res: Response) => {
    try {
      const userId = getUserId(req);
      const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
      const pptFile = files?.file?.[0];
      if (!pptFile) {
        return res.status(400).json({
          success: false, data: null,
          error: { code: '1001', message: '请上传 PPTX 文件' },
        });
      }

      const originalName = Buffer.from(pptFile.originalname, 'latin1').toString('utf8');
      const ext = path.extname(originalName).toLowerCase();
      if (ext !== '.pptx') {
        try { fs.unlinkSync(pptFile.path); } catch { /* ignore */ }
        return res.status(400).json({
          success: false, data: null,
          error: { code: '1001', message: '仅支持 PPTX 文件' },
        });
      }

      const body = req.body || {};
      const enableAvatar = body.enable_avatar === '1' || body.enable_avatar === 'true' || body.enableAvatar === 'true';
      const driveMode = (body.avatar_drive_mode || body.avatarDriveMode || 'video') as 'photo' | 'video';
      const photoFile = files?.photo?.[0];

      if (enableAvatar && driveMode === 'photo' && !photoFile) {
        try { fs.unlinkSync(pptFile.path); } catch { /* ignore */ }
        return res.status(400).json({
          success: false, data: null,
          error: { code: '4001', message: '数字人静照模式需上传照片' },
        });
      }
      if (enableAvatar && driveMode === 'video' && !(body.avatar_ref_video_id || body.avatarRefVideoId)) {
        try { fs.unlinkSync(pptFile.path); } catch { /* ignore */ }
        if (photoFile) try { fs.unlinkSync(photoFile.path); } catch { /* ignore */ }
        return res.status(400).json({
          success: false, data: null,
          error: { code: '4001', message: '数字人视频模式需选择参考视频' },
        });
      }

      const voiceId = body.selected_voice_id || body.selectedVoiceId;
      const modelId = body.selected_model_id || body.selectedModelId;
      if (!voiceId || !modelId) {
        try { fs.unlinkSync(pptFile.path); } catch { /* ignore */ }
        if (photoFile) try { fs.unlinkSync(photoFile.path); } catch { /* ignore */ }
        return res.status(400).json({
          success: false, data: null,
          error: { code: '4001', message: '请选择音色和配音模型' },
        });
      }

      // avatar_page_indexes: JSON array e.g. "[1,2,5]" or empty/all
      let avatarPageIndexes: number[] | null = null;
      const pagesRaw = body.avatar_page_indexes ?? body.avatarPageIndexes;
      if (pagesRaw != null && pagesRaw !== '' && pagesRaw !== 'all') {
        try {
          const parsed = typeof pagesRaw === 'string' ? JSON.parse(pagesRaw) : pagesRaw;
          if (Array.isArray(parsed)) {
            avatarPageIndexes = parsed
              .map((n: any) => Number(n))
              .filter((n: number) => Number.isFinite(n) && n >= 1);
            if (!avatarPageIndexes.length) avatarPageIndexes = null;
          }
        } catch {
          avatarPageIndexes = null;
        }
      }

      let avatarLayout = { x: 0.72, y: 0.52, w: 0.25, h: 0.444 };
      const layoutRaw = body.avatar_layout ?? body.avatarLayout;
      if (layoutRaw) {
        try {
          const src = typeof layoutRaw === 'string' ? JSON.parse(layoutRaw) : layoutRaw;
          const x = Number(src?.x);
          const y = Number(src?.y);
          const w = Number(src?.w);
          const h = Number(src?.h);
          if ([x, y, w, h].every((n) => Number.isFinite(n))) {
            avatarLayout = {
              x: Math.min(0.95, Math.max(0, x)),
              y: Math.min(0.95, Math.max(0, y)),
              w: Math.min(1, Math.max(0.05, w)),
              h: Math.min(1, Math.max(0.05, h)),
            };
          }
        } catch { /* keep default */ }
      }

      const pauseDurationRaw = Number(body.pause_duration ?? body.pauseDuration);
      const pauseDuration = Number.isFinite(pauseDurationRaw)
        ? Math.min(10, Math.max(0, pauseDurationRaw))
        : 2;

      const maxRetriesRaw = Number(body.max_retries ?? body.maxRetries);
      const maxRetries = Number.isFinite(maxRetriesRaw)
        ? Math.min(20, Math.max(0, Math.round(maxRetriesRaw)))
        : 5;

      const avatarFirstPageOnly = body.avatar_first_page_only === '1'
        || body.avatar_first_page_only === 'true'
        || body.avatarFirstPageOnly === 'true'
        || body.avatarFirstPageOnly === true;

      const enableExplainInsert = body.enable_explain_insert === '1'
        || body.enable_explain_insert === 'true'
        || body.enableExplainInsert === 'true'
        || body.enableExplainInsert === true;
      const qualityRaw = String(body.explain_export_quality || body.explainExportQuality || '1080p');
      const explainExportQuality = (['720p', '1080p', '1440p'].includes(qualityRaw)
        ? qualityRaw
        : '1080p') as MoocJobConfig['explainExportQuality'];

      const config: MoocJobConfig = {
        targetDurationMin: Number(body.target_duration ?? body.targetDuration ?? 0) || 0,
        useExistingNote: !(body.use_existing_note === '0' || body.use_existing_note === 'false'
          || body.useExistingNote === 'false'),
        selectedVoiceId: String(voiceId),
        selectedModelId: String(modelId),
        enableAvatar,
        avatarDriveMode: driveMode === 'photo' ? 'photo' : 'video',
        avatarRefVideoId: body.avatar_ref_video_id || body.avatarRefVideoId || null,
        avatarPhotoPath: photoFile?.path || null,
        avatarPageIndexes: avatarFirstPageOnly ? [1] : avatarPageIndexes,
        avatarFirstPageOnly,
        avatarLayout,
        allowSilentPages: !(body.allow_silent_pages === '0' || body.allow_silent_pages === 'false'
          || body.allowSilentPages === 'false'),
        defaultSilentPageDuration: Number(body.default_silent_page_duration ?? body.defaultSilentPageDuration ?? 5) || 5,
        pauseDuration,
        maxRetries,
        chromaSimilarity: clampChromaSimilarity(
          body.chroma_similarity ?? body.chromaSimilarity,
        ),
        enableExplainInsert,
        explainExportQuality,
        explainBatchId: null,
        explainInsertSummary: null,
      };

      const job = moocJobs.createJob({
        userId,
        fileName: originalName,
        filePath: pptFile.path,
        name: body.name || undefined,
        config,
      });

      // Kick serial queue
      pumpMoocQueue();

      res.json({ success: true, data: serializeJob(job, projectService, progressExtras), error: null });
    } catch (error: any) {
      res.status(500).json({
        success: false, data: null,
        error: { code: '5000', message: error.message },
      });
    }
  });

  // Cancel
  router.post('/jobs/:id/cancel', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = moocJobs.getJob(String(req.params.id));
    if (!job || job.user_id !== userId) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    }
    if (job.status === 'queued') {
      const updated = moocJobs.cancelJob(job.id, userId);
      return res.json({ success: true, data: serializeJob(updated, projectService, progressExtras), error: null });
    }
    if (job.status === 'running') {
      requestMoocJobCancel(job.id);
      const updated = moocJobs.getJob(job.id);
      return res.json({ success: true, data: serializeJob(updated, projectService, progressExtras), error: null });
    }
    res.json({ success: true, data: serializeJob(job, projectService, progressExtras), error: null });
  });

  /**
   * One-click optimize: keep existing PPT/dubbing/avatar, generate knowledge-point
   * explain inserts, then re-compose the final video.
   */
  router.post('/jobs/:id/optimize-explain', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = moocJobs.getJob(String(req.params.id));
    if (!job || job.user_id !== userId) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    }
    if (job.status === 'running' || job.status === 'queued') {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '任务进行中，无法优化' },
      });
    }
    if (job.status !== 'success' && job.status !== 'failed' && job.status !== 'cancelled') {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '仅已完成或失败的任务可优化' },
      });
    }
    const qualityRaw = String(req.body?.explainExportQuality || req.body?.explain_export_quality || '');
    const quality = (['720p', '1080p', '1440p'].includes(qualityRaw)
      ? qualityRaw
      : undefined) as '720p' | '1080p' | '1440p' | undefined;
    const updated = moocJobs.queueOptimizeExplain(job.id, userId, {
      explainExportQuality: quality,
      force: true,
    });
    if (!updated) {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '无法优化（需保留项目产物；若原文件丢失请重跑）' },
      });
    }
    pumpMoocQueue();
    res.json({
      success: true,
      data: serializeJob(updated, projectService, progressExtras),
      error: null,
    });
  });

  function parseBoolFlag(v: any): boolean {
    return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }

  function handleOptimizeMultipart(req: Request, res: Response, defaults?: { changeAvatar?: boolean; addExplain?: boolean }) {
    const userId = getUserId(req);
    const job = moocJobs.getJob(String(req.params.id));
    if (!job || job.user_id !== userId) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    }
    if (job.status === 'running' || job.status === 'queued') {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '任务进行中，无法优化' },
      });
    }
    const body = req.body || {};
    const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    const photoFile = files?.photo?.[0];

    const changeAvatar = body.change_avatar != null || body.changeAvatar != null || body.do_avatar != null
      ? parseBoolFlag(body.change_avatar ?? body.changeAvatar ?? body.do_avatar)
      : (defaults?.changeAvatar ?? true);
    const addExplain = body.add_explain != null || body.addExplain != null || body.do_explain != null
      ? parseBoolFlag(body.add_explain ?? body.addExplain ?? body.do_explain)
      : (defaults?.addExplain ?? false);

    if (!changeAvatar && !addExplain) {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '请至少选择「更换数字人」或「加讲解」之一' },
      });
    }

    let avatarPatch: Partial<MoocJobConfig> | undefined;
    if (changeAvatar) {
      const driveMode = (body.avatar_drive_mode || body.avatarDriveMode || 'video') as 'photo' | 'video';
      if (driveMode === 'photo' && !photoFile) {
        const cfg0 = moocJobs.parseConfig(job);
        if (!cfg0.avatarPhotoPath || !fs.existsSync(cfg0.avatarPhotoPath)) {
          return res.status(400).json({
            success: false, data: null,
            error: { code: '4001', message: '静照模式请上传数字人照片' },
          });
        }
      }
      if (driveMode === 'video' && !(body.avatar_ref_video_id || body.avatarRefVideoId)) {
        return res.status(400).json({
          success: false, data: null,
          error: { code: '4001', message: '视频模式请选择参考视频' },
        });
      }

      let avatarPageIndexes: number[] | null = null;
      const pagesRaw = body.avatar_page_indexes ?? body.avatarPageIndexes;
      if (pagesRaw != null && pagesRaw !== '' && pagesRaw !== 'all') {
        try {
          const parsed = typeof pagesRaw === 'string' ? JSON.parse(pagesRaw) : pagesRaw;
          if (Array.isArray(parsed)) {
            avatarPageIndexes = parsed.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n >= 1);
            if (!avatarPageIndexes.length) avatarPageIndexes = null;
          }
        } catch { avatarPageIndexes = null; }
      }
      const avatarFirstPageOnly = parseBoolFlag(body.avatar_first_page_only)
        || parseBoolFlag(body.avatarFirstPageOnly);

      let avatarLayout = moocJobs.parseConfig(job).avatarLayout || { x: 0.72, y: 0.52, w: 0.25, h: 0.444 };
      const layoutRaw = body.avatar_layout ?? body.avatarLayout;
      if (layoutRaw) {
        try {
          const src = typeof layoutRaw === 'string' ? JSON.parse(layoutRaw) : layoutRaw;
          const x = Number(src?.x); const y = Number(src?.y);
          const w = Number(src?.w); const h = Number(src?.h);
          if ([x, y, w, h].every((n) => Number.isFinite(n))) {
            avatarLayout = {
              x: Math.min(0.95, Math.max(0, x)),
              y: Math.min(0.95, Math.max(0, y)),
              w: Math.min(1, Math.max(0.05, w)),
              h: Math.min(1, Math.max(0.05, h)),
            };
          }
        } catch { /* keep */ }
      }

      avatarPatch = {
        enableAvatar: true,
        avatarDriveMode: driveMode === 'photo' ? 'photo' : 'video',
        avatarRefVideoId: body.avatar_ref_video_id || body.avatarRefVideoId || null,
        avatarPhotoPath: photoFile?.path || moocJobs.parseConfig(job).avatarPhotoPath || null,
        avatarPageIndexes: avatarFirstPageOnly ? [1] : avatarPageIndexes,
        avatarFirstPageOnly,
        avatarLayout,
        chromaSimilarity: clampChromaSimilarity(
          body.chroma_similarity ?? body.chromaSimilarity ?? moocJobs.parseConfig(job).chromaSimilarity,
        ),
      };
    }

    const qualityRaw = String(body.explain_export_quality || body.explainExportQuality || '');
    const explainExportQuality = (['720p', '1080p', '1440p'].includes(qualityRaw)
      ? qualityRaw
      : undefined) as '720p' | '1080p' | '1440p' | undefined;

    const updated = moocJobs.queueOptimize(job.id, userId, {
      changeAvatar,
      addExplain,
      avatarPatch,
      explainExportQuality,
    });
    if (!updated) {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '无法优化（需保留项目产物）' },
      });
    }
    pumpMoocQueue();
    res.json({
      success: true,
      data: serializeJob(updated, projectService, progressExtras),
      error: null,
    });
  }

  const optimizeUpload = (req: Request, res: Response, next: () => void) => {
    upload.fields([{ name: 'photo', maxCount: 1 }])(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false, data: null,
          error: { code: '1001', message: err.message },
        });
      }
      next();
    });
  };

  /**
   * Unified finished-job optimize: change avatar and/or add/redo explain inserts.
   * Multipart: change_avatar, add_explain, avatar_*, explain_export_quality, photo?
   */
  router.post('/jobs/:id/optimize', optimizeUpload, (req, res) => {
    handleOptimizeMultipart(req, res, { changeAvatar: false, addExplain: false });
  });

  /**
   * Replace avatar on a finished job (legacy). Prefer POST /optimize with change_avatar=1.
   * Body may also set add_explain=1 to combine.
   */
  router.post('/jobs/:id/optimize-avatar', optimizeUpload, (req, res) => {
    handleOptimizeMultipart(req, res, { changeAvatar: true, addExplain: false });
  });

  /** Batch optimize multiple finished jobs. */
  router.post('/jobs/optimize-explain', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '请提供任务 id 列表' },
      });
    }
    const qualityRaw = String(req.body?.explainExportQuality || req.body?.explain_export_quality || '');
    const quality = (['720p', '1080p', '1440p'].includes(qualityRaw)
      ? qualityRaw
      : undefined) as '720p' | '1080p' | '1440p' | undefined;
    const results: any[] = [];
    let ok = 0;
    for (const id of ids.slice(0, 50)) {
      const job = moocJobs.getJob(id);
      if (!job || job.user_id !== userId) {
        results.push({ id, ok: false, error: '不存在' });
        continue;
      }
      const updated = moocJobs.queueOptimizeExplain(id, userId, {
        explainExportQuality: quality,
        force: true,
      });
      if (!updated) {
        results.push({ id, ok: false, error: '无法优化' });
        continue;
      }
      ok += 1;
      results.push({ id, ok: true, job: serializeJob(updated, projectService, progressExtras) });
    }
    if (ok) pumpMoocQueue();
    res.json({
      success: true,
      data: { ok, total: ids.length, results },
      error: null,
    });
  });

  /** Update tunable runtime config (e.g. chromaSimilarity) without restarting the job. */
  router.patch('/jobs/:id/config', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = moocJobs.getJob(String(req.params.id));
    if (!job || job.user_id !== userId) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    }
    const cfg: any = { ...moocJobs.parseConfig(job) };
    const body = req.body || {};
    if (body.chromaSimilarity != null || body.chroma_similarity != null) {
      cfg.chromaSimilarity = clampChromaSimilarity(
        body.chromaSimilarity ?? body.chroma_similarity,
      );
    }
    moocJobs.updateJob(job.id, { config_json: JSON.stringify(cfg) });
    const updated = moocJobs.getJob(job.id);
    res.json({
      success: true,
      data: serializeJob(updated, projectService, { ...progressExtras, detail: true }),
      error: null,
    });
  });

  /**
   * Repair one explain child (QC-failed / generation-failed):
   * mode=reexport | regenerate → QC → patch inserts → recompose MOOC.
   */
  router.post('/jobs/:id/explain/:childId/repair', async (req: Request, res: Response) => {
    if (!explainJobs || !explainBatches || !videoComposer || !db) {
      return res.status(503).json({
        success: false, data: null,
        error: { code: '503', message: '讲解修复服务未就绪' },
      });
    }
    const modeRaw = String(req.body?.mode || 'reexport');
    const mode = modeRaw === 'regenerate' ? 'regenerate' : 'reexport';
    try {
      const result = await repairExplainChildForMooc({
        moocJobId: String(req.params.id),
        childId: String(req.params.childId),
        userId: getUserId(req),
        mode,
        moocJobs,
        explainJobs,
        batches: explainBatches,
        projectService,
        videoComposer,
        db,
      });
      res.json({ success: true, data: result, error: null });
    } catch (err: any) {
      const code = err?.code === '404' || err?.code === '400' ? err.code : '500';
      const status = code === '404' ? 404 : code === '400' ? 400 : 500;
      res.status(status).json({
        success: false, data: null,
        error: { code: String(code), message: err?.message || '修复失败' },
      });
    }
  });

  /**
   * User approve selected explain children → export → insert → single recompose.
   * Body: { childIds: string[] }
   */
  router.post('/jobs/:id/explain/approve', async (req: Request, res: Response) => {
    if (!explainJobs || !explainBatches || !videoComposer || !db) {
      return res.status(503).json({
        success: false, data: null,
        error: { code: '503', message: '讲解入片服务未就绪' },
      });
    }
    // Client axios interceptor snake_cases body: childIds → child_ids
    const rawIds = req.body?.childIds ?? req.body?.child_ids;
    const rawOne = req.body?.childId ?? req.body?.child_id;
    const childIds = Array.isArray(rawIds)
      ? rawIds.map(String)
      : (rawOne ? [String(rawOne)] : []);
    try {
      const result = await approveExplainChildrenForMooc({
        moocJobId: String(req.params.id),
        childIds,
        userId: getUserId(req),
        moocJobs,
        explainJobs,
        batches: explainBatches,
        projectService,
        videoComposer,
        db,
      });
      res.json({ success: true, data: result, error: null });
    } catch (err: any) {
      const code = err?.code === '404' || err?.code === '400' ? err.code : '500';
      const status = code === '404' ? 404 : code === '400' ? 400 : 500;
      res.status(status).json({
        success: false, data: null,
        error: { code: String(code), message: err?.message || '入片失败' },
      });
    }
  });

  /** User skip one explain child (do not insert into final video). */
  router.post('/jobs/:id/explain/:childId/skip', (req: Request, res: Response) => {
    if (!explainJobs) {
      return res.status(503).json({
        success: false, data: null,
        error: { code: '503', message: '讲解服务未就绪' },
      });
    }
    try {
      const result = skipExplainChildForMooc({
        moocJobId: String(req.params.id),
        childId: String(req.params.childId),
        userId: getUserId(req),
        moocJobs,
        explainJobs,
      });
      res.json({ success: true, data: result, error: null });
    } catch (err: any) {
      const code = err?.code === '404' || err?.code === '400' ? err.code : '500';
      const status = code === '404' ? 404 : code === '400' ? 400 : 500;
      res.status(status).json({
        success: false, data: null,
        error: { code: String(code), message: err?.message || '操作失败' },
      });
    }
  });

  /**
   * Retry / resume:
   * - body.resume !== false (default): 断点续跑，保留已完成阶段
   * - body.resume === false 或 ?mode=restart: 全部重跑
   */
  router.post('/jobs/:id/retry', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = moocJobs.getJob(String(req.params.id));
    if (!job || job.user_id !== userId) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    }
    if (job.status === 'running' || job.status === 'queued') {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '任务进行中，无法重试' },
      });
    }
    if (!fs.existsSync(job.file_path)) {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '原始文件已丢失，请重新创建任务' },
      });
    }

    const mode = String(req.query.mode || req.body?.mode || '');
    const wantResume = mode === 'restart'
      ? false
      : !(req.body?.resume === false || req.body?.resume === '0' || req.body?.resume === 0);

    const updated = wantResume
      ? moocJobs.queueResume(job.id, userId)
      : moocJobs.queueRestart(job.id, userId);

    if (!updated) {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '无法重试该任务' },
      });
    }
    pumpMoocQueue();
    res.json({
      success: true,
      data: { ...serializeJob(updated, projectService, progressExtras), resume: wantResume },
      error: null,
    });
  });

  // Delete
  router.delete('/jobs/:id', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const ok = moocJobs.deleteJob(String(req.params.id), userId);
    if (!ok) {
      return res.status(400).json({
        success: false, data: null,
        error: { code: '400', message: '无法删除（任务不存在或正在运行）' },
      });
    }
    res.json({ success: true, data: { deleted: true }, error: null });
  });

  return router;
}

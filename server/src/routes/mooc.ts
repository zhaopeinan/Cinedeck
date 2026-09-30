import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { MoocJobService, STAGE_LABEL_CN, getMoocUploadDir, type MoocJobConfig } from '../services/moocJobService';
import { pumpMoocQueue, requestMoocJobCancel } from '../services/moocPipelineWorker';
import { ProjectService } from '../services/projectService';
import { PptParserService } from '../services/pptParser';

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

function serializeJob(job: any, projectService?: ProjectService) {
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
  return {
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
    project,
    pptAvailable: !!(job.file_path && fs.existsSync(job.file_path)),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

export function createMoocRouter(
  moocJobs: MoocJobService,
  projectService: ProjectService,
  pptParser: PptParserService,
): Router {
  const router = Router();

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
        jobs: jobs.map((j) => serializeJob(j, projectService)),
        queue: {
          hasRunning: moocJobs.hasRunning(),
          queuedCount: jobs.filter((j) => j.status === 'queued').length,
        },
      },
      error: null,
    });
  });

  // Get single job
  router.get('/jobs/:id', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = moocJobs.getJob(String(req.params.id));
    if (!job || job.user_id !== userId) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    }
    res.json({ success: true, data: serializeJob(job, projectService), error: null });
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

      res.json({ success: true, data: serializeJob(job, projectService), error: null });
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
      return res.json({ success: true, data: serializeJob(updated, projectService), error: null });
    }
    if (job.status === 'running') {
      requestMoocJobCancel(job.id);
      const updated = moocJobs.getJob(job.id);
      return res.json({ success: true, data: serializeJob(updated, projectService), error: null });
    }
    res.json({ success: true, data: serializeJob(job, projectService), error: null });
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
      data: { ...serializeJob(updated, projectService), resume: wantResume },
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

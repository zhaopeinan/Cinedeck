import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import {
  createAvatarJob,
  getAvatarJob,
  listRunningOrQueued,
  requestCancelAvatarJob,
  type AvatarDriveMode,
} from '../../services/avatarProgress';
import {
  dequeueAvatarJob,
  enqueueAvatarJob,
  getAvatarJobsDir,
} from '../../services/avatarWorker';
import {
  createComposeJob,
  getComposeJob,
  listComposeRunningOrQueued,
} from '../../services/composeProgress';
import {
  clampChromaBlend,
  clampChromaSimilarity,
  enqueueComposeJob,
  getComposeJobsDir,
  parseComposeLayoutJson,
  parseComposeMode,
  publicComposeJob,
} from '../../services/avatarComposeService';
import { createApiKeyAuth } from '../../middleware/apiKeyAuth';
import { OpenApiKeyService } from '../../services/openApiKeyService';
import { sendMediaFile } from '../../utils/sendMediaFile';

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_COMPOSE_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_SECONDS_HINT = 120;
const DRIVE_MODES = new Set<AvatarDriveMode>(['photo', 'video']);

function parseDriveMode(raw: unknown): AvatarDriveMode | null {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'video';
  if (DRIVE_MODES.has(v as AvatarDriveMode)) return v as AvatarDriveMode;
  return null;
}

function openOwnerId(req: Request): string {
  return `open:${req.openApiKey!.id}`;
}

function publicJob(job: NonNullable<ReturnType<typeof getAvatarJob>>) {
  return {
    id: job.id,
    driveMode: job.driveMode,
    status: job.status,
    stage: job.stage,
    message: job.message,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    hasVideo: !!job.outputPath && fs.existsSync(job.outputPath),
  };
}

function assertOpenOwner(job: NonNullable<ReturnType<typeof getAvatarJob>>, req: Request): boolean {
  return job.userId === openOwnerId(req);
}

export function createOpenAvatarRouter(openApiKeys: OpenApiKeyService): Router {
  const router = Router();
  const { apiKeyRequired, requireScope } = createApiKeyAuth(openApiKeys);
  router.use(apiKeyRequired, requireScope('avatar'));

  const jobsDir = getAvatarJobsDir();
  const uploadTmp = path.resolve(process.cwd(), '..', 'data', 'open-uploads', 'avatar');
  fs.mkdirSync(uploadTmp, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const jobId = (req as any)._avatarJobId as string | undefined;
      if (jobId) {
        const dir = path.join(jobsDir, jobId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
        return;
      }
      cb(null, uploadTmp);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '';
      if (file.fieldname === 'photo') {
        cb(null, `photo${ext || '.jpg'}`);
      } else if (file.fieldname === 'template' || file.fieldname === 'video') {
        cb(null, `template_src${ext || '.mp4'}`);
      } else if (file.fieldname === 'audio') {
        cb(null, `audio${ext || '.wav'}`);
      } else {
        cb(null, `${randomUUID()}${ext || '.bin'}`);
      }
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: Math.max(MAX_PHOTO_BYTES, MAX_VIDEO_BYTES, MAX_AUDIO_BYTES) },
    fileFilter: (_req, file, cb) => {
      const name = file.originalname.toLowerCase();
      if (file.fieldname === 'photo') {
        if (!/\.(jpe?g|png)$/.test(name) && !file.mimetype.startsWith('image/')) {
          return cb(new Error('照片仅支持 JPG/PNG'));
        }
      } else if (file.fieldname === 'template' || file.fieldname === 'video') {
        if (!/\.(mp4|mov|webm|avi)$/.test(name) && !file.mimetype.startsWith('video/')) {
          return cb(new Error('参考视频仅支持 MP4/MOV/WEBM'));
        }
      } else if (file.fieldname === 'audio') {
        if (!/\.(wav|mp3)$/.test(name) && !file.mimetype.startsWith('audio/')) {
          return cb(new Error('音频仅支持 WAV/MP3'));
        }
      }
      cb(null, true);
    },
  });

  router.post('/jobs', (req: Request, res: Response) => {
    const pending = listRunningOrQueued();
    if (pending.length >= 3) {
      return res.status(429).json({
        success: false,
        data: null,
        error: { code: 'AVATAR_BUSY', message: '数字人任务排队较多，请稍后再试' },
      });
    }

    const jobId = randomUUID();
    (req as any)._avatarJobId = jobId;

    upload.fields([
      { name: 'photo', maxCount: 1 },
      { name: 'template', maxCount: 1 },
      { name: 'video', maxCount: 1 },
      { name: 'audio', maxCount: 1 },
    ])(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'UPLOAD_ERROR', message: err.message || '上传失败' },
        });
      }

      const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
      const photo = files?.photo?.[0];
      const template = files?.template?.[0] || files?.video?.[0];
      const audio = files?.audio?.[0];

      const driveMode = parseDriveMode(req.body?.driveMode ?? req.body?.drive_mode);
      if (!driveMode) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'INVALID_DRIVE_MODE', message: '驱动模式仅支持 photo 或 video' },
        });
      }

      if (!audio) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'MISSING_FILES', message: '请上传解说音频（字段名 audio）' },
        });
      }
      if (audio.size > MAX_AUDIO_BYTES) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'AUDIO_TOO_LARGE', message: '音频过大（上限 50MB）' },
        });
      }

      let templatePath: string | null = null;

      if (driveMode === 'photo') {
        if (!photo) {
          return res.status(400).json({
            success: false,
            data: null,
            error: { code: 'MISSING_FILES', message: '静照口型模式请上传照片（字段名 photo）' },
          });
        }
        if (photo.size > MAX_PHOTO_BYTES) {
          return res.status(400).json({
            success: false,
            data: null,
            error: { code: 'PHOTO_TOO_LARGE', message: '照片过大（上限 20MB）' },
          });
        }
      } else {
        if (!template) {
          return res.status(400).json({
            success: false,
            data: null,
            error: { code: 'MISSING_FILES', message: '参考视频模式请上传 template（或 video）' },
          });
        }
        if (template.size > MAX_VIDEO_BYTES) {
          return res.status(400).json({
            success: false,
            data: null,
            error: { code: 'VIDEO_TOO_LARGE', message: '参考视频过大（上限 100MB）' },
          });
        }
        templatePath = template.path;
      }

      const job = createAvatarJob({
        id: jobId,
        userId: openOwnerId(req),
        driveMode,
        photoPath: photo?.path || null,
        templatePath: driveMode === 'photo' ? (photo?.path || null) : templatePath,
        refVideoId: null,
        audioPath: audio.path,
      });
      enqueueAvatarJob(jobId);

      res.json({
        success: true,
        data: {
          ...publicJob(job),
          hint:
            driveMode === 'video'
              ? `参考视频中的肢体动作会保留；建议人脸清晰，音频不超过 ${MAX_AUDIO_SECONDS_HINT} 秒`
              : `静照模式仅驱动口型；建议音频不超过 ${MAX_AUDIO_SECONDS_HINT} 秒`,
        },
        error: null,
      });
    });
  });

  router.get('/jobs/:id', (req: Request, res: Response) => {
    const job = getAvatarJob(String(req.params.id));
    if (!job || !assertOpenOwner(job, req)) {
      return res.status(404).json({
        success: false,
        data: null,
        error: { code: '404', message: '任务不存在' },
      });
    }
    res.json({ success: true, data: publicJob(job), error: null });
  });

  router.get('/jobs/:id/video', (req: Request, res: Response) => {
    const job = getAvatarJob(String(req.params.id));
    if (!job || !assertOpenOwner(job, req) || !job.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({
        success: false,
        data: null,
        error: { code: '404', message: '视频不存在' },
      });
    }
    sendMediaFile(req, res, job.outputPath, {
      contentType: 'video/mp4',
      fileName: `avatar-${job.id}.mp4`,
      disposition: 'inline',
    });
  });

  router.post('/jobs/:id/cancel', (req: Request, res: Response) => {
    const job = getAvatarJob(String(req.params.id));
    if (!job || !assertOpenOwner(job, req)) {
      return res.status(404).json({
        success: false,
        data: null,
        error: { code: '404', message: '任务不存在' },
      });
    }
    dequeueAvatarJob(job.id);
    const updated = requestCancelAvatarJob(job.id);
    res.json({ success: true, data: updated ? publicJob(updated) : null, error: null });
  });

  // --- Greenscreen compose onto background video ---

  const composeDir = getComposeJobsDir();
  const composeUpload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const jobId = (req as any)._composeJobId as string | undefined;
        if (!jobId) return cb(new Error('missing compose job id'), composeDir);
        const dir = path.join(composeDir, jobId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
        if (file.fieldname === 'background') cb(null, `background${ext}`);
        else if (file.fieldname === 'greenscreen') cb(null, `greenscreen${ext}`);
        else cb(null, `${randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: MAX_COMPOSE_VIDEO_BYTES },
    fileFilter: (_req, file, cb) => {
      const name = file.originalname.toLowerCase();
      if (!/\.(mp4|mov|webm|avi)$/.test(name) && !file.mimetype.startsWith('video/')) {
        return cb(new Error('仅支持视频文件 MP4/MOV/WEBM'));
      }
      cb(null, true);
    },
  });

  function assertComposeOwner(
    job: NonNullable<ReturnType<typeof getComposeJob>>,
    req: Request,
  ): boolean {
    return job.userId === openOwnerId(req);
  }

  router.post('/compose', (req: Request, res: Response) => {
    if (listComposeRunningOrQueued().length >= 4) {
      return res.status(429).json({
        success: false,
        data: null,
        error: { code: 'COMPOSE_BUSY', message: '合成任务较多，请稍后再试' },
      });
    }

    const jobId = randomUUID();
    (req as any)._composeJobId = jobId;

    composeUpload.fields([
      { name: 'background', maxCount: 1 },
      { name: 'greenscreen', maxCount: 1 },
    ])(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'UPLOAD_ERROR', message: err.message || '上传失败' },
        });
      }

      const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
      const background = files?.background?.[0];
      let greenscreenPath: string | null = files?.greenscreen?.[0]?.path || null;
      const greenscreenJobId = String(
        req.body?.greenscreenJobId || req.body?.greenscreen_job_id || '',
      ).trim();

      if (!background) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'MISSING_FILES', message: '请上传底视频（字段名 background）' },
        });
      }

      if (!greenscreenPath && greenscreenJobId) {
        const srcJob = getAvatarJob(greenscreenJobId);
        if (
          !srcJob
          || !assertOpenOwner(srcJob, req)
          || !srcJob.outputPath
          || !fs.existsSync(srcJob.outputPath)
        ) {
          return res.status(404).json({
            success: false,
            data: null,
            error: { code: 'GS_JOB_NOT_FOUND', message: '绿幕生成任务不存在或尚未完成' },
          });
        }
        const dest = path.join(
          composeDir,
          jobId,
          `greenscreen${path.extname(srcJob.outputPath) || '.mp4'}`,
        );
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(srcJob.outputPath, dest);
        greenscreenPath = dest;
      }

      if (!greenscreenPath) {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: 'MISSING_FILES',
            message: '请上传绿幕视频（greenscreen），或指定本 Key 下的 greenscreenJobId',
          },
        });
      }

      const mode = parseComposeMode(req.body?.mode);
      const layout = parseComposeLayoutJson(req.body?.layout);
      const chromaSimilarity = clampChromaSimilarity(
        req.body?.chromaSimilarity ?? req.body?.chroma_similarity,
      );
      const chromaBlend = clampChromaBlend(req.body?.chromaBlend ?? req.body?.chroma_blend);

      const job = createComposeJob({
        id: jobId,
        userId: openOwnerId(req),
        mode,
        backgroundPath: background.path,
        greenscreenPath,
        layout,
        chromaSimilarity,
        chromaBlend,
      });
      enqueueComposeJob(jobId);

      res.json({
        success: true,
        data: {
          ...publicComposeJob(job),
          hint: mode === 'preview' ? '预览约前 8 秒，参数与最终导出一致' : '正在导出全片',
        },
        error: null,
      });
    });
  });

  router.get('/compose/:id', (req: Request, res: Response) => {
    const job = getComposeJob(String(req.params.id));
    if (!job || !assertComposeOwner(job, req)) {
      return res.status(404).json({
        success: false,
        data: null,
        error: { code: '404', message: '合成任务不存在' },
      });
    }
    res.json({ success: true, data: publicComposeJob(job), error: null });
  });

  router.get('/compose/:id/video', (req: Request, res: Response) => {
    const job = getComposeJob(String(req.params.id));
    if (!job || !assertComposeOwner(job, req) || !job.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({
        success: false,
        data: null,
        error: { code: '404', message: '合成视频不存在' },
      });
    }
    const name = job.mode === 'preview' ? `compose-preview-${job.id}.mp4` : `compose-${job.id}.mp4`;
    sendMediaFile(req, res, job.outputPath, {
      contentType: 'video/mp4',
      fileName: name,
      disposition: 'inline',
    });
  });

  return router;
}

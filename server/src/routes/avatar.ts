import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import {
  createAvatarJob,
  getAvatarJob,
  listRunningOrQueued,
  type AvatarDriveMode,
} from '../services/avatarProgress';
import { enqueueAvatarJob, getAvatarJobsDir } from '../services/avatarWorker';
import { AvatarRefVideoService } from '../services/avatarRefVideoService';
import type Database from 'better-sqlite3';

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_SECONDS_HINT = 120;
const MAX_REFS_PER_USER = 20;
const DRIVE_MODES = new Set<AvatarDriveMode>(['photo', 'video']);

function getUserId(req: Request): string {
  return (req as any).user?.id || '';
}

function parseDriveMode(raw: unknown): AvatarDriveMode | null {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'video';
  if (DRIVE_MODES.has(v as AvatarDriveMode)) return v as AvatarDriveMode;
  return null;
}

function publicJob(job: NonNullable<ReturnType<typeof getAvatarJob>>) {
  return {
    id: job.id,
    driveMode: job.driveMode,
    refVideoId: job.refVideoId,
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

function assertJobOwner(job: NonNullable<ReturnType<typeof getAvatarJob>>, req: Request): boolean {
  const userId = getUserId(req);
  const role = (req as any).user?.role;
  if (role === 'admin') return true;
  return !!userId && job.userId === userId;
}

export function createAvatarRouter(db: Database.Database): Router {
  const router = Router();
  const jobsDir = getAvatarJobsDir();
  const refService = new AvatarRefVideoService(db);
  // Keep ref uploads on the same volume as /data/private to avoid EXDEV rename failures
  const uploadTmp = path.resolve(process.cwd(), '..', 'data', 'private', '_upload_tmp');
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

  // --- Private reference video library (owner-only) ---

  router.get('/refs', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, data: null, error: { code: '401', message: '未登录' } });
    }
    const rows = refService.listByUser(userId).map((r) => refService.publicRow(r));
    res.json({ success: true, data: rows, error: null });
  });

  router.post('/refs', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, data: null, error: { code: '401', message: '未登录' } });
    }
    if (refService.listByUser(userId).length >= MAX_REFS_PER_USER) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: 'REF_LIMIT', message: `每位用户最多保存 ${MAX_REFS_PER_USER} 段参考视频` },
      });
    }

    upload.single('video')(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'UPLOAD_ERROR', message: err.message || '上传失败' },
        });
      }
      const file = req.file;
      if (!file) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'MISSING_FILES', message: '请上传参考视频' },
        });
      }
      if (file.size > MAX_VIDEO_BYTES) {
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'VIDEO_TOO_LARGE', message: '参考视频过大（上限 100MB）' },
        });
      }
      try {
        const row = refService.createFromUpload({
          userId,
          name: String(req.body?.name || req.body?.Name || ''),
          originalName: file.originalname,
          tempPath: file.path,
          fileSize: file.size,
          isGreenscreen: AvatarRefVideoService.parseBoolFlag(
            req.body?.isGreenscreen ?? req.body?.is_greenscreen,
          ),
        });
        // Pre-normalize for Duix at upload time (saves re-encode on every generation)
        void (async () => {
          try {
            const { ensureDuixTemplate } = await import('../services/duixTemplatePrep');
            const prepared = await ensureDuixTemplate(row.file_path, 'video');
            refService.setPreparedPath(row.id, userId, prepared);
            console.log(`[AvatarRef] prepared Duix template for ${row.id}`);
          } catch (e: any) {
            console.warn(`[AvatarRef] prepare template failed: ${e?.message || e}`);
          }
        })();
        res.json({ success: true, data: refService.publicRow(row), error: null });
      } catch (e: any) {
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        res.status(500).json({
          success: false,
          data: null,
          error: { code: '500', message: e?.message || '保存失败' },
        });
      }
    });
  });

  router.patch('/refs/:id', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const patch: { name?: string; isGreenscreen?: boolean } = {};
    if (req.body?.name != null || req.body?.Name != null) {
      patch.name = String(req.body?.name ?? req.body?.Name ?? '');
    }
    if (req.body?.isGreenscreen != null || req.body?.is_greenscreen != null) {
      patch.isGreenscreen = AvatarRefVideoService.parseBoolFlag(
        req.body?.isGreenscreen ?? req.body?.is_greenscreen,
      );
    }
    const row = refService.update(String(req.params.id), userId, patch);
    if (!row) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '参考视频不存在' } });
    }
    res.json({ success: true, data: refService.publicRow(row), error: null });
  });

  router.delete('/refs/:id', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const ok = refService.delete(String(req.params.id), userId);
    if (!ok) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '参考视频不存在' } });
    }
    res.json({ success: true, data: { id: req.params.id }, error: null });
  });

  router.get('/refs/:id/preview', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const row = refService.getOwned(String(req.params.id), userId);
    if (!row || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '参考视频不存在' } });
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name}"`);
    fs.createReadStream(row.file_path).pipe(res);
  });

  // --- Jobs (Duix only) ---

  router.post('/jobs', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, data: null, error: { code: '401', message: '未登录' } });
    }
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
      const template = files?.template?.[0];
      const audio = files?.audio?.[0];
      const refVideoId = String(req.body?.refVideoId || req.body?.ref_video_id || '').trim() || null;
      const saveToLibrary =
        String(req.body?.saveToLibrary || req.body?.save_to_library || '') === '1' ||
        String(req.body?.saveToLibrary || '').toLowerCase() === 'true';

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
          error: { code: 'MISSING_FILES', message: '请上传解说音频' },
        });
      }
      if (audio.size > MAX_AUDIO_BYTES) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'AUDIO_TOO_LARGE', message: '音频过大（上限 50MB）' },
        });
      }

      let templatePath: string | null = template?.path || null;
      let usedRefId: string | null = null;

      if (driveMode === 'photo') {
        if (!photo) {
          return res.status(400).json({
            success: false,
            data: null,
            error: { code: 'MISSING_FILES', message: '静照口型模式请上传照片' },
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
        if (refVideoId) {
          const owned = refService.getOwned(refVideoId, userId);
          if (!owned || !fs.existsSync(owned.file_path)) {
            return res.status(404).json({
              success: false,
              data: null,
              error: { code: 'REF_NOT_FOUND', message: '所选参考视频不存在或无权访问' },
            });
          }
          const dest = path.join(jobsDir, jobId, `template_src${path.extname(owned.file_path) || '.mp4'}`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(owned.file_path, dest);
          templatePath = dest;
          usedRefId = owned.id;
        } else if (template) {
          if (template.size > MAX_VIDEO_BYTES) {
            return res.status(400).json({
              success: false,
              data: null,
              error: { code: 'VIDEO_TOO_LARGE', message: '参考视频过大（上限 100MB）' },
            });
          }
          templatePath = template.path;
          if (saveToLibrary) {
            if (refService.listByUser(userId).length < MAX_REFS_PER_USER) {
              try {
                const saved = refService.createFromExistingFile({
                  userId,
                  name: String(req.body?.refName || req.body?.ref_name || template.originalname || ''),
                  sourcePath: template.path,
                  originalName: template.originalname,
                  isGreenscreen: AvatarRefVideoService.parseBoolFlag(
                    req.body?.isGreenscreen ?? req.body?.is_greenscreen,
                  ),
                });
                usedRefId = saved.id;
              } catch (e: any) {
                console.warn('[avatar] saveToLibrary failed:', e?.message || e);
              }
            }
          }
        } else {
          return res.status(400).json({
            success: false,
            data: null,
            error: { code: 'MISSING_FILES', message: '请选择已有参考视频，或上传一段新的参考视频' },
          });
        }
      }

      const job = createAvatarJob({
        id: jobId,
        userId,
        driveMode,
        photoPath: photo?.path || null,
        templatePath,
        refVideoId: usedRefId,
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
    if (!job || !assertJobOwner(job, req)) {
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
    if (!job || !assertJobOwner(job, req) || !job.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({
        success: false,
        data: null,
        error: { code: '404', message: '视频不存在' },
      });
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `inline; filename="avatar-${job.id}.mp4"`);
    fs.createReadStream(job.outputPath).pipe(res);
  });

  return router;
}

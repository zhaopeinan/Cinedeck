import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import type Database from 'better-sqlite3';
import { ProjectService } from '../services/projectService';
import { AvatarRefVideoService } from '../services/avatarRefVideoService';
import { generateProjectAvatars, isProjectAvatarRunning } from '../services/projectAvatarWorker';
import { getProjectAvatarProgress } from '../services/projectAvatarProgress';
import { requestCancel } from '../services/jobCancel';

const PROJECTS_DIR = path.resolve(process.cwd(), '..', 'data', 'projects');
/** Default PiP for ~1:1 avatar on 16:9 slide */
const DEFAULT_LAYOUT = { x: 0.72, y: 0.52, w: 0.25, h: 0.444 };

function getUserId(req: Request): string {
  return (req as any).user?.id || '';
}

function parseLayout(raw: any) {
  const src = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const x = Number(src?.x);
  const y = Number(src?.y);
  const w = Number(src?.w);
  const h = Number(src?.h);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) {
    throw new Error('布局参数无效');
  }
  return {
    x: Math.min(0.95, Math.max(0, x)),
    y: Math.min(0.95, Math.max(0, y)),
    w: Math.min(1, Math.max(0.05, w)),
    h: Math.min(1, Math.max(0.05, h)),
  };
}

export function createProjectAvatarRouter(projectService: ProjectService, db: Database.Database): Router {
  const router = Router();
  const refService = new AvatarRefVideoService(db);

  const photoUpload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const dir = path.join(PROJECTS_DIR, String(req.params.id), 'avatar');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `photo${ext}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!/\.(jpe?g|png)$/i.test(file.originalname) && !file.mimetype.startsWith('image/')) {
        return cb(new Error('照片仅支持 JPG/PNG'));
      }
      cb(null, true);
    },
  });

  router.get('/:id/avatar/settings', (req: Request, res: Response) => {
    const project = projectService.getProject(String(req.params.id)) as any;
    if (!project) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
    }
    let layout = DEFAULT_LAYOUT;
    try {
      if (project.avatar_layout_json) layout = parseLayout(project.avatar_layout_json);
    } catch { /* keep default */ }

    res.json({
      success: true,
      data: {
        driveMode: project.avatar_drive_mode || 'video',
        refVideoId: project.avatar_ref_video_id || null,
        photoPath: project.avatar_photo_path || null,
        hasPhoto: !!(project.avatar_photo_path && fs.existsSync(project.avatar_photo_path)),
        layout,
        progress: getProjectAvatarProgress(String(req.params.id)),
        running: isProjectAvatarRunning(String(req.params.id)),
      },
      error: null,
    });
  });

  router.put('/:id/avatar/settings', (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const project = projectService.getProject(projectId) as any;
    if (!project) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
    }
    const userId = getUserId(req);
    const updates: Record<string, any> = {};

    if (req.body?.driveMode === 'photo' || req.body?.driveMode === 'video') {
      updates.avatar_drive_mode = req.body.driveMode;
    } else if (req.body?.drive_mode === 'photo' || req.body?.drive_mode === 'video') {
      updates.avatar_drive_mode = req.body.drive_mode;
    }

    const refVideoId = req.body?.refVideoId ?? req.body?.ref_video_id;
    if (refVideoId !== undefined) {
      if (refVideoId === null || refVideoId === '') {
        updates.avatar_ref_video_id = null;
      } else {
        const owned = refService.getOwned(String(refVideoId), userId);
        if (!owned) {
          return res.status(404).json({
            success: false,
            data: null,
            error: { code: 'REF_NOT_FOUND', message: '参考视频不存在或无权访问' },
          });
        }
        updates.avatar_ref_video_id = owned.id;
      }
    }

    if (req.body?.layout) {
      try {
        updates.avatar_layout_json = JSON.stringify(parseLayout(req.body.layout));
      } catch (e: any) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'BAD_LAYOUT', message: e?.message || '布局无效' },
        });
      }
    }

    const updated = projectService.updateProject(projectId, updates);
    res.json({ success: true, data: updated, error: null });
  });

  router.post('/:id/avatar/photo', (req: Request, res: Response) => {
    photoUpload.single('photo')(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'UPLOAD_ERROR', message: err.message || '上传失败' },
        });
      }
      if (!req.file) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'MISSING_FILES', message: '请上传照片' },
        });
      }
      const updated = projectService.updateProject(String(req.params.id), {
        avatar_photo_path: req.file.path,
        avatar_drive_mode: 'photo',
      });
      // Pre-build silent looping template beside the photo
      void (async () => {
        try {
          const { ensureDuixTemplate } = await import('../services/duixTemplatePrep');
          await ensureDuixTemplate(req.file!.path, 'photo');
        } catch (e: any) {
          console.warn(`[ProjectAvatar] photo template prep failed: ${e?.message || e}`);
        }
      })();
      res.json({ success: true, data: { photoPath: req.file.path, project: updated }, error: null });
    });
  });

  router.put('/:id/avatar/pages', (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const pages = Array.isArray(req.body?.pages) ? req.body.pages : [];
    for (const p of pages) {
      const pageIndex = Number(p.pageIndex ?? p.page_index);
      if (!Number.isFinite(pageIndex)) continue;
      const patch: Record<string, any> = {};
      if (p.enabled !== undefined) patch.avatar_enabled = p.enabled ? 1 : 0;
      if (p.visible !== undefined) patch.avatar_visible = p.visible ? 1 : 0;
      if (p.status === 'skipped') {
        patch.avatar_status = 'skipped';
        patch.avatar_enabled = 0;
      }
      if (p.layout) {
        try {
          patch.avatar_layout_json = JSON.stringify(parseLayout(p.layout));
        } catch {
          // ignore bad layout for this page
        }
      }
      if (Object.keys(patch).length) {
        projectService.updateSlide(projectId, pageIndex, patch);
      }
    }
    res.json({ success: true, data: projectService.getSlides(projectId), error: null });
  });

  router.post('/:id/avatar/generate', (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const userId = getUserId(req);
    if (isProjectAvatarRunning(projectId)) {
      return res.status(409).json({
        success: false,
        data: null,
        error: { code: 'BUSY', message: '数字人正在生成中' },
      });
    }

    const project = projectService.getProject(projectId) as any;
    if (!project) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
    }

    const slides = projectService.getSlides(projectId) as any[];
    let pageIndexes: number[] = Array.isArray(req.body?.pageIndexes)
      ? req.body.pageIndexes.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
      : Array.isArray(req.body?.page_indexes)
        ? req.body.page_indexes.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
        : [];

    if (!pageIndexes.length) {
      pageIndexes = slides
        .filter((s) => s.dubbing_status === 'generated' && (s.avatar_enabled === undefined || s.avatar_enabled === 1 || s.avatar_enabled === true))
        .map((s) => s.page_index);
    }

    // Mark unselected pages as not participating — but NEVER wipe already-generated assets
    const selected = new Set(pageIndexes);
    if (req.body?.markSkipped) {
      for (const s of slides) {
        if (s.dubbing_status === 'generated' && !selected.has(s.page_index)) {
          if (s.avatar_status === 'generated' && s.avatar_video_path) {
            // Keep file + status; only hide from default selection
            projectService.updateSlide(projectId, s.page_index, {
              avatar_enabled: 0,
              avatar_visible: 0,
            });
          } else {
            projectService.updateSlide(projectId, s.page_index, {
              avatar_enabled: 0,
              avatar_status: 'skipped',
              avatar_visible: 0,
            });
          }
        }
      }
    }

    if (!pageIndexes.length) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: 'NO_PAGES', message: '没有可生成的页面（需已配音且已勾选）' },
      });
    }

    // fire and forget
    generateProjectAvatars({ projectId, userId, pageIndexes, projectService, db }).catch((err) => {
      console.error('[ProjectAvatar]', err?.message || err);
    });

    res.json({
      success: true,
      data: { pageIndexes, progress: getProjectAvatarProgress(projectId) },
      error: null,
    });
  });

  router.get('/:id/avatar/progress', (req: Request, res: Response) => {
    res.json({
      success: true,
      data: getProjectAvatarProgress(String(req.params.id)),
      error: null,
    });
  });

  router.post('/:id/avatar/cancel', (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    requestCancel('avatar', projectId);
    res.json({
      success: true,
      data: { message: '已请求取消数字人生成', progress: getProjectAvatarProgress(projectId) },
      error: null,
    });
  });

  router.get('/:id/avatar/pages/:pageIndex/video', (req: Request, res: Response) => {
    const slide = projectService.getSlide(String(req.params.id), parseInt(String(req.params.pageIndex), 10)) as any;
    if (!slide?.avatar_video_path || !fs.existsSync(slide.avatar_video_path)) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '数字人视频不存在' } });
    }
    res.setHeader('Content-Type', 'video/mp4');
    fs.createReadStream(slide.avatar_video_path).pipe(res);
  });

  return router;
}

import { Router, Request, Response } from 'express';
import { ProjectService } from '../services/projectService';
import { OpenCutAdapter } from '../services/opencutAdapter';
import { VideoComposerService } from '../services/videoComposer';
import { requestCancel, JobCancelledError } from '../services/jobCancel';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

type P = { id: string };

export function createOpenCutRouter(projectService: ProjectService, openCutAdapter: OpenCutAdapter, videoComposer?: VideoComposerService): Router {
  const router = Router();

  // 创建编辑项目
  router.post('/:id/opencut/init', async (req: Request<P>, res: Response) => {
    try {
      const project = projectService.getProject(req.params.id);
      if (!project) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
      }

      const slides = projectService.getSlides(req.params.id) as any[];
      const videoSlides = slides
        .filter(s => fs.existsSync(s.image_path || ''))
        .map(s => ({
          pageIndex: s.page_index,
          imagePath: s.image_path,
          duration: s.dubbing_duration || project.default_silent_page_duration || 5,
        }));

      const audioSlides = slides
        .filter(s => s.dubbing_status === 'generated' && s.dubbing_audio_path && (
          s.dubbing_audio_path.startsWith('http://') ||
          s.dubbing_audio_path.startsWith('https://') ||
          fs.existsSync(s.dubbing_audio_path)
        ))
        .map(s => ({
          pageIndex: s.page_index,
          audioPath: s.dubbing_audio_path,
          duration: s.dubbing_duration || 0,
        }));

      const result = await openCutAdapter.initProject({
        projectId: req.params.id,
        slides: videoSlides,
        audios: audioSlides,
        aspectRatio: '16:9',
      });

      // Save edit project to database
      const editId = uuidv4();
      const now = new Date().toISOString();
      const db = (projectService as any).db;
      db.prepare(`
        INSERT OR REPLACE INTO edit_projects (id, project_id, source_video_path, status, timeline, edit_version, export_status, created_at, updated_at)
        VALUES (?, ?, ?, 'editing', ?, 1, 'none', ?, ?)
      `).run(editId, req.params.id, project.video_file_path || '', JSON.stringify(result.timeline), now, now);

      res.json({ success: true, data: { ...result, editProjectId: editId }, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '7002', message: error.message } });
    }
  });

  // 获取编辑项目
  router.get('/:id/opencut/project', (req: Request, res: Response) => {
    const db = (projectService as any).db;
    const editProject = db.prepare('SELECT * FROM edit_projects WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1').get(req.params.id);
    if (!editProject) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '编辑项目不存在' } });
    }
    res.json({ success: true, data: editProject, error: null });
  });

  // 更新时间轴
  router.put('/:id/opencut/timeline', async (req: Request<P>, res: Response) => {
    try {
      const result = await openCutAdapter.updateTimeline(req.params.id, req.body.timeline);
      const db = (projectService as any).db;
      const now = new Date().toISOString();
      db.prepare('UPDATE edit_projects SET timeline = ?, edit_version = edit_version + 1, updated_at = ? WHERE project_id = ?')
        .run(JSON.stringify(result), now, req.params.id);
      res.json({ success: true, data: result, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '7002', message: error.message } });
    }
  });

  // 导出最终视频 — 支持变速和页间停顿，OpenCut 不可用时降级
  router.post('/:id/opencut/export', async (req: Request<P>, res: Response) => {
    try {
      const db = (projectService as any).db;
      const now = new Date().toISOString();
      const project = projectService.getProject(req.params.id);
      if (!project || !project.video_file_path) {
        return res.status(400).json({ success: false, data: null, error: { code: '7003', message: '没有可导出的视频，请先合成讲解视频' } });
      }

      const speed = Number(req.body.speed) || 1.0;
      const pauseDuration = Number(req.body.pause_duration) || 0;
      const aspectRatio = req.body.aspect_ratio || 'original';
      // 前端拦截器会把 crop 内部 key 转成 snake_case，这里兼容两种命名
      const cropRaw = req.body.crop || null;
      const crop = cropRaw ? {
        xPct: cropRaw.xPct ?? cropRaw.x_pct ?? 0,
        yPct: cropRaw.yPct ?? cropRaw.y_pct ?? 0,
        widthPct: cropRaw.widthPct ?? cropRaw.width_pct ?? 100,
        heightPct: cropRaw.heightPct ?? cropRaw.height_pct ?? 100,
      } : undefined;

      const slides = projectService.getSlides(req.params.id) as any[];
      const hasAvatarSlides = slides.some((s: any) =>
        (s.avatar_visible === 1 || s.avatar_visible === true) &&
        s.avatar_status === 'generated' &&
        !!s.avatar_video_path,
      );
      // 有数字人时必须重渲染融合（不能只复制旧的 output.mp4，否则导出缺数字人）
      const needsRender = (
        speed !== 1.0 ||
        pauseDuration > 0 ||
        (aspectRatio && aspectRatio !== 'original') ||
        !!crop ||
        hasAvatarSlides
      ) && videoComposer;

      const available = await openCutAdapter.isAvailable();
      if (!available) {
        if (needsRender) {
          // 异步渲染：立即返回，后台执行，前端轮询进度
          db.prepare('UPDATE edit_projects SET export_status = ? WHERE project_id = ?').run('exporting', req.params.id);
          res.json({ success: true, data: { taskId: `local_${req.params.id}`, async: true, degraded: true }, error: null });

          videoComposer!.renderExport({
            projectId: req.params.id,
            slides,
            speed,
            pauseDuration,
            aspectRatio,
            crop,
            allowSilentPages: !!project.allow_silent_pages,
            defaultSilentPageDuration: project.default_silent_page_duration || 5,
          }).then(({ exportPath, totalDuration }) => {
            db.prepare('UPDATE edit_projects SET export_status = ?, export_file_path = ?, updated_at = ? WHERE project_id = ?')
              .run('success', exportPath, new Date().toISOString(), req.params.id);
            // 进度文件保留，前端通过 export_done 识别完成
          }).catch((err: any) => {
            if (err instanceof JobCancelledError || err?.name === 'JobCancelledError') {
              db.prepare('UPDATE edit_projects SET export_status = ? WHERE project_id = ?').run('cancelled', req.params.id);
              videoComposer!.writeProgress(req.params.id, 'export_cancelled', 0, slides.length);
              return;
            }
            db.prepare('UPDATE edit_projects SET export_status = ? WHERE project_id = ?').run('failed', req.params.id);
            // 写入失败进度
            videoComposer!.writeExportError(req.params.id, err.message || '导出失败');
          });
          return;
        }

        // 降级：直接复制已合成的视频作为导出结果
        const exportDir = path.dirname(project.video_file_path);
        const exportPath = path.join(exportDir, `export_${Date.now()}.mp4`);
        try {
          fs.copyFileSync(project.video_file_path, exportPath);
        } catch {
          // 复制失败则直接引用源文件
        }
        const finalPath = fs.existsSync(exportPath) ? exportPath : project.video_file_path;
        db.prepare('UPDATE edit_projects SET export_status = ?, export_file_path = ?, updated_at = ? WHERE project_id = ?')
          .run('success', finalPath, now, req.params.id);
        return res.json({ success: true, data: { taskId: `local_${req.params.id}`, exportFilePath: finalPath, degraded: true }, error: null });
      }

      db.prepare('UPDATE edit_projects SET export_status = ? WHERE project_id = ?').run('exporting', req.params.id);
      const taskId = await openCutAdapter.startExport(req.params.id, req.body);
      res.json({ success: true, data: { taskId }, error: null });
    } catch (error: any) {
      const db = (projectService as any).db;
      db.prepare('UPDATE edit_projects SET export_status = ? WHERE project_id = ?').run('failed', req.params.id);
      res.status(500).json({ success: false, data: null, error: { code: '7003', message: error.message } });
    }
  });

  // 下载导出视频
  router.get('/:id/opencut/download', (req: Request<P>, res: Response) => {
    const db = (projectService as any).db;
    const editProject = db.prepare('SELECT export_file_path FROM edit_projects WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1').get(req.params.id);
    if (!editProject || !editProject.export_file_path || !fs.existsSync(editProject.export_file_path)) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '导出文件不存在' } });
    }
    res.download(editProject.export_file_path);
  });

  // 导出状态
  router.get('/:id/opencut/export/status', async (req: Request, res: Response) => {
    try {
      const db = (projectService as any).db;
      const editProject = db.prepare('SELECT export_status, export_file_path FROM edit_projects WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1').get(req.params.id) as any;
      const progress = videoComposer?.getProgress(req.params.id as string) || null;
      // 过滤出导出相关进度
      const exportProgress = progress && (progress as any).stage?.startsWith('export_') ? progress : null;
      res.json({ success: true, data: { ...editProject, progress: exportProgress }, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '7003', message: error.message } });
    }
  });

  // 取消导出（立即杀掉 ffmpeg）
  router.post('/:id/opencut/export/cancel', (req: Request<P>, res: Response) => {
    const projectId = req.params.id;
    if (videoComposer) {
      videoComposer.forceCancelExport(projectId);
    } else {
      requestCancel('export', projectId);
    }
    const db = (projectService as any).db;
    try {
      db.prepare('UPDATE edit_projects SET export_status = ? WHERE project_id = ? AND export_status = ?')
        .run('cancelled', projectId, 'exporting');
    } catch { /* ignore */ }
    res.json({ success: true, data: { message: '已强制停止导出' }, error: null });
  });

  // 重试导出
  router.post('/:id/opencut/export/retry', async (req: Request<P>, res: Response) => {
    try {
      const taskId = await openCutAdapter.startExport(req.params.id, req.body);
      res.json({ success: true, data: { taskId }, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '7003', message: error.message } });
    }
  });

  return router;
}

import { Router, Request, Response } from 'express';
import { ProjectService } from '../services/projectService';
import { VideoComposerService } from '../services/videoComposer';

type P = { id: string };

export function createVideoRouter(projectService: ProjectService, videoComposer: VideoComposerService): Router {
  const router = Router();

  // 合成讲解视频 — 立即返回，后台异步合成，前端轮询进度
  router.post('/:id/video/compose', async (req: Request<P>, res: Response) => {
    try {
      const projectId = req.params.id;
      const project = projectService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
      }

      const slides = projectService.getSlides(projectId) as any[];

      // 生成前校验
      const hasFailedNotes = slides.some(s =>
        s.note_status === 'read_failed' || s.note_status === 'page_failed' || s.note_status === 'too_long'
      );
      if (hasFailedNotes) {
        return res.status(400).json({ success: false, data: null, error: { code: '2002', message: '存在备注读取失败的页面' } });
      }

      const hasNotesPages = slides.filter(s => s.note_status === 'loaded');
      const allDubbed = hasNotesPages.every(s => s.dubbing_status === 'generated');
      if (!allDubbed) {
        return res.status(400).json({ success: false, data: null, error: { code: '5002', message: '存在未完成配音的页面' } });
      }

      // 立即标记为生成中，写入初始进度
      projectService.updateProject(projectId, { video_status: 'generating' });
      videoComposer.clearProgress(projectId);
      videoComposer.writeInitialProgress(projectId, slides.length);

      // 立即返回 — 后台异步合成
      res.json({ success: true, data: { message: '视频合成已启动', totalPages: slides.length }, error: null });

      // 后台合成（HTTP 层面 fire-and-forget）
      videoComposer.composeVideo({
        projectId,
        slides,
        allowSilentPages: !!project.allow_silent_pages,
        defaultSilentPageDuration: project.default_silent_page_duration || 5,
      }).catch(err => {
        console.error('[Video] Background composition error:', err.message);
      });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '6001', message: error.message } });
    }
  });

  // 获取视频合成状态
  router.get('/:id/video/status', (req: Request<P>, res: Response) => {
    const project = projectService.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
    }
    res.json({ success: true, data: { videoStatus: project.video_status, videoFilePath: project.video_file_path }, error: null });
  });

  // 获取视频合成进度
  router.get('/:id/video/progress', (req: Request<P>, res: Response) => {
    const project = projectService.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
    }
    const progress = videoComposer.getProgress(req.params.id);
    res.json({ success: true, data: progress, error: null });
  });

  // 取消视频合成（立即杀掉 ffmpeg）
  router.post('/:id/video/cancel', (req: Request<P>, res: Response) => {
    const projectId = req.params.id;
    const project = projectService.getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
    }
    videoComposer.forceCancelCompose(projectId);
    res.json({ success: true, data: { message: '已强制停止视频合成' }, error: null });
  });

  // 获取视频播放/下载地址（?download=1 强制附件下载）
  router.get('/:id/video/play', (req: Request<P>, res: Response) => {
    const project = projectService.getProject(req.params.id);
    if (!project || !project.video_file_path) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '视频不存在' } });
    }
    const asDownload = String(req.query.download || '') === '1';
    if (asDownload) {
      const safeName = String(project.name || 'mooc')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .slice(0, 80) || 'mooc';
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp4"`);
    }
    res.sendFile(project.video_file_path);
  });

  // 显式下载入口（与 ?download=1 等价，便于前端调用）
  router.get('/:id/video/download', (req: Request<P>, res: Response) => {
    const project = projectService.getProject(req.params.id);
    if (!project || !project.video_file_path) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '视频不存在' } });
    }
    const safeName = String(project.name || 'mooc')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 80) || 'mooc';
    res.download(project.video_file_path, `${safeName}.mp4`);
  });

  // 重试视频合成 — 立即返回，后台异步合成
  router.post('/:id/video/retry', async (req: Request<P>, res: Response) => {
    try {
      const projectId = req.params.id;
      const project = projectService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
      }
      const slides = projectService.getSlides(projectId) as any[];

      // 立即标记为生成中，清除旧进度
      projectService.updateProject(projectId, { video_status: 'generating' });
      videoComposer.clearProgress(projectId);
      videoComposer.writeInitialProgress(projectId, slides.length);

      // 立即返回 — 后台异步合成
      res.json({ success: true, data: { message: '视频合成已启动', totalPages: slides.length }, error: null });

      // 后台合成（HTTP 层面 fire-and-forget）
      videoComposer.composeVideo({
        projectId,
        slides,
        allowSilentPages: !!project.allow_silent_pages,
        defaultSilentPageDuration: project.default_silent_page_duration || 5,
      }).catch(err => {
        console.error('[Video] Background retry composition error:', err.message);
      });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '6001', message: error.message } });
    }
  });

  return router;
}

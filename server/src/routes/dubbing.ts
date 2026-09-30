import { Router, Request, Response } from 'express';
import { ProjectService } from '../services/projectService';
import { VoiceboxAdapter } from '../services/voiceboxAdapter';
import { VideoComposerService } from '../services/videoComposer';
import { SystemSettingsService } from '../services/systemSettingsService';
import {
  appendDubbingLog,
  finishDubbingProgress,
  getDubbingProgress,
  markDubbingCancelled,
  startDubbingProgress,
} from '../services/dubbingProgress';
import {
  generateAllInBackground,
  generateSingleInBackground,
} from '../services/dubbingGenerator';

type P = { id: string; pageIndex: string };

export function createDubbingRouter(projectService: ProjectService, voicebox: VoiceboxAdapter, videoComposer: VideoComposerService, systemSettings: SystemSettingsService): Router {
  const router = Router();

  /**
   * Generate dubbing for all pages — returns immediately, runs in background.
   * Frontend polls /dubbing/status for progress.
   */
  router.post('/:id/dubbing/generate', async (req: Request<P>, res: Response) => {
    try {
      const projectId = req.params.id;
      const project = projectService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
      }

      if (!project.selected_voice_id) {
        return res.status(400).json({ success: false, data: null, error: { code: '3002', message: '请先选择配音音色' } });
      }
      if (!project.selected_model_id) {
        return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '请先选择配音模型' } });
      }

      const slides = projectService.getSlides(projectId) as any[];
      const hasFailedNotes = slides.some(s =>
        s.note_status === 'read_failed' || s.note_status === 'page_failed' || s.note_status === 'too_long'
      );
      if (hasFailedNotes) {
        return res.status(400).json({ success: false, data: null, error: { code: '2002', message: '存在备注读取失败的页面' } });
      }

      const noteSlides = slides.filter(s => s.note_status === 'loaded');
      const toGenerate = noteSlides.filter(s => s.dubbing_status !== 'generated');
      const concurrency = systemSettings.getDubbingConcurrency();

      // Keep non-current pages as pending so UI shows real queue progress.
      for (const slide of toGenerate) {
        if (slide.dubbing_status !== 'pending') {
          projectService.updateSlide(projectId, slide.page_index, { dubbing_status: 'pending', dubbing_error: null });
        }
      }

      startDubbingProgress(projectId, toGenerate.length, concurrency);

      // Return immediately — generate in background
      res.json({ success: true, data: { message: '配音生成已启动', totalPages: toGenerate.length, concurrency }, error: null });

      // Background generation (fire-and-forget from HTTP perspective)
      generateAllInBackground(projectId, noteSlides, project.selected_voice_id, project.selected_model_id, voicebox, projectService, videoComposer, project, systemSettings, concurrency).catch(err => {
        console.error('[Dubbing] Background generation error:', err.message);
        appendDubbingLog(projectId, `后台任务异常: ${err.message}`, 'error');
        finishDubbingProgress(projectId, { completedCount: 0, failedCount: toGenerate.length });
      });

    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '5002', message: error.message } });
    }
  });

  // 生成单页配音
  router.post('/:id/dubbing/generate/:pageIndex', async (req: Request<P>, res: Response) => {
    try {
      const projectId = req.params.id;
      const pageIdx = parseInt(req.params.pageIndex);
      const project = projectService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
      }

      const slide = projectService.getSlide(projectId, pageIdx) as any;
      if (!slide || slide.note_status !== 'loaded') {
        return res.status(400).json({ success: false, data: null, error: { code: '5002', message: '该页面无法生成配音' } });
      }

      // Return immediately, generate in background
      projectService.updateSlide(projectId, pageIdx, { dubbing_status: 'generating', dubbing_error: null });
      startDubbingProgress(projectId, 1);
      appendDubbingLog(projectId, `开始重新生成第 ${pageIdx} 页配音`, 'info');
      res.json({ success: true, data: { message: '单页配音重新生成已启动' }, error: null });

      generateSingleInBackground(projectId, pageIdx, slide, project.selected_voice_id, project.selected_model_id, voicebox, projectService, systemSettings).catch(err => {
        console.error(`[Dubbing] Single page ${pageIdx} generation error:`, err.message);
        appendDubbingLog(projectId, `第 ${pageIdx + 1} 页异常: ${err.message}`, 'error');
        finishDubbingProgress(projectId, { completedCount: 0, failedCount: 1 });
      });

    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '5002', message: error.message } });
    }
  });

  // 获取配音整体状态
  router.get('/:id/dubbing/status', (req: Request<P>, res: Response) => {
    const slides = projectService.getSlides(req.params.id) as any[];
    const noteSlides = slides.filter(s => s.note_status === 'loaded');
    const progress = getDubbingProgress(req.params.id);
    const summary = {
      total: noteSlides.length,
      generated: noteSlides.filter(s => s.dubbing_status === 'generated').length,
      generating: noteSlides.filter(s => s.dubbing_status === 'generating').length,
      failed: noteSlides.filter(s => s.dubbing_status === 'failed').length,
      pending: noteSlides.filter(s => s.dubbing_status === 'pending' || s.dubbing_status === 'regenerate_pending').length,
      active: progress?.status === 'running',
      progress: progress ? {
        status: progress.status,
        currentPageIndex: progress.currentPageIndex,
        currentPage: progress.currentPageIndex,
        activePages: progress.activePages,
        concurrency: progress.concurrency,
        stage: progress.stage,
        message: progress.message,
        startedAt: progress.startedAt,
        updatedAt: progress.updatedAt,
        completedCount: progress.completedCount,
        failedCount: progress.failedCount,
        totalToGenerate: progress.totalToGenerate,
        taskId: progress.taskId,
        waitSeconds: progress.waitSeconds,
        logs: progress.logs.slice(-40),
      } : null,
    };
    res.json({ success: true, data: summary, error: null });
  });

  // 取消配音生成
  router.post('/:id/dubbing/cancel', (req: Request<P>, res: Response) => {
    markDubbingCancelled(req.params.id);
    const slides = projectService.getSlides(req.params.id) as any[];
    for (const slide of slides) {
      if (slide.dubbing_status === 'generating') {
        projectService.updateSlide(req.params.id, slide.page_index, { dubbing_status: 'pending' });
      }
    }
    res.json({ success: true, data: null, error: null });
  });

  return router;
}

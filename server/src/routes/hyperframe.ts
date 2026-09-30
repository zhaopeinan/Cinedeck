import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import {
  HyperframeJobService,
  HYPERFRAME_UPLOAD_DIR,
  publicHyperframeJob,
  type HfPageScript,
} from '../services/hyperframeJobService';
import { pumpHyperframeQueue } from '../services/hyperframeWorker';
import { decodeUploadFilename } from '../utils/uploadFilename';
import type { ProjectService } from '../services/projectService';

const MAX_BYTES = 200 * 1024 * 1024;

function getUser(req: Request) {
  return (req as any).user as { id: string; username: string; role: string } | undefined;
}

export function createHyperframeRouter(
  jobs: HyperframeJobService,
  projectService: ProjectService,
): Router {
  const router = Router();
  fs.mkdirSync(HYPERFRAME_UPLOAD_DIR, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const jobId = randomUUID();
      (req as any)._hfJobId = jobId;
      const dir = path.join(HYPERFRAME_UPLOAD_DIR, jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(decodeUploadFilename(file.originalname)).toLowerCase() || '.pptx';
      cb(null, `source${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(decodeUploadFilename(file.originalname)).toLowerCase();
      if (!['.pptx', '.ppt'].includes(ext)) {
        cb(new Error('请上传 PPTX/PPT 文件'));
        return;
      }
      cb(null, true);
    },
  });

  router.get('/jobs', (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user?.id) return res.status(401).json({ success: false, data: null, error: { code: 'AUTH001', message: '未登录' } });
    const rows = jobs.listJobs(user.id, user.role === 'admin');
    res.json({
      success: true,
      data: {
        jobs: rows.map(publicHyperframeJob),
        hasRunning: jobs.hasRunning(),
      },
      error: null,
    });
  });

  router.get('/jobs/:id', (req: Request, res: Response) => {
    const user = getUser(req);
    const row = jobs.getJob(String(req.params.id));
    if (!row) return res.status(404).json({ success: false, data: null, error: { code: '4040', message: '任务不存在' } });
    if (user?.role !== 'admin' && row.user_id !== user?.id) {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '没有权限' } });
    }
    const pub = publicHyperframeJob(row);
    let slides: any[] = [];
    if (row.project_id) {
      const toPublic = (p: string | null) => {
        if (!p) return null;
        const idx = p.replace(/\\/g, '/').lastIndexOf('/data/');
        if (idx >= 0) return p.replace(/\\/g, '/').slice(idx);
        return null;
      };
      slides = (projectService.getSlides(row.project_id) as any[]).map((s) => ({
        pageIndex: s.page_index,
        imageUrl: toPublic(s.image_path),
        thumbnailUrl: toPublic(s.thumbnail_path) || toPublic(s.image_path),
        note: s.note_content || '',
        noteStatus: s.note_status,
      }));
    }
    res.json({ success: true, data: { ...pub, slides }, error: null });
  });

  router.post('/jobs', (req: Request, res: Response) => {
    upload.single('file')(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({ success: false, data: null, error: { code: '4001', message: err.message || '上传失败' } });
      }
      const user = getUser(req);
      if (!user?.id) return res.status(401).json({ success: false, data: null, error: { code: 'AUTH001', message: '未登录' } });
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '请上传 PPT 文件' } });
      }
      const fileName = decodeUploadFilename(file.originalname);
      const name = String(req.body?.name || path.parse(fileName).name || 'HyperFrame 任务').trim();
      const useExistingNote = String(req.body?.use_existing_note ?? req.body?.useExistingNote ?? 'true') !== 'false';
      const row = jobs.createJob({
        id: (req as any)._hfJobId,
        userId: user.id,
        name,
        fileName,
        filePath: file.path,
        config: { useExistingNote },
      });
      pumpHyperframeQueue();
      res.json({ success: true, data: publicHyperframeJob(row), error: null });
    });
  });

  router.put('/jobs/:id/scripts', (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user?.id) return res.status(401).json({ success: false, data: null, error: { code: 'AUTH001', message: '未登录' } });
    const scripts = (req.body?.scripts || req.body) as HfPageScript[];
    if (!Array.isArray(scripts)) {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: 'scripts 必须是数组' } });
    }
    const updated = jobs.saveScripts(String(req.params.id), user.id, scripts);
    if (!updated) {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '无法保存（任务不存在或状态不允许）' } });
    }
    res.json({ success: true, data: publicHyperframeJob(updated), error: null });
  });

  router.post('/jobs/:id/confirm', (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user?.id) return res.status(401).json({ success: false, data: null, error: { code: 'AUTH001', message: '未登录' } });
    const voiceId = req.body?.selected_voice_id || req.body?.selectedVoiceId;
    const modelId = req.body?.selected_model_id || req.body?.selectedModelId;
    if (!voiceId || !modelId) {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '请选择音色与配音模型' } });
    }
    const scripts = req.body?.scripts as HfPageScript[] | undefined;
    if (Array.isArray(scripts)) {
      jobs.saveScripts(String(req.params.id), user.id, scripts);
    }
    const rawPages = req.body?.selected_page_indexes ?? req.body?.selectedPageIndexes;
    const selectedPageIndexes = Array.isArray(rawPages)
      ? rawPages.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
      : undefined;
    const updated = jobs.queueProduce(String(req.params.id), user.id, {
      selectedVoiceId: voiceId,
      selectedModelId: modelId,
      selectedPageIndexes,
    });
    if (!updated) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: '4001', message: '请先完成讲义确认，并至少勾选一页' },
      });
    }
    pumpHyperframeQueue();
    res.json({ success: true, data: publicHyperframeJob(updated), error: null });
  });

  router.get('/jobs/:id/download', (req: Request, res: Response) => {
    const user = getUser(req);
    const row = jobs.getJob(String(req.params.id));
    if (!row) return res.status(404).json({ success: false, data: null, error: { code: '4040', message: '任务不存在' } });
    if (user?.role !== 'admin' && row.user_id !== user?.id) {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '没有权限' } });
    }
    if (!row.video_path || !fs.existsSync(row.video_path)) {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '视频尚未生成' } });
    }
    res.download(row.video_path, `${row.name || 'lecture'}.mp4`);
  });

  router.get('/jobs/:id/composition', (req: Request, res: Response) => {
    const user = getUser(req);
    const row = jobs.getJob(String(req.params.id));
    if (!row) return res.status(404).json({ success: false, data: null, error: { code: '4040', message: '任务不存在' } });
    if (user?.role !== 'admin' && row.user_id !== user?.id) {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '没有权限' } });
    }
    if (!row.composition_dir || !fs.existsSync(path.join(row.composition_dir, 'index.html'))) {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: 'HyperFrames 工程尚未生成' } });
    }
    const indexPath = path.join(row.composition_dir, 'index.html');
    res.type('html').send(fs.readFileSync(indexPath, 'utf8'));
  });

  router.delete('/jobs/:id', (req: Request, res: Response) => {
    const user = getUser(req);
    const row = jobs.getJob(String(req.params.id));
    if (!row) return res.status(404).json({ success: false, data: null, error: { code: '4040', message: '任务不存在' } });
    if (user?.role !== 'admin' && row.user_id !== user?.id) {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '没有权限' } });
    }
    if (row.status === 'running') {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '任务进行中，请稍后再删' } });
    }
    jobs.deleteJob(row.id);
    res.json({ success: true, data: null, error: null });
  });

  return router;
}

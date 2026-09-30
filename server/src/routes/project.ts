import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { ProjectService } from '../services/projectService';
import { PptParserService } from '../services/pptParser';
import { dispatchTask } from '../services/taskDispatcher';

type P = { id: string; pageIndex: string };

const UPLOAD_DIR = path.resolve(process.cwd(), '..', 'data', 'projects', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  fileFilter: (_req, file, cb) => {
    // 修复中文文件名编码：multer 默认用 latin1 编码 originalname
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(originalName).toLowerCase();
    if (ext !== '.pptx') {
      cb(new Error('仅支持PPTX文件'));
      return;
    }
    cb(null, true);
  },
  limits: { fileSize: 200 * 1024 * 1024 },
});

export function createProjectRouter(projectService: ProjectService, pptParser: PptParserService): Router {
  const router = Router();

  const getUserId = (req: Request): string => (req as any).user?.id || '';
  const getUserRole = (req: Request): string => (req as any).user?.role || '';

  // 创建项目（上传PPTX）
  router.post('/', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.name === 'MulterError' && (err as any).code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ success: false, data: null, error: { code: '1002', message: '文件大小超过限制(200MB)' } });
        }
        return res.status(400).json({ success: false, data: null, error: { code: '1001', message: err.message } });
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, data: null, error: { code: '1001', message: '请选择PPTX文件' } });
      }

      const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const project = projectService.createProject(originalName, req.file.size, req.file.path, getUserId(req));

      res.json({ success: true, data: project, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '5000', message: error.message } });
    }
  });

  // 获取项目列表（普通用户只看自己的，管理员可看全部）
  router.get('/', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const role = getUserRole(req);
    const isAdminViewAll = req.query.all === '1' && role === 'admin';
    const projects = isAdminViewAll ? projectService.listAllProjects() : projectService.listProjects(userId);
    res.json({ success: true, data: projects, error: null });
  });

  // 获取项目详情
  router.get('/:id', (req: Request<P>, res: Response) => {
    const project = projectService.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
    }
    // 权限校验：非管理员只能访问自己的项目
    const userId = getUserId(req);
    const role = getUserRole(req);
    if (role !== 'admin' && project.user_id && project.user_id !== userId) {
      return res.status(403).json({ success: false, data: null, error: { code: '403', message: '无权访问该项目' } });
    }
    res.json({ success: true, data: project, error: null });
  });

  // 更新项目配置
  router.put('/:id', (req: Request<P>, res: Response) => {
    try {
      const project = projectService.getProject(req.params.id);
      if (!project) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
      }
      const userId = getUserId(req);
      const role = getUserRole(req);
      if (role !== 'admin' && project.user_id && project.user_id !== userId) {
        return res.status(403).json({ success: false, data: null, error: { code: '403', message: '无权修改该项目' } });
      }
      const updated = projectService.updateProject(req.params.id, req.body);
      res.json({ success: true, data: updated, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '5000', message: error.message } });
    }
  });

  // 删除项目（管理员或项目所有者可删除）
  router.delete('/:id', (req: Request<P>, res: Response) => {
    const project = projectService.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
    }
    const userId = getUserId(req);
    const role = getUserRole(req);
    if (role !== 'admin' && project.user_id && project.user_id !== userId) {
      return res.status(403).json({ success: false, data: null, error: { code: '403', message: '无权删除该项目' } });
    }
    const deleted = projectService.deleteProject(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
    }
    res.json({ success: true, data: null, error: null });
  });

  // 触发PPT解析
  router.post('/:id/parse', async (req: Request<P>, res: Response) => {
    try {
      const projectId = req.params.id;
      const result = await dispatchTask(
        'parse_ppt',
        { projectId },
        projectId,
        async () => pptParser.parsePpt(projectId),
        { timeoutMs: 180000 },
      );
      res.json({ success: true, data: result.result, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '2000', message: error.message } });
    }
  });

  // 获取页面列表
  router.get('/:id/slides', (req: Request<P>, res: Response) => {
    const slides = projectService.getSlides(req.params.id);
    res.json({ success: true, data: slides, error: null });
  });

  // 重新解析单页备注
  router.post('/:id/slides/:pageIndex/reparse', async (req: Request<P>, res: Response) => {
    try {
      const result = await pptParser.reparseSlide(req.params.id, parseInt(req.params.pageIndex));
      res.json({ success: true, data: result, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '2000', message: error.message } });
    }
  });

  // 手动编辑备注内容
  router.patch('/:id/slides/:pageIndex/note', (req: Request<P>, res: Response) => {
    try {
      const { note_content } = req.body;
      if (typeof note_content !== 'string') {
        return res.status(400).json({ success: false, data: null, error: { code: '2001', message: '缺少 note_content' } });
      }
      const pageIndex = parseInt(req.params.pageIndex, 10);
      const content = note_content.trim();
      const charCount = content.length;
      // TTS 语速约 5.5 字/秒
      const estimatedDuration = charCount / 5.5;
      projectService.updateSlide(req.params.id, pageIndex, {
        note_content: content,
        note_char_count: charCount,
        note_status: content ? 'loaded' : 'empty',
        estimated_duration: estimatedDuration,
        script_content: content,
        script_status: content ? 'generated' : 'none',
        dubbing_status: 'pending', // 编辑后需要重新配音
      });
      const updated = projectService.getSlide(req.params.id, pageIndex);
      res.json({ success: true, data: updated, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '2002', message: error.message } });
    }
  });

  // 获取页面图片
  router.get('/:id/slides/:pageIndex/image', (req: Request<P>, res: Response) => {
    const slide = projectService.getSlide(req.params.id, parseInt(req.params.pageIndex)) as any;
    if (!slide || !slide.image_path) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '页面图片不存在' } });
    }
    res.sendFile(slide.image_path);
  });

  // 获取页面缩略图
  router.get('/:id/slides/:pageIndex/thumbnail', (req: Request<P>, res: Response) => {
    const slide = projectService.getSlide(req.params.id, parseInt(req.params.pageIndex)) as any;
    if (!slide || !slide.thumbnail_path) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '缩略图不存在' } });
    }
    res.sendFile(slide.thumbnail_path);
  });

  // 获取页面配音音频（?download=1 时强制附件下载）
  router.get('/:id/slides/:pageIndex/audio', async (req: Request<P>, res: Response) => {
    const pageIndex = parseInt(req.params.pageIndex, 10);
    const slide = projectService.getSlide(req.params.id, pageIndex) as any;
    if (!slide || !slide.dubbing_audio_path) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: '音频不存在' } });
    }
    const audioPath = slide.dubbing_audio_path;
    const asDownload = String(req.query.download || '') === '1';
    const filename = `slide_${pageIndex}.wav`;

    const setDownloadHeaders = (contentType: string) => {
      res.setHeader('Content-Type', contentType);
      if (asDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      } else {
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      }
    };

    // If audioPath is a URL (from Voicebox), proxy the audio
    if (audioPath.startsWith('http://') || audioPath.startsWith('https://')) {
      try {
        const axios = (await import('axios')).default;
        const audioRes = await axios.get(audioPath, { responseType: 'stream', timeout: 30000 });
        const contentType = (audioRes.headers['content-type'] as string) || 'audio/wav';
        setDownloadHeaders(contentType);
        if (audioRes.headers['content-length']) {
          res.setHeader('Content-Length', audioRes.headers['content-length'] as string);
        }
        audioRes.data.pipe(res);
      } catch (err: any) {
        res.status(502).json({ success: false, data: null, error: { code: '5004', message: '音频代理失败: ' + err.message } });
      }
      return;
    }

    // Local file path
    const ext = path.extname(audioPath).toLowerCase();
    const localName = ext ? `slide_${pageIndex}${ext}` : filename;
    if (asDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${localName}"`);
    }
    res.sendFile(audioPath);
  });

  // 自动保存
  router.post('/:id/autosave', (req: Request<P>, res: Response) => {
    const project = projectService.updateProject(req.params.id, {
      ...req.body,
      last_saved_at: new Date().toISOString(),
    });
    res.json({ success: true, data: project, error: null });
  });

  // 重新导入PPT（替换原文件）
  router.post('/:id/reimport', upload.single('file'), async (req: Request<P>, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, data: null, error: { code: '1001', message: '请选择PPTX文件' } });
      }

      const project = projectService.getProject(req.params.id);
      if (!project) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '项目不存在' } });
      }

      const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const projectDir = path.dirname(project.file_path);
      const destFilePath = path.join(projectDir, originalName);

      // 清除旧的slides数据
      projectService.deleteSlides(req.params.id);

      // 移动新文件到项目目录
      fs.copyFileSync(req.file.path, destFilePath);

      // 清理上传临时文件
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }

      // 重置项目状态
      const updatedProject = projectService.updateProject(req.params.id, {
        file_name: originalName,
        file_size: req.file.size,
        file_path: destFilePath,
        parse_status: 'pending',
        video_status: 'none',
        selected_voice_id: null,
        selected_model_id: null,
        video_file_path: null,
      });

      res.json({ success: true, data: updatedProject, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '5000', message: error.message } });
    }
  });

  // 标记配音为需要重新生成
  router.put('/:id/dubbing/mark-regenerate', (req: Request<P>, res: Response) => {
    try {
      projectService.markSlidesRegenerate(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '5000', message: error.message } });
    }
  });

  return router;
}

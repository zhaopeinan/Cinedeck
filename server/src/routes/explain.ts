import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { ExplainJobService, EXPLAIN_UPLOAD_DIR } from '../services/explainJobService';
import { pumpExplainQueue, resumeExplainJob } from '../services/explainWorker';
import { getExplainPosterPath, getExplainStyle, listExplainStyles } from '../services/explainStyleCatalog';
import { LlmService } from '../services/llmService';
import { decodeUploadFilename } from '../utils/uploadFilename';

function getUserId(req: Request): string {
  return (req as any).user?.id || '';
}

export function createExplainRouter(jobs: ExplainJobService, llm: LlmService): Router {
  const router = Router();
  fs.mkdirSync(EXPLAIN_UPLOAD_DIR, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = path.join(EXPLAIN_UPLOAD_DIR, randomUUID());
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        cb(null, decodeUploadFilename(file.originalname) || 'source.txt');
      },
    }),
    limits: { fileSize: 40 * 1024 * 1024 },
  });

  router.get('/styles', (_req: Request, res: Response) => {
    const styles = listExplainStyles().map((s) => ({
      id: s.id,
      name: s.name,
      nameZh: s.nameZh,
      family: s.family,
      familyZh: s.familyZh,
      description: s.description,
      hasPoster: !!getExplainPosterPath(s.id),
      variants: s.variants || null,
    }));
    res.json({ success: true, data: { styles }, error: null });
  });

  router.get('/styles/:id/poster', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const variant = typeof req.query.variant === 'string' ? req.query.variant : null;
    const p = getExplainPosterPath(id, variant);
    if (!p) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.resolve(p));
  });

  router.get('/llm-status', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const cfg = llm.resolveConfig({ userId, module: 'explain' });
    res.json({
      success: true,
      data: {
        configured: !!cfg,
        name: cfg?.name || null,
        modelName: cfg?.model_name || null,
        baseUrl: cfg?.base_url || null,
      },
      error: null,
    });
  });

  router.get('/jobs', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, data: null, error: { code: '401', message: '未登录' } });
    const rows = jobs.listJobs(userId).map((j) => jobs.publicRow(j));
    res.json({ success: true, data: { jobs: rows }, error: null });
  });

  router.get('/jobs/:id', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = jobs.getOwned(String(req.params.id), userId);
    if (!job) return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    res.json({ success: true, data: jobs.publicRow(job), error: null });
  });

  router.post('/jobs', upload.single('file'), (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, data: null, error: { code: '401', message: '未登录' } });

    const cfg = llm.resolveConfig({ userId, module: 'explain' });
    if (!cfg) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: 'LLM_REQUIRED', message: '请先在「设置 → 大模型」中配置并激活 LLM API' },
      });
    }

    const topicText = String(req.body?.topic || req.body?.text || '').trim();
    const file = req.file;
    if (!topicText && !file) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: '400', message: '请粘贴选题文本或上传文件' },
      });
    }

    const name = String(req.body?.name || '').trim()
      || (topicText ? topicText.slice(0, 40) : (file ? decodeUploadFilename(file.originalname) : '讲解动画'));

    const job = jobs.createJob({
      userId,
      name,
      topicText,
      sourceType: file ? 'file' : 'text',
      sourceFileName: file ? decodeUploadFilename(file.originalname) : null,
      sourceFilePath: file ? file.path : null,
    });
    pumpExplainQueue();
    res.json({ success: true, data: jobs.publicRow(job), error: null });
  });

  router.post('/jobs/:id/select-style', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = jobs.getOwned(String(req.params.id), userId);
    if (!job) return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    if (job.status !== 'await_style') {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: '400', message: '当前不在选风格阶段' },
      });
    }
    const styleId = Number(req.body?.styleId ?? req.body?.style_id);
    const style = getExplainStyle(styleId);
    if (!style) {
      return res.status(400).json({ success: false, data: null, error: { code: '400', message: '无效风格' } });
    }
    const voiceoverRaw = String(req.body?.voiceover || 'none').toLowerCase();
    const voiceover = voiceoverRaw === 'zh' || voiceoverRaw === 'en' ? voiceoverRaw : 'none';
    const variant = req.body?.variant ? String(req.body.variant) : null;

    jobs.updateJob(job.id, {
      selected_style_id: styleId,
      selected_variant: variant,
      voiceover: voiceover as any,
    });
    const updated = jobs.getJob(job.id)!;
    resumeExplainJob(updated, 'sample');
    res.json({ success: true, data: jobs.publicRow(jobs.getJob(job.id)!), error: null });
  });

  router.post('/jobs/:id/approve-sample', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = jobs.getOwned(String(req.params.id), userId);
    if (!job) return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    if (job.status !== 'await_sample') {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: '400', message: '当前不在样片确认阶段' },
      });
    }
    resumeExplainJob(job, 'final');
    res.json({ success: true, data: jobs.publicRow(jobs.getJob(job.id)!), error: null });
  });

  router.post('/jobs/:id/reject-sample', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = jobs.getOwned(String(req.params.id), userId);
    if (!job) return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    if (job.status !== 'await_sample') {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: '400', message: '当前不在样片确认阶段' },
      });
    }
    // regenerate sample with same style
    resumeExplainJob(job, 'sample');
    res.json({ success: true, data: jobs.publicRow(jobs.getJob(job.id)!), error: null });
  });

  router.post('/jobs/:id/retry', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = jobs.getOwned(String(req.params.id), userId);
    if (!job) return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: '400', message: '仅失败或已取消的任务可重试' },
      });
    }
    // Clear corrupted binary topic so worker re-extracts from source file
    const topic = String(job.topic_text || '');
    const badTopic = topic.includes('[Content_Types].xml') || /^PK[\x03\x04]/.test(topic);
    jobs.updateJob(job.id, {
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: '已重新排队',
      error: null,
      cancel_requested: 0,
      finished_at: null,
      recommendations_json: null,
      selected_style_id: null,
      sample_path: null,
      final_path: null,
      ...(badTopic ? { topic_text: '' } : {}),
    });
    pumpExplainQueue();
    res.json({ success: true, data: jobs.publicRow(jobs.getJob(job.id)!), error: null });
  });

  router.post('/jobs/:id/cancel', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const updated = jobs.requestCancel(String(req.params.id), userId);
    if (!updated) return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    res.json({ success: true, data: jobs.publicRow(updated), error: null });
  });

  router.delete('/jobs/:id', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const ok = jobs.deleteJob(String(req.params.id), userId);
    if (!ok) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: '400', message: '无法删除（不存在或仍在运行）' },
      });
    }
    res.json({ success: true, data: null, error: null });
  });

  const sendHtml = (req: Request, res: Response, kind: 'sample' | 'final') => {
    const userId = getUserId(req);
    const job = jobs.getOwned(String(req.params.id), userId);
    if (!job) return res.status(404).end();
    const filePath = kind === 'sample' ? job.sample_path : job.final_path;
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.resolve(filePath));
  };

  router.get('/jobs/:id/sample', (req, res) => sendHtml(req, res, 'sample'));
  router.get('/jobs/:id/final', (req, res) => sendHtml(req, res, 'final'));

  return router;
}

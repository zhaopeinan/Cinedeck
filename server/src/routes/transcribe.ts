import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import {
  TranscribeJobService,
  TRANSCRIBE_UPLOAD_DIR,
  publicTranscribeJob,
} from '../services/transcribeJobService';
import { decodeUploadFilename } from '../utils/uploadFilename';
import { pumpTranscribeQueue } from '../services/transcribeWorker';
import { shouldSimplifyTranscript, toSimplifiedChinese } from '../utils/toSimplifiedChinese';

const MAX_BYTES = 500 * 1024 * 1024;
const ALLOWED_EXT = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.flv', '.m4v', '.mpeg', '.mpg', '.wmv', '.3gp',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma',
]);

function getUser(req: Request) {
  return (req as any).user as { id: string; username: string; role: string } | undefined;
}

function cleanupJobFiles(filePath: string, audioPath: string | null) {
  for (const p of [filePath, audioPath]) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
  try {
    const dir = path.dirname(filePath);
    if (dir.startsWith(TRANSCRIBE_UPLOAD_DIR) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch { /* ignore */ }
}

export function createTranscribeRouter(jobs: TranscribeJobService): Router {
  const router = Router();
  fs.mkdirSync(TRANSCRIBE_UPLOAD_DIR, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const jobId = randomUUID();
      (req as any)._transcribeJobId = jobId;
      const dir = path.join(TRANSCRIBE_UPLOAD_DIR, jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(decodeUploadFilename(file.originalname)).toLowerCase() || '.mp4';
      cb(null, `source${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(decodeUploadFilename(file.originalname)).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        cb(new Error(`不支持的格式 ${ext || '(无后缀)'}，请上传常见视频或音频文件`));
        return;
      }
      cb(null, true);
    },
  });

  router.get('/jobs', (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user?.id) return res.status(401).json({ success: false, data: null, error: { code: 'AUTH001', message: '未登录' } });
    const rows = jobs.listByUser(user.id, user.role === 'admin');
    res.json({ success: true, data: rows.map(publicTranscribeJob), error: null });
  });

  router.get('/jobs/:id', (req: Request, res: Response) => {
    const user = getUser(req);
    const id = String(req.params.id);
    const row = jobs.get(id);
    if (!row) return res.status(404).json({ success: false, data: null, error: { code: '4040', message: '任务不存在' } });
    if (user?.role !== 'admin' && row.user_id !== user?.id) {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '没有权限' } });
    }
    res.json({ success: true, data: publicTranscribeJob(row), error: null });
  });

  router.get('/jobs/:id/download', (req: Request, res: Response) => {
    const user = getUser(req);
    const id = String(req.params.id);
    const row = jobs.get(id);
    if (!row) return res.status(404).json({ success: false, data: null, error: { code: '4040', message: '任务不存在' } });
    if (user?.role !== 'admin' && row.user_id !== user?.id) {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '没有权限' } });
    }
    if (!row.text) {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '尚未生成文本' } });
    }
    const base = path.parse(decodeUploadFilename(row.file_name)).name || '转写结果';
    const filename = `${base}.txt`;
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_') || 'transcript.txt';
    const body = shouldSimplifyTranscript(row.language)
      ? toSimplifiedChinese(row.text)
      : row.text;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(`\uFEFF${body}`);
  });

  router.post('/jobs', (req: Request, res: Response) => {
    upload.single('file')(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: '4001', message: err.message || '上传失败' },
        });
      }
      const user = getUser(req);
      if (!user?.id) return res.status(401).json({ success: false, data: null, error: { code: 'AUTH001', message: '未登录' } });
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '请上传视频或音频文件' } });
      }
      const language = String(req.body?.language || 'auto').trim() || 'auto';
      const model = String(req.body?.model || 'base').trim() || 'base';
      const row = jobs.createJob({
        id: (req as any)._transcribeJobId,
        userId: user.id,
        fileName: decodeUploadFilename(file.originalname),
        filePath: file.path,
        language: language === 'auto' ? null : language,
        model,
      });
      pumpTranscribeQueue();
      res.json({ success: true, data: publicTranscribeJob(row), error: null });
    });
  });


  router.post('/jobs/:id/reset', (req: Request, res: Response) => {
    const user = getUser(req);
    const id = String(req.params.id);
    const row = jobs.get(id);
    if (!row) return res.status(404).json({ success: false, data: null, error: { code: '4040', message: '任务不存在' } });
    if (user?.role !== 'admin' && row.user_id !== user?.id) {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '没有权限' } });
    }
    if (!row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '源文件已删除，请重新上传' } });
    }
    const updated = jobs.forceRequeue(row.id, '已强制重新排队，将从断点续跑');
    if (!updated) {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '当前状态无法重置' } });
    }
    pumpTranscribeQueue();
    res.json({ success: true, data: publicTranscribeJob(updated), error: null });
  });

  router.post('/jobs/:id/retry', (req: Request, res: Response) => {
    const user = getUser(req);
    const id = String(req.params.id);
    const row = jobs.get(id);
    if (!row) return res.status(404).json({ success: false, data: null, error: { code: '4040', message: '任务不存在' } });
    if (user?.role !== 'admin' && row.user_id !== user?.id) {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '没有权限' } });
    }
    if (row.status === 'running' || row.status === 'queued') {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '任务已在队列中' } });
    }
    if (!row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '源文件已删除，请重新上传' } });
    }
    jobs.update(row.id, {
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: '重新排队（有断点则续跑）',
      error: null,
      // keep parts.json for resume; clear displayed text until done
      text: null,
      finished_at: null,
      file_name: decodeUploadFilename(row.file_name),
    });
    pumpTranscribeQueue();
    res.json({ success: true, data: publicTranscribeJob(jobs.get(row.id)!), error: null });
  });

  router.delete('/jobs/:id', (req: Request, res: Response) => {
    const user = getUser(req);
    const id = String(req.params.id);
    const row = jobs.get(id);
    if (!row) return res.status(404).json({ success: false, data: null, error: { code: '4040', message: '任务不存在' } });
    if (user?.role !== 'admin' && row.user_id !== user?.id) {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '没有权限' } });
    }
    if (row.status === 'running') {
      return res.status(400).json({ success: false, data: null, error: { code: '4001', message: '任务进行中，请稍后再删' } });
    }
    jobs.delete(row.id);
    cleanupJobFiles(row.file_path, row.audio_path);
    res.json({ success: true, data: null, error: null });
  });

  return router;
}

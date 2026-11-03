import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { VoiceboxAdapter } from '../../services/voiceboxAdapter';
import { ensureVoiceboxRunningForAudio } from '../../services/avatarWorker';
import { createApiKeyAuth } from '../../middleware/apiKeyAuth';
import { OpenApiKeyService } from '../../services/openApiKeyService';

type P = { id: string };

const UPLOAD_DIR = path.resolve(process.cwd(), '..', 'data', 'open-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const voiceUpload = multer({
  dest: UPLOAD_DIR,
  fileFilter: (_req, file, cb) => {
    const allowed = ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.opus'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

export function createOpenTtsRouter(
  voicebox: VoiceboxAdapter,
  openApiKeys: OpenApiKeyService,
): Router {
  const router = Router();
  const { apiKeyRequired, requireScope } = createApiKeyAuth(openApiKeys);

  router.use(apiKeyRequired, requireScope('tts'));

  const unavailable = (res: Response, message: string) => {
    res.status(503).json({ success: false, data: null, error: { code: '5003', message } });
  };

  router.get('/voices', async (req: Request, res: Response) => {
    try {
      await ensureVoiceboxRunningForAudio();
      const voices = await voicebox.listVoices(req.query as any);
      res.json({ success: true, data: voices, error: null });
    } catch {
      unavailable(res, 'Voicebox 服务未启动，音色列表不可用');
    }
  });

  router.post('/voices', voiceUpload.single('audio'), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      const { name, language, description, referenceText, reference_text } = req.body || {};
      if (!name || !language) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: '3006', message: '缺少必要参数：name, language' },
        });
      }
      if (!file?.path) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: '3006', message: '请上传参考音频（字段名 audio）' },
        });
      }

      await ensureVoiceboxRunningForAudio();
      const voice = await voicebox.createVoiceFromUpload({
        name,
        language,
        description: description || '',
        audioPath: file.path,
        originalName: file.originalname,
        referenceText: referenceText || reference_text || '',
      });
      res.json({ success: true, data: voice, error: null });
    } catch (error: any) {
      const status = error?.response?.status;
      const detail = error?.response?.data?.detail;
      let message = error?.message || 'Voicebox 服务未启动，无法创建音色';
      if (Array.isArray(detail) && detail[0]?.msg) {
        message = detail.map((d: any) => d.msg).filter(Boolean).join('；');
      } else if (typeof detail === 'string') {
        message = detail;
      }
      const code = status && status >= 400 && status < 500 ? status : 503;
      res.status(code).json({ success: false, data: null, error: { code: '3006', message } });
    } finally {
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
    }
  });

  router.delete('/voices/:id', async (req: Request<P>, res: Response) => {
    try {
      await voicebox.deleteVoice(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(503).json({
        success: false,
        data: null,
        error: { code: '3002', message: error.message || 'Voicebox 服务未启动' },
      });
    }
  });

  router.get('/voices/:id/sample', async (req: Request<P>, res: Response) => {
    try {
      await ensureVoiceboxRunningForAudio();
      const { data, contentType } = await voicebox.getVoiceSampleBuffer(req.params.id);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(data);
    } catch (error: any) {
      res.status(503).json({
        success: false,
        data: null,
        error: { code: '3003', message: error.message || '试听失败' },
      });
    }
  });

  router.post('/generate', async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      await ensureVoiceboxRunningForAudio();
      const task = await voicebox.generateDubbing({
        text: b.text,
        voiceId: b.voiceId || b.voice_id,
        modelId: b.modelId || b.model_id,
        language: b.language || 'zh-CN',
        maxChunkChars: b.maxChunkChars ?? b.max_chunk_chars,
        instruct: b.instruct,
      });
      res.json({ success: true, data: task, error: null });
    } catch (error: any) {
      const status = /缺少/.test(error.message || '') ? 400 : 503;
      res.status(status).json({
        success: false,
        data: null,
        error: { code: '5002', message: error.message || 'Voicebox 服务未启动，无法生成配音' },
      });
    }
  });

  router.get('/tasks/:id', async (req: Request<P>, res: Response) => {
    try {
      const task = await voicebox.getTaskStatus(req.params.id);
      res.json({ success: true, data: task, error: null });
    } catch {
      res.json({ success: true, data: { status: 'failed', error: 'Voicebox 服务不可用' }, error: null });
    }
  });

  router.get('/tasks/:id/result', async (req: Request<P>, res: Response) => {
    try {
      const result = await voicebox.getTaskResult(req.params.id);
      res.json({
        success: true,
        data: { ...result, audioUrl: `/api/open/v1/tts/tasks/${req.params.id}/audio` },
        error: null,
      });
    } catch (error: any) {
      res.status(503).json({
        success: false,
        data: null,
        error: { code: '5002', message: error.message || '获取生成结果失败' },
      });
    }
  });

  router.get('/tasks/:id/audio', async (req: Request<P>, res: Response) => {
    try {
      const { data, contentType } = await voicebox.getTaskAudioBuffer(req.params.id);
      const download = String(req.query.download || '') === '1';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (download) {
        res.setHeader('Content-Disposition', `attachment; filename="tts-${req.params.id}.wav"`);
      }
      res.send(data);
    } catch (error: any) {
      res.status(503).json({
        success: false,
        data: null,
        error: { code: '5002', message: error.message || '音频不可用' },
      });
    }
  });

  router.post('/tasks/:id/cancel', async (req: Request<P>, res: Response) => {
    try {
      await voicebox.cancelTask(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch {
      res.json({ success: true, data: null, error: null });
    }
  });

  return router;
}

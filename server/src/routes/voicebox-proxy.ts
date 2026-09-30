import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { VoiceboxAdapter } from '../services/voiceboxAdapter';
import { ensureVoiceboxRunningForAudio } from '../services/avatarWorker';
import { DialogueJobService } from '../services/dialogueJobService';
import { parseDialogueScript, validateCast } from '../services/dialogueScript';
import { pumpDialogueQueue } from '../services/dialogueGenerator';

type P = { id: string };

// Multer config for voice uploads
const UPLOAD_DIR = path.resolve(process.cwd(), '..', 'data', 'voice-uploads');
const voiceUpload = multer({
  dest: UPLOAD_DIR,
  fileFilter: (_req, file, cb) => {
    const allowed = ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.opus'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

function getUserId(req: Request): string {
  return (req as any).user?.id || '';
}

export function createVoiceboxRouter(
  voicebox: VoiceboxAdapter,
  dialogueJobs?: DialogueJobService,
): Router {
  const router = Router();

  // Voicebox 不可用时：用 503 + success:false，避免前端把空列表当成“真的没有音色”
  const unavailableResponse = (res: Response, message: string) => {
    res.status(503).json({ success: false, data: [], error: { code: '5003', message } });
  };

  // 健康检查
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const result = await voicebox.healthCheck();
      res.json({ success: true, data: result, error: null });
    } catch {
      res.json({ success: true, data: { available: false, version: '' }, error: null });
    }
  });

  // 获取音色列表
  router.get('/voices', async (req: Request, res: Response) => {
    try {
      await ensureVoiceboxRunningForAudio();
      const voices = await voicebox.listVoices(req.query as any);
      res.json({ success: true, data: voices, error: null });
    } catch {
      unavailableResponse(res, 'Voicebox服务未启动，音色列表不可用');
    }
  });

  // 创建个人音色（multipart form-data）
  router.post('/voices', voiceUpload.single('audio'), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      const { name, language, description } = req.body;

      if (!name || !language) {
        return res.status(400).json({ success: false, data: null, error: { code: '3006', message: '缺少必要参数：name, language' } });
      }

      const voice = await voicebox.createVoiceFromUpload({
        name,
        language,
        description: description || '',
        audioPath: file?.path || '',
        originalName: file?.originalname,
      });
      res.json({ success: true, data: voice, error: null });
    } catch (error: any) {
      res.status(503).json({ success: false, data: null, error: { code: '3006', message: error.message || 'Voicebox服务未启动，无法创建音色' } });
    }
  });

  // 删除音色
  router.delete('/voices/:id', async (req: Request<P>, res: Response) => {
    try {
      await voicebox.deleteVoice(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(503).json({ success: false, data: null, error: { code: '3002', message: error.message || 'Voicebox服务未启动' } });
    }
  });

  // 获取音色试听（代理音频流，避免重定向到容器内网地址）
  // 预置音色无克隆样本时会现场合成短试听并缓存，可能需要数十秒
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
        error: { code: '3003', message: error.message || '试听失败，Voicebox服务未启动' },
      });
    }
  });

  // 获取模型列表
  router.get('/models', async (req: Request, res: Response) => {
    try {
      await ensureVoiceboxRunningForAudio();
      const models = await voicebox.listModels(req.query as any);
      res.json({ success: true, data: models, error: null });
    } catch {
      unavailableResponse(res, 'Voicebox服务未启动，模型列表不可用');
    }
  });

  // 下载模型
  router.post('/models/:id/download', async (req: Request<P>, res: Response) => {
    try {
      await voicebox.downloadModel(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(503).json({ success: false, data: null, error: { code: '4003', message: error.message || 'Voicebox服务未启动' } });
    }
  });

  // 暂停下载
  router.post('/models/:id/download/pause', async (req: Request<P>, res: Response) => {
    try {
      await voicebox.pauseModelDownload(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(503).json({ success: false, data: null, error: { code: '4003', message: error.message || 'Voicebox服务未启动' } });
    }
  });

  // 继续下载
  router.post('/models/:id/download/resume', async (req: Request<P>, res: Response) => {
    try {
      await voicebox.resumeModelDownload(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(503).json({ success: false, data: null, error: { code: '4003', message: error.message || 'Voicebox服务未启动' } });
    }
  });

  // 取消下载
  router.post('/models/:id/download/cancel', async (req: Request<P>, res: Response) => {
    try {
      await voicebox.cancelModelDownload(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(503).json({ success: false, data: null, error: { code: '4003', message: error.message || 'Voicebox服务未启动' } });
    }
  });

  // 删除模型
  router.delete('/models/:id', async (req: Request<P>, res: Response) => {
    try {
      await voicebox.deleteModel(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(503).json({ success: false, data: null, error: { code: '4001', message: error.message || 'Voicebox服务未启动' } });
    }
  });

  // 获取模型状态
  router.get('/models/:id/status', async (req: Request<P>, res: Response) => {
    try {
      const status = await voicebox.getModelStatus(req.params.id);
      res.json({ success: true, data: status, error: null });
    } catch {
      res.json({ success: true, data: { status: 'unavailable' }, error: null });
    }
  });

  // 生成配音 / 造声工厂试听
  router.post('/generate', async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
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
      res.status(status).json({ success: false, data: null, error: { code: '5002', message: error.message || 'Voicebox服务未启动，无法生成配音' } });
    }
  });

  // 查询任务状态
  router.get('/tasks/:id', async (req: Request<P>, res: Response) => {
    try {
      const task = await voicebox.getTaskStatus(req.params.id);
      res.json({ success: true, data: task, error: null });
    } catch {
      res.json({ success: true, data: { status: 'failed', error: 'Voicebox服务不可用' }, error: null });
    }
  });

  // 任务结果（时长等）
  router.get('/tasks/:id/result', async (req: Request<P>, res: Response) => {
    try {
      const result = await voicebox.getTaskResult(req.params.id);
      res.json({
        success: true,
        data: { ...result, audioUrl: `/api/v1/voicebox/tasks/${req.params.id}/audio` },
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

  // 播放 / 下载生成音频（代理 Voicebox，避免容器内网地址）
  router.get('/tasks/:id/audio', async (req: Request<P>, res: Response) => {
    try {
      const { data, contentType } = await voicebox.getTaskAudioBuffer(req.params.id);
      const download = String(req.query.download || '') === '1';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (download) {
        const name = `voice-factory-${req.params.id}.wav`;
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
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

  // 取消任务
  router.post('/tasks/:id/cancel', async (req: Request<P>, res: Response) => {
    try {
      await voicebox.cancelTask(req.params.id);
      res.json({ success: true, data: null, error: null });
    } catch {
      res.json({ success: true, data: null, error: null });
    }
  });

  // ── 多人对话（造声工厂）────────────────────────────────────────────

  if (dialogueJobs) {
    router.post('/dialogue/preview', (req: Request, res: Response) => {
      try {
        const script = String(req.body?.script || req.body?.scriptText || '');
        const parsed = parseDialogueScript(script);
        res.json({
          success: true,
          data: {
            segmentCount: parsed.segments.length,
            speakers: parsed.speakers,
            preview: parsed.segments.slice(0, 20).map((s) => ({
              speaker: s.speaker,
              text: s.text.slice(0, 80),
              lineNo: s.lineNo,
            })),
          },
          error: null,
        });
      } catch (error: any) {
        res.status(400).json({
          success: false, data: null,
          error: { code: '400', message: error.message || '解析失败' },
        });
      }
    });

    router.get('/dialogue', (req: Request, res: Response) => {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ success: false, data: null, error: { code: '401', message: '未登录' } });
      }
      const rows = dialogueJobs.listJobs(userId).map((j) => dialogueJobs.publicRow(j));
      res.json({
        success: true,
        data: { jobs: rows, queue: { hasRunning: dialogueJobs.hasRunning() } },
        error: null,
      });
    });

    router.post('/dialogue', async (req: Request, res: Response) => {
      try {
        const userId = getUserId(req);
        if (!userId) {
          return res.status(401).json({ success: false, data: null, error: { code: '401', message: '未登录' } });
        }
        const b = req.body || {};
        const script = String(b.script || b.scriptText || '');
        const modelId = String(b.modelId || b.model_id || '');
        if (!modelId) {
          return res.status(400).json({
            success: false, data: null,
            error: { code: '400', message: '请选择配音模型' },
          });
        }

        let cast: Record<string, string> = {};
        if (b.cast && typeof b.cast === 'object') {
          for (const [k, v] of Object.entries(b.cast)) {
            if (typeof v === 'string' && v.trim()) cast[String(k).trim()] = v.trim();
          }
        }

        const parsed = parseDialogueScript(script);
        const castCheck = validateCast(parsed.speakers, cast);
        if (!castCheck.ok) {
          return res.status(400).json({
            success: false, data: null,
            error: { code: '400', message: `角色未映射音色：${castCheck.missing.join('、')}` },
          });
        }

        // Soft-correct model when cast mixes with incompatible engine (preset ↔ CustomVoice)
        let resolvedModelId = modelId;
        try {
          const voiceIds = [...new Set(Object.values(cast))];
          const metas = await Promise.all(voiceIds.map((id) => voicebox.getVoice(id).catch(() => null)));
          const hasPreset = metas.some((v) => v && (v.source === 'preset' || v._voiceboxProfile?.voice_type === 'preset'));
          const hasClone = metas.some((v) => v && v.source !== 'preset' && v._voiceboxProfile?.voice_type !== 'preset');
          const eng = String(modelId).toLowerCase().replace(/-/g, '_');
          const isCustom = eng.includes('custom');
          if (hasPreset && !isCustom) {
            const size = modelId.includes('0.6B') ? '0.6B' : '1.7B';
            resolvedModelId = `qwen-custom-voice-${size}`;
          } else if (hasClone && !hasPreset && isCustom) {
            const size = modelId.includes('0.6B') ? '0.6B' : '1.7B';
            resolvedModelId = `qwen-tts-${size}`;
          }
        } catch {
          resolvedModelId = modelId;
        }

        const job = dialogueJobs.createJob({
          userId,
          name: b.name ? String(b.name) : undefined,
          scriptText: script,
          cast,
          modelId: resolvedModelId,
          language: String(b.language || 'zh-CN'),
          instruct: b.instruct ? String(b.instruct) : null,
          gapMs: Number.isFinite(Number(b.gapMs ?? b.gap_ms)) ? Number(b.gapMs ?? b.gap_ms) : undefined,
          maxChunkChars: Number.isFinite(Number(b.maxChunkChars ?? b.max_chunk_chars))
            ? Number(b.maxChunkChars ?? b.max_chunk_chars)
            : undefined,
          segmentCount: parsed.segments.length,
        });

        pumpDialogueQueue();
        res.json({ success: true, data: dialogueJobs.publicRow(job), error: null });
      } catch (error: any) {
        const status = /剧本|解析|角色|段数|过长/.test(error.message || '') ? 400 : 500;
        res.status(status).json({
          success: false, data: null,
          error: { code: String(status), message: error.message || '创建失败' },
        });
      }
    });

    router.get('/dialogue/:id', (req: Request<P>, res: Response) => {
      const userId = getUserId(req);
      const job = dialogueJobs.getOwned(String(req.params.id), userId);
      if (!job) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
      }
      res.json({ success: true, data: dialogueJobs.publicRow(job), error: null });
    });

    router.post('/dialogue/:id/cancel', (req: Request<P>, res: Response) => {
      const userId = getUserId(req);
      const updated = dialogueJobs.requestCancel(String(req.params.id), userId);
      if (!updated) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
      }
      res.json({ success: true, data: dialogueJobs.publicRow(updated), error: null });
    });

    router.get('/dialogue/:id/audio', (req: Request<P>, res: Response) => {
      const userId = getUserId(req);
      const job = dialogueJobs.getOwned(String(req.params.id), userId);
      if (!job || !job.output_path || !fs.existsSync(job.output_path)) {
        return res.status(404).json({ success: false, data: null, error: { code: '404', message: '音频不存在' } });
      }
      const displayName = String(job.name || 'dialogue')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 80) || 'dialogue';
      // HTTP headers must be ASCII; put UTF-8 name in filename*
      const asciiName = displayName.replace(/[^\x20-\x7E]/g, '_') || 'dialogue';
      const utf8Name = encodeURIComponent(`${displayName}.wav`);
      const asDownload = String(req.query.download || '') === '1';
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader(
        'Content-Disposition',
        `${asDownload ? 'attachment' : 'inline'}; filename="${asciiName}.wav"; filename*=UTF-8''${utf8Name}`,
      );
      res.setHeader('Accept-Ranges', 'bytes');
      res.sendFile(job.output_path);
    });

    router.delete('/dialogue/:id', (req: Request<P>, res: Response) => {
      const userId = getUserId(req);
      const ok = dialogueJobs.deleteJob(String(req.params.id), userId);
      if (!ok) {
        return res.status(400).json({
          success: false, data: null,
          error: { code: '400', message: '无法删除（任务不存在或正在运行）' },
        });
      }
      res.json({ success: true, data: { id: req.params.id }, error: null });
    });
  }

  return router;
}

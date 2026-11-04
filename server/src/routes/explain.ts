import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { ExplainJobService, EXPLAIN_UPLOAD_DIR } from '../services/explainJobService';
import { pumpExplainQueue, resumeExplainJob } from '../services/explainWorker';
import { getExplainPosterPath, getExplainStyle, listExplainStyles } from '../services/explainStyleCatalog';
import { LlmService } from '../services/llmService';
import { ExplainGenSettingsService } from '../services/explainGenSettings';
import {
  EXPLAIN_EXPORT_QUALITIES,
  estimateExplainDurationSec,
  exportExplainHtmlToMp4,
  probeAudioDurationSec,
  type ExplainExportQuality,
} from '../services/explainExport';
import { decodeUploadFilename } from '../utils/uploadFilename';

function getUserId(req: Request): string {
  return (req as any).user?.id || '';
}

function parseVoiceBody(body: any): {
  ok: true;
  voiceover: 'none' | 'zh' | 'en';
  voiceId: string | null;
  modelId: string | null;
} | { ok: false; message: string } {
  const voiceoverRaw = String(body?.voiceover || 'none').toLowerCase();
  const voiceover = voiceoverRaw === 'zh' || voiceoverRaw === 'en' ? voiceoverRaw : 'none';
  const voiceId = String(body?.voiceId ?? body?.voice_id ?? '').trim() || null;
  const modelId = String(body?.modelId ?? body?.model_id ?? '').trim() || null;
  if (voiceover !== 'none' && !voiceId) {
    return { ok: false, message: '已选择配音语言，请再选择一个音色（可先试听）' };
  }
  if (voiceover !== 'none' && !modelId) {
    return { ok: false, message: '请选择配音模型' };
  }
  return {
    ok: true,
    voiceover,
    voiceId: voiceover === 'none' ? null : voiceId,
    modelId: voiceover === 'none' ? null : modelId,
  };
}

export function createExplainRouter(
  jobs: ExplainJobService,
  llm: LlmService,
  genSettings: ExplainGenSettingsService,
): Router {
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
    const gen = genSettings.getForUser(userId);
    res.json({
      success: true,
      data: {
        configured: !!cfg,
        name: cfg?.name || null,
        modelName: cfg?.model_name || null,
        baseUrl: cfg?.base_url || null,
        genSettings: gen,
      },
      error: null,
    });
  });

  router.get('/gen-settings', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, data: null, error: { code: '401', message: '未登录' } });
    res.json({ success: true, data: genSettings.publicPayload(userId), error: null });
  });

  router.put('/gen-settings', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, data: null, error: { code: '401', message: '未登录' } });
    try {
      const body = req.body || {};
      genSettings.setForUser(userId, {
        maxTokensRecommend: body.maxTokensRecommend ?? body.max_tokens_recommend,
        maxTokensScript: body.maxTokensScript ?? body.max_tokens_script,
        maxTokensSample: body.maxTokensSample ?? body.max_tokens_sample,
        maxTokensFinal: body.maxTokensFinal ?? body.max_tokens_final,
        reasoningEffort: body.reasoningEffort ?? body.reasoning_effort,
      });
      res.json({ success: true, data: genSettings.publicPayload(userId), error: null });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        data: null,
        error: { code: '400', message: err?.message || '保存失败' },
      });
    }
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
    const variant = req.body?.variant ? String(req.body.variant) : null;
    const voice = parseVoiceBody(req.body);
    if (!voice.ok) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: '400', message: voice.message },
      });
    }

    jobs.updateJob(job.id, {
      selected_style_id: styleId,
      selected_variant: variant,
      voiceover: voice.voiceover,
      selected_voice_id: voice.voiceId,
      selected_model_id: voice.modelId,
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
    // Optional: lock in voice for final if client sends it (must match sample unless none→none)
    if (req.body?.voiceover !== undefined) {
      const voice = parseVoiceBody(req.body);
      if (!voice.ok) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: '400', message: voice.message },
        });
      }
      const voiceChanged =
        voice.voiceover !== job.voiceover
        || voice.voiceId !== (job.selected_voice_id || null)
        || voice.modelId !== (job.selected_model_id || null);
      if (voiceChanged && voice.voiceover !== 'none') {
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: '400',
            message: '音色已变更，请先点「应用音色并重做样片」，确认带配音样片后再生成全片',
          },
        });
      }
      jobs.updateJob(job.id, {
        voiceover: voice.voiceover,
        selected_voice_id: voice.voiceId,
        selected_model_id: voice.modelId,
      });
    }
    const fresh = jobs.getJob(job.id)!;
    resumeExplainJob(fresh, 'final');
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
    // Allow updating voice before regenerating sample
    if (req.body?.voiceover !== undefined) {
      const voice = parseVoiceBody(req.body);
      if (!voice.ok) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: '400', message: voice.message },
        });
      }
      jobs.updateJob(job.id, {
        voiceover: voice.voiceover,
        selected_voice_id: voice.voiceId,
        selected_model_id: voice.modelId,
      });
    }
    const fresh = jobs.getJob(job.id)!;
    resumeExplainJob(fresh, 'sample');
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
      video_path: null,
      ...(badTopic ? { topic_text: '' } : {}),
    });
    pumpExplainQueue();
    res.json({ success: true, data: jobs.publicRow(jobs.getJob(job.id)!), error: null });
  });

  router.get('/export-qualities', (_req: Request, res: Response) => {
    res.json({ success: true, data: { qualities: EXPLAIN_EXPORT_QUALITIES }, error: null });
  });

  router.post('/jobs/:id/export', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = jobs.getOwned(String(req.params.id), userId);
    if (!job) return res.status(404).json({ success: false, data: null, error: { code: '404', message: '任务不存在' } });
    if (!job.final_path || !fs.existsSync(job.final_path)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: '400', message: '请先完成全片 HTML 后再导出 MP4' },
      });
    }

    const qualityRaw = String(req.body?.quality || '1080p').toLowerCase();
    const quality = (['720p', '1080p', '1440p'].includes(qualityRaw) ? qualityRaw : '1080p') as ExplainExportQuality;

    let cfg: any = {};
    try { cfg = JSON.parse(job.config_json || '{}'); } catch { cfg = {}; }
    if (cfg?.export?.status === 'running') {
      return res.status(409).json({
        success: false,
        data: jobs.publicRow(job),
        error: { code: '409', message: '正在导出中，请稍候' },
      });
    }

    const finalDir = path.dirname(job.final_path);
    const audioPath = path.join(finalDir, 'narration.wav');
    const outPath = path.join(finalDir, `export_${quality}.mp4`);
    const audioDur = await probeAudioDurationSec(audioPath);
    const durationSec = audioDur || estimateExplainDurationSec(job.script_json, audioPath);

    cfg.export = { status: 'running', quality, startedAt: new Date().toISOString(), error: null };
    jobs.updateJob(job.id, {
      config_json: JSON.stringify(cfg),
      message: `正在导出 ${quality} MP4（约 ${Math.ceil(durationSec)} 秒动画）…`,
    });

    // Run async so HTTP can return quickly; client polls job
    void (async () => {
      try {
        await exportExplainHtmlToMp4({
          htmlPath: job.final_path!,
          outPath,
          quality,
          audioPath: fs.existsSync(audioPath) ? audioPath : null,
          durationSec,
        });
        let latestCfg: any = {};
        try { latestCfg = JSON.parse(jobs.getJob(job.id)?.config_json || '{}'); } catch { latestCfg = {}; }
        latestCfg.export = {
          status: 'done',
          quality,
          finishedAt: new Date().toISOString(),
          error: null,
        };
        jobs.updateJob(job.id, {
          video_path: outPath,
          config_json: JSON.stringify(latestCfg),
          message: `MP4 已导出（${quality}）`,
        });
      } catch (err: any) {
        let latestCfg: any = {};
        try { latestCfg = JSON.parse(jobs.getJob(job.id)?.config_json || '{}'); } catch { latestCfg = {}; }
        latestCfg.export = {
          status: 'failed',
          quality,
          finishedAt: new Date().toISOString(),
          error: String(err?.message || err).slice(0, 500),
        };
        jobs.updateJob(job.id, {
          config_json: JSON.stringify(latestCfg),
          message: `MP4 导出失败：${String(err?.message || err).slice(0, 120)}`,
        });
      }
    })();

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

  router.get('/jobs/:id/video', (req: Request, res: Response) => {
    const userId = getUserId(req);
    const job = jobs.getOwned(String(req.params.id), userId);
    if (!job?.video_path || !fs.existsSync(job.video_path)) return res.status(404).end();
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="explain-${job.id.slice(0, 8)}.mp4"`);
    res.sendFile(path.resolve(job.video_path));
  });

  return router;
}

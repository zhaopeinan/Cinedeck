import { Router, Request, Response } from 'express';
import { LlmService } from '../services/llmService';
import { ScriptGeneratorService } from '../services/scriptGenerator';
import fs from 'fs';
import path from 'path';

type P = { id: string };

// 测试图片目录
const TEST_IMAGES_DIR = path.resolve(process.cwd(), '..', 'data', 'test-images');

// 测试图片元数据（文件在服务启动时由 generateTestImages 确保）
interface TestImage {
  id: string;
  name: string;
  description: string;
  filename: string;
}

const TEST_IMAGES: TestImage[] = [
  { id: 'city', name: '城市夜景', description: '霓虹灯闪烁的赛博朋克城市', filename: 'test-city.png' },
  { id: 'nature', name: '自然风光', description: '山脉与湖泊的自然风景', filename: 'test-nature.png' },
  { id: 'chart', name: '数据图表', description: '柱状图与饼图的数据可视化', filename: 'test-chart.png' },
  { id: 'office', name: '办公场景', description: '办公桌上的电脑和文件', filename: 'test-office.png' },
];

export function createLlmRouter(llmService: LlmService, scriptGenerator: ScriptGeneratorService): Router {
  const router = Router();

  // 获取当前请求用户的 ID
  const getUserId = (req: Request): string => (req as any).user?.id || '';

  // ===== LLM 配置 CRUD =====

  // 获取所有配置（按当前用户过滤）
  router.get('/configs', (req: Request, res: Response) => {
    try {
      const userId = getUserId(req);
      const configs = llmService.listConfigs(userId);
      const safe = configs.map(c => ({ ...c, api_key: c.api_key ? '******' : null }));
      res.json({ success: true, data: safe, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8001', message: error.message } });
    }
  });

  // 获取激活的配置
  router.get('/configs/active', (req: Request, res: Response) => {
    try {
      const userId = getUserId(req);
      const config = llmService.getActiveConfig(userId);
      const safe = config ? { ...config, api_key: config.api_key ? '******' : null } : null;
      res.json({ success: true, data: safe, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8001', message: error.message } });
    }
  });

  // 创建配置
  router.post('/configs', (req: Request, res: Response) => {
    try {
      const userId = getUserId(req);
      const { name, base_url, model_name, api_key, temperature, max_retry_cycles, tolerance_rate } = req.body;
      if (!name || !base_url || !model_name) {
        return res.status(400).json({ success: false, data: null, error: { code: '8002', message: '缺少必填字段' } });
      }
      const config = llmService.createConfig({ name, base_url, model_name, api_key, temperature, max_retry_cycles, tolerance_rate, user_id: userId });
      res.json({ success: true, data: config, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8003', message: error.message } });
    }
  });

  // 更新配置
  router.put('/configs/:id', (req: Request<P>, res: Response) => {
    try {
      const { name, base_url, model_name, api_key, temperature, max_retry_cycles, tolerance_rate } = req.body;
      const data: any = { name, base_url, model_name, temperature, max_retry_cycles, tolerance_rate };
      if (api_key && api_key !== '******') data.api_key = api_key;
      const config = llmService.updateConfig(req.params.id as string, data);
      if (!config) {
        return res.status(404).json({ success: false, data: null, error: { code: '8004', message: '配置不存在' } });
      }
      res.json({ success: true, data: config, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8005', message: error.message } });
    }
  });

  // 删除配置
  router.delete('/configs/:id', (req: Request<P>, res: Response) => {
    try {
      const userId = getUserId(req);
      llmService.deleteConfig(req.params.id as string, userId);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8006', message: error.message } });
    }
  });

  // 设置激活配置
  router.post('/configs/:id/activate', (req: Request<P>, res: Response) => {
    try {
      llmService.setActive(req.params.id as string);
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8007', message: error.message } });
    }
  });

  // ===== 测试图片 =====

  // 获取可用测试图片列表
  router.get('/test-images', (_req: Request, res: Response) => {
    try {
      const images = TEST_IMAGES.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        url: `/data/test-images/${t.filename}`,
      }));
      res.json({ success: true, data: images, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8020', message: error.message } });
    }
  });

  // 多模态测试：发送测试图片给大模型，返回描述
  router.post('/configs/:id/test', async (req: Request<P>, res: Response) => {
    try {
      const configId = req.params.id as string;
      const { test_image_id } = req.body;
      const testImage = TEST_IMAGES.find(t => t.id === test_image_id) || TEST_IMAGES[0];

      const imagePath = path.join(TEST_IMAGES_DIR, testImage.filename);
      if (!fs.existsSync(imagePath)) {
        return res.status(404).json({ success: false, data: null, error: { code: '8021', message: '测试图片不存在' } });
      }

      // 读取图片转 data URI
      const imageBuffer = fs.readFileSync(imagePath);
      const base64 = imageBuffer.toString('base64');
      const dataUri = `data:image/png;base64,${base64}`;

      // 调用多模态大模型，让模型描述图片
      const reply = await llmService.chatWithImageDataUri(
        '请详细描述这张图片的内容，包括你看到的主要元素、颜色、场景等。请用中文回答。',
        dataUri,
        { temperature: 0.3, maxTokens: 500, configId },
      );

      res.json({ success: true, data: { reply, testImage: testImage.name, testImageUrl: `/data/test-images/${testImage.filename}` }, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8008', message: error.message } });
    }
  });

  // ===== 解说词生成 =====

  // 生成解说词（异步）
  router.post('/projects/:id/script/generate', (req: Request<P>, res: Response) => {
    try {
      const userId = getUserId(req);
      const { target_duration, use_existing_note } = req.body;
      const targetDurationMin = Number(target_duration) || 0;
      const targetDurationSec = targetDurationMin > 0 ? targetDurationMin * 60 : 0;
      const useExistingNote = use_existing_note !== false;

      res.json({ success: true, data: { async: true }, error: null });

      scriptGenerator.generateScripts(req.params.id, targetDurationSec, useExistingNote, userId).catch((err: any) => {
        (scriptGenerator as any).setProgress(req.params.id, 'failed', 0, 0, err.message);
      });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8009', message: error.message } });
    }
  });

  // 查询生成进度
  router.get('/projects/:id/script/progress', (req: Request<P>, res: Response) => {
    try {
      const progress = scriptGenerator.getProgress(req.params.id);
      res.json({ success: true, data: progress, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8010', message: error.message } });
    }
  });

  // 取消生成/重试
  router.post('/projects/:id/script/cancel', (req: Request<P>, res: Response) => {
    try {
      scriptGenerator.cancelGeneration(req.params.id);
      res.json({ success: true, data: { cancelled: true }, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8017', message: error.message } });
    }
  });

  // 单页重新生成解说词（同步返回结果）
  router.post('/projects/:id/script/generate-page/:pageIndex', async (req: Request<P & { pageIndex: string }>, res: Response) => {
    try {
      const userId = getUserId(req);
      const pageIndex = parseInt(req.params.pageIndex, 10);
      const { target_duration } = req.body;
      const targetDurationSec = Number(target_duration) || 30;

      const result = await scriptGenerator.generateSingleScript(req.params.id, pageIndex, targetDurationSec, userId);
      res.json({ success: true, data: result, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8011', message: error.message } });
    }
  });

  // 单页优化解说词（同步）
  router.post('/projects/:id/script/optimize-page/:pageIndex', async (req: Request<P & { pageIndex: string }>, res: Response) => {
    try {
      const userId = getUserId(req);
      const pageIndex = parseInt(req.params.pageIndex, 10);
      const result = await scriptGenerator.optimizeSingleScript(req.params.id, pageIndex, userId);
      res.json({ success: true, data: result, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8015', message: error.message } });
    }
  });

  // 单页调整解说词长度（同步）
  router.post('/projects/:id/script/adjust-page/:pageIndex', async (req: Request<P & { pageIndex: string }>, res: Response) => {
    try {
      const userId = getUserId(req);
      const pageIndex = parseInt(req.params.pageIndex, 10);
      const { target_duration } = req.body;
      const targetDurationSec = Number(target_duration) || 30;
      const result = await scriptGenerator.adjustSingleScriptLength(req.params.id, pageIndex, targetDurationSec, userId);
      res.json({ success: true, data: result, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8016', message: error.message } });
    }
  });

  // 优化解说词（异步）
  router.post('/projects/:id/script/optimize', (req: Request<P>, res: Response) => {
    try {
      const userId = getUserId(req);
      res.json({ success: true, data: { async: true }, error: null });
      scriptGenerator.optimizeScripts(req.params.id, userId).catch((err: any) => {
        (scriptGenerator as any).setProgress(req.params.id, 'failed', 0, 0, err.message);
      });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8012', message: error.message } });
    }
  });

  // 批量优化备注（异步）
  router.post('/projects/:id/notes/optimize', (req: Request<P>, res: Response) => {
    try {
      const userId = getUserId(req);
      res.json({ success: true, data: { async: true }, error: null });
      scriptGenerator.optimizeNotes(req.params.id, userId).catch((err: any) => {
        (scriptGenerator as any).setProgress(req.params.id, 'failed', 0, 0, err.message);
      });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8015', message: error.message } });
    }
  });

  // 调整解说词长度（异步）
  router.post('/projects/:id/script/adjust-length', (req: Request<P>, res: Response) => {
    try {
      const userId = getUserId(req);
      const { target_duration } = req.body;
      const targetDurationSec = Number(target_duration) * 60;
      if (!targetDurationSec || targetDurationSec <= 0) {
        return res.status(400).json({ success: false, data: null, error: { code: '8013', message: '目标时长必须大于 0' } });
      }
      res.json({ success: true, data: { async: true }, error: null });
      scriptGenerator.adjustScriptsLength(req.params.id, targetDurationSec, userId).catch((err: any) => {
        (scriptGenerator as any).setProgress(req.params.id, 'failed', 0, 0, err.message);
      });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: '8014', message: error.message } });
    }
  });

  return router;
}

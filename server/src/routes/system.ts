import { Router, Request, Response } from 'express';
import { getGpuStatus } from '../services/gpuStatus';
import { getVoiceboxGpuQueueStatus } from '../services/voiceboxGpuQueue';
import { getServiceStatuses } from '../services/serviceStatus';

/** Lightweight system status routes (auth required by mount). */
export function createSystemRouter(): Router {
  const router = Router();

  router.get('/gpu', async (_req: Request, res: Response) => {
    try {
      const data = await getGpuStatus();
      res.json({
        success: true,
        data: { ...data, voiceboxQueue: getVoiceboxGpuQueueStatus() },
        error: null,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        data: null,
        error: { code: 'GPU001', message: error.message || 'GPU 状态查询失败' },
      });
    }
  });

  router.get('/services', async (_req: Request, res: Response) => {
    try {
      const data = await getServiceStatuses();
      res.json({ success: true, data, error: null });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        data: null,
        error: { code: 'SVC001', message: error.message || '服务状态查询失败' },
      });
    }
  });

  return router;
}

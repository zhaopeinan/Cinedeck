import { Router, Request, Response } from 'express';
import { SystemSettingsService } from '../services/systemSettingsService';

/**
 * System settings router — admin-only read/write of system-level configuration.
 */
export function createSystemSettingsRouter(systemSettings: SystemSettingsService): Router {
  const router = Router();

  // List all settings
  router.get('/', (req: Request, res: Response) => {
    try {
      const settings = systemSettings.list();
      res.json({ success: true, data: settings, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'SYS500', message: error.message } });
    }
  });

  // Update a single setting
  router.put('/:key', (req: Request, res: Response) => {
    try {
      const key = String(req.params.key);
      const { value } = req.body;
      if (value === undefined || value === null) {
        return res.status(400).json({ success: false, data: null, error: { code: 'SYS400', message: '缺少 value 参数' } });
      }
      const updatedBy = (req as any).user?.username || null;
      const result = systemSettings.update(key, String(value), updatedBy);
      res.json({ success: true, data: result, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'SYS500', message: error.message } });
    }
  });

  return router;
}

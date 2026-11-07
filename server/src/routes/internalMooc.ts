/**
 * Localhost-only hooks for ops / batch scripts that run outside the dispatcher process.
 */
import { Router, type Request, type Response } from 'express';
import { wakeMoocQueue } from '../services/moocPipelineWorker';

function isLocalhost(req: Request): boolean {
  const raw = String(req.socket.remoteAddress || req.ip || '');
  return raw === '127.0.0.1'
    || raw === '::1'
    || raw === '::ffff:127.0.0.1'
    || raw.endsWith('127.0.0.1');
}

export function createInternalMoocRouter() {
  const router = Router();

  /** POST /api/internal/mooc/wake — claim next queued MOOC job if idle. */
  router.post('/wake', (req: Request, res: Response) => {
    if (!isLocalhost(req)) {
      return res.status(403).json({
        success: false,
        data: null,
        error: { code: '403', message: 'localhost only' },
      });
    }
    const ok = wakeMoocQueue();
    return res.json({
      success: true,
      data: {
        woken: ok,
        reason: req.body?.reason || null,
        at: new Date().toISOString(),
      },
      error: null,
    });
  });

  return router;
}

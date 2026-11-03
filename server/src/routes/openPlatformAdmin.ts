import { Router, Request, Response } from 'express';
import {
  OpenApiKeyService,
  OPEN_API_SCOPES,
  type OpenApiScope,
} from '../services/openApiKeyService';

function parseScopesBody(raw: unknown): OpenApiScope[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => String(s || '').trim().toLowerCase())
    .filter((s): s is OpenApiScope => (OPEN_API_SCOPES as string[]).includes(s));
}

export function createOpenPlatformAdminRouter(openApiKeys: OpenApiKeyService): Router {
  const router = Router();

  router.get('/keys', (_req: Request, res: Response) => {
    res.json({ success: true, data: openApiKeys.list(), error: null });
  });

  router.post('/keys', (req: Request, res: Response) => {
    try {
      const name = String(req.body?.name || '').trim();
      const scopes = parseScopesBody(req.body?.scopes);
      const createdBy = (req as any).user?.id || null;
      const result = openApiKeys.create({ name, scopes, createdBy });
      res.json({
        success: true,
        data: {
          ...result.key,
          apiKey: result.apiKey,
        },
        error: null,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        data: null,
        error: { code: 'OPEN_KEY_CREATE', message: error?.message || '创建失败' },
      });
    }
  });

  router.patch('/keys/:id', (req: Request, res: Response) => {
    try {
      const patch: Partial<{ name: string; scopes: OpenApiScope[]; status: 'active' | 'disabled' }> = {};
      if (req.body?.name != null) patch.name = String(req.body.name);
      if (req.body?.scopes != null) patch.scopes = parseScopesBody(req.body.scopes);
      if (req.body?.status != null) {
        const s = String(req.body.status);
        if (s !== 'active' && s !== 'disabled') {
          return res.status(400).json({
            success: false,
            data: null,
            error: { code: 'OPEN_KEY_UPDATE', message: '状态仅支持 active / disabled' },
          });
        }
        patch.status = s;
      }
      const updated = openApiKeys.update(String(req.params.id), patch);
      if (!updated) {
        return res.status(404).json({
          success: false,
          data: null,
          error: { code: '404', message: '密钥不存在' },
        });
      }
      res.json({ success: true, data: updated, error: null });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        data: null,
        error: { code: 'OPEN_KEY_UPDATE', message: error?.message || '更新失败' },
      });
    }
  });

  router.delete('/keys/:id', (req: Request, res: Response) => {
    const ok = openApiKeys.delete(String(req.params.id));
    if (!ok) {
      return res.status(404).json({
        success: false,
        data: null,
        error: { code: '404', message: '密钥不存在' },
      });
    }
    res.json({ success: true, data: { id: req.params.id }, error: null });
  });

  return router;
}

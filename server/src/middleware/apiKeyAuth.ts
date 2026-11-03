import { Request, Response, NextFunction } from 'express';
import {
  OpenApiKeyService,
  type OpenApiKeyVerified,
  type OpenApiScope,
} from '../services/openApiKeyService';

declare global {
  namespace Express {
    interface Request {
      openApiKey?: OpenApiKeyVerified;
    }
  }
}

/** In-memory RPM limiter per API key id */
const RATE_LIMIT_RPM = Math.max(10, Number(process.env.OPEN_API_RPM || 60));
const WINDOW_MS = 60_000;
const hitBuckets = new Map<string, number[]>();

function pruneHits(hits: number[], now: number): number[] {
  return hits.filter((t) => now - t < WINDOW_MS);
}

function checkRateLimit(keyId: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const pruned = pruneHits(hitBuckets.get(keyId) || [], now);
  if (pruned.length >= RATE_LIMIT_RPM) {
    const oldest = pruned[0];
    const retryAfterSec = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
    hitBuckets.set(keyId, pruned);
    return { ok: false, retryAfterSec };
  }
  pruned.push(now);
  hitBuckets.set(keyId, pruned);
  return { ok: true, retryAfterSec: 0 };
}

function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('sk_')) return token;
  }
  const xKey = req.headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.trim()) return xKey.trim();
  if (Array.isArray(xKey) && xKey[0]) return String(xKey[0]).trim();
  // media tags / download links
  if (typeof req.query.api_key === 'string' && req.query.api_key.startsWith('sk_')) {
    return req.query.api_key;
  }
  return null;
}

export function createApiKeyAuth(openApiKeys: OpenApiKeyService) {
  function apiKeyRequired(req: Request, res: Response, next: NextFunction) {
    const raw = extractApiKey(req);
    if (!raw) {
      return res.status(401).json({
        success: false,
        data: null,
        error: { code: 'OPEN_AUTH001', message: '缺少 API Key（Authorization: Bearer sk_... 或 X-API-Key）' },
      });
    }
    const verified = openApiKeys.verify(raw);
    if (!verified) {
      return res.status(401).json({
        success: false,
        data: null,
        error: { code: 'OPEN_AUTH002', message: 'API Key 无效或已禁用' },
      });
    }

    const rate = checkRateLimit(verified.id);
    if (!rate.ok) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      return res.status(429).json({
        success: false,
        data: null,
        error: {
          code: 'OPEN_RATE_LIMIT',
          message: `请求过于频繁（上限 ${RATE_LIMIT_RPM} 次/分钟），请稍后重试`,
        },
      });
    }

    req.openApiKey = verified;
    // fire-and-forget last_used touch (sync sqlite is fine)
    openApiKeys.touchLastUsed(verified.id);
    next();
  }

  function requireScope(scope: OpenApiScope) {
    return (req: Request, res: Response, next: NextFunction) => {
      const key = req.openApiKey;
      if (!key) {
        return res.status(401).json({
          success: false,
          data: null,
          error: { code: 'OPEN_AUTH001', message: '未鉴权' },
        });
      }
      if (!openApiKeys.hasScope(key, scope)) {
        return res.status(403).json({
          success: false,
          data: null,
          error: { code: 'OPEN_SCOPE', message: `此 API Key 无权访问 ${scope}` },
        });
      }
      next();
    };
  }

  return { apiKeyRequired, requireScope };
}

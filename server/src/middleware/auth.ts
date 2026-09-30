import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/authService';

export function createAuthMiddleware(authService: AuthService) {
  /** 要求登录 */
  function authRequired(req: Request, res: Response, next: NextFunction) {
    // 支持 Authorization header 和 query 参数 token（用于 img/audio/video 标签）
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (typeof req.query.token === 'string') {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ success: false, data: null, error: { code: 'AUTH001', message: '未登录' } });
    }
    const payload = authService.verifyToken(token);
    if (!payload) {
      return res.status(401).json({ success: false, data: null, error: { code: 'AUTH002', message: '登录已过期，请重新登录' } });
    }
    // 将用户信息挂到 req 上
    (req as any).user = payload;
    next();
  }

  /** 要求管理员 */
  function adminRequired(req: Request, res: Response, next: NextFunction) {
    const user = (req as any).user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, data: null, error: { code: 'AUTH003', message: '需要管理员权限' } });
    }
    next();
  }

  return { authRequired, adminRequired };
}

// 扩展 Express Request 类型
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; username: string; role: string };
    }
  }
}

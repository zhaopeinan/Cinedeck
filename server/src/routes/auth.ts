import { Router, Request, Response } from 'express';
import { AuthService } from '../services/authService';

export function createAuthRouter(authService: AuthService, authRequired?: any, adminRequired?: any): Router {
  const router = Router();

  // ===== 公开路由 =====

  // 生成滑块验证码
  router.get('/captcha', (_req: Request, res: Response) => {
    try {
      const challenge = authService.generateCaptcha();
      res.json({ success: true, data: challenge, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'AUTH100', message: error.message } });
    }
  });

  // 校验滑块验证码
  router.post('/captcha/verify', (req: Request, res: Response) => {
    try {
      const { captcha_id, slider_x } = req.body;
      if (!captcha_id || slider_x === undefined) {
        return res.status(400).json({ success: false, data: null, error: { code: 'AUTH101', message: '缺少参数' } });
      }
      const result = authService.verifyCaptcha(captcha_id, Number(slider_x));
      if (result.success) {
        res.json({ success: true, data: { token: result.token }, error: null });
      } else {
        res.json({ success: false, data: null, error: { code: 'AUTH102', message: result.message } });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'AUTH103', message: error.message } });
    }
  });

  // 登录
  router.post('/login', (req: Request, res: Response) => {
    try {
      const { username, password, captcha_token } = req.body;
      if (!username || !password || !captcha_token) {
        return res.status(400).json({ success: false, data: null, error: { code: 'AUTH104', message: '缺少参数' } });
      }
      const ip = req.ip || req.socket.remoteAddress || '';
      const userAgent = req.headers['user-agent'] || '';
      const result = authService.login(username, password, captcha_token);
      if (result.success) {
        authService.logOperation({
          userId: result.user!.id,
          username: result.user!.username,
          action: 'login',
          ip,
          userAgent,
          details: '用户登录',
          status: 'success',
        });
        res.json({ success: true, data: { token: result.token, user: result.user }, error: null });
      } else {
        authService.logOperation({
          username,
          action: 'login',
          ip,
          userAgent,
          details: `登录失败: ${result.message}`,
          status: 'failed',
        });
        res.status(401).json({ success: false, data: null, error: { code: 'AUTH105', message: result.message } });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'AUTH106', message: error.message } });
    }
  });

  // ===== 需要登录的路由 =====
  const requireAuth = authRequired || ((_req: any, _res: any, next: any) => next());
  const requireAdmin = adminRequired || ((_req: any, _res: any, next: any) => next());

  // 获取当前用户信息（需要登录）
  router.get('/me', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ success: false, data: null, error: { code: 'AUTH107', message: '未登录' } });
    const fullUser = authService.getUserById(user.id);
    res.json({ success: true, data: fullUser, error: null });
  });

  // 修改密码（需要登录）
  router.post('/change-password', requireAuth, (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { old_password, new_password } = req.body;
      if (!old_password || !new_password) {
        return res.status(400).json({ success: false, data: null, error: { code: 'AUTH108', message: '缺少参数' } });
      }
      const result = authService.changePassword(user.id, old_password, new_password);
      if (result.success) {
        authService.logOperation({ userId: user.id, username: user.username, action: 'change_password', details: '修改密码' });
        res.json({ success: true, data: null, error: null });
      } else {
        res.status(400).json({ success: false, data: null, error: { code: 'AUTH109', message: result.message } });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'AUTH110', message: error.message } });
    }
  });

  // ===== 以下为管理员接口 =====

  // 用户列表
  router.get('/users', requireAuth, requireAdmin, (req: Request, res: Response) => {
    try {
      const users = authService.getAllUsers();
      res.json({ success: true, data: users, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'AUTH111', message: error.message } });
    }
  });

  // 创建用户
  router.post('/users', requireAuth, requireAdmin, (req: Request, res: Response) => {
    try {
      const { username, password, role } = req.body;
      if (!username || !password) {
        return res.status(400).json({ success: false, data: null, error: { code: 'AUTH112', message: '缺少用户名或密码' } });
      }
      const user = authService.createUser({ username, password, role });
      const operator = (req as any).user;
      authService.logOperation({ userId: operator.id, username: operator.username, action: 'create_user', target: username, details: `创建用户: ${username}, 角色: ${role || 'user'}` });
      res.json({ success: true, data: user, error: null });
    } catch (error: any) {
      res.status(400).json({ success: false, data: null, error: { code: 'AUTH113', message: error.message } });
    }
  });

  // 更新用户
  router.put('/users/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
    try {
      const { password, role, status } = req.body;
      const user = authService.updateUser(req.params.id as string, { password, role, status });
      if (!user) return res.status(404).json({ success: false, data: null, error: { code: 'AUTH114', message: '用户不存在' } });
      const operator = (req as any).user;
      authService.logOperation({ userId: operator.id, username: operator.username, action: 'update_user', target: user.username, details: `更新用户: ${user.username}` });
      res.json({ success: true, data: user, error: null });
    } catch (error: any) {
      res.status(400).json({ success: false, data: null, error: { code: 'AUTH115', message: error.message } });
    }
  });

  // 删除用户
  router.delete('/users/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
    try {
      const targetId = req.params.id as string;
      const ok = authService.deleteUser(targetId);
      if (!ok) return res.status(404).json({ success: false, data: null, error: { code: 'AUTH116', message: '用户不存在' } });
      const operator = (req as any).user;
      authService.logOperation({ userId: operator.id, username: operator.username, action: 'delete_user', target: targetId, details: '删除用户' });
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(400).json({ success: false, data: null, error: { code: 'AUTH117', message: error.message } });
    }
  });

  // 重置用户密码
  router.post('/users/:id/reset-password', requireAuth, requireAdmin, (req: Request, res: Response) => {
    try {
      const { new_password } = req.body;
      if (!new_password) return res.status(400).json({ success: false, data: null, error: { code: 'AUTH118', message: '缺少新密码' } });
      const targetId = req.params.id as string;
      const ok = authService.resetPassword(targetId, new_password);
      if (!ok) return res.status(404).json({ success: false, data: null, error: { code: 'AUTH119', message: '用户不存在' } });
      const operator = (req as any).user;
      authService.logOperation({ userId: operator.id, username: operator.username, action: 'reset_password', target: targetId, details: '管理员重置密码' });
      res.json({ success: true, data: null, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'AUTH120', message: error.message } });
    }
  });

  // 操作日志
  router.get('/logs', requireAuth, requireAdmin, (req: Request, res: Response) => {
    try {
      const { page, page_size, user_id, action, status } = req.query;
      const result = authService.getLogs({
        page: page ? Number(page) : 1,
        pageSize: page_size ? Number(page_size) : 20,
        userId: user_id as string | undefined,
        action: action as string | undefined,
        status: status as string | undefined,
      });
      res.json({ success: true, data: result, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'AUTH121', message: error.message } });
    }
  });

  // 系统统计
  router.get('/stats', requireAuth, requireAdmin, (_req: Request, res: Response) => {
    try {
      const stats = authService.getStats();
      res.json({ success: true, data: stats, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'AUTH122', message: error.message } });
    }
  });

  return router;
}

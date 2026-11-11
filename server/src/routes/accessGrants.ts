import { Router, Request, Response } from 'express';
import { AccessGrantService } from '../services/accessGrantService';
import { AuthService } from '../services/authService';

export function createAccessGrantsRouter(
  grants: AccessGrantService,
  authService: AuthService,
  authRequired: any,
  adminRequired: any,
): Router {
  const router = Router();

  router.get('/', authRequired, (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const data = grants.listForUser(user.id);
      res.json({ success: true, data, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'GRANT001', message: error.message } });
    }
  });

  router.post('/', authRequired, (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { grantee_username, note } = req.body || {};
      if (!grantee_username || typeof grantee_username !== 'string') {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'GRANT002', message: '缺少被授权用户名' },
        });
      }
      const grant = grants.createGrant({
        grantorUserId: user.id,
        granteeUsername: grantee_username,
        createdBy: user.id,
        note: typeof note === 'string' ? note : null,
      });
      authService.logOperation({
        userId: user.id,
        username: user.username,
        action: 'access_grant',
        target: grant.grantee_username || grant.grantee_user_id,
        details: `授权 ${grant.grantee_username} 查看并操作本人数据`,
        ip: req.ip || req.socket.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '',
      });
      res.json({ success: true, data: grant, error: null });
    } catch (error: any) {
      res.status(400).json({ success: false, data: null, error: { code: 'GRANT003', message: error.message } });
    }
  });

  router.delete('/:id', authRequired, (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const isAdmin = user.role === 'admin';
      const grant = grants.revokeGrant(String(req.params.id), user.id, isAdmin);
      authService.logOperation({
        userId: user.id,
        username: user.username,
        action: 'access_revoke',
        target: grant.grantee_username || grant.grantee_user_id,
        details: `撤销授权: grantor=${grant.grantor_username}, grantee=${grant.grantee_username}`,
        ip: req.ip || req.socket.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '',
      });
      res.json({ success: true, data: grant, error: null });
    } catch (error: any) {
      const code = error.message === '授权记录不存在' ? 404 : 400;
      res.status(code).json({ success: false, data: null, error: { code: 'GRANT004', message: error.message } });
    }
  });

  router.get('/admin', authRequired, adminRequired, (req: Request, res: Response) => {
    try {
      const { grantor_user_id, grantee_user_id, status } = req.query;
      const list = grants.listAdmin({
        grantorUserId: grantor_user_id ? String(grantor_user_id) : undefined,
        granteeUserId: grantee_user_id ? String(grantee_user_id) : undefined,
        status: status ? String(status) : 'active',
      });
      res.json({ success: true, data: list, error: null });
    } catch (error: any) {
      res.status(500).json({ success: false, data: null, error: { code: 'GRANT005', message: error.message } });
    }
  });

  router.post('/admin', authRequired, adminRequired, (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { grantor_user_id, grantee_username, note } = req.body || {};
      if (!grantor_user_id || !grantee_username) {
        return res.status(400).json({
          success: false,
          data: null,
          error: { code: 'GRANT006', message: '缺少授权人或被授权用户' },
        });
      }
      const grant = grants.createGrant({
        grantorUserId: String(grantor_user_id),
        granteeUsername: String(grantee_username),
        createdBy: user.id,
        note: typeof note === 'string' ? note : null,
      });
      authService.logOperation({
        userId: user.id,
        username: user.username,
        action: 'access_grant',
        target: grant.grantee_username || grant.grantee_user_id,
        details: `管理员代授: grantor=${grant.grantor_username}, grantee=${grant.grantee_username}`,
        ip: req.ip || req.socket.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '',
      });
      res.json({ success: true, data: grant, error: null });
    } catch (error: any) {
      res.status(400).json({ success: false, data: null, error: { code: 'GRANT007', message: error.message } });
    }
  });

  return router;
}

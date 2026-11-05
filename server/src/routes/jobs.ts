import { Router, Request, Response } from 'express';
import { JobRegistry, type JobKind } from '../services/jobRegistry';
import { getAvatarJob, requestCancelAvatarJob } from '../services/avatarProgress';
import { getComposeJob, requestCancelComposeJob } from '../services/composeProgress';
import { DialogueJobService } from '../services/dialogueJobService';
import { MoocJobService } from '../services/moocJobService';
import { ExplainJobService } from '../services/explainJobService';
import { requestMoocJobCancel } from '../services/moocPipelineWorker';
import { requestCancel } from '../services/jobCancel';
import { markDubbingCancelled } from '../services/dubbingProgress';
import {
  getExplainExportJob,
  requestCancelExplainExportJob,
} from '../services/explainExportQueue';

function getUserId(req: Request): string {
  return (req as any).user?.id || '';
}

export function createJobsRouter(
  registry: JobRegistry,
  deps: {
    dialogueJobs: DialogueJobService;
    moocJobs: MoocJobService;
    explainJobs?: ExplainJobService;
  },
): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        data: null,
        error: { code: '401', message: '未登录' },
      });
    }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const jobs = registry.listForUser(userId, { status, limit });
    res.json({ success: true, data: { jobs }, error: null });
  });

  router.get('/summary', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        data: null,
        error: { code: '401', message: '未登录' },
      });
    }
    const summary = registry.summaryForUser(userId);
    res.json({ success: true, data: summary, error: null });
  });

  /**
   * Proxy cancel to existing cancel paths where available.
   * Body/query: kind is inferred from id prefix or required as ?kind=
   */
  router.post('/:id/cancel', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        data: null,
        error: { code: '401', message: '未登录' },
      });
    }

    const rawId = String(req.params.id || '');
    let kind = String(req.query.kind || req.body?.kind || '') as JobKind | '';
    let id = rawId;

    if (!kind) {
      if (rawId.startsWith('dubbing:')) {
        kind = 'tts_dubbing';
        id = rawId.slice('dubbing:'.length);
      } else if (rawId.startsWith('project_avatar:')) {
        kind = 'project_avatar';
        id = rawId.slice('project_avatar:'.length);
      } else if (rawId.startsWith('video:')) {
        kind = 'video_compose';
        id = rawId.slice('video:'.length);
      }
    }

    if (!kind) {
      // Infer from in-memory maps / DB ownership
      const avatar = getAvatarJob(rawId);
      if (avatar && avatar.userId === userId) kind = 'avatar';
      const compose = getComposeJob(rawId);
      if (!kind && compose && compose.userId === userId) kind = 'compose';
      if (!kind) {
        const d = deps.dialogueJobs.getOwned(rawId, userId);
        if (d) kind = 'dialogue';
      }
      if (!kind) {
        const m = deps.moocJobs.getJob(rawId);
        if (m && m.user_id === userId) kind = 'mooc';
      }
      if (!kind && deps.explainJobs) {
        const e = deps.explainJobs.getOwned(rawId, userId);
        if (e) kind = 'explain';
      }
      if (!kind) {
        const ex = getExplainExportJob(rawId);
        if (ex && ex.userId === userId) kind = 'explain_export';
      }
    }

    if (!kind) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: 'JOB_CANCEL_KIND', message: '无法识别任务类型，请指定 kind' },
      });
    }

    try {
      switch (kind) {
        case 'avatar': {
          const job = getAvatarJob(id);
          if (!job || job.userId !== userId) {
            return res.status(404).json({
              success: false,
              data: null,
              error: { code: '404', message: '任务不存在' },
            });
          }
          const updated = requestCancelAvatarJob(id);
          return res.json({ success: true, data: { id, kind, status: updated?.status }, error: null });
        }
        case 'compose': {
          const job = getComposeJob(id);
          if (!job || job.userId !== userId) {
            return res.status(404).json({
              success: false,
              data: null,
              error: { code: '404', message: '任务不存在' },
            });
          }
          const updated = requestCancelComposeJob(id);
          return res.json({ success: true, data: { id, kind, status: updated?.status }, error: null });
        }
        case 'dialogue': {
          const updated = deps.dialogueJobs.requestCancel(id, userId);
          if (!updated) {
            return res.status(404).json({
              success: false,
              data: null,
              error: { code: '404', message: '任务不存在' },
            });
          }
          return res.json({ success: true, data: { id, kind, status: updated.status }, error: null });
        }
        case 'mooc': {
          const job = deps.moocJobs.getJob(id);
          if (!job || job.user_id !== userId) {
            return res.status(404).json({
              success: false,
              data: null,
              error: { code: '404', message: '任务不存在' },
            });
          }
          const updated = deps.moocJobs.cancelJob(id, userId);
          requestMoocJobCancel(id);
          return res.json({ success: true, data: { id, kind, status: updated?.status }, error: null });
        }
        case 'tts_dubbing': {
          markDubbingCancelled(id);
          return res.json({ success: true, data: { id, kind, status: 'cancelled' }, error: null });
        }
        case 'project_avatar': {
          requestCancel('avatar', id);
          return res.json({ success: true, data: { id, kind, status: 'cancelled' }, error: null });
        }
        case 'explain': {
          if (!deps.explainJobs) {
            return res.status(400).json({
              success: false,
              data: null,
              error: { code: 'JOB_NO_CANCEL', message: '讲解动画取消不可用' },
            });
          }
          const updated = deps.explainJobs.requestCancel(id, userId);
          if (!updated) {
            return res.status(404).json({
              success: false,
              data: null,
              error: { code: '404', message: '任务不存在' },
            });
          }
          return res.json({ success: true, data: { id, kind, status: updated.status }, error: null });
        }
        case 'explain_export': {
          const updated = requestCancelExplainExportJob(id, userId);
          if (!updated) {
            return res.status(404).json({
              success: false,
              data: null,
              error: { code: '404', message: '任务不存在' },
            });
          }
          return res.json({ success: true, data: { id, kind, status: updated.status }, error: null });
        }
        default:
          return res.status(400).json({
            success: false,
            data: null,
            error: { code: 'JOB_NO_CANCEL', message: `该类型任务暂不支持从此处取消（${kind}）` },
          });
      }
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        data: null,
        error: { code: 'JOB_CANCEL_ERR', message: err?.message || '取消失败' },
      });
    }
  });

  return router;
}

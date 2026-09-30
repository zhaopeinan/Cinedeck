import { Router, Request, Response } from 'express';
import { taskQueue } from '../services/taskQueue';

export function createWorkerRouter(): Router {
  const router = Router();

  // Worker registration
  router.post('/register', (req: Request, res: Response) => {
    const { workerId, capabilities } = req.body;
    if (!workerId || !capabilities) {
      return res.status(400).json({ success: false, data: null, error: { code: '400', message: 'Missing workerId or capabilities' } });
    }
    taskQueue.registerWorker(workerId, capabilities);
    console.log(`[Dispatcher] Worker registered: ${workerId} (${capabilities.join(', ')})`);
    res.json({ success: true, data: { workerId }, error: null });
  });

  // Worker heartbeat
  router.post('/heartbeat', (req: Request, res: Response) => {
    const { workerId } = req.body;
    if (!workerId) {
      return res.status(400).json({ success: false, data: null, error: { code: '400', message: 'Missing workerId' } });
    }
    taskQueue.heartbeat(workerId);
    res.json({ success: true, data: null, error: null });
  });

  // Worker polls for task
  router.post('/poll', (req: Request, res: Response) => {
    const { workerId, capabilities } = req.body;
    if (!workerId) {
      return res.status(400).json({ success: false, data: null, error: { code: '400', message: 'Missing workerId' } });
    }
    taskQueue.heartbeat(workerId);
    const task = taskQueue.poll(workerId, capabilities || []);
    res.json({ success: true, data: task || null, error: null });
  });

  // Worker reports task result
  router.post('/result', (req: Request, res: Response) => {
    const { workerId, taskId, result } = req.body;
    if (!workerId || !taskId || !result) {
      return res.status(400).json({ success: false, data: null, error: { code: '400', message: 'Missing required fields' } });
    }
    taskQueue.reportResult(taskId, result);
    console.log(`[Dispatcher] Task ${taskId} result from ${workerId}: ${result.success ? 'OK' : 'FAILED'}`);
    res.json({ success: true, data: null, error: null });
  });

  // Get task status (for frontend polling)
  router.get('/tasks/:taskId', (req: Request<{ taskId: string }>, res: Response) => {
    const task = taskQueue.getTask(req.params.taskId);
    if (!task) {
      return res.status(404).json({ success: false, data: null, error: { code: '404', message: 'Task not found' } });
    }
    res.json({ success: true, data: task, error: null });
  });

  // Get project tasks
  router.get('/projects/:projectId/tasks', (req: Request<{ projectId: string }>, res: Response) => {
    const tasks = taskQueue.getProjectTasks(req.params.projectId);
    res.json({ success: true, data: tasks, error: null });
  });

  // Retry failed task
  router.post('/tasks/:taskId/retry', (req: Request<{ taskId: string }>, res: Response) => {
    const task = taskQueue.retryTask(req.params.taskId);
    if (!task) {
      return res.status(400).json({ success: false, data: null, error: { code: '400', message: 'Task not found or not failed' } });
    }
    res.json({ success: true, data: task, error: null });
  });

  // Queue stats
  router.get('/stats', (_req: Request, res: Response) => {
    res.json({ success: true, data: taskQueue.getStats(), error: null });
  });

  // List workers
  router.get('/list', (_req: Request, res: Response) => {
    res.json({ success: true, data: taskQueue.getWorkers(), error: null });
  });

  return router;
}

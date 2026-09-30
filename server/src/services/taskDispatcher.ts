import { taskQueue } from './taskQueue';

function hasWorkers(): boolean {
  return taskQueue.hasAvailableWorker();
}

export async function dispatchTask(
  type: 'parse_ppt' | 'generate_dubbing' | 'compose_video',
  params: Record<string, any>,
  projectId: string,
  localExecutor: () => Promise<any>,
  options: { priority?: number; timeoutMs?: number } = {},
): Promise<{ taskId?: string; result?: any; dispatchedTo: 'local' | 'worker' }> {
  if (hasWorkers()) {
    const task = taskQueue.enqueue(type, params, projectId, options.priority || 5);

    const timeoutMs = options.timeoutMs || 300000; // 5 min default
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const pollInterval = setInterval(() => {
        const currentTask = taskQueue.getTask(task.id);
        if (!currentTask) {
          clearInterval(pollInterval);
          reject(new Error('Task not found'));
          return;
        }

        if (currentTask.status === 'completed') {
          clearInterval(pollInterval);
          resolve({ taskId: task.id, result: currentTask.result, dispatchedTo: 'worker' as const });
        } else if (currentTask.status === 'failed') {
          clearInterval(pollInterval);
          reject(new Error(currentTask.error || 'Task failed'));
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(pollInterval);
          reject(new Error('Task timed out'));
        }
      }, 1000);
    });
  } else {
    const result = await localExecutor();
    return { result, dispatchedTo: 'local' };
  }
}

export function enqueueTask(
  type: 'parse_ppt' | 'generate_dubbing' | 'compose_video',
  params: Record<string, any>,
  projectId: string,
  options: { priority?: number } = {},
): { taskId: string; dispatchedTo: 'local' | 'worker' } {
  if (hasWorkers()) {
    const task = taskQueue.enqueue(type, params, projectId, options.priority || 5);
    return { taskId: task.id, dispatchedTo: 'worker' };
  }
  return { taskId: '', dispatchedTo: 'local' };
}

export function getTaskStatus(taskId: string) {
  return taskQueue.getTask(taskId);
}

export function getQueueStats() {
  return taskQueue.getStats();
}

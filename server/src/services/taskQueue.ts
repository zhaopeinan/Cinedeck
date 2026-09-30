import { v4 as uuidv4 } from 'uuid';

export interface Task {
  id: string;
  type: 'parse_ppt' | 'generate_dubbing' | 'compose_video';
  params: Record<string, any>;
  projectId: string;
  priority: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  workerId?: string;
}

interface Worker {
  id: string;
  lastHeartbeat: number;
  capabilities: string[];
}

const HEARTBEAT_TIMEOUT_MS = 30_000; // 30 seconds

class TaskQueue {
  private tasks: Map<string, Task> = new Map();
  private workers: Map<string, Worker> = new Map();

  enqueue(
    type: Task['type'],
    params: Record<string, any>,
    projectId: string,
    priority: number = 5,
  ): Task {
    const task: Task = {
      id: uuidv4(),
      type,
      params,
      projectId,
      priority,
      status: 'queued',
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getTasksByProject(projectId: string): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.projectId === projectId);
  }

  claimTask(workerId: string, capabilities?: string[]): Task | undefined {
    // Clean stale workers first
    this.cleanStaleWorkers();

    const caps = capabilities || [];
    const queued = Array.from(this.tasks.values())
      .filter(t => t.status === 'queued')
      .filter(t => caps.length === 0 || caps.includes(t.type))
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

    if (queued.length === 0) return undefined;

    const task = queued[0];
    task.status = 'processing';
    task.startedAt = Date.now();
    task.workerId = workerId;
    return task;
  }

  completeTask(taskId: string, result: any): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();
  }

  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();
  }

  registerWorker(workerId: string, capabilities: string[] = []): void {
    this.workers.set(workerId, {
      id: workerId,
      lastHeartbeat: Date.now(),
      capabilities,
    });
  }

  unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  workerHeartbeat(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastHeartbeat = Date.now();
    }
  }

  hasAvailableWorker(): boolean {
    this.cleanStaleWorkers();
    return this.workers.size > 0;
  }

  getStats() {
    this.cleanStaleWorkers();
    const tasks = Array.from(this.tasks.values());
    return {
      workers: this.workers.size,
      tasks: {
        queued: tasks.filter(t => t.status === 'queued').length,
        processing: tasks.filter(t => t.status === 'processing').length,
        completed: tasks.filter(t => t.status === 'completed').length,
        failed: tasks.filter(t => t.status === 'failed').length,
      },
    };
  }

  // Aliases used by workers.ts routes
  heartbeat(workerId: string): void {
    this.workerHeartbeat(workerId);
  }

  poll(workerId: string, capabilities: string[] = []): Task | undefined {
    return this.claimTask(workerId, capabilities);
  }

  reportResult(taskId: string, result: { success: boolean; data?: any; error?: string }): void {
    if (result.success) {
      this.completeTask(taskId, result.data);
    } else {
      this.failTask(taskId, result.error || 'Task failed');
    }
  }

  getProjectTasks(projectId: string): Task[] {
    return this.getTasksByProject(projectId);
  }

  retryTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'failed') return undefined;
    task.status = 'queued';
    task.error = undefined;
    task.completedAt = undefined;
    task.workerId = undefined;
    return task;
  }

  getWorkers(): Worker[] {
    this.cleanStaleWorkers();
    return Array.from(this.workers.values());
  }

  private cleanStaleWorkers(): void {
    const now = Date.now();
    for (const [id, worker] of this.workers) {
      if (now - worker.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.workers.delete(id);
        // Re-queue tasks that were being processed by this worker
        for (const task of this.tasks.values()) {
          if (task.workerId === id && task.status === 'processing') {
            task.status = 'queued';
            task.workerId = undefined;
          }
        }
      }
    }
  }
}

export const taskQueue = new TaskQueue();

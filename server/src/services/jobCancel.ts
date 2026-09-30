/** In-memory cancel flags for long-running project jobs. */

type JobKind = 'avatar' | 'compose' | 'export';

const flags = new Map<string, boolean>();

function key(kind: JobKind, projectId: string) {
  return `${kind}:${projectId}`;
}

/** Call when a job starts so a previous cancel doesn't linger. */
export function beginJob(kind: JobKind, projectId: string) {
  flags.delete(key(kind, projectId));
}

export function requestCancel(kind: JobKind, projectId: string) {
  flags.set(key(kind, projectId), true);
}

export function isCancelled(kind: JobKind, projectId: string): boolean {
  return !!flags.get(key(kind, projectId));
}

export function clearCancel(kind: JobKind, projectId: string) {
  flags.delete(key(kind, projectId));
}

export class JobCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

export function throwIfCancelled(kind: JobKind, projectId: string) {
  if (isCancelled(kind, projectId)) {
    throw new JobCancelledError();
  }
}

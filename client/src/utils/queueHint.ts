/** 排队位次文案：queuePosition 为 1-based（含自己） */
export function formatQueueHint(
  status: string | undefined | null,
  queuePosition?: number | null,
  fallbackMessage?: string | null,
): string | null {
  if (status === 'queued') {
    if (queuePosition != null && queuePosition > 1) {
      return `排队中 · 前面还有 ${queuePosition - 1} 个`;
    }
    if (queuePosition === 1) return '排队中 · 即将开始';
    return fallbackMessage || '排队中';
  }
  if (status === 'running') {
    return fallbackMessage || '进行中';
  }
  return fallbackMessage || null;
}

/** 在同一列表内估算队内位置（仅当列表含全部排队任务时准确） */
export function estimateQueuePosition(
  jobs: Array<{ id: string; status: string; createdAt?: string; created_at?: string }>,
  id: string,
): number | null {
  const job = jobs.find((j) => j.id === id);
  if (!job || job.status !== 'queued') return null;
  const queued = jobs
    .filter((j) => j.status === 'queued')
    .sort((a, b) => {
      const ac = a.createdAt || a.created_at || '';
      const bc = b.createdAt || b.created_at || '';
      return ac < bc ? -1 : 1;
    });
  const idx = queued.findIndex((j) => j.id === id);
  return idx >= 0 ? idx + 1 : null;
}

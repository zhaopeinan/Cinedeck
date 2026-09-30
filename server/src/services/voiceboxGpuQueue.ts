/**
 * Serialize Voicebox GPU work (Whisper + TTS) so pipelines do not thrash VRAM.
 * Duix avatar jobs use a separate exclusive lock that stops Voicebox; we wait
 * for that lock to clear before starting Voicebox work.
 *
 * TTS is async on the Voicebox server: generateDubbing returns a task id while
 * GPU stays busy. We therefore keep a "TTS hold" until the task reaches a
 * terminal status (via noteVoiceboxTaskEnded from getTaskStatus).
 */

type QueueEntry = {
  label: string;
  enqueuedAt: number;
};

let tail: Promise<void> = Promise.resolve();
let activeLabel: string | null = null;
let activeStartedAt: number | null = null;
const waiting: QueueEntry[] = [];
const ttsHolds = new Map<string, { label: string; since: number }>();

/** Optional probe: true while Duix is holding the GPU exclusive section. */
let duixBusyProbe: (() => boolean) | null = null;

export function setDuixBusyProbe(fn: (() => boolean) | null) {
  duixBusyProbe = fn;
}

export function getVoiceboxGpuQueueStatus() {
  return {
    active: activeLabel,
    activeStartedAt,
    waiting: waiting.map((w) => ({ label: w.label, waitedMs: Date.now() - w.enqueuedAt })),
    waitingCount: waiting.length,
    ttsHolds: [...ttsHolds.entries()].map(([id, h]) => ({
      id,
      label: h.label,
      heldMs: Date.now() - h.since,
    })),
  };
}

export function noteVoiceboxTaskStarted(taskId: string, label = 'tts') {
  if (!taskId) return;
  ttsHolds.set(taskId, { label, since: Date.now() });
}

export function noteVoiceboxTaskEnded(taskId: string) {
  if (!taskId) return;
  ttsHolds.delete(taskId);
}

async function waitDuixClear(timeoutMs = 120_000): Promise<void> {
  if (!duixBusyProbe) return;
  const start = Date.now();
  while (duixBusyProbe()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('数字人正在占用 GPU，请等数字人任务结束后再试转写/配音');
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function waitTtsHoldsClear(timeoutMs = 20 * 60 * 1000): Promise<void> {
  const start = Date.now();
  while (ttsHolds.size > 0) {
    if (Date.now() - start > timeoutMs) {
      const ids = [...ttsHolds.keys()].join(',');
      throw new Error(`Voicebox TTS 任务长时间未结束（${ids}），请稍后重试`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Run fn exclusively on the Voicebox GPU lane (after Duix + in-flight TTS clear).
 */
export async function withVoiceboxGpu<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const entry: QueueEntry = { label, enqueuedAt: Date.now() };
  waiting.push(entry);

  let release!: () => void;
  const prev = tail;
  tail = new Promise<void>((r) => {
    release = r;
  });

  try {
    await prev;
    const idx = waiting.indexOf(entry);
    if (idx >= 0) waiting.splice(idx, 1);
    await waitDuixClear();
    await waitTtsHoldsClear();
    activeLabel = label;
    activeStartedAt = Date.now();
    console.log(`[VoiceboxGPU] start ${label} (queue=${waiting.length}, ttsHolds=${ttsHolds.size})`);
    return await fn();
  } finally {
    console.log(`[VoiceboxGPU] done ${label}`);
    activeLabel = null;
    activeStartedAt = null;
    release();
  }
}

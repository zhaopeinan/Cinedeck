/**
 * Adaptive concurrency for explain animation jobs.
 *
 * AIMD-style:
 * - Start at MIN (default 2)
 * - If system looks healthy and work is queued → probe MAX (default 3)
 * - If Voicebox GPU backs up / TTS waits climb → fall back toward MIN
 *
 * Scaling down never kills in-flight jobs; pump simply stops claiming new ones.
 */
import { getVoiceboxGpuQueueStatus } from './voiceboxGpuQueue';

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const MIN = () => envInt('EXPLAIN_CONCURRENT_MIN', 2, 1, 4);
const MAX = () => {
  const lo = MIN();
  return Math.max(lo, envInt('EXPLAIN_CONCURRENT_MAX', 3, lo, 4));
};
const COOLDOWN_MS = () => envInt('EXPLAIN_CONCURRENT_COOLDOWN_MS', 120_000, 30_000, 30 * 60_000);
/** TTS queue wait above this → consider saturated */
const TTS_WAIT_SLOW_MS = () => envInt('EXPLAIN_TTS_WAIT_SLOW_MS', 20_000, 5_000, 300_000);

type TtsSample = { at: number; waitedMs: number };
type CompletionSample = { at: number; ok: boolean; limit: number };

let currentLimit = MIN();
let lastChangeAt = 0;
let lastChangeReason = 'init';
const ttsSamples: TtsSample[] = [];
const completions: CompletionSample[] = [];

function trimSamples() {
  const cutoff = Date.now() - 15 * 60_000;
  while (ttsSamples.length && ttsSamples[0].at < cutoff) ttsSamples.shift();
  while (completions.length && completions[0].at < cutoff) completions.shift();
  while (ttsSamples.length > 40) ttsSamples.shift();
  while (completions.length > 40) completions.shift();
}

function avgRecentTtsWait(): number | null {
  trimSamples();
  const recent = ttsSamples.slice(-5);
  if (!recent.length) return null;
  return recent.reduce((s, x) => s + x.waitedMs, 0) / recent.length;
}

function voiceboxPressure(): boolean {
  const st = getVoiceboxGpuQueueStatus();
  if (st.waitingCount >= 1) return true;
  // Multiple in-flight TTS holds while more explain jobs want GPU
  if (st.ttsHolds.length >= 2) return true;
  const avg = avgRecentTtsWait();
  if (avg != null && avg >= TTS_WAIT_SLOW_MS()) return true;
  return false;
}

function canScaleUp(queued: number, running: number): boolean {
  if (queued <= 0) return false;
  if (running < currentLimit) return false; // not even using current budget
  if (voiceboxPressure()) return false;
  // Need a bit of evidence that current limit is stable
  const recentOk = completions.filter((c) => c.limit === currentLimit && c.ok).slice(-2);
  if (recentOk.length < 1 && ttsSamples.length < 1) {
    // Cold start at MIN: allow one probe up if GPU idle
    return currentLimit === MIN() && getVoiceboxGpuQueueStatus().waitingCount === 0;
  }
  const avg = avgRecentTtsWait();
  if (avg != null && avg >= TTS_WAIT_SLOW_MS() * 0.6) return false;
  return true;
}

export function noteExplainTtsWait(waitedMs: number) {
  const w = Math.max(0, Number(waitedMs) || 0);
  ttsSamples.push({ at: Date.now(), waitedMs: w });
  trimSamples();
}

export function noteExplainJobFinished(ok: boolean) {
  completions.push({ at: Date.now(), ok: !!ok, limit: currentLimit });
  trimSamples();
  // Re-evaluate promptly after a finish
  evaluateExplainConcurrency({ queuedHint: null, runningHint: null });
}

/**
 * Recompute limit. Call from pump with live queue depths.
 */
export function evaluateExplainConcurrency(opts?: {
  queuedHint?: number | null;
  runningHint?: number | null;
}): number {
  const min = MIN();
  const max = MAX();
  // Clamp if env changed
  if (currentLimit < min) currentLimit = min;
  if (currentLimit > max) currentLimit = max;

  const now = Date.now();
  if (now - lastChangeAt < COOLDOWN_MS()) return currentLimit;

  const pressure = voiceboxPressure();
  if (pressure && currentLimit > min) {
    currentLimit -= 1;
    lastChangeAt = now;
    lastChangeReason = `scale_down:voicebox_pressure(waiting=${getVoiceboxGpuQueueStatus().waitingCount},avgTtsWait=${avgRecentTtsWait()?.toFixed(0) ?? 'n/a'})`;
    console.log(`[ExplainConcurrency] ${lastChangeReason} → ${currentLimit} (min=${min}, max=${max})`);
    return currentLimit;
  }

  const queued = opts?.queuedHint != null ? opts.queuedHint : null;
  const running = opts?.runningHint != null ? opts.runningHint : null;
  if (queued != null && running != null && currentLimit < max && canScaleUp(queued, running)) {
    currentLimit += 1;
    lastChangeAt = now;
    lastChangeReason = `scale_up:healthy_with_queue(queued=${queued},running=${running})`;
    console.log(`[ExplainConcurrency] ${lastChangeReason} → ${currentLimit} (min=${min}, max=${max})`);
    return currentLimit;
  }

  return currentLimit;
}

export function getExplainMaxConcurrent(): number {
  return evaluateExplainConcurrency();
}

export function getExplainConcurrencyStatus() {
  trimSamples();
  return {
    current: currentLimit,
    min: MIN(),
    max: MAX(),
    cooldownMs: COOLDOWN_MS(),
    lastChangeAt,
    lastChangeReason,
    avgRecentTtsWaitMs: avgRecentTtsWait(),
    voicebox: getVoiceboxGpuQueueStatus(),
    recentCompletions: completions.slice(-8),
  };
}

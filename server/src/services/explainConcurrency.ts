/**
 * Adaptive concurrency for **讲解动画生成** (LLM 分镜/HTML + 旁白)。
 *
 * 规则（可环境变量覆盖）：
 * - 默认从 1 起步，每次只 +1 / -1
 * - 上限默认 6
 * - 有排队且系统健康 → 升
 * - Voicebox 排队 / TTS 变慢 / 讲解生成阶段明显变慢或失败增多 → 降
 *
 * 降并发不杀在跑任务，只是少开新的。
 */
import { getVoiceboxGpuQueueStatus } from './voiceboxGpuQueue';

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** 所有自适应并发：默认下限 1 */
const MIN = () => envInt('EXPLAIN_CONCURRENT_MIN', 1, 1, 6);
/** 所有自适应并发：默认上限 6 */
const MAX = () => {
  const lo = MIN();
  return Math.max(lo, envInt('EXPLAIN_CONCURRENT_MAX', 6, lo, 6));
};
const COOLDOWN_MS = () => envInt('EXPLAIN_CONCURRENT_COOLDOWN_MS', 90_000, 20_000, 30 * 60_000);
const TTS_WAIT_SLOW_MS = () => envInt('EXPLAIN_TTS_WAIT_SLOW_MS', 15_000, 3_000, 300_000);
/** 讲解 HTML/分镜阶段平均耗时超过该值视为偏慢（秒级，默认 8 分钟） */
const GEN_STAGE_SLOW_MS = () => envInt('EXPLAIN_GEN_STAGE_SLOW_MS', 8 * 60_000, 60_000, 60 * 60_000);

type TtsSample = { at: number; waitedMs: number };
type GenSample = { at: number; stage: string; durationMs: number; limit: number };
type CompletionSample = { at: number; ok: boolean; limit: number };

let currentLimit = MIN();
let lastChangeAt = 0;
let lastChangeReason = 'init';
const ttsSamples: TtsSample[] = [];
const genSamples: GenSample[] = [];
const completions: CompletionSample[] = [];

function trimSamples() {
  const cutoff = Date.now() - 20 * 60_000;
  while (ttsSamples.length && ttsSamples[0].at < cutoff) ttsSamples.shift();
  while (genSamples.length && genSamples[0].at < cutoff) genSamples.shift();
  while (completions.length && completions[0].at < cutoff) completions.shift();
  while (ttsSamples.length > 50) ttsSamples.shift();
  while (genSamples.length > 50) genSamples.shift();
  while (completions.length > 50) completions.shift();
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function avgRecentTtsWait(): number | null {
  trimSamples();
  return avg(ttsSamples.slice(-6).map((x) => x.waitedMs));
}

function avgRecentGenMs(): number | null {
  trimSamples();
  return avg(genSamples.slice(-6).map((x) => x.durationMs));
}

function recentFailRate(): number | null {
  trimSamples();
  const recent = completions.slice(-8);
  if (recent.length < 3) return null;
  const bad = recent.filter((c) => !c.ok).length;
  return bad / recent.length;
}

function voiceboxPressure(): boolean {
  const st = getVoiceboxGpuQueueStatus();
  if (st.waitingCount >= 1) return true;
  if (st.ttsHolds.length >= 2) return true;
  const ttsAvg = avgRecentTtsWait();
  if (ttsAvg != null && ttsAvg >= TTS_WAIT_SLOW_MS()) return true;
  return false;
}

/** 讲解动画生成（LLM/HTML）压力：阶段耗时飙升或失败率高 */
function generationPressure(): boolean {
  const genAvg = avgRecentGenMs();
  if (genAvg != null && genAvg >= GEN_STAGE_SLOW_MS()) return true;
  const failRate = recentFailRate();
  if (failRate != null && failRate >= 0.4) return true;
  return false;
}

function systemPressure(): boolean {
  return voiceboxPressure() || generationPressure();
}

function canScaleUp(queued: number, running: number): boolean {
  if (queued <= 0) return false;
  if (running < currentLimit) return false;
  if (systemPressure()) return false;

  // 冷启动：在 1 上跑稳一点再探 2（有排队且无压力即可）
  if (currentLimit === MIN()) {
    const recentOk = completions.filter((c) => c.ok).slice(-1);
    return recentOk.length >= 1 || getVoiceboxGpuQueueStatus().waitingCount === 0;
  }

  // 更高档位：至少有一次在当前档位成功完成，且 TTS/生成不太慢
  const okAtLimit = completions.filter((c) => c.limit === currentLimit && c.ok).slice(-2);
  if (okAtLimit.length < 1) return false;

  const ttsAvg = avgRecentTtsWait();
  if (ttsAvg != null && ttsAvg >= TTS_WAIT_SLOW_MS() * 0.7) return false;
  const genAvg = avgRecentGenMs();
  if (genAvg != null && genAvg >= GEN_STAGE_SLOW_MS() * 0.85) return false;
  return true;
}

export function noteExplainTtsWait(waitedMs: number) {
  ttsSamples.push({ at: Date.now(), waitedMs: Math.max(0, Number(waitedMs) || 0) });
  trimSamples();
}

/** 记录讲解生成阶段耗时（scripting / sample HTML / final HTML 等） */
export function noteExplainGenStage(stage: string, durationMs: number) {
  genSamples.push({
    at: Date.now(),
    stage: String(stage || 'gen'),
    durationMs: Math.max(0, Number(durationMs) || 0),
    limit: currentLimit,
  });
  trimSamples();
}

export function noteExplainJobFinished(ok: boolean) {
  completions.push({ at: Date.now(), ok: !!ok, limit: currentLimit });
  trimSamples();
  evaluateExplainConcurrency({ queuedHint: null, runningHint: null });
}

/**
 * 重新计算并发上限。pump 时传入 queued/running。
 * 每次只升降 1 档。
 */
export function evaluateExplainConcurrency(opts?: {
  queuedHint?: number | null;
  runningHint?: number | null;
}): number {
  const min = MIN();
  const max = MAX();
  if (currentLimit < min) currentLimit = min;
  if (currentLimit > max) currentLimit = max;

  const now = Date.now();
  if (now - lastChangeAt < COOLDOWN_MS() && lastChangeAt > 0) return currentLimit;

  const pressure = systemPressure();
  if (pressure && currentLimit > min) {
    currentLimit -= 1;
    lastChangeAt = now;
    lastChangeReason = `scale_down:${
      voiceboxPressure() ? 'voicebox' : 'generation'
    }(ttsWait=${avgRecentTtsWait()?.toFixed(0) ?? 'n/a'},genMs=${avgRecentGenMs()?.toFixed(0) ?? 'n/a'},failRate=${recentFailRate()?.toFixed(2) ?? 'n/a'})`;
    console.log(`[ExplainConcurrency] ${lastChangeReason} → ${currentLimit} (range ${min}–${max})`);
    return currentLimit;
  }

  const queued = opts?.queuedHint != null ? opts.queuedHint : null;
  const running = opts?.runningHint != null ? opts.runningHint : null;
  if (queued != null && running != null && currentLimit < max && canScaleUp(queued, running)) {
    currentLimit += 1;
    lastChangeAt = now;
    lastChangeReason = `scale_up:healthy(queued=${queued},running=${running})`;
    console.log(`[ExplainConcurrency] ${lastChangeReason} → ${currentLimit} (range ${min}–${max})`);
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
    kind: 'explain_animation',
    current: currentLimit,
    min: MIN(),
    max: MAX(),
    cooldownMs: COOLDOWN_MS(),
    lastChangeAt,
    lastChangeReason,
    avgRecentTtsWaitMs: avgRecentTtsWait(),
    avgRecentGenMs: avgRecentGenMs(),
    recentFailRate: recentFailRate(),
    voicebox: getVoiceboxGpuQueueStatus(),
    recentCompletions: completions.slice(-8),
  };
}

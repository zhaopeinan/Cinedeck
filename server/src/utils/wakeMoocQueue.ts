/**
 * Wake the live dispatcher MOOC queue.
 *
 * - In-process (API / pipeline): calls wakeMoocQueue() directly.
 * - External scripts (docker exec batch_*): HTTP POST to localhost internal endpoint,
 *   because a separate Node process has no pipeline deps and pumpMoocQueue() is a no-op.
 */
import { wakeMoocQueue as wakeInProcess } from '../services/moocPipelineWorker';

const DEFAULT_WAKE_URL = process.env.MOOC_WAKE_URL
  || `http://127.0.0.1:${process.env.PORT || 3001}/api/internal/mooc/wake`;

export async function ensureMoocQueueAwake(opts?: {
  reason?: string;
  url?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; via: 'in-process' | 'http' | 'none'; detail?: string }> {
  if (wakeInProcess()) {
    return { ok: true, via: 'in-process' };
  }

  const url = opts?.url || DEFAULT_WAKE_URL;
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: opts?.reason || 'external_wake' }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, via: 'http', detail: `HTTP ${res.status} ${text.slice(0, 200)}` };
    }
    return { ok: true, via: 'http' };
  } catch (err: any) {
    return { ok: false, via: 'none', detail: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

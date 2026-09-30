import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GpuDeviceStatus {
  index: number;
  name: string;
  utilizationGpu: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
}

export interface GpuStatusSnapshot {
  available: boolean;
  gpus: GpuDeviceStatus[];
  error: string | null;
  queriedAt: string;
}

const CACHE_TTL_MS = 800;
let cache: { at: number; data: GpuStatusSnapshot } | null = null;

function parseNum(raw: string): number | null {
  const s = (raw || '').trim();
  if (!s || s === '[N/A]' || s === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function queryNvidiaSmi(): Promise<GpuStatusSnapshot> {
  const queriedAt = new Date().toISOString();
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 2000, maxBuffer: 256 * 1024 },
    );

    const gpus: GpuDeviceStatus[] = [];
    for (const line of stdout.split('\n')) {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 6) continue;
      const index = parseNum(parts[0]);
      gpus.push({
        index: index != null ? Math.round(index) : gpus.length,
        name: parts[1] || `GPU ${gpus.length}`,
        utilizationGpu: parseNum(parts[2]),
        memoryUsedMb: parseNum(parts[3]),
        memoryTotalMb: parseNum(parts[4]),
        temperatureC: parseNum(parts[5]),
        powerDrawW: parseNum(parts[6]),
        powerLimitW: parseNum(parts[7]),
      });
    }

    if (!gpus.length) {
      return { available: false, gpus: [], error: 'nvidia-smi 无输出', queriedAt };
    }
    return { available: true, gpus, error: null, queriedAt };
  } catch (err: any) {
    const msg = err?.code === 'ENOENT'
      ? '未找到 nvidia-smi'
      : (err?.stderr || err?.message || '查询失败').toString().slice(0, 300);
    return { available: false, gpus: [], error: msg, queriedAt };
  }
}

/** Cached snapshot; safe for 1Hz polling. */
export async function getGpuStatus(): Promise<GpuStatusSnapshot> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  const data = await queryNvidiaSmi();
  cache = { at: now, data };
  return data;
}

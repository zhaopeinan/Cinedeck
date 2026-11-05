/**
 * Build LRC lyrics aligned to TTS audio.
 * Prefer ffmpeg silencedetect boundaries; fall back to punctuation-weighted timing.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface LrcLine {
  startSec: number;
  text: string;
}

export function formatLrcTimestamp(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  const whole = Math.floor(rem);
  const hundredths = Math.min(99, Math.round((rem - whole) * 100));
  return `[${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
}

export function renderLrc(lines: LrcLine[], meta?: { title?: string; artist?: string }): string {
  const header: string[] = [];
  if (meta?.title) header.push(`[ti:${meta.title.replace(/[\[\]]/g, '')}]`);
  if (meta?.artist) header.push(`[ar:${meta.artist.replace(/[\[\]]/g, '')}]`);
  header.push('[by:Cinedeck]');
  const body = lines
    .filter((l) => l.text.trim())
    .map((l) => `${formatLrcTimestamp(l.startSec)}${l.text.trim()}`);
  return [...header, ...body].join('\n') + '\n';
}

/** Split into lyric lines; keep Chinese/English clause punctuation on the line. */
export function splitLyricLines(text: string): string[] {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  // Prefer explicit newlines
  if (raw.includes('\n')) {
    return raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }
  // Split after clause punctuation but keep the mark
  const parts = raw
    .split(/(?<=[。！？；!?；…]|(?<![A-Za-z0-9])[.!?;])|(?<=[，、,：:])/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Merge tiny leftovers into previous
  const merged: string[] = [];
  for (const p of parts) {
    if (merged.length && p.length <= 1 && /[。！？；，、,.!?;:：…]/.test(p)) {
      merged[merged.length - 1] += p;
    } else {
      merged.push(p);
    }
  }
  return merged.length ? merged : [raw];
}

function speakingWeight(line: string): number {
  // Chinese ideographs ≈ 1 beat; latin words ≈ 1; digits/punct lighter
  let w = 0;
  const chars = Array.from(line);
  for (const ch of chars) {
    if (/[\u4e00-\u9fff]/.test(ch)) w += 1;
    else if (/[A-Za-z]/.test(ch)) w += 0.35;
    else if (/\d/.test(ch)) w += 0.5;
    else if (/[。！？!?]/.test(ch)) w += 0.15;
    else if (/[，、,；;：:]/.test(ch)) w += 0.08;
  }
  return Math.max(0.5, w);
}

function pauseAfter(line: string): number {
  if (/[。！？!?…]/.test(line.slice(-1))) return 0.35;
  if (/[；;]/.test(line.slice(-1))) return 0.25;
  if (/[，、,：:]/.test(line.slice(-1))) return 0.18;
  return 0.08;
}

/** Proportional timing with punctuation pause budget. */
export function alignLinesProportional(lines: string[], durationSec: number): LrcLine[] {
  if (!lines.length) return [];
  const dur = Math.max(0.2, durationSec);
  const weights = lines.map(speakingWeight);
  const pauses = lines.map((l, i) => (i < lines.length - 1 ? pauseAfter(l) : 0));
  const pauseSum = pauses.reduce((a, b) => a + b, 0);
  const speakBudget = Math.max(0.2, dur - Math.min(pauseSum, dur * 0.35));
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const scale = speakBudget / wSum;

  let t = 0;
  const out: LrcLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push({ startSec: Math.min(dur - 0.01, t), text: lines[i] });
    t += weights[i] * scale + (pauses[i] || 0);
  }
  // Ensure last line isn't past end; nudge first if needed
  if (out.length) out[0].startSec = 0;
  return out;
}

export interface SilenceGap {
  start: number;
  end: number;
}

/** Parse ffmpeg silencedetect stderr. */
export function parseSilenceDetect(stderr: string): SilenceGap[] {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const s = /silence_start:\s*([0-9.]+)/i.exec(line);
    if (s) starts.push(Number(s[1]));
    const e = /silence_end:\s*([0-9.]+)/i.exec(line);
    if (e) ends.push(Number(e[1]));
  }
  const gaps: SilenceGap[] = [];
  const n = Math.min(starts.length, ends.length);
  for (let i = 0; i < n; i++) {
    if (ends[i] > starts[i]) gaps.push({ start: starts[i], end: ends[i] });
  }
  // orphan start without end → ignore
  return gaps;
}

export function detectSilences(audioPath: string, opts?: {
  noiseDb?: number;
  minDuration?: number;
  timeoutMs?: number;
}): Promise<SilenceGap[]> {
  const noiseDb = opts?.noiseDb ?? -32;
  const minDuration = opts?.minDuration ?? 0.12;
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', audioPath,
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
      '-f', 'null', '-',
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, opts?.timeoutMs ?? 60000);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parseSilenceDetect(stderr));
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

/**
 * Align lyric lines to silence gaps between clauses.
 * Falls back to proportional if silence count is unusable.
 */
export function alignLinesWithSilences(
  lines: string[],
  durationSec: number,
  silences: SilenceGap[],
): LrcLine[] {
  if (lines.length <= 1) {
    return lines.map((text) => ({ startSec: 0, text }));
  }
  const dur = Math.max(0.2, durationSec);
  // Interior pauses: ignore leading/trailing silence near edges
  const interior = silences.filter((g) => g.start > 0.08 && g.end < dur - 0.08 && (g.end - g.start) >= 0.1);
  const need = lines.length - 1;
  if (interior.length < Math.max(1, Math.floor(need * 0.5))) {
    return alignLinesProportional(lines, dur);
  }

  // Pick `need` silences evenly if too many
  let chosen = interior;
  if (interior.length > need) {
    chosen = [];
    for (let i = 0; i < need; i++) {
      const idx = Math.round((i + 0.5) * (interior.length / need) - 0.5);
      chosen.push(interior[Math.max(0, Math.min(interior.length - 1, idx))]);
    }
    // de-dupe preserving order
    const seen = new Set<number>();
    chosen = chosen.filter((g) => {
      const k = Math.round(g.start * 100);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    while (chosen.length < need && interior.length) {
      const extra = interior.find((g) => !chosen.includes(g));
      if (!extra) break;
      chosen.push(extra);
      chosen.sort((a, b) => a.start - b.start);
    }
  }

  if (chosen.length < need) {
    // Not enough pauses — hybrid: use known pauses, fill rest proportionally within spans
    return alignLinesProportional(lines, dur);
  }

  chosen = chosen.slice(0, need).sort((a, b) => a.start - b.start);
  const starts: number[] = [0];
  for (const g of chosen) {
    // Next line starts when speech resumes after pause
    starts.push(Math.min(dur - 0.01, g.end));
  }
  // Monotonic fix
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] <= starts[i - 1]) starts[i] = starts[i - 1] + 0.05;
  }
  return lines.map((text, i) => ({
    startSec: Math.min(dur - 0.01, Math.max(0, starts[i] ?? 0)),
    text,
  }));
}

export async function buildLrcForAudio(opts: {
  text: string;
  durationSec: number;
  audioPath?: string | null;
  title?: string;
  artist?: string;
}): Promise<{ lrc: string; lines: LrcLine[]; method: 'silence' | 'proportional' }> {
  const lines = splitLyricLines(opts.text);
  const dur = Math.max(0.2, Number(opts.durationSec) || 0);
  let aligned: LrcLine[] = [];
  let method: 'silence' | 'proportional' = 'proportional';

  if (opts.audioPath && fs.existsSync(opts.audioPath) && lines.length > 1) {
    const silences = await detectSilences(opts.audioPath);
    const viaSilence = alignLinesWithSilences(lines, dur, silences);
    // Heuristic: if we got distinct increasing starts matching line count, prefer silence
    const spreads = viaSilence.map((l) => l.startSec);
    const increasing = spreads.every((v, i) => i === 0 || v >= spreads[i - 1]);
    if (increasing && silences.length >= Math.max(1, lines.length - 2)) {
      aligned = viaSilence;
      method = 'silence';
    } else {
      aligned = alignLinesProportional(lines, dur);
    }
  } else {
    aligned = alignLinesProportional(lines, dur);
  }

  return {
    lrc: renderLrc(aligned, { title: opts.title, artist: opts.artist }),
    lines: aligned,
    method,
  };
}

/** Write buffer to temp file, run callback, cleanup. */
export async function withTempAudioFile(
  data: Buffer,
  ext: string,
  fn: (filePath: string) => Promise<void> | void,
): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cinedeck-lrc-'));
  const filePath = path.join(dir, `audio${ext.startsWith('.') ? ext : `.${ext}`}`);
  try {
    await fs.promises.writeFile(filePath, data);
    await fn(filePath);
  } finally {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function wavBufferToMp3(wav: Buffer, timeoutMs = 120000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-codec:a', 'libmp3lame',
      '-q:a', '2',
      '-f', 'mp3',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('mp3 转码超时'));
    }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`mp3 转码失败：${stderr.slice(-300) || code}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.write(wav);
    child.stdin.end();
  });
}

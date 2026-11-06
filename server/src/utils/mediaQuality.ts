/**
 * Media quality gates for TTS audio and explain-animation exports.
 * Goal: catch "Voicebox/HTML succeeded but content is unusable" before compose.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

export class MediaQualityError extends Error {
  code = 'MEDIA_QC_FAIL';
  constructor(message: string) {
    super(message);
    this.name = 'MediaQualityError';
  }
}

function run(
  command: string,
  args: string[],
  timeoutMs = 60000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    };
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => done(code ?? 1));
    child.on('error', () => done(1));
  });
}

/** Rewrite Voicebox URL to the in-cluster origin when needed. */
export function normalizeVoiceboxAudioUrl(url: string): string {
  const base = (process.env.VOICEBOX_BASE_URL || 'http://ppt-audio-voicebox:17493').replace(/\/$/, '');
  try {
    const u = new URL(url);
    const b = new URL(base);
    if (u.pathname.startsWith('/audio/') || u.port === '17493' || u.port === b.port) {
      return `${b.origin}${u.pathname}${u.search}`;
    }
  } catch { /* keep */ }
  return url;
}

export async function downloadVoiceboxAudio(url: string, dest: string): Promise<void> {
  const fetchUrl = normalizeVoiceboxAudioUrl(url);
  const res = await axios.get(fetchUrl, { responseType: 'arraybuffer', timeout: 180000 });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(res.data));
}

export async function probeAudioDurationSec(filePath: string): Promise<number> {
  const r = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    filePath,
  ], 30000);
  const dur = Number(String(r.stdout || '').trim());
  if (!(r.code === 0 && Number.isFinite(dur) && dur > 0)) {
    throw new MediaQualityError(`无法解析音频时长：${path.basename(filePath)}`);
  }
  return dur;
}

export type SpeechAudioQcResult = {
  ok: boolean;
  durationSec: number;
  charsPerSec: number | null;
  reasons: string[];
};

/**
 * Reject TTS that is wildly too long/short vs text, or nearly empty / clipped.
 * Empirically Chinese narration sits near ~4.5–5.5 chars/sec in this product.
 */
export async function qcSpeechAudio(opts: {
  filePath: string;
  text?: string;
  /** Soft expected duration (e.g. slide.estimated_duration); optional */
  expectedDurationSec?: number | null;
  minDurationSec?: number;
}): Promise<SpeechAudioQcResult> {
  const reasons: string[] = [];
  if (!fs.existsSync(opts.filePath)) {
    return { ok: false, durationSec: 0, charsPerSec: null, reasons: ['音频文件不存在'] };
  }
  const size = fs.statSync(opts.filePath).size;
  if (size < 1500) {
    return { ok: false, durationSec: 0, charsPerSec: null, reasons: [`音频过小（${size}B）`] };
  }

  let durationSec = 0;
  try {
    durationSec = await probeAudioDurationSec(opts.filePath);
  } catch (e: any) {
    return { ok: false, durationSec: 0, charsPerSec: null, reasons: [e?.message || 'ffprobe 失败'] };
  }

  const minDur = opts.minDurationSec ?? 0.4;
  if (durationSec < minDur) reasons.push(`时长过短（${durationSec.toFixed(2)}s）`);

  const text = String(opts.text || '').replace(/\s+/g, '');
  const textLen = [...text].length; // unicode-aware-ish
  let charsPerSec: number | null = null;
  if (textLen >= 20 && durationSec > 0) {
    charsPerSec = textLen / durationSec;
    // Too slow ⇒ stretched/garbled/looped audio (seen: 401 chars → 707s ≈ 0.57 cps)
    if (charsPerSec < 1.6) {
      reasons.push(
        `语速异常偏慢（${charsPerSec.toFixed(2)} 字/秒，约 ${textLen} 字 / ${durationSec.toFixed(1)}s）；疑似杂音或生成失控`,
      );
    }
    // Too fast ⇒ truncated / wrong file
    if (charsPerSec > 12) {
      reasons.push(
        `语速异常偏快（${charsPerSec.toFixed(2)} 字/秒，约 ${textLen} 字 / ${durationSec.toFixed(1)}s）；疑似截断`,
      );
    }
  }

  const expected = Number(opts.expectedDurationSec);
  if (Number.isFinite(expected) && expected >= 8 && durationSec > 0) {
    const ratio = durationSec / expected;
    if (ratio > 3.5) {
      reasons.push(
        `相对预估时长过长（实际 ${durationSec.toFixed(1)}s / 预估 ${expected.toFixed(1)}s = ${ratio.toFixed(1)}x）`,
      );
    }
    if (ratio < 0.25) {
      reasons.push(
        `相对预估时长过短（实际 ${durationSec.toFixed(1)}s / 预估 ${expected.toFixed(1)}s = ${ratio.toFixed(2)}x）`,
      );
    }
  }

  // Energy sanity on first ~20s
  const ast = await run('ffmpeg', [
    '-v', 'error',
    '-t', '20',
    '-i', opts.filePath,
    '-af', 'volumedetect',
    '-f', 'null', '-',
  ], 60000);
  const meanM = (ast.stderr || '').match(/mean_volume:\s*([-\d.]+)\s*dB/);
  const maxM = (ast.stderr || '').match(/max_volume:\s*([-\d.]+)\s*dB/);
  if (meanM) {
    const mean = Number(meanM[1]);
    if (Number.isFinite(mean) && mean < -45) {
      reasons.push(`前 20 秒音量过低（mean ${mean.toFixed(1)} dB），疑似静音/坏轨`);
    }
  }
  if (maxM) {
    const peak = Number(maxM[1]);
    if (Number.isFinite(peak) && peak > -0.05) {
      // near 0 dBFS often means hard clipping; soft warn only if also mean is high
      const mean = meanM ? Number(meanM[1]) : -99;
      if (mean > -12) reasons.push(`峰值接近削波（max ${peak.toFixed(2)} dB）`);
    }
  }

  return { ok: reasons.length === 0, durationSec, charsPerSec, reasons };
}

export async function assertSpeechAudioOk(opts: Parameters<typeof qcSpeechAudio>[0]): Promise<SpeechAudioQcResult> {
  const r = await qcSpeechAudio(opts);
  if (!r.ok) throw new MediaQualityError(r.reasons.join('；'));
  return r;
}

export type ExplainMotionQcResult = {
  ok: boolean;
  reasons: string[];
  /** Lower is more different (more motion). Uses inverse-ish of PSNR for logging. */
  scores: { mid: number; end: number; midPsnr: number; endPsnr: number };
};

/** Average PSNR between two images; Infinity if identical. Higher ⇒ more similar. */
export async function imagePsnrDb(aPath: string, bPath: string): Promise<number> {
  const r = await run('ffmpeg', [
    '-v', 'info',
    '-i', aPath,
    '-i', bPath,
    '-lavfi', 'psnr',
    '-f', 'null', '-',
  ], 60000);
  const m = `${r.stderr}\n${r.stdout}`.match(/average:([inf\d.]+)/i);
  if (!m) return 0;
  if (/^inf$/i.test(m[1])) return 99;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * QC an explain MP4 by sampling early/mid/late frames.
 * Frozen "title pile + empty stage" clips fail here (very high PSNR across timeline).
 */
export async function qcExplainAnimationMp4(opts: {
  filePath: string;
  durationSec?: number;
  /** Fail when BOTH mid and end PSNR vs start exceed this (dB). */
  maxStillPsnrDb?: number;
}): Promise<ExplainMotionQcResult> {
  const reasons: string[] = [];
  const emptyScores = { mid: 0, end: 0, midPsnr: 0, endPsnr: 0 };
  if (!fs.existsSync(opts.filePath) || fs.statSync(opts.filePath).size < 5000) {
    return { ok: false, reasons: ['讲解视频不存在或过小'], scores: emptyScores };
  }

  let duration = Number(opts.durationSec) || 0;
  if (!(duration > 1)) {
    const r = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', opts.filePath,
    ], 30000);
    duration = Number(String(r.stdout || '').trim()) || 0;
  }
  if (!(duration > 2)) {
    return { ok: false, reasons: ['讲解视频时长异常'], scores: emptyScores };
  }

  const tmpDir = path.join(path.dirname(opts.filePath), `_qc_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const points = [
    { name: 't0', t: Math.min(0.4, duration * 0.02) },
    { name: 'mid', t: duration * 0.45 },
    { name: 'end', t: Math.max(0.5, duration * 0.88) },
  ];
  try {
    for (const p of points) {
      const out = path.join(tmpDir, `${p.name}.png`);
      const r = await run('ffmpeg', [
        '-y', '-ss', p.t.toFixed(3), '-i', opts.filePath,
        '-frames:v', '1', out,
      ], 60000);
      if (r.code !== 0 || !fs.existsSync(out)) {
        reasons.push(`抽帧失败（${p.name}@${p.t.toFixed(1)}s）`);
      }
    }
    if (reasons.length) {
      return { ok: false, reasons, scores: emptyScores };
    }
    const t0 = path.join(tmpDir, 't0.png');
    const midPsnr = await imagePsnrDb(t0, path.join(tmpDir, 'mid.png'));
    const endPsnr = await imagePsnrDb(t0, path.join(tmpDir, 'end.png'));
    // Convert to a 0..1 "motion-ish" score for logs: 1 - clamp(psnr/50)
    const toMotion = (psnr: number) => Math.max(0, Math.min(1, 1 - (psnr / 50)));
    const mid = toMotion(midPsnr);
    const end = toMotion(endPsnr);
    const maxStill = opts.maxStillPsnrDb ?? 28;
    if (midPsnr >= maxStill && endPsnr >= maxStill) {
      reasons.push(
        `画面几乎无变化（PSNR mid=${midPsnr.toFixed(1)}dB, end=${endPsnr.toFixed(1)}dB）；疑似录制 seek 失效或动画卡在初始帧（叠字/空白）`,
      );
    }
    return {
      ok: reasons.length === 0,
      reasons,
      scores: { mid, end, midPsnr, endPsnr },
    };
  } finally {
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch { /* ignore */ }
  }
}

export async function assertExplainAnimationMp4Ok(
  opts: Parameters<typeof qcExplainAnimationMp4>[0],
): Promise<ExplainMotionQcResult> {
  const r = await qcExplainAnimationMp4(opts);
  if (!r.ok) throw new MediaQualityError(r.reasons.join('；'));
  return r;
}

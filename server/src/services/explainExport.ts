import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { HYPERFRAMES_IMAGE } from './hyperframeRender';

export type ExplainExportQuality = '720p' | '1080p' | '1440p';

export const EXPLAIN_EXPORT_QUALITIES: Array<{
  id: ExplainExportQuality;
  label: string;
  width: number;
  height: number;
}> = [
  { id: '720p', label: '720p（1280×720）', width: 1280, height: 720 },
  { id: '1080p', label: '1080p（1920×1080）', width: 1920, height: 1080 },
  { id: '1440p', label: '1440p（2560×1440）', width: 2560, height: 1440 },
];

function run(
  command: string,
  args: string[],
  opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
  },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    };
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, opts?.timeoutMs ?? 30 * 60 * 1000);
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      opts?.onStdout?.(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      // ffmpeg writes progress to stderr; recorder may too
      opts?.onStdout?.(s);
    });
    child.on('close', (code) => finish(code ?? 1));
    child.on('error', () => finish(1));
  });
}

function summarizeExportFailure(stdout: string, stderr: string, timedOut: boolean): string {
  if (timedOut) {
    return '导出超时：截帧墙钟远超片长，请重试（已提高超时与截帧速度）';
  }
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^frame\s+\d+\/\d+/i.test(l) && !/^ffmpeg /i.test(l));
  const tail = lines.slice(-12).join(' | ').slice(0, 600);
  return tail || '导出进程异常退出';
}

async function isUsableMp4(filePath: string, minDurationSec = 2): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;
  if (fs.statSync(filePath).size < 5000) return false;
  const r = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json',
    filePath,
  ], { timeoutMs: 30000 });
  if (r.code !== 0) return false;
  try {
    const j = JSON.parse(r.stdout || '{}');
    const dur = Number(j?.format?.duration);
    const hasVideo = Array.isArray(j?.streams) && j.streams.some((s: any) => s.codec_type === 'video');
    return hasVideo && Number.isFinite(dur) && dur >= minDurationSec;
  } catch {
    return false;
  }
}

async function resolveHostPath(containerPath: string): Promise<string> {
  if (!containerPath.startsWith('/data')) return containerPath;
  const dataHost = process.env.HYPERFRAMES_DATA_HOST || process.env.DATA_HOST || '';
  if (dataHost) return path.join(dataHost, containerPath.slice('/data'.length));

  const name = process.env.HOSTNAME || 'ppt_audio-dispatcher-1';
  const inspect = await run('docker', ['inspect', '-f', '{{range .Mounts}}{{.Destination}}|{{.Source}}{{println}}{{end}}', name], { timeoutMs: 15000 });
  if (inspect.code === 0) {
    for (const line of inspect.stdout.split('\n')) {
      const [dest, src] = line.trim().split('|');
      if (dest === '/data' && src) return path.join(src, containerPath.slice('/data'.length));
    }
  }
  const vol = await run('docker', ['volume', 'inspect', '-f', '{{.Mountpoint}}', 'ppt_audio_app-data'], { timeoutMs: 15000 });
  if (vol.code === 0 && vol.stdout.trim()) {
    return path.join(vol.stdout.trim(), containerPath.slice('/data'.length));
  }
  return containerPath;
}

export function estimateExplainDurationSec(scriptJson: string | null, audioPath: string | null): number {
  if (audioPath && fs.existsSync(audioPath)) {
    // Rough: rely on caller probing; fallback below
  }
  try {
    const script = JSON.parse(scriptJson || '{}');
    const nodes = Array.isArray(script?.nodes) ? script.nodes : [];
    const sum = nodes.reduce((acc: number, n: any) => acc + (Number(n?.seconds) || 0), 0);
    if (sum >= 3) return Math.min(300, Math.ceil(sum + 1));
  } catch { /* ignore */ }
  return 30;
}

export async function probeAudioDurationSec(audioPath: string): Promise<number | null> {
  if (!fs.existsSync(audioPath)) return null;
  const r = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath,
  ], { timeoutMs: 30000 });
  if (r.code !== 0) return null;
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Strip embedded base64 narration from HTML — audio is muxed by ffmpeg from a
 * separate wav. Huge data: URIs commonly stall Puppeteer navigation.
 */
export function prepareExplainHtmlForRecording(html: string): string {
  let out = html;
  // Remove injected explain-narration <audio>…</audio>
  out = out.replace(/<audio\b[^>]*\bid\s*=\s*["']explain-narration["'][^>]*>[\s\S]*?<\/audio>/gi, '');
  // Remove any remaining giant data:audio URIs (safety)
  out = out.replace(/\s*src\s*=\s*["']data:audio\/[^"']+["']/gi, ' src=""');
  // Drop narration sync scripts (old + id="explain-narration-sync")
  out = out.replace(
    /<script(?:\s+id=["']explain-narration-sync["'])?>\s*\(function\(\)\{\s*var a=document\.getElementById\(['"]explain-narration['"]\);[\s\S]*?<\/script>/gi,
    '',
  );

  // Hide interactive preview chrome (play bar / scrubber) — must not appear in MP4.
  // Preview iframe keeps the original HTML; only the recording copy gets this CSS.
  const hidePlayerCss = `
<style id="explain-hide-player-chrome">
#player, #player *, #playBtn, #playIcon, #track, #fill, #knob, #chapter, #time,
#chapterLabel, #timeLabel, #progressTrack, #progressFill,
#controls, #controlBar, #control-bar, #scrubber, #progress,
.player-bar, .playback-bar, .play-bar, .controls-bar,
[data-explain-player], [aria-label="播放/暂停"], [aria-label="播放"], [aria-label="暂停"] {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
  width: 0 !important;
  height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
}
</style>`;
  if (!/id=["']explain-hide-player-chrome["']/.test(out)) {
    if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${hidePlayerCss}</head>`);
    else if (/<body[^>]*>/i.test(out)) out = out.replace(/<body([^>]*)>/i, `<body$1>${hidePlayerCss}`);
    else out = `${hidePlayerCss}\n${out}`;
  }

  // Expose timeline controls for headless capture. Screenshotting is slower than
  // realtime, so rAF-driven clocks freeze; the recorder seeks each frame instead.
  const bridge = `
window.__explainRec = {
  seek: function(sec){
    try {
      if (typeof playing !== 'undefined') playing = false;
      if (typeof lastTs !== 'undefined') lastTs = 0;
      // Some decks use seconds in t; others use milliseconds in elapsed (TOTAL>1000).
      if (typeof t === 'number') t = Math.max(0, sec);
      if (typeof elapsed === 'number') {
        var scale = (typeof TOTAL === 'number' && TOTAL > 1000) ? 1000 : 1;
        elapsed = Math.max(0, sec * scale);
      }
      if (typeof updateUI === 'function') updateUI();
      if (typeof applyTimeline === 'function' && typeof elapsed === 'number') applyTimeline(elapsed, true);
      if (typeof render === 'function' && typeof t === 'number') render(t);
    } catch (e) {}
  },
  pause: function(){
    try { if (typeof playing !== 'undefined') playing = false; } catch (e) {}
  },
  total: function(){
    try {
      if (typeof TOTAL === 'number' && TOTAL > 0) {
        return TOTAL > 1000 ? TOTAL / 1000 : TOTAL;
      }
    } catch (e) {}
    return 0;
  }
};
`;
  // Prefer inject inside the main IIFE after timeline vars so it closes over t/elapsed/playing.
  if (!out.includes('window.__explainRec')) {
    if (/\bvar\s+t\s*=\s*0\s*;/.test(out)) {
      out = out.replace(/\bvar\s+t\s*=\s*0\s*;/, (m) => `${m}\n${bridge}`);
    } else if (/\bvar\s+elapsed\s*=\s*0\s*;/.test(out)) {
      out = out.replace(/\bvar\s+elapsed\s*=\s*0\s*;/, (m) => `${m}\n${bridge}`);
    } else if (/\bvar\s+playing\s*=\s*(true|false)\s*;/.test(out)) {
      out = out.replace(/\bvar\s+playing\s*=\s*(true|false)\s*;/, (m) => `${m}\n${bridge}`);
    } else {
      const snip = `<script>${bridge}</script>`;
      if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${snip}</body>`);
      else out = `${out}\n${snip}`;
    }
  }
  return out;
}

/**
 * Record final/index.html to MP4 via Chromium in hyperframes image.
 */
export async function exportExplainHtmlToMp4(opts: {
  htmlPath: string;
  outPath: string;
  quality: ExplainExportQuality;
  audioPath?: string | null;
  durationSec: number;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const q = EXPLAIN_EXPORT_QUALITIES.find((x) => x.id === opts.quality) || EXPLAIN_EXPORT_QUALITIES[1];
  const htmlPath = path.resolve(opts.htmlPath);
  const outPath = path.resolve(opts.outPath);
  const workDir = path.dirname(htmlPath);
  if (!fs.existsSync(htmlPath)) throw new Error('完整动画 HTML 不存在');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const image = process.env.HYPERFRAMES_IMAGE || HYPERFRAMES_IMAGE;
  const hasImage = await run('docker', ['image', 'inspect', image], { timeoutMs: 15000 });
  if (hasImage.code !== 0) {
    throw new Error(`缺少渲染镜像 ${image}，无法导出 MP4`);
  }

  // Ensure recorder script is available next to HTML (copied from image build / hot-patch)
  const scriptSrcCandidates = [
    path.resolve(__dirname, '../../scripts/record_html_mp4.mjs'),
    path.resolve(process.cwd(), 'scripts/record_html_mp4.mjs'),
    '/app/scripts/record_html_mp4.mjs',
  ];
  const scriptSrc = scriptSrcCandidates.find((p) => fs.existsSync(p));
  if (!scriptSrc) throw new Error('缺少 record_html_mp4.mjs 脚本');
  const scriptDest = path.join(workDir, 'record_html_mp4.mjs');
  fs.copyFileSync(scriptSrc, scriptDest);

  // Write a slim recording HTML (no embedded wav) so Chromium loads quickly
  const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
  const slimHtml = prepareExplainHtmlForRecording(rawHtml);
  const recordHtmlName = 'index.record.html';
  const recordHtmlPath = path.join(workDir, recordHtmlName);
  fs.writeFileSync(recordHtmlPath, slimHtml, 'utf-8');
  opts.onLog?.(
    `record html ${Buffer.byteLength(rawHtml)} → ${Buffer.byteLength(slimHtml)} bytes`,
  );

  const hostWork = await resolveHostPath(workDir);
  const outName = path.basename(outPath);
  const audioName = opts.audioPath && fs.existsSync(opts.audioPath)
    ? path.basename(opts.audioPath)
    : null;
  // If audio is outside workDir, copy in
  if (opts.audioPath && fs.existsSync(opts.audioPath)) {
    const destAudio = path.join(workDir, path.basename(opts.audioPath));
    if (path.resolve(opts.audioPath) !== path.resolve(destAudio)) {
      fs.copyFileSync(opts.audioPath, destAudio);
    }
  }

  const seconds = Math.max(3, Math.min(300, Math.ceil(opts.durationSec)));
  const fps = 24;
  // Screenshot wall-clock is often 1.5–3× realtime at 1080p; budget generously.
  const timeoutMs = Math.max(
    25 * 60 * 1000,
    Math.ceil(seconds * fps * 2500) + 5 * 60 * 1000,
  );
  const args = [
    'run', '--rm',
    '--network', 'none',
    '--shm-size', '1g',
    '-v', `${hostWork}:/work:rw`,
    '-w', '/work',
    '-e', 'PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium',
    '-e', 'CHROME_PATH=/usr/bin/chromium',
    '--entrypoint', 'node',
    image,
    '/work/record_html_mp4.mjs',
    '--html', `/work/${recordHtmlName}`,
    '--out', `/work/${outName}`,
    '--width', String(q.width),
    '--height', String(q.height),
    '--fps', String(fps),
    '--seconds', String(seconds),
  ];
  if (audioName) {
    args.push('--audio', `/work/${audioName}`);
  }

  if (opts.signal?.aborted) throw new Error('导出已取消');
  opts.onLog?.(`docker timeout=${Math.round(timeoutMs / 1000)}s fps=${fps} ${args.join(' ')}`);
  let lineBuf = '';
  const r = await run('docker', args, {
    timeoutMs,
    signal: opts.signal,
    onStdout: (chunk) => {
      if (!opts.onLog) return;
      lineBuf += chunk;
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() || '';
      for (const line of parts) {
        const t = line.trim();
        if (t) opts.onLog(t);
      }
    },
  });
  if (opts.signal?.aborted) throw new Error('导出已取消');

  const produced = path.join(workDir, outName);
  if (produced !== outPath && fs.existsSync(produced)) {
    fs.renameSync(produced, outPath);
  }

  // Even if docker was SIGKILL'd at the end, accept a usable MP4 (false-negative timeout).
  const ok = await isUsableMp4(outPath, Math.min(3, Math.max(2, seconds * 0.5)));
  if (ok) {
    if (r.code !== 0) {
      opts.onLog?.(`docker exited ${r.code} but MP4 is usable → treat as success`);
    }
    opts.onLog?.(`export ok → ${outPath}`);
    return;
  }

  throw new Error(`导出 MP4 失败：${summarizeExportFailure(r.stdout, r.stderr, r.timedOut)}`);
}

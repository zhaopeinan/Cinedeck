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
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    };
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    };
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), opts?.timeoutMs ?? 30 * 60 * 1000);
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
  // Drop the autoplay hook script block that only targets explain-narration
  out = out.replace(
    /<script>\s*\(function\(\)\{\s*var a=document\.getElementById\(['"]explain-narration['"]\);[\s\S]*?<\/script>/gi,
    '',
  );
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
  const args = [
    'run', '--rm',
    '--network', 'none',
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
    '--fps', '30',
    '--seconds', String(seconds),
  ];
  if (audioName) {
    args.push('--audio', `/work/${audioName}`);
  }

  if (opts.signal?.aborted) throw new Error('导出已取消');
  opts.onLog?.(`docker ${args.join(' ')}`);
  let lineBuf = '';
  const r = await run('docker', args, {
    timeoutMs: Math.max(10 * 60 * 1000, (seconds + 120) * 1000),
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
  if (r.code !== 0) {
    throw new Error(`导出 MP4 失败：${(r.stderr || r.stdout).slice(-1000)}`);
  }
  const produced = path.join(workDir, outName);
  if (produced !== outPath && fs.existsSync(produced)) {
    fs.renameSync(produced, outPath);
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
    throw new Error('导出完成但未找到有效 MP4');
  }
  opts.onLog?.(`export ok → ${outPath}`);
}

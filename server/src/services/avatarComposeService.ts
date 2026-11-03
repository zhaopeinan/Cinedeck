import { spawn } from 'child_process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import {
  createComposeJob,
  getComposeJob,
  updateComposeJob,
  type ComposeJob,
  type ComposeLayout,
  type ComposeMode,
} from './composeProgress';
import { detectVideoEncoder, videoEncodeArgs } from './ffmpegEncoder';

const execFileAsync = promisify(execFile);

const COMPOSE_JOBS_DIR =
  process.env.AVATAR_COMPOSE_DIR ||
  path.resolve(process.cwd(), '..', 'data', 'avatar-compose');

const PREVIEW_MAX_SEC = Math.max(3, Number(process.env.AVATAR_COMPOSE_PREVIEW_SEC || 8));

let queue: string[] = [];
let running = false;

function log(msg: string) {
  console.log(`[AvatarCompose] ${msg}`);
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function runCmd(args: string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function probeSize(filePath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0:s=x',
      filePath,
    ],
    { timeout: 30000 },
  );
  const [w, h] = String(stdout).trim().split('x').map((x) => parseInt(x, 10));
  if (!(w > 0 && h > 0)) throw new Error(`无法读取视频尺寸: ${path.basename(filePath)}`);
  return { width: w, height: h };
}

async function probeDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout: 30000 },
    );
    const d = parseFloat(String(stdout).trim());
    if (d > 0) return d;
  } catch { /* fall through */ }
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: 30000 },
    );
    return parseFloat(String(stdout).trim()) || 0;
  } catch {
    return 0;
  }
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath],
      { timeout: 15000 },
    );
    return String(stdout).trim().length > 0;
  } catch {
    return false;
  }
}

function parseLayout(raw: ComposeLayout): ComposeLayout {
  return {
    x: clamp(Number(raw.x) || 0, 0, 1),
    y: clamp(Number(raw.y) || 0, 0, 1),
    w: clamp(Number(raw.w) || 0.25, 0.05, 0.95),
    h: clamp(Number(raw.h) || 0.4, 0.05, 0.95),
  };
}

/** Build chromakey filter segment; similarity ≈ green strength (higher = more aggressive). */
export function buildChromakeyFilter(similarity: number, blend: number): string {
  const sim = clamp(similarity, 0.05, 0.6).toFixed(3);
  const bl = clamp(blend, 0, 0.4).toFixed(3);
  return `chromakey=0x00FF00:${sim}:${bl},format=rgba,lut=a='if(lt(val\\,64)\\,0\\,255)',format=yuva420p`;
}

export function getComposeJobsDir(): string {
  fs.mkdirSync(COMPOSE_JOBS_DIR, { recursive: true });
  return COMPOSE_JOBS_DIR;
}

export async function runComposeOverlay(opts: {
  backgroundPath: string;
  greenscreenPath: string;
  outputPath: string;
  layout: ComposeLayout;
  chromaSimilarity: number;
  chromaBlend?: number;
  /** Cap output duration (preview). Omit for full bg duration. */
  maxDurationSec?: number;
  onProgress?: (message: string, progress: number) => void;
}): Promise<void> {
  const layout = parseLayout(opts.layout);
  const blend = opts.chromaBlend ?? 0.1;
  const bg = await probeSize(opts.backgroundPath);
  const gs = await probeSize(opts.greenscreenPath);
  const bgDur = await probeDuration(opts.backgroundPath);
  const gsDur = await probeDuration(opts.greenscreenPath);
  if (!(bgDur > 0.1)) throw new Error('底视频时长无效');

  let dur = bgDur;
  if (opts.maxDurationSec != null && opts.maxDurationSec > 0) {
    dur = Math.min(dur, opts.maxDurationSec);
  }
  dur = Math.max(0.2, dur);

  const width = even(bg.width);
  const height = even(bg.height);
  const avatarAr = Math.max(0.2, gs.width / Math.max(1, gs.height));

  let ow = even(width * layout.w);
  let oh = even(ow / avatarAr);
  if (oh > height * 0.95) {
    oh = even(height * 0.95);
    ow = even(oh * avatarAr);
  }
  let ox = even(width * layout.x);
  let oy = even(height * layout.y);
  if (ox + ow > width) ox = even(Math.max(0, width - ow));
  if (oy + oh > height) oy = even(Math.max(0, height - oh));

  const needFreeze = gsDur > 0.2 && gsDur + 0.05 < dur;
  const padSec = needFreeze ? Math.max(0.05, dur - gsDur) : 0;
  const pixFmt = buildChromakeyFilter(opts.chromaSimilarity, blend);
  const pipChain = needFreeze
    ? `setpts=PTS-STARTPTS,fps=25,scale=${ow}:${oh},setsar=1,${pixFmt},tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS`
    : `setpts=PTS-STARTPTS,fps=25,scale=${ow}:${oh},setsar=1,${pixFmt},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS`;

  const bgHasAudio = await hasAudioStream(opts.backgroundPath);
  const gsHasAudio = await hasAudioStream(opts.greenscreenPath);
  const encoder = await detectVideoEncoder();

  opts.onProgress?.('开始合成…', 20);

  // Prefer background audio; fall back to greenscreen narration.
  const useBgAudio = bgHasAudio;
  const useGsAudio = !bgHasAudio && gsHasAudio;

  const inputs = [
    '-y',
    '-i', opts.backgroundPath,
    '-i', opts.greenscreenPath,
  ];

  const videoFilters = [
    `[0:v]scale=${width}:${height},setsar=1,fps=25,format=yuv420p,trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[bg]`,
    `[1:v]${pipChain}[pip]`,
    `[bg][pip]overlay=${ox}:${oy}:eof_action=repeat:shortest=1[v]`,
  ];
  let audioPart: string[] = [];
  if (useBgAudio) {
    videoFilters.push(
      `[0:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS[a]`,
    );
    audioPart = ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'];
  } else if (useGsAudio) {
    videoFilters.push(
      `[1:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS[a]`,
    );
    audioPart = ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'];
  } else {
    audioPart = ['-an'];
  }

  const filterComplex = videoFilters.join(';');

  opts.onProgress?.('ffmpeg 渲染中…', 45);

  const r = await runCmd(
    [
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[v]',
      ...audioPart,
      ...videoEncodeArgs(encoder, { fast: !!opts.maxDurationSec }),
      '-movflags', '+faststart',
      '-t', String(dur),
      opts.outputPath,
    ],
    { timeoutMs: Math.max(120000, Math.ceil(dur) * 8000) },
  );

  if (r.code !== 0 || !fs.existsSync(opts.outputPath) || fs.statSync(opts.outputPath).size < 1000) {
    throw new Error(`合成失败: ${(r.stderr || r.stdout).slice(-800)}`);
  }
  opts.onProgress?.('合成完成', 100);
}

async function processComposeJob(jobId: string): Promise<void> {
  const job = getComposeJob(jobId);
  if (!job) return;

  try {
    updateComposeJob(jobId, {
      status: 'running',
      stage: 'preparing',
      message: '准备素材…',
      progress: 5,
      startedAt: new Date().toISOString(),
      error: null,
    });

    const outName = job.mode === 'preview' ? 'preview.mp4' : 'output.mp4';
    const outputPath = path.join(COMPOSE_JOBS_DIR, job.id, outName);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    await runComposeOverlay({
      backgroundPath: job.backgroundPath,
      greenscreenPath: job.greenscreenPath,
      outputPath,
      layout: job.layout,
      chromaSimilarity: job.chromaSimilarity,
      chromaBlend: job.chromaBlend,
      maxDurationSec: job.mode === 'preview' ? PREVIEW_MAX_SEC : undefined,
      onProgress: (message, progress) => {
        updateComposeJob(jobId, { stage: 'rendering', message, progress });
      },
    });

    updateComposeJob(jobId, {
      status: 'completed',
      stage: 'finished',
      message: job.mode === 'preview' ? '预览已生成' : '导出完成',
      progress: 100,
      outputPath,
      finishedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    const message = err?.message || String(err);
    log(`job ${jobId} failed: ${message}`);
    updateComposeJob(jobId, {
      status: 'failed',
      stage: 'failed',
      message: '合成失败',
      error: message.slice(0, 1500),
      progress: 100,
      finishedAt: new Date().toISOString(),
    });
  }
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      await processComposeJob(id);
    }
  } finally {
    running = false;
  }
}

export function enqueueComposeJob(jobId: string): void {
  queue.push(jobId);
  void pump();
}

export function publicComposeJob(job: ComposeJob) {
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    stage: job.stage,
    message: job.message,
    progress: job.progress,
    error: job.error,
    layout: job.layout,
    chromaSimilarity: job.chromaSimilarity,
    chromaBlend: job.chromaBlend,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    hasVideo: !!job.outputPath && fs.existsSync(job.outputPath),
  };
}

export function clampChromaSimilarity(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.28;
  return clamp(n, 0.05, 0.6);
}

export function clampChromaBlend(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.1;
  return clamp(n, 0, 0.4);
}

export function parseComposeMode(raw: unknown): ComposeMode {
  return String(raw || '').toLowerCase() === 'export' ? 'export' : 'preview';
}

export function parseComposeLayoutJson(raw: unknown): ComposeLayout {
  let obj: any = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  return parseLayout({
    x: Number(obj?.x),
    y: Number(obj?.y),
    w: Number(obj?.w),
    h: Number(obj?.h),
  });
}

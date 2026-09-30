import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { updateAvatarJob, getAvatarJob, type AvatarJob, type AvatarDriveMode } from './avatarProgress';

const DUIX_CONTAINER = process.env.DUIX_CONTAINER || 'duix-avatar-gen-video';
const OPENTALKING_CONTAINER = process.env.OPENTALKING_CONTAINER || 'opentalking-smoke';
const AVATAR_JOBS_DIR =
  process.env.AVATAR_JOBS_DIR ||
  path.resolve('/opt/opentalking/avatar-jobs');
/** Host path mounted into Duix as /code/data */
const DUIX_DATA_HOST =
  process.env.DUIX_DATA_HOST || '/data/duix_avatar_data/face2face';
/** Absolute path prefix inside Duix container */
const DUIX_DATA_CONTAINER = process.env.DUIX_DATA_CONTAINER || '/code/data';
const DUIX_API_BASE = (process.env.DUIX_API_BASE || 'http://duix-avatar-gen-video:8383').replace(/\/$/, '');
const STOP_CONTAINERS = (process.env.AVATAR_STOP_CONTAINERS || 'ppt-audio-voicebox,ollama')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** Also stop OpenTalking if present (legacy GPU peer) */
const STOP_PEER_CONTAINERS = [OPENTALKING_CONTAINER].filter(Boolean);
const STOP_ITRANS = process.env.AVATAR_STOP_ITRANS !== '0';
const MAX_AUDIO_SECONDS = Number(process.env.AVATAR_MAX_AUDIO_SECONDS || 120);
const MAX_TEMPLATE_SECONDS = Number(process.env.AVATAR_MAX_TEMPLATE_SECONDS || 60);
/**
 * Duix lips sometimes feel late; keep at 0 unless explicitly tuned.
 * (Compose-time A/V sync is handled separately — do not use this to paper over mux delay.)
 */
const LIP_LAG_SEC = Math.max(0, Number(process.env.AVATAR_LIP_LAG_SEC ?? '0'));


let queue: string[] = [];
let running = false;

function log(msg: string) {
  console.log(`[AvatarWorker] ${msg}`);
}

function runCmd(command: string, args: string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function dockerAvailable(): Promise<boolean> {
  const r = await runCmd('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10000 });
  return r.code === 0;
}

async function isContainerRunning(name: string): Promise<boolean> {
  const inspect = await runCmd('docker', ['inspect', '-f', '{{.State.Running}}', name], {
    timeoutMs: 15000,
  });
  return inspect.code === 0 && inspect.stdout.trim() === 'true';
}

async function ensureContainerRunning(name: string): Promise<void> {
  if (await isContainerRunning(name)) return;
  const start = await runCmd('docker', ['start', name], { timeoutMs: 120000 });
  if (start.code !== 0) {
    throw new Error(`无法启动容器 ${name}: ${start.stderr || start.stdout}`);
  }
}

/** Ensure Voicebox is up so project avatar can cache dubbing audio URLs. */
export async function ensureVoiceboxRunningForAudio(): Promise<void> {
  const name = STOP_CONTAINERS.find((c) => /voicebox/i.test(c)) || 'ppt-audio-voicebox';
  if (!(await dockerAvailable())) return;
  await ensureContainerRunning(name);
  const base = (process.env.VOICEBOX_BASE_URL || 'http://ppt-audio-voicebox:17493').replace(/\/$/, '');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log(`Voicebox health still not ready after start (${name}); audio download may fail`);
  throw new Error(`Voicebox 未就绪（${base}）。请确认 ppt-audio-voicebox 容器已启动后再重试。`);
}

async function stopContainerQuiet(name: string): Promise<boolean> {
  if (!(await isContainerRunning(name))) return false;
  const r = await runCmd('docker', ['stop', name], { timeoutMs: 90000 });
  if (r.code === 0) {
    log(`stopped ${name}`);
    return true;
  }
  return false;
}

async function stopGpuCompetitors(): Promise<string[]> {
  const stopped: string[] = [];
  for (const name of [...STOP_CONTAINERS, ...STOP_PEER_CONTAINERS]) {
    if (await stopContainerQuiet(name)) stopped.push(name);
  }

  if (STOP_ITRANS) {
    const r = await runCmd(
      'docker',
      [
        'run',
        '--rm',
        '--privileged',
        '--pid=host',
        'alpine:3.19',
        'nsenter',
        '-t',
        '1',
        '-m',
        '-u',
        '-i',
        '-n',
        'systemctl',
        'stop',
        'itrans.service',
      ],
      { timeoutMs: 60000 },
    );
    if (r.code === 0) {
      stopped.push('itrans.service');
      log('stopped itrans.service');
    } else {
      log(`itrans stop skipped: ${(r.stderr || r.stdout).slice(0, 200)}`);
    }
  }
  return stopped;
}

async function restoreGpuCompetitors(stopped: string[]): Promise<void> {
  for (const name of stopped) {
    // Do not restart OpenTalking peer after Duix jobs
    if (name === OPENTALKING_CONTAINER) continue;
    if (name === 'itrans.service') {
      const r = await runCmd(
        'docker',
        [
          'run',
          '--rm',
          '--privileged',
          '--pid=host',
          'alpine:3.19',
          'nsenter',
          '-t',
          '1',
          '-m',
          '-u',
          '-i',
          '-n',
          'systemctl',
          'start',
          'itrans.service',
        ],
        { timeoutMs: 60000 },
      );
      log(r.code === 0 ? 'restored itrans.service' : `restore itrans failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
      continue;
    }
    const r = await runCmd('docker', ['start', name], { timeoutMs: 90000 });
    if (r.code === 0) {
      log(`restored ${name}`);
    } else {
      log(`restore ${name} failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
      const r2 = await runCmd('docker', ['start', name], { timeoutMs: 90000 });
      log(r2.code === 0 ? `restored ${name} (retry)` : `restore ${name} retry failed`);
    }
  }
}

function findJobFile(jobDir: string, prefixes: string[], exts: string[]): string {
  const files = fs.readdirSync(jobDir);
  for (const name of files.sort()) {
    const lower = name.toLowerCase();
    if (prefixes.some((p) => lower.startsWith(p)) && exts.some((e) => lower.endsWith(e))) {
      return path.join(jobDir, name);
    }
  }
  throw new Error(`未找到输入文件 (${prefixes.join('/')}${exts.join(',')})`);
}

async function probeDurationSec(filePath: string): Promise<number> {
  const r = await runCmd(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { timeoutMs: 30000 },
  );
  const n = parseFloat(String(r.stdout).trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function probeVideoDurationSec(filePath: string): Promise<number> {
  const r = await runCmd(
    'ffprobe',
    [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    { timeoutMs: 30000 },
  );
  const n = parseFloat(String(r.stdout).trim());
  if (Number.isFinite(n) && n > 0) return n;
  return probeDurationSec(filePath);
}

/**
 * Force lip-sync: reset video PTS, lock fps=25, pad/trim to exact drive-audio length,
 * replace Duix's embedded audio with the original drive audio.
 * Also advances video by LIP_LAG_SEC to compensate for model mouth delay
 * (user hears audio first / sees lips late).
 */
async function remuxAvatarToDriveAudio(opts: {
  duixVideoPath: string;
  driveAudioPath: string;
  outputPath: string;
  /** Override default lip-lag compensation (seconds). */
  lipLagSec?: number;
}): Promise<void> {
  const audioDur = await probeDurationSec(opts.driveAudioPath);
  if (!(audioDur > 0.05)) {
    throw new Error(`驱动音频时长无效: ${opts.driveAudioPath}`);
  }
  const videoDur = await probeVideoDurationSec(opts.duixVideoPath);
  const lipLag = Math.max(0, opts.lipLagSec ?? LIP_LAG_SEC);
  // After advancing video by lipLag, we lose lipLag seconds at the end unless we pad.
  const endPad = Math.max(0, audioDur - Math.max(0, videoDur - lipLag));
  const parts = [
    'setpts=PTS-STARTPTS',
    'fps=25',
  ];
  if (lipLag > 0.001) {
    // Drop leading frames so mouth shapes that lagged audio now line up with speech.
    parts.push(`trim=start=${lipLag.toFixed(3)}`);
    parts.push('setpts=PTS-STARTPTS');
  }
  if (endPad > 0.02) {
    parts.push(`tpad=stop_mode=clone:stop_duration=${endPad.toFixed(3)}`);
  }
  parts.push(`trim=duration=${audioDur.toFixed(3)}`);
  parts.push('setpts=PTS-STARTPTS');
  const vf = parts.join(',');

  const r = await runCmd(
    'ffmpeg',
    [
      '-y',
      '-i', opts.duixVideoPath,
      '-i', opts.driveAudioPath,
      '-filter_complex', `[0:v]${vf}[v]`,
      '-map', '[v]',
      '-map', '1:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      '-t', audioDur.toFixed(3),
      '-movflags', '+faststart',
      opts.outputPath,
    ],
    { timeoutMs: 600000 },
  );
  if (r.code !== 0 || !fs.existsSync(opts.outputPath) || fs.statSync(opts.outputPath).size < 1000) {
    throw new Error(`数字人音画对齐失败: ${(r.stderr || r.stdout).slice(-600)}`);
  }
  log(`remux lip-sync ok lag=${lipLag.toFixed(3)}s audio=${audioDur.toFixed(3)}s videoWas=${videoDur.toFixed(3)}s -> ${opts.outputPath}`);
}

async function prepareMediaInJobDir(
  jobDir: string,
  driveMode: AvatarDriveMode = 'photo',
  opts?: { maxAudioSeconds?: number },
): Promise<{ audioWav: string; templateMp4: string }> {
  const audioIn = findJobFile(jobDir, ['audio'], ['.wav', '.mp3', '.m4a', '.aac']);
  const audioWav = path.join(jobDir, 'audio_16k.wav');
  const templateMp4 = path.join(jobDir, 'template.mp4');
  const maxAudio = opts?.maxAudioSeconds ?? MAX_AUDIO_SECONDS;

  const a = await runCmd(
    'ffmpeg',
    ['-y', '-i', audioIn, '-t', String(maxAudio), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioWav],
    { timeoutMs: 120000 },
  );
  if (a.code !== 0 || !fs.existsSync(audioWav)) {
    throw new Error(`音频预处理失败: ${(a.stderr || a.stdout).slice(-500)}`);
  }

  if (driveMode === 'video') {
    const srcVideo = findJobFile(jobDir, ['template_src'], ['.mp4', '.mov', '.webm', '.avi']);
    const t = await runCmd(
      'ffmpeg',
      [
        '-y', '-i', srcVideo,
        '-t', String(MAX_TEMPLATE_SECONDS),
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-r', '25',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
        templateMp4,
      ],
      { timeoutMs: 300000 },
    );
    if (t.code !== 0 || !fs.existsSync(templateMp4)) {
      throw new Error(`参考视频预处理失败: ${(t.stderr || t.stdout).slice(-500)}`);
    }
  } else {
    const photo = findJobFile(jobDir, ['photo'], ['.jpg', '.jpeg', '.png']);
    const t = await runCmd(
      'ffmpeg',
      [
        '-y', '-loop', '1', '-i', photo,
        '-t', '4', '-r', '25',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
        templateMp4,
      ],
      { timeoutMs: 120000 },
    );
    if (t.code !== 0 || !fs.existsSync(templateMp4)) {
      throw new Error(`照片模板生成失败: ${(t.stderr || t.stdout).slice(-500)}`);
    }
  }
  return { audioWav, templateMp4 };
}

async function waitDuixReady(timeoutMs = 300000): Promise<void> {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${DUIX_API_BASE}/easy/query?code=warmup-probe`, { signal: AbortSignal.timeout(5000) });
      if (r.status > 0) {
        log(`Duix ready via ${DUIX_API_BASE}`);
        return;
      }
    } catch (e: any) {
      lastErr = e?.message || String(e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Duix 服务未就绪: ${DUIX_API_BASE} (${lastErr})`);
}

async function runDuixViaHttp(job: AvatarJob): Promise<void> {
  const hostJobDir = path.join(AVATAR_JOBS_DIR, job.id);
  const driveMode = job.driveMode || 'photo';
  updateAvatarJob(job.id, {
    status: 'running',
    stage: 'preparing_media',
    message: driveMode === 'video' ? '预处理参考视频与音频…' : '预处理照片与音频…',
    progress: 35,
  });

  const { audioWav, templateMp4 } = await prepareMediaInJobDir(hostJobDir, driveMode);

  const stagingHost = path.join(DUIX_DATA_HOST, 'avatar-jobs', job.id);
  fs.mkdirSync(stagingHost, { recursive: true });
  const stageAudio = path.join(stagingHost, 'audio.wav');
  const stageVideo = path.join(stagingHost, 'template.mp4');
  fs.copyFileSync(audioWav, stageAudio);
  fs.copyFileSync(templateMp4, stageVideo);

  const audioUrl = `${DUIX_DATA_CONTAINER}/avatar-jobs/${job.id}/audio.wav`;
  const videoUrl = `${DUIX_DATA_CONTAINER}/avatar-jobs/${job.id}/template.mp4`;
  const code = randomUUID();

  updateAvatarJob(job.id, {
    stage: 'duix',
    message: 'Duix 正在生成口型视频…',
    progress: 45,
  });

  await waitDuixReady();

  const submitRes = await fetch(`${DUIX_API_BASE}/easy/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: audioUrl,
      video_url: videoUrl,
      code,
      chaofen: 0,
      watermark_switch: 0,
      pn: 1,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const submitJson: any = await submitRes.json().catch(() => ({}));
  if (!submitRes.ok || submitJson?.success === false || submitJson?.code !== 10000) {
    throw new Error(`Duix 提交失败: ${JSON.stringify(submitJson).slice(0, 500)}`);
  }

  const deadline = Date.now() + 30 * 60 * 1000;
  let resultRel: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const qRes = await fetch(`${DUIX_API_BASE}/easy/query?code=${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(15000),
    });
    const q: any = await qRes.json().catch(() => ({}));
    const data = q?.data || {};
    const status = data.status;
    const progress = typeof data.progress === 'number' ? data.progress : 45;
    const mapped = Math.min(90, Math.max(45, Math.round(45 + progress * 0.45)));
    updateAvatarJob(job.id, {
      stage: 'duix',
      message: data.msg || 'Duix 渲染中…',
      progress: mapped,
    });

    if (status === 2) {
      resultRel = String(data.result || '');
      break;
    }
    if (status === 3) {
      throw new Error(`Duix 生成失败: ${data.msg || JSON.stringify(data).slice(0, 500)}`);
    }
  }
  if (!resultRel) {
    throw new Error('Duix 生成超时');
  }

  const resultName = path.basename(resultRel);
  const resultHost = path.join(DUIX_DATA_HOST, 'temp', resultName);
  if (!fs.existsSync(resultHost) || fs.statSync(resultHost).size < 1000) {
    throw new Error(`Duix 结果文件缺失: ${resultHost}`);
  }

  const outputPath = path.join(hostJobDir, 'output.mp4');
  fs.copyFileSync(resultHost, outputPath);
  updateAvatarJob(job.id, {
    outputPath,
    stage: 'muxed',
    message: '视频已生成',
    progress: 95,
  });
}

async function processJob(jobId: string): Promise<void> {
  const job = getAvatarJob(jobId);
  if (!job) return;

  try {
    updateAvatarJob(jobId, {
      status: 'running',
      stage: 'preparing',
      message: '准备 Duix GPU 环境…',
      progress: 5,
      startedAt: new Date().toISOString(),
      error: null,
    });

    updateAvatarJob(jobId, { stage: 'gpu_lock', message: '释放 GPU 占用（互斥调度）…', progress: 15 });
    await withDuixGpuExclusive(async () => {
      updateAvatarJob(jobId, { stage: 'rendering', message: '开始渲染…', progress: 30 });
      await runDuixViaHttp(job);
    });

    updateAvatarJob(jobId, {
      status: 'completed',
      stage: 'finished',
      message: '生成完成',
      progress: 100,
      finishedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    const message = err?.message || String(err);
    log(`job ${jobId} [duix] failed: ${message}`);
    updateAvatarJob(jobId, {
      status: 'failed',
      stage: 'failed',
      message: '生成失败',
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
      await processJob(id);
    }
  } finally {
    running = false;
  }
}

export function enqueueAvatarJob(jobId: string): void {
  queue.push(jobId);
  void pump();
}

export function getAvatarJobsDir(): string {
  fs.mkdirSync(AVATAR_JOBS_DIR, { recursive: true });
  return AVATAR_JOBS_DIR;
}

/** Shared GPU exclusive section for standalone avatar + PPT project avatar batch. */
let gpuLock: Promise<void> = Promise.resolve();
let duixGpuBusy = false;

export function isDuixGpuBusy(): boolean {
  return duixGpuBusy;
}

export async function withDuixGpuExclusive<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = gpuLock;
  gpuLock = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  let stopped: string[] = [];
  duixGpuBusy = true;
  try {
    if (!(await dockerAvailable())) {
      throw new Error('当前环境无 Docker，无法运行数字人生成');
    }
    stopped = await stopGpuCompetitors();
    await ensureContainerRunning(DUIX_CONTAINER);
    return await fn();
  } finally {
    try {
      await stopContainerQuiet(DUIX_CONTAINER);
    } catch { /* ignore */ }
    try {
      await restoreGpuCompetitors(stopped);
    } catch { /* ignore */ }
    duixGpuBusy = false;
    release();
  }
}

// Wire Voicebox GPU lane so Whisper/TTS waits while Duix holds the card.
try {
  // lazy require to avoid circular init issues at module load
  const { setDuixBusyProbe } = require('./voiceboxGpuQueue') as typeof import('./voiceboxGpuQueue');
  setDuixBusyProbe(() => duixGpuBusy);
} catch { /* ignore if queue module missing in tests */ }


/**
 * Run one Duix clip from local audio + template source files.
 * Long audio (> MAX_AUDIO_SECONDS) is split into chunks, generated, then concatenated
 * so lip-sync matches the full narration (e.g. P19 ~161s).
 * Caller should hold withDuixGpuExclusive for batches.
 */
export async function synthesizeDuixClip(opts: {
  workId: string;
  audioSourcePath: string;
  driveMode: AvatarDriveMode;
  templateSourcePath: string;
  onProgress?: (message: string, progress: number) => void;
  /** Return true to abort between chunks / Duix poll ticks */
  isCancelled?: () => boolean;
}): Promise<string> {
  const hostJobDir = path.join(AVATAR_JOBS_DIR, opts.workId);
  fs.mkdirSync(hostJobDir, { recursive: true });
  const { JobCancelledError } = await import('./jobCancel');
  const checkCancel = () => {
    if (opts.isCancelled?.()) throw new JobCancelledError('数字人生成已取消');
  };

  // Prepare template ONCE (upload-time cache or lazy). Shared across long-audio chunks.
  checkCancel();
  opts.onProgress?.('准备参考画面模板…', 32);
  const { ensureDuixTemplate } = await import('./duixTemplatePrep');
  const preparedTemplate = await ensureDuixTemplate(
    opts.templateSourcePath,
    opts.driveMode === 'video' ? 'video' : 'photo',
  );

  const audioDur = await probeDurationSec(opts.audioSourcePath);
  // Leave small margin under Duix hard limit
  const chunkLimit = Math.max(30, MAX_AUDIO_SECONDS - 1);

  if (audioDur > 0 && audioDur > chunkLimit + 0.5) {
    const chunkCount = Math.ceil(audioDur / chunkLimit);
    opts.onProgress?.(
      `配音 ${audioDur.toFixed(0)}s，将分 ${chunkCount} 段生成数字人…`,
      36,
    );
    const partPaths: string[] = [];
    let start = 0;
    let idx = 0;
    while (start < audioDur - 0.05) {
      checkCancel();
      const len = Math.min(chunkLimit, audioDur - start);
      const chunkWorkId = `${opts.workId}-c${idx}`;
      const chunkDir = path.join(AVATAR_JOBS_DIR, chunkWorkId);
      fs.mkdirSync(chunkDir, { recursive: true });

      const chunkAudio = path.join(chunkDir, 'audio.wav');
      const cut = await runCmd(
        'ffmpeg',
        [
          '-y', '-ss', String(start.toFixed(3)), '-t', String(len.toFixed(3)),
          '-i', opts.audioSourcePath,
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
          chunkAudio,
        ],
        { timeoutMs: 120000 },
      );
      if (cut.code !== 0 || !fs.existsSync(chunkAudio)) {
        throw new Error(`切分配音失败(第 ${idx + 1} 段): ${(cut.stderr || cut.stdout).slice(-400)}`);
      }

      opts.onProgress?.(
        `生成第 ${idx + 1}/${chunkCount} 段（${start.toFixed(0)}–${(start + len).toFixed(0)}s）…`,
        Math.round(40 + (idx / chunkCount) * 50),
      );
      const part = await synthesizeDuixClipOnce({
        workId: chunkWorkId,
        audioSourcePath: chunkAudio,
        driveMode: opts.driveMode,
        preparedTemplateMp4: preparedTemplate,
        maxAudioSeconds: chunkLimit + 1,
        isCancelled: opts.isCancelled,
        onProgress: (msg, p) => {
          const segPct = Math.max(0, Math.min(100, Number(p) || 0));
          const pagePct = Math.round(((idx + segPct / 100) / chunkCount) * 100);
          opts.onProgress?.(
            `第 ${idx + 1}/${chunkCount} 段：${msg}`,
            pagePct,
          );
        },
      });
      partPaths.push(part);
      start += len;
      idx += 1;
    }

    // Re-encode concat (NOT -c copy): copy-concat leaves broken PTS / A-V offset at boundaries.
    const listFile = path.join(hostJobDir, 'concat.txt');
    fs.writeFileSync(
      listFile,
      partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
    );
    const concatRaw = path.join(hostJobDir, 'concat_raw.mp4');
    const concat = await runCmd(
      'ffmpeg',
      [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        concatRaw,
      ],
      { timeoutMs: 600000 },
    );
    if (concat.code !== 0 || !fs.existsSync(concatRaw)) {
      throw new Error(`拼接数字人分段失败: ${(concat.stderr || concat.stdout || '').slice(-500)}`);
    }

    // Final pass against the FULL original drive audio (exact length + continuous timeline)
    const outputPath = path.join(hostJobDir, 'output.mp4');
    opts.onProgress?.('对齐长配音音画…', 92);
    await remuxAvatarToDriveAudio({
      duixVideoPath: concatRaw,
      driveAudioPath: opts.audioSourcePath,
      outputPath,
    });
    opts.onProgress?.('长配音数字人已拼接完成', 95);
    return outputPath;
  }

  checkCancel();
  return synthesizeDuixClipOnce({
    workId: opts.workId,
    audioSourcePath: opts.audioSourcePath,
    driveMode: opts.driveMode,
    preparedTemplateMp4: preparedTemplate,
    maxAudioSeconds: MAX_AUDIO_SECONDS,
    isCancelled: opts.isCancelled,
    onProgress: opts.onProgress,
  });
}

async function synthesizeDuixClipOnce(opts: {
  workId: string;
  audioSourcePath: string;
  driveMode: AvatarDriveMode;
  /** Already-normalized H.264 template — skip re-encode */
  preparedTemplateMp4: string;
  maxAudioSeconds: number;
  onProgress?: (message: string, progress: number) => void;
  isCancelled?: () => boolean;
}): Promise<string> {
  const hostJobDir = path.join(AVATAR_JOBS_DIR, opts.workId);
  fs.mkdirSync(hostJobDir, { recursive: true });
  const { JobCancelledError } = await import('./jobCancel');
  const checkCancel = () => {
    if (opts.isCancelled?.()) throw new JobCancelledError('数字人生成已取消');
  };

  const audioExt = path.extname(opts.audioSourcePath).toLowerCase() || '.wav';
  const audioDest = path.join(hostJobDir, `audio${audioExt}`);
  fs.copyFileSync(opts.audioSourcePath, audioDest);

  // Use pre-normalized template directly (no per-chunk ffmpeg re-encode)
  const templateMp4 = path.join(hostJobDir, 'template.mp4');
  fs.copyFileSync(opts.preparedTemplateMp4, templateMp4);

  checkCancel();
  opts.onProgress?.('预处理音频…', 35);
  const audioIn = findJobFile(hostJobDir, ['audio'], ['.wav', '.mp3', '.m4a', '.aac']);
  const audioWav = path.join(hostJobDir, 'audio_16k.wav');
  const a = await runCmd(
    'ffmpeg',
    ['-y', '-i', audioIn, '-t', String(opts.maxAudioSeconds), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioWav],
    { timeoutMs: 120000 },
  );
  if (a.code !== 0 || !fs.existsSync(audioWav)) {
    throw new Error(`音频预处理失败: ${(a.stderr || a.stdout).slice(-500)}`);
  }

  const stagingHost = path.join(DUIX_DATA_HOST, 'avatar-jobs', opts.workId);
  fs.mkdirSync(stagingHost, { recursive: true });
  fs.copyFileSync(audioWav, path.join(stagingHost, 'audio.wav'));
  fs.copyFileSync(templateMp4, path.join(stagingHost, 'template.mp4'));

  const audioUrl = `${DUIX_DATA_CONTAINER}/avatar-jobs/${opts.workId}/audio.wav`;
  const videoUrl = `${DUIX_DATA_CONTAINER}/avatar-jobs/${opts.workId}/template.mp4`;
  const code = randomUUID();

  opts.onProgress?.('Duix 正在生成口型视频…', 45);
  await waitDuixReady();

  const submitRes = await fetch(`${DUIX_API_BASE}/easy/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: audioUrl,
      video_url: videoUrl,
      code,
      chaofen: 0,
      watermark_switch: 0,
      pn: 1,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const submitJson: any = await submitRes.json().catch(() => ({}));
  if (!submitRes.ok || submitJson?.success === false || submitJson?.code !== 10000) {
    throw new Error(`Duix 提交失败: ${JSON.stringify(submitJson).slice(0, 500)}`);
  }

  const deadline = Date.now() + 30 * 60 * 1000;
  let resultRel: string | null = null;
  while (Date.now() < deadline) {
    checkCancel();
    await new Promise((r) => setTimeout(r, 2000));
    checkCancel();
    const qRes = await fetch(`${DUIX_API_BASE}/easy/query?code=${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(15000),
    });
    const q: any = await qRes.json().catch(() => ({}));
    const data = q?.data || {};
    if (typeof data.progress === 'number') {
      const raw = Number(data.progress);
      const pct = Math.max(0, Math.min(100, Math.round(raw <= 1 ? raw * 100 : raw)));
      const baseMsg = data.msg || 'Duix 渲染中';
      opts.onProgress?.(`${baseMsg}（${pct}%）`, pct);
    } else if (data.msg) {
      opts.onProgress?.(String(data.msg), 50);
    }
    if (data.status === 2) {
      resultRel = String(data.result || '');
      break;
    }
    if (data.status === 3) {
      throw new Error(`Duix 生成失败: ${data.msg || JSON.stringify(data).slice(0, 500)}`);
    }
  }
  if (!resultRel) throw new Error('Duix 生成超时');

  const resultHost = path.join(DUIX_DATA_HOST, 'temp', path.basename(resultRel));
  if (!fs.existsSync(resultHost) || fs.statSync(resultHost).size < 1000) {
    throw new Error(`Duix 结果文件缺失: ${resultHost}`);
  }
  const rawPath = path.join(hostJobDir, 'duix_raw.mp4');
  fs.copyFileSync(resultHost, rawPath);
  const outputPath = path.join(hostJobDir, 'output.mp4');
  opts.onProgress?.('对齐口型与配音…', 92);
  // Prefer the 16k drive wav used for Duix; fall back to original source
  const driveAudio = fs.existsSync(audioWav) ? audioWav : opts.audioSourcePath;
  await remuxAvatarToDriveAudio({
    duixVideoPath: rawPath,
    driveAudioPath: driveAudio,
    outputPath,
  });
  opts.onProgress?.('视频已生成', 95);
  return outputPath;
}

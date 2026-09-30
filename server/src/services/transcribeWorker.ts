import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { VoiceboxAdapter } from './voiceboxAdapter';
import { TranscribeJobService, type TranscribeJobRow } from './transcribeJobService';
import { shouldSimplifyTranscript, toSimplifiedChinese } from '../utils/toSimplifiedChinese';
import { ensureVoiceboxRunningForAudio } from './avatarWorker';

/** HuggingFace Whisper processor truncates to ~30s; stay under that per chunk. */
const CHUNK_SECONDS = 28;

function runCmd(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function whisperSize(modelId: string): string {
  const id = (modelId || 'base').toLowerCase().replace(/^whisper-/, '');
  if (['base', 'small', 'medium', 'large', 'turbo'].includes(id)) return id;
  return 'base';
}

async function probeDuration(filePath: string): Promise<number> {
  const r = await runCmd('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', filePath,
  ], 30000);
  const n = parseFloat(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

async function extractWav(inputPath: string, wavPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(wavPath), { recursive: true });
  const r = await runCmd('ffmpeg', [
    '-y', '-i', inputPath,
    '-vn', '-sn', '-dn',
    '-map', '0:a:0',
    '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le',
    wavPath,
  ], 10 * 60 * 1000);
  if (r.code !== 0 || !fs.existsSync(wavPath) || fs.statSync(wavPath).size < 100) {
    throw new Error(`提取音频失败：${(r.stderr || r.stdout).slice(-400) || 'ffmpeg 未生成有效音频'}`);
  }
}

async function splitWav(wavPath: string, chunkDir: string): Promise<string[]> {
  fs.mkdirSync(chunkDir, { recursive: true });
  const pattern = path.join(chunkDir, 'chunk_%04d.wav');
  const r = await runCmd('ffmpeg', [
    '-y', '-i', wavPath,
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le',
    pattern,
  ], 10 * 60 * 1000);
  const files = fs.existsSync(chunkDir)
    ? fs.readdirSync(chunkDir)
      .filter((n) => /^chunk_\d+\.wav$/i.test(n))
      .sort()
      .map((n) => path.join(chunkDir, n))
      .filter((p) => fs.statSync(p).size > 1000)
    : [];
  if (!files.length) {
    throw new Error(`音频分段失败：${(r.stderr || r.stdout).slice(-400) || '未生成分段'}`);
  }
  return files;
}

function joinTranscripts(parts: string[]): string {
  const cleaned = parts.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return '';
  const cjk = cleaned.filter((p) => /[\u4e00-\u9fff]/.test(p)).length;
  const sep = cjk >= cleaned.length / 2 ? '' : ' ';
  return cleaned.join(sep);
}

let pumping = false;
let jobs: TranscribeJobService | null = null;
let voicebox: VoiceboxAdapter | null = null;

export function initTranscribePipeline(opts: {
  jobs: TranscribeJobService;
  voicebox: VoiceboxAdapter;
}) {
  jobs = opts.jobs;
  voicebox = opts.voicebox;
  const recovered = jobs.recoverStaleRunning();
  if (recovered > 0) {
    console.warn(`[Transcribe] recovered ${recovered} stale running job(s) after restart`);
  }
  setInterval(() => { void pumpTranscribeQueue(); }, 2000);
  void pumpTranscribeQueue();
}

export function pumpTranscribeQueue() {
  void pumpOnce();
}

async function pumpOnce() {
  if (pumping || !jobs || !voicebox) return;
  // Alive process but hung Whisper: unlock so queue can move again
  if (!pumping) {
    const hung = jobs.recoverHungRunning();
    if (hung > 0) {
      console.warn(`[Transcribe] requeued ${hung} hung running job(s)`);
    }
  }
  if (jobs.hasRunning()) return;
  const next = jobs.nextQueued();
  if (!next) return;
  pumping = true;
  try {
    await runJob(next);
  } catch (err: any) {
    console.error('[Transcribe] unhandled', err);
    jobs.update(next.id, {
      status: 'failed',
      stage: 'failed',
      error: err?.message || String(err),
      message: '转写失败',
      finished_at: new Date().toISOString(),
    });
  } finally {
    pumping = false;
    if (jobs.nextQueued()) setTimeout(() => { void pumpOnce(); }, 300);
  }
}

function partsPath(jobDir: string) {
  return path.join(jobDir, 'parts.json');
}

function loadParts(jobDir: string, expected: number): string[] {
  try {
    const p = partsPath(jobDir);
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw?.parts)) return [];
    const parts = raw.parts.map((x: any) => String(x ?? ''));
    // Only reuse if length matches current chunk count (same split)
    if (raw.chunkCount && Number(raw.chunkCount) !== expected) return [];
    return parts;
  } catch {
    return [];
  }
}

function saveParts(jobDir: string, parts: string[], chunkCount: number) {
  fs.writeFileSync(partsPath(jobDir), JSON.stringify({ chunkCount, parts, savedAt: new Date().toISOString() }));
}

async function runJob(job: TranscribeJobRow) {
  if (!jobs || !voicebox) return;
  const started = new Date().toISOString();
  jobs.update(job.id, {
    status: 'running',
    stage: 'extracting',
    progress: 8,
    message: '正在从视频提取音频…',
    started_at: started,
    error: null,
  });

  const jobDir = path.dirname(job.file_path);
  const wavPath = path.join(jobDir, `${job.id}.wav`);
  const wavReady = fs.existsSync(wavPath) && fs.statSync(wavPath).size > 1000;
  if (!wavReady) {
    await extractWav(job.file_path, wavPath);
  } else {
    jobs.update(job.id, { message: '复用已提取音频…', progress: 12 });
  }
  const duration = await probeDuration(wavPath);
  jobs.update(job.id, {
    audio_path: wavPath,
    duration_sec: duration || null,
    stage: 'transcribing',
    progress: 20,
    message: duration ? `音频约 ${Math.round(duration / 60)} 分钟，正在分段识别…` : '正在分段识别…',
  });

  await ensureVoiceboxRunningForAudio();

  const chunkDir = path.join(jobDir, 'chunks');
  const chunks = await splitWav(wavPath, chunkDir);
  const language = job.language && job.language !== 'auto' ? job.language : 'zh';
  const model = whisperSize(job.model);
  const cached = loadParts(jobDir, chunks.length);
  const parts: string[] = chunks.map((_, i) => (typeof cached[i] === 'string' ? cached[i] : ''));
  const resumeFrom = parts.findIndex((p) => !p);
  if (resumeFrom > 0) {
    console.log(`[Transcribe] ${job.id} resume from chunk ${resumeFrom + 1}/${chunks.length}`);
  }

  for (let i = 0; i < chunks.length; i++) {
    if (parts[i]) continue; // already recognized
    const pct = 20 + Math.round(((i + 1) / chunks.length) * 75);
    jobs.update(job.id, {
      progress: Math.min(pct, 95),
      message: `正在识别 ${i + 1}/${chunks.length} 段…`,
    });
    let lastErr: any;
    let text = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await voicebox.transcribeAudio({
          audioPath: chunks[i],
          originalName: `chunk_${i}.wav`,
          language,
          model,
        });
        text = result.text || '';
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        console.warn(`[Transcribe] ${job.id} chunk ${i + 1} attempt ${attempt} failed:`, err?.message || err);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (lastErr) throw lastErr;
    parts[i] = text;
    saveParts(jobDir, parts, chunks.length);
    console.log(`[Transcribe] ${job.id} chunk ${i + 1}/${chunks.length} chars=${text.length}`);
  }

  const joined = joinTranscripts(parts);
  const text = shouldSimplifyTranscript(job.language) ? toSimplifiedChinese(joined) : joined;
  try {
    fs.rmSync(chunkDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  try {
    fs.unlinkSync(partsPath(jobDir));
  } catch { /* ignore */ }

  jobs.update(job.id, {
    status: 'success',
    stage: 'done',
    progress: 100,
    message: `转写完成（${chunks.length} 段）`,
    text,
    duration_sec: duration || null,
    finished_at: new Date().toISOString(),
    error: null,
  });
  console.log(`[Transcribe] ${job.id} done (${duration.toFixed(1)}s, ${text.length} chars, ${chunks.length} chunks)`);
}

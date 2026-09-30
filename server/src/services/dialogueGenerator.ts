import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { VoiceboxAdapter } from './voiceboxAdapter';
import { DialogueJobService, type DialogueJobRow } from './dialogueJobService';
import { parseDialogueScript } from './dialogueScript';
import { ensureVoiceboxRunningForAudio } from './avatarWorker';
import { withVoiceboxGpu } from './voiceboxGpuQueue';

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DialoguePipelineDeps {
  jobs: DialogueJobService;
  voicebox: VoiceboxAdapter;
}

let deps: DialoguePipelineDeps | null = null;
let pumping = false;

export function initDialoguePipeline(d: DialoguePipelineDeps) {
  deps = d;
  deps.jobs.recoverStaleRunning();
  setTimeout(() => pumpDialogueQueue(), 1500);
}

export function pumpDialogueQueue() {
  if (!deps) return;
  if (pumping) return;
  if (deps.jobs.hasRunning()) return;
  const job = deps.jobs.claimNextQueued();
  if (!job) return;
  pumping = true;
  void runDialogueJob(job)
    .catch((err) => {
      console.error('[Dialogue] job failed:', err?.message || err);
    })
    .finally(() => {
      pumping = false;
      setTimeout(() => pumpDialogueQueue(), 800);
    });
}

async function pollVoiceboxTask(
  voicebox: VoiceboxAdapter,
  taskId: string,
  opts: { timeoutMs: number; isCancel: () => boolean },
): Promise<{ duration: number }> {
  const started = Date.now();
  while (Date.now() - started < opts.timeoutMs) {
    if (opts.isCancel()) throw Object.assign(new Error('已取消'), { cancelled: true });
    const st = await voicebox.getTaskStatus(taskId);
    if (st.status === 'succeeded') {
      const result = await voicebox.getTaskResult(taskId);
      return { duration: Number(result.duration || 0) };
    }
    if (st.status === 'failed') {
      throw new Error(st.error || 'Voicebox 生成失败');
    }
    await sleep(1500);
  }
  throw new Error('单段合成超时');
}

async function writeSilenceWav(dest: string, gapMs: number, sampleRate = 24000): Promise<void> {
  const dur = Math.max(0.05, gapMs / 1000);
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=r=${sampleRate}:cl=mono`,
    '-t', String(dur),
    '-acodec', 'pcm_s16le',
    dest,
  ], { timeout: 30000 });
}

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { timeout: 30000 });
  const n = parseFloat(String(stdout).trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function concatSegments(
  segmentPaths: string[],
  outputPath: string,
  listPath: string,
): Promise<void> {
  const lines = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join('\n'), 'utf8');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outputPath,
  ], { timeout: 600000 });
}

async function runDialogueJob(job: DialogueJobRow) {
  if (!deps) return;
  const { jobs, voicebox } = deps;
  const workDir = job.work_dir || path.join(path.resolve(process.cwd(), '..', 'data', 'dialogue-jobs'), job.id);
  fs.mkdirSync(workDir, { recursive: true });
  const segmentsDir = path.join(workDir, 'segments');
  fs.mkdirSync(segmentsDir, { recursive: true });

  const throwIfCancel = () => {
    if (jobs.isCancelRequested(job.id)) {
      throw Object.assign(new Error('已取消'), { cancelled: true });
    }
  };

  try {
    await ensureVoiceboxRunningForAudio();
    throwIfCancel();

    const parsed = parseDialogueScript(job.script_text);
    const cast = jobs.parseCast(job);
    const missing = parsed.speakers.filter((s) => !cast[s]);
    if (missing.length) {
      throw new Error(`角色未映射音色：${missing.join('、')}`);
    }

    jobs.updateJob(job.id, {
      stage: 'synthesizing',
      message: `合成中 0/${parsed.segments.length}`,
      progress: 2,
    });

    const audioParts: string[] = [];
    let silencePath: string | null = null;
    if (job.gap_ms > 0) {
      silencePath = path.join(segmentsDir, 'gap.wav');
      await writeSilenceWav(silencePath, job.gap_ms);
    }

    for (let i = 0; i < parsed.segments.length; i++) {
      throwIfCancel();
      const seg = parsed.segments[i];
      const voiceId = cast[seg.speaker];
      const segPath = path.join(segmentsDir, `seg_${String(i).padStart(4, '0')}.wav`);

      // Resume: skip already-written segments
      if (fs.existsSync(segPath) && fs.statSync(segPath).size > 1000) {
        audioParts.push(segPath);
        if (silencePath && i < parsed.segments.length - 1) audioParts.push(silencePath);
        jobs.updateJob(job.id, {
          completed_segments: i + 1,
          progress: Math.min(90, Math.round(((i + 1) / parsed.segments.length) * 85) + 5),
          message: `合成中 ${i + 1}/${parsed.segments.length}（复用缓存）`,
        });
        continue;
      }

      jobs.updateJob(job.id, {
        message: `合成第 ${i + 1}/${parsed.segments.length} 段 · ${seg.speaker}`,
        progress: Math.min(90, Math.round((i / parsed.segments.length) * 85) + 5),
      });

      await withVoiceboxGpu(`dialogue:seg-${i + 1}`, async () => {
        const task = await voicebox.generateDubbing({
          text: seg.text,
          voiceId,
          modelId: job.model_id,
          language: job.language || 'zh-CN',
          maxChunkChars: job.max_chunk_chars || 150,
          instruct: job.instruct || undefined,
        });

        await pollVoiceboxTask(voicebox, task.id, {
          timeoutMs: 15 * 60 * 1000,
          isCancel: () => jobs.isCancelRequested(job.id),
        });

        const { data } = await voicebox.getTaskAudioBuffer(task.id);
        fs.writeFileSync(segPath, data);
        audioParts.push(segPath);
      });
      if (silencePath && i < parsed.segments.length - 1) audioParts.push(silencePath);

      jobs.updateJob(job.id, {
        completed_segments: i + 1,
        progress: Math.min(90, Math.round(((i + 1) / parsed.segments.length) * 85) + 5),
        message: `合成中 ${i + 1}/${parsed.segments.length}`,
      });
    }

    throwIfCancel();
    jobs.updateJob(job.id, {
      stage: 'concat',
      progress: 92,
      message: '拼接音频…',
    });

    const outputPath = path.join(workDir, 'output.wav');
    const listPath = path.join(workDir, 'concat.txt');
    await concatSegments(audioParts, outputPath, listPath);

    const duration = await probeDuration(outputPath).catch(() => 0);
    jobs.updateJob(job.id, {
      status: 'success',
      stage: 'done',
      progress: 100,
      message: '已完成',
      error: null,
      output_path: outputPath,
      duration_sec: duration || null,
      finished_at: new Date().toISOString(),
    });
    console.log(`[Dialogue] job ${job.id} done, segments=${parsed.segments.length}, duration=${duration.toFixed(1)}s`);
  } catch (err: any) {
    if (err?.cancelled || jobs.isCancelRequested(job.id)) {
      jobs.updateJob(job.id, {
        status: 'cancelled',
        stage: 'failed',
        message: '已取消',
        error: null,
        finished_at: new Date().toISOString(),
      });
      return;
    }
    const msg = err?.message || String(err);
    jobs.updateJob(job.id, {
      status: 'failed',
      stage: 'failed',
      message: '生成失败',
      error: msg.slice(0, 2000),
      finished_at: new Date().toISOString(),
    });
  }
}

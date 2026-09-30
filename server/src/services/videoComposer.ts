import path from 'path';
import fs from 'fs';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { ProjectService } from './projectService';
import { detectVideoEncoder, videoEncodeArgs, type FfmpegVideoEncoder } from './ffmpegEncoder';
import { beginJob, clearCancel, isCancelled, JobCancelledError, requestCancel } from './jobCancel';
import {
  legacySlideAudioCachePath,
  slideAudioCachePath,
} from '../utils/mediaCache';

const execFileAsync = promisify(execFile);

type TrackedJob = 'compose' | 'export';


export interface ComposeInput {
  projectId: string;
  slides: any[];
  allowSilentPages: boolean;
  defaultSilentPageDuration: number;
  /** 页间停顿（秒），默认 0；MOOC 等一键流程可设为 2 */
  pauseDuration?: number;
}

export interface ExportRenderInput {
  projectId: string;
  slides: any[];
  speed: number;           // 0.5 - 2.0, 1.0 = normal
  pauseDuration: number;   // seconds between slides, 0 = no pause
  aspectRatio?: string;    // '16:9' | '9:16' | '1:1' | '4:3' | null
  crop?: {                 // Custom crop (takes precedence over aspectRatio)
    xPct: number;          // 0-100
    yPct: number;          // 0-100
    widthPct: number;      // 0-100
    heightPct: number;     // 0-100
  };
  allowSilentPages: boolean;
  defaultSilentPageDuration: number;
}

export interface ComposeProgress {
  stage: string;
  currentPage: number;
  totalPages: number;
  updatedAt: string;
}

const STAGE_LABELS: Record<string, string> = {
  preparing: '准备页面素材',
  audio: '合成音频',
  video: '合成视频',
  final: '生成完成',
};

export class VideoComposerService {
  constructor(private projectService: ProjectService) {}

  /** In-flight ffmpeg/ffprobe children keyed by project — killed on force cancel */
  private activeChildren = new Map<string, Set<ChildProcess>>();

  private trackChild(projectId: string, child: ChildProcess) {
    let set = this.activeChildren.get(projectId);
    if (!set) {
      set = new Set();
      this.activeChildren.set(projectId, set);
    }
    set.add(child);
    const cleanup = () => {
      set!.delete(child);
      if (set!.size === 0) this.activeChildren.delete(projectId);
    };
    child.once('exit', cleanup);
    child.once('error', cleanup);
  }

  private killTracked(projectId: string) {
    const set = this.activeChildren.get(projectId);
    if (!set?.size) return;
    for (const child of [...set]) {
      if (!child.pid) continue;
      try {
        // Kill process group if detached; fall back to the child itself
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } catch {
        // already dead
      }
    }
  }

  /**
   * Run ffmpeg/ffprobe with cancel support: registers the child so forceCancel can SIGKILL it.
   */
  private runCmd(
    projectId: string,
    kind: TrackedJob,
    file: string,
    args: string[],
    opts?: { timeout?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (isCancelled(kind, projectId)) {
        reject(new JobCancelledError(kind === 'compose' ? '视频合成已取消' : '导出已取消'));
        return;
      }

      const child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // New process group so we can kill ffmpeg + helpers with -pid
        detached: process.platform !== 'win32',
      });

      this.trackChild(projectId, child);

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };

      const timer = opts?.timeout
        ? setTimeout(() => {
            try {
              if (child.pid) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
              }
            } catch { /* ignore */ }
            settle(() => reject(new Error(`${file} timed out after ${opts.timeout}ms`)));
          }, opts.timeout)
        : null;

      child.on('error', (err: Error) => {
        settle(() => reject(err));
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (isCancelled(kind, projectId)) {
          settle(() => reject(new JobCancelledError(kind === 'compose' ? '视频合成已取消' : '导出已取消')));
          return;
        }
        if (code !== 0) {
          const err: any = new Error(
            signal
              ? `${file} killed by ${signal}: ${stderr.slice(-800)}`
              : `${file} exited with code ${code}: ${stderr.slice(-800)}`,
          );
          err.code = code;
          err.signal = signal;
          err.stderr = stderr;
          settle(() => reject(err));
          return;
        }
        settle(() => resolve({ stdout, stderr }));
      });
    });
  }

  /** Flag cancel + immediately kill in-flight ffmpeg for this project. */
  forceCancelCompose(projectId: string) {
    requestCancel('compose', projectId);
    this.killTracked(projectId);
    this.finalizeComposeCancel(projectId);
  }

  forceCancelExport(projectId: string) {
    requestCancel('export', projectId);
    this.killTracked(projectId);
    try {
      this.writeProgress(projectId, 'export_cancelled', 0, 0);
    } catch { /* ignore */ }
  }

  /** Restore UI-visible state right away (don't wait for loop to notice). */
  finalizeComposeCancel(projectId: string) {
    try {
      const progressPath = this.getProgressPath(projectId);
      if (progressPath) {
        fs.writeFileSync(progressPath, JSON.stringify({
          stage: 'cancelled',
          currentPage: 0,
          totalPages: 0,
          updatedAt: new Date().toISOString(),
          error: '用户已取消',
        }));
      }
    } catch { /* ignore */ }
    const latest = this.projectService.getProject(projectId) as any;
    const keepSuccess = !!(latest?.video_file_path && fs.existsSync(latest.video_file_path));
    this.projectService.updateProject(projectId, {
      video_status: keepSuccess ? 'success' : 'pending',
    });
  }

  private getProgressPath(projectId: string): string {
    const project = this.projectService.getProject(projectId);
    if (!project) return '';
    const projectDir = path.dirname(project.file_path);
    return path.join(projectDir, 'compose_progress.json');
  }

  writeProgress(projectId: string, stage: string, currentPage: number, totalPages: number) {
    const progressPath = this.getProgressPath(projectId);
    if (!progressPath) return;
    const progress: ComposeProgress = {
      stage,
      currentPage,
      totalPages,
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(progressPath, JSON.stringify(progress));
    } catch {
      // Ignore write errors for progress tracking
    }
  }

  getProgress(projectId: string): ComposeProgress | null {
    const progressPath = this.getProgressPath(projectId);
    if (!progressPath || !fs.existsSync(progressPath)) return null;
    try {
      const data = fs.readFileSync(progressPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  clearProgress(projectId: string) {
    const progressPath = this.getProgressPath(projectId);
    if (progressPath && fs.existsSync(progressPath)) {
      try { fs.unlinkSync(progressPath); } catch { /* ignore */ }
    }
  }

  /**
   * 写入导出失败进度
   */
  writeExportError(projectId: string, errorMessage: string) {
    const progressPath = this.getProgressPath(projectId);
    if (!progressPath) return;
    const progress = {
      stage: 'export_failed',
      currentPage: 0,
      totalPages: 0,
      updatedAt: new Date().toISOString(),
      error: errorMessage,
    };
    try {
      fs.writeFileSync(progressPath, JSON.stringify(progress));
    } catch {
      // ignore
    }
  }

  /**
   * Write initial progress so the frontend can poll immediately
   * before the background composition starts writing updates.
   */
  writeInitialProgress(projectId: string, totalPages: number) {
    this.writeProgress(projectId, 'preparing', 0, totalPages);
  }

  /**
   * Resolve audio path: if it's a URL, download to a local temp file first.
   * Cache key includes the source URL/path hash so regenerated dubbing is not reused.
   */
  private async resolveAudioPath(audioPath: string, projectDir: string, pageIndex: number): Promise<string | null> {
    if (!audioPath) return null;

    // Already a local file that exists
    if (!audioPath.startsWith('http://') && !audioPath.startsWith('https://')) {
      return fs.existsSync(audioPath) ? audioPath : null;
    }

    const audioDir = path.join(projectDir, 'audio_cache');
    fs.mkdirSync(audioDir, { recursive: true });
    const localPath = slideAudioCachePath(projectDir, pageIndex, audioPath);

    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 1000) {
      return localPath;
    }

    // Drop legacy unversioned cache if present
    const legacy = legacySlideAudioCachePath(projectDir, pageIndex);
    try { if (fs.existsSync(legacy)) fs.unlinkSync(legacy); } catch { /* ignore */ }

    try {
      console.log(`[VideoComposer] Downloading audio for slide ${pageIndex} from ${audioPath}`);
      const res = await axios.get(audioPath, { responseType: 'arraybuffer', timeout: 60000 });
      fs.writeFileSync(localPath, Buffer.from(res.data));
      console.log(`[VideoComposer] Audio downloaded: ${localPath} (${(res.data.length / 1024).toFixed(1)}KB)`);
      return localPath;
    } catch (err: any) {
      console.error(`[VideoComposer] Failed to download audio for slide ${pageIndex}: ${err.message}`);
      return null;
    }
  }

  private async probeSize(filePath: string): Promise<{ width: number; height: number }> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      filePath,
    ], { timeout: 30000 });
    const [w, h] = String(stdout).trim().split(',').map((n) => parseInt(n, 10));
    if (!w || !h) throw new Error(`无法读取尺寸: ${filePath}`);
    return { width: w, height: h };
  }

  private parseLayout(raw: any): { x: number; y: number; w: number; h: number } {
    try {
      const src = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      return {
        x: Math.min(0.95, Math.max(0, Number(src.x) || 0.73)),
        y: Math.min(0.95, Math.max(0, Number(src.y) || 0.7)),
        w: Math.min(1, Math.max(0.05, Number(src.w) || 0.25)),
        h: Math.min(1, Math.max(0.05, Number(src.h) || 0.444)),
      };
    } catch {
      return { x: 0.72, y: 0.52, w: 0.25, h: 0.444 };
    }
  }

  /** Overlay avatar video (loop/trim to duration) on slide image + project audio. */
  private async composeSlideWithAvatar(opts: {
    projectId: string;
    imagePath: string;
    avatarPath: string;
    audioPath: string;
    duration: number;
    layoutJson: any;
    outputPath: string;
    encoder: FfmpegVideoEncoder;
    /** Cancel / progress job kind — export also reuses this compositor. */
    jobKind?: TrackedJob;
    /** When true, chromakey green (Duix greenscreen) before overlay. */
    chromaKey?: boolean;
  }): Promise<void> {
    const jobKind: TrackedJob = opts.jobKind || 'compose';
    const { width, height } = await this.probeSize(opts.imagePath);
    const avatar = await this.probeSize(opts.avatarPath);
    const layout = this.parseLayout(opts.layoutJson);
    const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
    const avatarAr = Math.max(0.2, avatar.width / Math.max(1, avatar.height));

    // Width follows layout.w; height follows avatar aspect (no black pad bars).
    let ow = even(width * layout.w);
    let oh = even(ow / avatarAr);
    if (oh > height * 0.95) {
      oh = even(height * 0.95);
      ow = even(oh * avatarAr);
    }
    let ox = even(width * layout.x);
    let oy = even(height * layout.y);
    // Keep overlay inside frame
    if (ox + ow > width) ox = even(Math.max(0, width - ow));
    if (oy + oh > height) oy = even(Math.max(0, height - oh));
    const dur = Math.max(0.2, Number(opts.duration) || 1);
    // Use VIDEO stream duration — format duration often follows the longer audio track
    // and wrongly disables freeze / enables stream_loop.
    let avatarDur = 0;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        opts.avatarPath,
      ], { timeout: 30000 });
      avatarDur = parseFloat(String(stdout).trim()) || 0;
    } catch { /* ignore */ }
    if (!(avatarDur > 0)) {
      avatarDur = await this.probeDuration(opts.avatarPath).catch(() => 0);
    }

    // NEVER stream_loop avatar — looping restarts lip-sync from the beginning.
    // If short: freeze last frame; if long/equal: trim.
    const needFreeze = avatarDur > 0.2 && avatarDur + 0.05 < dur;
    const padSec = needFreeze ? Math.max(0.05, dur - avatarDur) : 0;
    // Greenscreen: chromakey then harden alpha.
    // Soft blend alone leaves the person semi-transparent (ghostly) on white slides;
    // lut forces near-transparent → 0 and everything else → opaque.
    // similarity ~0.28 clears Duix's muddy green without needing extreme values.
    const pixFmt = opts.chromaKey
      ? "chromakey=0x00FF00:0.28:0.10,format=rgba,lut=a='if(lt(val\\,64)\\,0\\,255)',format=yuva420p"
      : 'format=yuv420p';
    const pipChain = needFreeze
      ? `setpts=PTS-STARTPTS,fps=25,scale=${ow}:${oh},setsar=1,${pixFmt},tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS`
      : `setpts=PTS-STARTPTS,fps=25,scale=${ow}:${oh},setsar=1,${pixFmt},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS`;

    // Keep lips locked: prefer avatar file's own audio (already remuxed with drive audio).
    // Crossing a separate project wav caused video to start tens of ms after audio.
    // Fall back to project narration if avatar has no audio stream.
    let hasAvatarAudio = false;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_type',
        '-of', 'csv=p=0',
        opts.avatarPath,
      ], { timeout: 15000 });
      hasAvatarAudio = String(stdout).trim().length > 0;
    } catch { /* ignore */ }

    const audioLabel = hasAvatarAudio ? '1:a' : '2:a';
    const inputs = hasAvatarAudio
      ? [
          '-loop', '1', '-framerate', '25', '-t', String(dur), '-i', opts.imagePath,
          '-i', opts.avatarPath,
        ]
      : [
          '-loop', '1', '-framerate', '25', '-t', String(dur), '-i', opts.imagePath,
          '-i', opts.avatarPath,
          '-i', opts.audioPath,
        ];

    const filterComplex = [
      `[0:v]scale=${even(width)}:${even(height)},setsar=1,fps=25,format=yuv420p,setpts=PTS-STARTPTS[bg]`,
      `[1:v]${pipChain}[pip]`,
      `[bg][pip]overlay=${ox}:${oy}:eof_action=repeat:shortest=1[v]`,
      `[${audioLabel}]aresample=async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=mono,apad,atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS[a]`,
    ].join(';');

    if (opts.chromaKey) {
      console.log(`[VideoComposer] Chromakey greenscreen overlay for ${path.basename(opts.outputPath)}`);
    }

    await this.runCmd(opts.projectId, jobKind, 'ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[v]', '-map', '[a]',
      ...videoEncodeArgs(opts.encoder),
      // pcm in mkv: no AAC priming delay (was ~21ms, audio led lips)
      '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
      '-vsync', 'cfr',
      '-t', String(dur),
      opts.outputPath,
    ], { timeout: this.segmentTimeoutMs(dur, 'avatar') });
  }

  private resolveAvatarPath(slide: any): string | null {
    if (
      (slide.avatar_visible === 1 || slide.avatar_visible === true) &&
      slide.avatar_status === 'generated' &&
      slide.avatar_video_path &&
      fs.existsSync(slide.avatar_video_path)
    ) {
      return slide.avatar_video_path;
    }
    return null;
  }

  /**
   * Timeout for per-slide ffmpeg. Long narration (e.g. 10+ min) needs far more than 120s.
   * Rough budget: base + ~2.5s wall time per media second (NVENC still-image + PCM write).
   */
  private segmentTimeoutMs(durationSec: number, kind: 'simple' | 'avatar' | 'merge' = 'simple'): number {
    const d = Math.max(1, Number(durationSec) || 1);
    if (kind === 'merge') {
      return Math.max(300_000, Math.ceil(d * 800) + 120_000);
    }
    if (kind === 'avatar') {
      return Math.max(300_000, Math.ceil(d * 3000) + 180_000);
    }
    return Math.max(180_000, Math.ceil(d * 2500) + 120_000);
  }

  /**
   * Reuse a segment only when it exists, duration matches, AND all source
   * inputs are older than the segment (so regenerated dubbing/avatar invalidate it).
   */
  private async canReuseSegment(
    segmentPath: string,
    expectedDuration: number,
    sources: Array<string | null | undefined>,
  ): Promise<boolean> {
    if (!fs.existsSync(segmentPath)) return false;
    try {
      const segStat = fs.statSync(segmentPath);
      for (const src of sources) {
        if (!src || !fs.existsSync(src)) continue;
        if (fs.statSync(src).mtimeMs > segStat.mtimeMs + 50) {
          console.log(`[VideoComposer] Segment stale vs source ${path.basename(src)}, will rebuild`);
          return false;
        }
      }
      const existing = await this.probeDuration(segmentPath);
      return Math.abs(existing - expectedDuration) <= 0.75;
    } catch {
      return false;
    }
  }

  private async probeDuration(filePath: string): Promise<number> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 30000 });
    const n = parseFloat(String(stdout).trim());
    if (!Number.isFinite(n) || n <= 0) throw new Error(`无法读取时长: ${filePath}`);
    return n;
  }

  async composeVideo(input: ComposeInput): Promise<{ videoPath: string; openCutProject: any }> {
    const project = this.projectService.getProject(input.projectId);
    if (!project) throw new Error('项目不存在');

    beginJob('compose', input.projectId);
    this.projectService.updateProject(input.projectId, { video_status: 'generating' });
    const encoder = await detectVideoEncoder();
    const chromaKey = this.projectService.isAvatarRefGreenscreen((project as any).avatar_ref_video_id);

    try {
      const projectDir = path.dirname(project.file_path);
      const segmentsDir = path.join(projectDir, 'segments');
      const outputPath = path.join(projectDir, 'output.mp4');
      const timelinePath = path.join(projectDir, 'timeline.json');

      fs.mkdirSync(segmentsDir, { recursive: true });

      const timeline: any = { tracks: [{ id: 'video', type: 'video', clips: [] }, { id: 'audio', type: 'audio', clips: [] }], duration: 0 };
      let currentTime = 0;
      const segmentFiles: string[] = [];

      const totalPages = input.slides.length;

      // Stage 1: Preparing page assets
      this.writeProgress(input.projectId, 'preparing', 0, totalPages);

      for (let i = 0; i < input.slides.length; i++) {
        if (isCancelled('compose', input.projectId)) throw new JobCancelledError('视频合成已取消');
        const slide = input.slides[i];
        const pageIndex = slide.page_index;
        const imagePath = slide.image_path;
        const rawAudioPath = slide.dubbing_audio_path;

        // Resolve audio: download URL to local file if needed
        let localAudioPath: string | null = null;
        if (slide.dubbing_status === 'generated' && rawAudioPath) {
          localAudioPath = await this.resolveAudioPath(rawAudioPath, projectDir, pageIndex);
        }

        const hasAudio = !!localAudioPath;
        const isSilentPage = slide.note_status === 'empty';

        let duration: number;
        if (hasAudio) {
          duration = slide.dubbing_duration || input.defaultSilentPageDuration;
        } else if (isSilentPage && input.allowSilentPages) {
          duration = input.defaultSilentPageDuration;
        } else if (isSilentPage) {
          continue; // Skip silent pages if not allowed
        } else {
          duration = input.defaultSilentPageDuration;
        }

        const segmentPath = path.join(segmentsDir, chromaKey ? `segment_${pageIndex}_gs3.mkv` : `segment_${pageIndex}.mkv`);
        const segTimeout = this.segmentTimeoutMs(duration, 'simple');
        const useFastEncode = duration >= 90;
        let usedAvatar = false;

        // Stage 2: Audio composition for this slide
        if (hasAudio) {
          this.writeProgress(input.projectId, 'audio', i + 1, totalPages);
          const avatarPath = this.resolveAvatarPath(slide);

          if (await this.canReuseSegment(segmentPath, duration, [localAudioPath, imagePath, avatarPath])) {
            console.log(`[VideoComposer] Reusing segment ${pageIndex} (${duration.toFixed(1)}s)`);
            usedAvatar = !!avatarPath;
          } else if (avatarPath) {
            usedAvatar = true;
            // Ensure we overwrite any stale segment
            try { if (fs.existsSync(segmentPath)) fs.unlinkSync(segmentPath); } catch { /* ignore */ }
            await this.composeSlideWithAvatar({
              projectId: input.projectId,
              imagePath,
              avatarPath,
              audioPath: localAudioPath!,
              duration,
              layoutJson: slide.avatar_layout_json || (project as any).avatar_layout_json,
              outputPath: segmentPath,
              encoder,
              chromaKey,
            });
          } else {
            // Intermediate mkv+pcm avoids AAC priming delay (~21ms) that makes lips look late.
            console.log(`[VideoComposer] Encoding slide ${pageIndex} (${duration.toFixed(1)}s, timeout ${Math.round(segTimeout / 1000)}s)`);
            try { if (fs.existsSync(segmentPath)) fs.unlinkSync(segmentPath); } catch { /* ignore */ }
            await this.runCmd(input.projectId, 'compose', 'ffmpeg', [
              '-y',
              '-loop', '1', '-framerate', '25', '-t', String(duration), '-i', imagePath,
              '-i', localAudioPath!,
              '-filter_complex',
              [
                `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25,format=yuv420p,setpts=PTS-STARTPTS[v]`,
                `[1:a]aresample=async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=mono,apad,atrim=0:${Number(duration).toFixed(3)},asetpts=PTS-STARTPTS[a]`,
              ].join(';'),
              '-map', '[v]', '-map', '[a]',
              ...videoEncodeArgs(encoder, { fast: useFastEncode }),
              '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
              '-vsync', 'cfr',
              '-t', String(duration),
              segmentPath,
            ], { timeout: segTimeout });
          }
        } else {
          // Stage 3: Silent slides — still include a silent PCM track so concat streams match
          this.writeProgress(input.projectId, 'video', i + 1, totalPages);
          if (!(await this.canReuseSegment(segmentPath, duration, [imagePath]))) {
            try { if (fs.existsSync(segmentPath)) fs.unlinkSync(segmentPath); } catch { /* ignore */ }
            await this.runCmd(input.projectId, 'compose', 'ffmpeg', [
              '-y',
              '-loop', '1', '-framerate', '25', '-t', String(duration), '-i', imagePath,
              '-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
              '-filter_complex',
              `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25,format=yuv420p,setpts=PTS-STARTPTS[v]`,
              '-map', '[v]', '-map', '1:a',
              ...videoEncodeArgs(encoder, { fast: useFastEncode }),
              '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
              '-shortest',
              segmentPath,
            ], { timeout: segTimeout });
          }
        }

        segmentFiles.push(segmentPath);

        timeline.tracks[0].clips.push({
          id: `video_${pageIndex}`,
          slideIndex: pageIndex,
          startTime: currentTime,
          endTime: currentTime + duration,
          sourcePath: imagePath,
          duration,
        });

        if (hasAudio) {
          timeline.tracks[1].clips.push({
            id: `audio_${pageIndex}`,
            slideIndex: pageIndex,
            startTime: currentTime,
            endTime: currentTime + duration,
            sourcePath: localAudioPath,
            duration,
            volume: 1,
          });
        }

        currentTime += duration;

        // 页间停顿（与导出逻辑一致：冻结合成末帧或静帧 + 静音）
        const pauseDuration = Number(input.pauseDuration) || 0;
        const hasLaterSegment = input.slides.slice(i + 1).some((s) => {
          if (s.note_status === 'empty' && !input.allowSilentPages) return false;
          return true;
        });
        if (pauseDuration > 0 && hasLaterSegment) {
          const pausePath = path.join(segmentsDir, `pause_${pageIndex}.mkv`);
          const pauseStr = pauseDuration.toFixed(3);
          if (usedAvatar && fs.existsSync(segmentPath)) {
            const freezeStart = Math.max(0, duration - 0.12);
            await this.runCmd(input.projectId, 'compose', 'ffmpeg', [
              '-y',
              '-ss', String(freezeStart.toFixed(3)),
              '-i', segmentPath,
              '-f', 'lavfi', '-t', pauseStr, '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
              '-filter_complex',
              `[0:v]fps=25,format=yuv420p,tpad=stop_mode=clone:stop_duration=${pauseStr},` +
                `trim=duration=${pauseStr},setpts=PTS-STARTPTS[v]`,
              '-map', '[v]', '-map', '1:a',
              ...videoEncodeArgs(encoder, { fast: true }),
              '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
              '-t', pauseStr,
              pausePath,
            ], { timeout: 120000 });
          } else {
            await this.runCmd(input.projectId, 'compose', 'ffmpeg', [
              '-y',
              '-loop', '1', '-framerate', '25', '-t', pauseStr, '-i', imagePath,
              '-f', 'lavfi', '-t', pauseStr, '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
              '-filter_complex',
              `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25,format=yuv420p,setpts=PTS-STARTPTS[v]`,
              '-map', '[v]', '-map', '1:a',
              ...videoEncodeArgs(encoder, { fast: true }),
              '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
              '-t', pauseStr,
              pausePath,
            ], { timeout: 120000 });
          }
          segmentFiles.push(pausePath);
          currentTime += pauseDuration;
        }
      }

      timeline.duration = currentTime;

      if (isCancelled('compose', input.projectId)) throw new JobCancelledError('视频合成已取消');

      // Stage 3: Final video concatenation
      this.writeProgress(input.projectId, 'video', totalPages, totalPages);

      // Concatenate mkv/pcm segments, then one AAC encode for the final mp4
      const concatListPath = path.join(segmentsDir, 'concat.txt');
      fs.writeFileSync(concatListPath, segmentFiles.map(f => `file '${f}'`).join('\n'));

      const concatMkv = path.join(segmentsDir, 'concat.mkv');
      const mergeTimeout = this.segmentTimeoutMs(timeline.duration || currentTime, 'merge');
      await this.runCmd(input.projectId, 'compose', 'ffmpeg', [
        '-y',
        '-f', 'concat', '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        concatMkv,
      ], { timeout: mergeTimeout });

      await this.runCmd(input.projectId, 'compose', 'ffmpeg', [
        '-y',
        '-i', concatMkv,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '1',
        '-muxdelay', '0', '-muxpreload', '0',
        '-movflags', '+faststart',
        outputPath,
      ], { timeout: mergeTimeout });

      // Save timeline
      fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));

      // Cleanup segments
      try { fs.rmSync(segmentsDir, { recursive: true, force: true }); } catch {}

      // Stage 4: Done
      this.writeProgress(input.projectId, 'final', totalPages, totalPages);

      this.projectService.updateProject(input.projectId, {
        video_status: 'success',
        video_file_path: outputPath,
      });

      return { videoPath: outputPath, openCutProject: timeline };
    } catch (error: any) {
      if (error instanceof JobCancelledError || error?.name === 'JobCancelledError' || isCancelled('compose', input.projectId)) {
        this.finalizeComposeCancel(input.projectId);
        return { videoPath: (this.projectService.getProject(input.projectId) as any)?.video_file_path || '', openCutProject: null };
      }
      const msg = error?.code === 'ENOENT'
        ? `视频合成失败：找不到命令 ${error?.path || 'ffmpeg'}（容器未安装 ffmpeg）`
        : (error?.message || String(error));
      this.writeExportError(input.projectId, msg);
      // Keep stage name recognizable for preview page
      try {
        const progressPath = this.getProgressPath(input.projectId);
        if (progressPath) {
          fs.writeFileSync(progressPath, JSON.stringify({
            stage: 'failed',
            currentPage: 0,
            totalPages: input.slides?.length || 0,
            updatedAt: new Date().toISOString(),
            error: msg,
          }));
        }
      } catch { /* ignore */ }
      this.projectService.updateProject(input.projectId, { video_status: 'failed' });
      throw error;
    } finally {
      clearCancel('compose', input.projectId);
    }
  }

  /**
   * 根据导出设置（变速、页间停顿）重新渲染视频
   */
  async renderExport(input: ExportRenderInput): Promise<{ exportPath: string; totalDuration: number }> {
    const project = this.projectService.getProject(input.projectId);
    if (!project) throw new Error('项目不存在');

    beginJob('export', input.projectId);
    const projectDir = path.dirname(project.file_path);
    const segmentsDir = path.join(projectDir, 'export_segments');
    const exportPath = path.join(projectDir, `export_${Date.now()}.mp4`);

    fs.mkdirSync(segmentsDir, { recursive: true });
    const encoder = await detectVideoEncoder();
    const chromaKey = this.projectService.isAvatarRefGreenscreen((project as any).avatar_ref_video_id);

    try {
    const speed = input.speed || 1.0;
    const pauseDuration = input.pauseDuration || 0;
    const aspectRatio = input.aspectRatio && input.aspectRatio !== 'original' ? input.aspectRatio : null;

    // 获取图片尺寸（用于生成黑场停顿段和裁切计算）
    let imgWidth = 1920;
    let imgHeight = 1080;
    const firstImage = input.slides.find(s => fs.existsSync(s.image_path || ''));
    if (firstImage) {
      try {
        const { stdout } = await execFileAsync('ffprobe', [
          '-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height',
          '-of', 'csv=s=x:p=0', firstImage.image_path,
        ]);
        const dims = stdout.trim().split('x');
        if (dims.length === 2) {
          const w = parseInt(dims[0]);
          const h = parseInt(dims[1]);
          if (w > 0 && h > 0) { imgWidth = w; imgHeight = h; }
        }
      } catch { /* 使用默认尺寸 */ }
    }

    // 计算裁切参数（自定义坐标优先，其次比例预设，最后不裁切）
    let cropW = imgWidth;
    let cropH = imgHeight;
    let outWidth = imgWidth;
    let outHeight = imgHeight;
    let cropX = 0;
    let cropY = 0;

    if (input.crop) {
      // 自定义裁切坐标（百分比转像素）
      cropW = Math.floor(imgWidth * input.crop.widthPct / 100);
      cropH = Math.floor(imgHeight * input.crop.heightPct / 100);
      cropX = Math.floor(imgWidth * input.crop.xPct / 100);
      cropY = Math.floor(imgHeight * input.crop.yPct / 100);
      outWidth = cropW;
      outHeight = cropH;
    } else if (aspectRatio) {
      const [tw, th] = aspectRatio.split(':').map(Number);
      const targetRatio = tw / th;
      const currentRatio = imgWidth / imgHeight;
      if (currentRatio > targetRatio) {
        cropW = Math.floor(imgHeight * targetRatio);
        cropH = imgHeight;
      } else {
        cropW = imgWidth;
        cropH = Math.floor(imgWidth / targetRatio);
      }
      outWidth = cropW;
      outHeight = cropH;
      cropX = Math.floor((imgWidth - cropW) / 2);
      cropY = Math.floor((imgHeight - cropH) / 2);
    }

    // 确保偶数尺寸（libx264 要求）
    outWidth = Math.floor(outWidth / 2) * 2;
    outHeight = Math.floor(outHeight / 2) * 2;
    const hasCrop = input.crop || aspectRatio;
    const videoFilter = hasCrop
      ? `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${outWidth}:${outHeight}`
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

    const segmentFiles: string[] = [];
    let totalDuration = 0;
    const totalSlides = input.slides.length;
    // 写入导出初始进度（复用 compose_progress.json，stage 区分导出阶段）
    this.writeProgress(input.projectId, 'export_preparing', 0, totalSlides);

    for (let i = 0; i < input.slides.length; i++) {
      if (isCancelled('export', input.projectId)) throw new JobCancelledError('导出已取消');
      const slide = input.slides[i];
      const pageIndex = slide.page_index;
      const imagePath = slide.image_path;
      const isLast = i === input.slides.length - 1;

      // 解析音频路径
      let localAudioPath: string | null = null;
      if (slide.dubbing_status === 'generated' && slide.dubbing_audio_path) {
        localAudioPath = await this.resolveAudioPath(slide.dubbing_audio_path, projectDir, pageIndex);
      }

      const hasAudio = !!localAudioPath;
      const isSilentPage = slide.note_status === 'empty';

      // 跳过不允许的静音页
      if (isSilentPage && !input.allowSilentPages) continue;

      let originalDuration: number;
      if (hasAudio) {
        originalDuration = slide.dubbing_duration || input.defaultSilentPageDuration;
      } else {
        originalDuration = input.defaultSilentPageDuration;
      }

      // 变速后的时长；中间段统一 mkv+PCM，避免每页 AAC priming 导致口型偏晚
      const adjustedDuration = originalDuration / speed;
      const segmentPath = path.join(segmentsDir, chromaKey ? `seg_${i}_gs3.mkv` : `seg_${i}.mkv`);
      const avatarPath = this.resolveAvatarPath(slide);
      let usedAvatar = false;
      const durStr = adjustedDuration.toFixed(3);
      const segTimeout = this.segmentTimeoutMs(Math.max(originalDuration, adjustedDuration), avatarPath ? 'avatar' : 'simple');
      const useFastEncode = adjustedDuration >= 90;

      if (hasAudio && avatarPath) {
        // 与预览合成一致：先叠数字人，再按导出参数做裁切/变速（仍输出 PCM）
        const rawPath = path.join(segmentsDir, chromaKey ? `raw_${i}_gs3.mkv` : `raw_${i}.mkv`);
        await this.composeSlideWithAvatar({
          projectId: input.projectId,
          imagePath,
          avatarPath,
          audioPath: localAudioPath!,
          duration: originalDuration,
          layoutJson: slide.avatar_layout_json || (project as any).avatar_layout_json,
          outputPath: rawPath,
          encoder,
          jobKind: 'export',
          chromaKey,
        });

        const vfParts: string[] = hasCrop
          ? [`crop=${cropW}:${cropH}:${cropX}:${cropY}`, `scale=${outWidth}:${outHeight}`]
          : ['scale=trunc(iw/2)*2:trunc(ih/2)*2'];
        if (speed !== 1.0) vfParts.push(`setpts=PTS/${speed}`);

        const aFilter = speed !== 1.0
          ? `atempo=${speed},aresample=async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=mono,apad,atrim=0:${durStr},asetpts=PTS-STARTPTS`
          : `aresample=async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=mono,apad,atrim=0:${durStr},asetpts=PTS-STARTPTS`;

        await this.runCmd(input.projectId, 'export', 'ffmpeg', [
          '-y',
          '-i', rawPath,
          '-filter_complex',
          `[0:v]${vfParts.join(',')},fps=25,format=yuv420p,setpts=PTS-STARTPTS[v];[0:a]${aFilter}[a]`,
          '-map', '[v]', '-map', '[a]',
          ...videoEncodeArgs(encoder, { fast: useFastEncode }),
          '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
          '-vsync', 'cfr',
          '-t', durStr,
          segmentPath,
        ], { timeout: segTimeout });
        try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
        usedAvatar = true;
      } else if (hasAudio) {
        const aFilter = speed !== 1.0
          ? `atempo=${speed},aresample=async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=mono,apad,atrim=0:${durStr},asetpts=PTS-STARTPTS`
          : `aresample=async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=mono,apad,atrim=0:${durStr},asetpts=PTS-STARTPTS`;
        await this.runCmd(input.projectId, 'export', 'ffmpeg', [
          '-y',
          '-loop', '1', '-framerate', '25', '-t', durStr, '-i', imagePath,
          '-i', localAudioPath!,
          '-filter_complex',
          [
            `[0:v]${videoFilter},fps=25,format=yuv420p,setpts=PTS-STARTPTS[v]`,
            `[1:a]${aFilter}[a]`,
          ].join(';'),
          '-map', '[v]', '-map', '[a]',
          ...videoEncodeArgs(encoder, { fast: useFastEncode }),
          '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
          '-vsync', 'cfr',
          '-t', durStr,
          segmentPath,
        ], { timeout: segTimeout });
      } else {
        // 静音页也带 PCM 静音轨，保证 concat 流结构一致
        await this.runCmd(input.projectId, 'export', 'ffmpeg', [
          '-y',
          '-loop', '1', '-framerate', '25', '-t', durStr, '-i', imagePath,
          '-f', 'lavfi', '-t', durStr, '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
          '-filter_complex',
          `[0:v]${videoFilter},fps=25,format=yuv420p,setpts=PTS-STARTPTS[v]`,
          '-map', '[v]', '-map', '1:a',
          ...videoEncodeArgs(encoder, { fast: useFastEncode }),
          '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
          '-shortest',
          segmentPath,
        ], { timeout: segTimeout });
      }

      segmentFiles.push(segmentPath);
      totalDuration += adjustedDuration;
      // 写入导出进度
      this.writeProgress(input.projectId, 'export_rendering', i + 1, totalSlides);

      // 页间停顿：保留当前页画面（有数字人则冻结合成段末帧），PCM 静音轨
      if (pauseDuration > 0 && !isLast) {
        const pausePath = path.join(segmentsDir, `pause_${i}.mkv`);
        const pauseStr = pauseDuration.toFixed(3);
        if (usedAvatar && fs.existsSync(segmentPath)) {
          // Freeze last frame for the full pause. Do NOT use -shortest with -sseof:
          // sseof only has ~0.08s of video, and -shortest would truncate the pause
          // to that length, shifting the rest of the timeline and scrambling audio sync.
          const freezeStart = Math.max(0, adjustedDuration - 0.12);
          await this.runCmd(input.projectId, 'export', 'ffmpeg', [
            '-y',
            '-ss', String(freezeStart.toFixed(3)),
            '-i', segmentPath,
            '-f', 'lavfi', '-t', pauseStr, '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
            '-filter_complex',
            [
              `[0:v]fps=25,format=yuv420p,tpad=stop_mode=clone:stop_duration=${pauseStr},` +
                `trim=duration=${pauseStr},setpts=PTS-STARTPTS,scale=${outWidth}:${outHeight}[v]`,
            ].join(''),
            '-map', '[v]', '-map', '1:a',
            ...videoEncodeArgs(encoder),
            '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
            '-t', pauseStr,
            pausePath,
          ], { timeout: 120000 });
        } else {
          await this.runCmd(input.projectId, 'export', 'ffmpeg', [
            '-y',
            '-loop', '1', '-framerate', '25', '-t', pauseStr, '-i', imagePath,
            '-f', 'lavfi', '-t', pauseStr, '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
            '-filter_complex',
            `[0:v]${videoFilter},fps=25,format=yuv420p,setpts=PTS-STARTPTS[v]`,
            '-map', '[v]', '-map', '1:a',
            ...videoEncodeArgs(encoder),
            '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
            '-t', pauseStr,
            pausePath,
          ], { timeout: 120000 });
        }
        segmentFiles.push(pausePath);
        totalDuration += pauseDuration;
      }
    }

    // 合并 mkv/pcm，再一次性编 AAC → 最终 mp4（与合成链路一致）
    if (isCancelled('export', input.projectId)) throw new JobCancelledError('导出已取消');
    this.writeProgress(input.projectId, 'export_merging', totalSlides, totalSlides);
    const concatListPath = path.join(segmentsDir, 'concat.txt');
    fs.writeFileSync(concatListPath, segmentFiles.map(f => `file '${f}'`).join('\n'));

    const concatMkv = path.join(segmentsDir, 'concat.mkv');
    const mergeTimeout = this.segmentTimeoutMs(totalDuration, 'merge');
    await this.runCmd(input.projectId, 'export', 'ffmpeg', [
      '-y',
      '-f', 'concat', '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      concatMkv,
    ], { timeout: mergeTimeout });

    await this.runCmd(input.projectId, 'export', 'ffmpeg', [
      '-y',
      '-i', concatMkv,
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '1',
      '-muxdelay', '0', '-muxpreload', '0',
      '-movflags', '+faststart',
      exportPath,
    ], { timeout: mergeTimeout });

    // 清理临时段
    try { fs.rmSync(segmentsDir, { recursive: true, force: true }); } catch {}

    // 导出完成
    this.writeProgress(input.projectId, 'export_done', totalSlides, totalSlides);
    return { exportPath, totalDuration };
    } catch (error: any) {
      try { fs.rmSync(segmentsDir, { recursive: true, force: true }); } catch {}
      if (error instanceof JobCancelledError || error?.name === 'JobCancelledError' || isCancelled('export', input.projectId)) {
        this.writeProgress(input.projectId, 'export_cancelled', 0, input.slides?.length || 0);
        throw error;
      }
      throw error;
    } finally {
      clearCancel('export', input.projectId);
    }
  }
}

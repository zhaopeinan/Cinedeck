import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type FfmpegVideoEncoder = 'h264_nvenc' | 'libx264';

let cachedEncoder: FfmpegVideoEncoder | null = null;
let detecting: Promise<FfmpegVideoEncoder> | null = null;

/**
 * Detect whether NVIDIA NVENC is usable in this process.
 * Override with FFMPEG_VIDEO_ENCODER=libx264|h264_nvenc.
 */
export async function detectVideoEncoder(): Promise<FfmpegVideoEncoder> {
  const forced = (process.env.FFMPEG_VIDEO_ENCODER || '').trim().toLowerCase();
  if (forced === 'libx264' || forced === 'h264_nvenc') {
    cachedEncoder = forced;
    return forced;
  }
  if (cachedEncoder) return cachedEncoder;
  if (detecting) return detecting;

  detecting = (async () => {
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error',
          // NVENC rejects tiny frames (min ~128–146px); use a safe probe size
          '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.04',
          '-frames:v', '1',
          '-c:v', 'h264_nvenc', '-f', 'null', '-',
        ],
        { timeout: 20000 },
      );
      cachedEncoder = 'h264_nvenc';
      console.log('[FFmpeg] video encoder: h264_nvenc (GPU)');
    } catch (err: any) {
      cachedEncoder = 'libx264';
      console.log(`[FFmpeg] video encoder: libx264 (CPU) — NVENC unavailable: ${err?.message || err}`);
    }
    return cachedEncoder!;
  })();

  try {
    return await detecting;
  } finally {
    detecting = null;
  }
}

/** Encoder args inserted after inputs / before output path. Includes pix_fmt. */
export function videoEncodeArgs(
  encoder: FfmpegVideoEncoder,
  opts?: { fast?: boolean },
): string[] {
  if (encoder === 'h264_nvenc') {
    // p4 = balanced; p1 = fastest (long still slides)
    // bf=0 / delay=0: avoid B-frame & encoder delay that makes lips look late vs audio
    return [
      '-c:v', 'h264_nvenc',
      '-preset', opts?.fast ? 'p1' : 'p4',
      '-rc', 'vbr',
      '-cq', opts?.fast ? '28' : '26',
      '-b:v', '0',
      '-bf', '0',
      '-delay', '0',
      '-pix_fmt', 'yuv420p',
    ];
  }
  return [
    '-c:v', 'libx264',
    '-preset', opts?.fast ? 'ultrafast' : 'veryfast',
    ...(opts?.fast ? ['-tune', 'stillimage'] : []),
    '-bf', '0',
    '-pix_fmt', 'yuv420p',
  ];
}

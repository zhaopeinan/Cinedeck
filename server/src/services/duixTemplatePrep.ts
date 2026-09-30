import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const MAX_TEMPLATE_SECONDS = Number(process.env.AVATAR_MAX_TEMPLATE_SECONDS || 60);

function runCmd(command: string, args: string[], timeoutMs = 300000): Promise<{ code: number; stdout: string; stderr: string }> {
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

/** Sidecar path for a Duix-ready H.264 template next to the source file. */
export function duixPreparedPathFor(sourcePath: string): string {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(dir, `${base}.duix.mp4`);
}

export function isDuixPreparedTemplate(filePath: string): boolean {
  return /\.duix\.mp4$/i.test(filePath) || filePath.includes('.duix.');
}

/**
 * Normalize a reference video into Duix-friendly H.264 (25fps, even dims, muted, capped length).
 * This is OUR preprocessing — Duix still re-extracts neural features on each /easy/submit
 * (official API has no feature cache). Caching this step still saves re-encode time per job/chunk.
 */
export async function prepareDuixVideoTemplate(srcVideo: string, destMp4: string): Promise<string> {
  if (fs.existsSync(destMp4) && fs.statSync(destMp4).size > 1000) {
    return destMp4;
  }
  fs.mkdirSync(path.dirname(destMp4), { recursive: true });
  const tmp = `${destMp4}.tmp.mp4`;
  const r = await runCmd('ffmpeg', [
    '-y', '-i', srcVideo,
    '-t', String(MAX_TEMPLATE_SECONDS),
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-r', '25',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
    tmp,
  ]);
  if (r.code !== 0 || !fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`参考视频预处理失败: ${(r.stderr || r.stdout).slice(-500)}`);
  }
  fs.renameSync(tmp, destMp4);
  return destMp4;
}

/** Build a short looping silent video from a still photo (Duix photo drive). */
export async function prepareDuixPhotoTemplate(photoPath: string, destMp4: string): Promise<string> {
  if (fs.existsSync(destMp4) && fs.statSync(destMp4).size > 1000) {
    return destMp4;
  }
  fs.mkdirSync(path.dirname(destMp4), { recursive: true });
  const tmp = `${destMp4}.tmp.mp4`;
  const r = await runCmd('ffmpeg', [
    '-y', '-loop', '1', '-i', photoPath,
    '-t', '4', '-r', '25',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
    tmp,
  ], 120000);
  if (r.code !== 0 || !fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`静照模板生成失败: ${(r.stderr || r.stdout).slice(-500)}`);
  }
  fs.renameSync(tmp, destMp4);
  return destMp4;
}

/** Ensure a Duix-ready template exists for a source (video or photo). */
export async function ensureDuixTemplate(sourcePath: string, driveMode: 'photo' | 'video'): Promise<string> {
  if (isDuixPreparedTemplate(sourcePath) && fs.existsSync(sourcePath)) {
    return sourcePath;
  }
  const dest = duixPreparedPathFor(sourcePath);
  if (driveMode === 'video') {
    return prepareDuixVideoTemplate(sourcePath, dest);
  }
  return prepareDuixPhotoTemplate(sourcePath, dest);
}

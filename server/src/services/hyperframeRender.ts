import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const HYPERFRAMES_IMAGE = process.env.HYPERFRAMES_IMAGE || 'ppt-audio-hyperframes:latest';
const HYPERFRAMES_CONTAINER = process.env.HYPERFRAMES_CONTAINER || 'ppt-audio-hyperframes';
/** Host path that maps to container /data (compose volume or bind). */
const DATA_HOST = process.env.HYPERFRAMES_DATA_HOST || process.env.DATA_HOST || '';

function run(command: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts?.timeoutMs ?? 30 * 60 * 1000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function dockerAvailable(): Promise<boolean> {
  const r = await run('docker', ['info'], { timeoutMs: 15000 });
  return r.code === 0;
}

/**
 * Resolve how to invoke official HyperFrames CLI.
 * Prefer: docker run --rm ppt-audio-hyperframes …
 * Fallback: local `npx hyperframes` if Node>=22 is present.
 */
export async function renderWithOfficialHyperframes(opts: {
  compositionDir: string;
  outputPath: string;
  quality?: 'draft' | 'standard' | 'high';
  onLog?: (line: string) => void;
}): Promise<void> {
  const composeDir = path.resolve(opts.compositionDir);
  const outPath = path.resolve(opts.outputPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (!fs.existsSync(path.join(composeDir, 'index.html'))) {
    throw new Error(`HyperFrames 工程缺少 index.html: ${composeDir}`);
  }

  const quality = opts.quality || 'standard';
  const log = (s: string) => {
    console.log(`[HyperFrames] ${s}`);
    opts.onLog?.(s);
  };

  // Try docker image first (official Node 22 + Chromium environment)
  if (await dockerAvailable()) {
    const hasImage = await run('docker', ['image', 'inspect', HYPERFRAMES_IMAGE], { timeoutMs: 15000 });
    if (hasImage.code === 0) {
      // Map host data root so container sees the same files.
      // compositionDir is under /data/... inside dispatcher; docker.sock uses host paths.
      const hostCompose = await resolveHostPath(composeDir);
      const outName = path.basename(outPath);
      const args = [
        'run', '--rm',
        '--network', 'none',
        '-v', `${hostCompose}:/work:rw`,
        '-w', '/work',
        '-e', 'PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium',
        '-e', 'CHROME_PATH=/usr/bin/chromium',
        '-e', 'HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium',
        '-e', 'HYPERFRAMES_BROWSER_EXECUTABLE=/usr/bin/chromium',
        HYPERFRAMES_IMAGE,
        'render',
        '--output', outName,
        '--quality', quality,
        '--fps', '30',
      ];
      log(`docker ${args.join(' ')}`);
      const r = await run('docker', args, { timeoutMs: 60 * 60 * 1000 });
      if (r.code !== 0) {
        throw new Error(`hyperframes render 失败：${(r.stderr || r.stdout).slice(-800)}`);
      }
      const produced = path.join(composeDir, outName);
      if (produced !== outPath && fs.existsSync(produced)) {
        fs.renameSync(produced, outPath);
      }
      if (!fs.existsSync(outPath)) {
        // CLI may write under renders/
        const alt = findRenderedMp4(composeDir);
        if (alt) fs.renameSync(alt, outPath);
      }
      if (!fs.existsSync(outPath)) {
        throw new Error('hyperframes render 完成但未找到输出 MP4');
      }
      log(`render ok → ${outPath}`);
      return;
    }
    log(`镜像 ${HYPERFRAMES_IMAGE} 不存在，尝试本地 npx hyperframes`);
  }

  // Local CLI fallback
  const r = await run(
    'npx',
    ['--yes', 'hyperframes@0.8.4', 'render', '--output', outPath, '--quality', quality, '--fps', '30'],
    { cwd: composeDir, timeoutMs: 60 * 60 * 1000 },
  );
  if (r.code !== 0) {
    throw new Error(
      `官方 HyperFrames 渲染不可用。请部署镜像 ${HYPERFRAMES_IMAGE}（Node 22 + Chromium）。详情：${(r.stderr || r.stdout).slice(-600)}`,
    );
  }
  if (!fs.existsSync(outPath)) {
    const alt = findRenderedMp4(composeDir);
    if (alt) fs.renameSync(alt, outPath);
  }
  if (!fs.existsSync(outPath)) throw new Error('hyperframes render 完成但未找到输出 MP4');
  log(`render ok → ${outPath}`);
}

export async function lintHyperframesProject(compositionDir: string): Promise<void> {
  if (!(await dockerAvailable())) return;
  const hasImage = await run('docker', ['image', 'inspect', HYPERFRAMES_IMAGE], { timeoutMs: 15000 });
  if (hasImage.code !== 0) return;
  const hostCompose = await resolveHostPath(path.resolve(compositionDir));
  const r = await run('docker', [
    'run', '--rm',
    '-v', `${hostCompose}:/work:ro`,
    '-w', '/work',
    HYPERFRAMES_IMAGE,
    'lint',
  ], { timeoutMs: 120000 });
  if (r.code !== 0) {
    console.warn('[HyperFrames] lint warnings/errors:', (r.stderr || r.stdout).slice(0, 500));
  }
}

function findRenderedMp4(dir: string): string | null {
  const candidates = [
    path.join(dir, 'lecture.mp4'),
    path.join(dir, 'output.mp4'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).size > 1000) return c;
  }
  const renders = path.join(dir, 'renders');
  if (fs.existsSync(renders)) {
    const files = fs.readdirSync(renders).filter((f) => f.endsWith('.mp4')).sort();
    if (files.length) return path.join(renders, files[files.length - 1]);
  }
  return null;
}

/**
 * Dispatcher sees paths under /data (volume). Docker CLI on host needs the
 * volume's real mountpoint or a bind path. Prefer HYPERFRAMES_DATA_HOST.
 */
async function resolveHostPath(containerPath: string): Promise<string> {
  // If already a host-looking path outside /data, use as-is
  if (!containerPath.startsWith('/data')) return containerPath;

  if (DATA_HOST) {
    return path.join(DATA_HOST, containerPath.slice('/data'.length));
  }

  // Inspect the app-data volume mount of this container
  const name = process.env.HOSTNAME || '';
  const inspect = await run('docker', ['inspect', '-f', '{{range .Mounts}}{{.Destination}}|{{.Source}}{{println}}{{end}}', name || 'ppt_audio-dispatcher-1'], { timeoutMs: 15000 });
  if (inspect.code === 0) {
    for (const line of inspect.stdout.split('\n')) {
      const [dest, src] = line.trim().split('|');
      if (dest === '/data' && src) {
        return path.join(src, containerPath.slice('/data'.length));
      }
    }
  }

  // Last resort: try common compose volume path via docker volume inspect
  const vol = await run('docker', ['volume', 'inspect', '-f', '{{.Mountpoint}}', 'ppt_audio_app-data'], { timeoutMs: 15000 });
  if (vol.code === 0 && vol.stdout.trim()) {
    return path.join(vol.stdout.trim(), containerPath.slice('/data'.length));
  }

  return containerPath;
}

export { HYPERFRAMES_IMAGE, HYPERFRAMES_CONTAINER };

import { spawn } from 'child_process';

export type ServiceRunState = 'running' | 'stopped' | 'missing' | 'unknown';

export interface ServiceStatusItem {
  id: string;
  label: string;
  /** docker container name or image name */
  target: string;
  kind: 'container' | 'image';
  state: ServiceRunState;
  /** short status from docker, e.g. "Up 5 minutes" / "Exited (137)" */
  detail: string | null;
  /** HTTP / API health when applicable */
  healthy: boolean | null;
  note: string | null;
}

export interface ServiceStatusSnapshot {
  services: ServiceStatusItem[];
  queriedAt: string;
}

function run(command: string, args: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
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

function voiceboxContainerName(): string {
  const fromEnv = process.env.VOICEBOX_CONTAINER?.trim();
  if (fromEnv) return fromEnv;
  try {
    const u = new URL(process.env.VOICEBOX_BASE_URL || 'http://ppt-audio-voicebox:17493');
    if (u.hostname) return u.hostname;
  } catch {
    // ignore
  }
  return 'ppt-audio-voicebox';
}

async function inspectContainer(name: string): Promise<{ state: ServiceRunState; detail: string | null }> {
  const r = await run('docker', [
    'inspect',
    '-f',
    '{{.State.Running}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}',
    name,
  ]);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || '').toLowerCase();
    if (msg.includes('no such object') || msg.includes('no such container')) {
      return { state: 'missing', detail: '容器不存在' };
    }
    return { state: 'unknown', detail: (r.stderr || r.stdout || 'inspect 失败').slice(0, 120) };
  }
  const [running, status, exitCode, err] = r.stdout.trim().split('|');
  if (running === 'true') {
    return { state: 'running', detail: status || 'running' };
  }
  const bits = [status || 'stopped'];
  if (exitCode && exitCode !== '0') bits.push(`exit ${exitCode}`);
  if (err) bits.push(err.slice(0, 60));
  return { state: 'stopped', detail: bits.filter(Boolean).join(' · ') };
}

async function inspectImage(image: string): Promise<{ state: ServiceRunState; detail: string | null }> {
  const r = await run('docker', ['image', 'inspect', '-f', '{{.Id}}', image]);
  if (r.code === 0 && r.stdout.trim()) {
    return { state: 'running', detail: '镜像已就绪（按需 docker run）' };
  }
  return { state: 'missing', detail: '镜像未加载' };
}

async function pingUrl(url: string, timeoutMs = 4000): Promise<boolean | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Aggregate docker + light HTTP health for status bar.
 * Does not start/stop anything.
 */
export async function getServiceStatuses(): Promise<ServiceStatusSnapshot> {
  const queriedAt = new Date().toISOString();
  const voiceboxName = voiceboxContainerName();
  const duixName = process.env.DUIX_CONTAINER || 'duix-avatar-gen-video';
  const ollamaName = process.env.OLLAMA_CONTAINER || 'ollama';
  const openTalkingName = process.env.OPENTALKING_CONTAINER || 'opentalking-smoke';
  const hyperframesImage = process.env.HYPERFRAMES_IMAGE || 'ppt-audio-hyperframes:latest';
  const voiceboxBase = (process.env.VOICEBOX_BASE_URL || 'http://ppt-audio-voicebox:17493').replace(/\/$/, '');
  const duixApi = (process.env.DUIX_API_BASE || 'http://duix-avatar-gen-video:8383').replace(/\/$/, '');

  const [
    voiceboxC,
    duixC,
    ollamaC,
    openTalkingC,
    hfImage,
  ] = await Promise.all([
    inspectContainer(voiceboxName),
    inspectContainer(duixName),
    inspectContainer(ollamaName),
    inspectContainer(openTalkingName),
    inspectImage(hyperframesImage),
  ]);

  let voiceboxHealthy: boolean | null = null;
  let voiceboxNote: string | null = '配音 / 转写依赖';
  if (voiceboxC.state === 'running') {
    voiceboxHealthy = await pingUrl(`${voiceboxBase}/health`);
    if (voiceboxHealthy) {
      try {
        const res = await fetch(`${voiceboxBase}/health`, { signal: AbortSignal.timeout(4000) });
        const j: any = await res.json();
        if (j?.model_loaded) voiceboxNote = `模型已加载 · ${j.model_size || 'TTS'}`;
        else voiceboxNote = '健康 · 模型未常驻（按需加载）';
      } catch {
        voiceboxNote = '健康检查通过';
      }
    } else {
      voiceboxNote = '容器在跑但 /health 未就绪';
    }
  } else if (voiceboxC.state === 'stopped') {
    voiceboxNote = '可能被数字人互斥停掉';
  }

  let duixHealthy: boolean | null = null;
  let duixNote: string | null = '数字人生成；空闲时常停止以释放 GPU';
  if (duixC.state === 'running') {
    // Duix API path varies; treat any reachable HTTP as healthy-ish
    duixHealthy = await pingUrl(`${duixApi}/`);
    if (duixHealthy == null) duixHealthy = true;
    duixNote = duixHealthy ? '运行中' : '容器在跑但 API 无响应';
  }

  const services: ServiceStatusItem[] = [
    {
      id: 'voicebox',
      label: 'Voicebox',
      target: voiceboxName,
      kind: 'container',
      state: voiceboxC.state,
      detail: voiceboxC.detail,
      healthy: voiceboxHealthy,
      note: voiceboxNote,
    },
    {
      id: 'duix',
      label: 'Duix',
      target: duixName,
      kind: 'container',
      state: duixC.state,
      detail: duixC.detail,
      healthy: duixHealthy,
      note: duixNote,
    },
    {
      id: 'ollama',
      label: 'Ollama',
      target: ollamaName,
      kind: 'container',
      state: ollamaC.state,
      detail: ollamaC.detail,
      healthy: null,
      note: '本地大模型；数字人时可能互斥停掉',
    },
    {
      id: 'hyperframes',
      label: 'HyperFrames',
      target: hyperframesImage,
      kind: 'image',
      state: hfImage.state === 'running' ? 'running' : hfImage.state,
      detail: hfImage.detail,
      healthy: hfImage.state === 'running' ? true : null,
      note: '官方渲染镜像（按需启动）',
    },
    {
      id: 'opentalking',
      label: 'OpenTalking',
      target: openTalkingName,
      kind: 'container',
      state: openTalkingC.state,
      detail: openTalkingC.detail,
      healthy: null,
      note: '旧版数字人备选',
    },
  ];

  return { services, queriedAt };
}

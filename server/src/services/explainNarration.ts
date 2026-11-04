import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { VoiceboxAdapter } from './voiceboxAdapter';
import { withVoiceboxGpu } from './voiceboxGpuQueue';
import { ensureVoiceboxRunningForAudio } from './avatarWorker';

function pickNarrationNodes(script: any, mode: 'sample' | 'final'): Array<{ narration: string; seconds?: number }> {
  const nodes = Array.isArray(script?.nodes) ? script.nodes : [];
  if (!nodes.length) return [];
  if (mode === 'final') return nodes;
  const focus = String(script?.sampleFocus || '').trim();
  const m = focus.match(/(\d+)\s*[-–—~到至]\s*(\d+)/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const sliced = nodes.filter((n: any) => {
      const id = Number(n?.id);
      return Number.isFinite(id) && id >= lo && id <= hi;
    });
    if (sliced.length) return sliced;
  }
  return nodes.slice(0, Math.min(3, nodes.length));
}

export function buildNarrationText(script: any, mode: 'sample' | 'final'): string {
  const parts = pickNarrationNodes(script, mode)
    .map((n) => String(n?.narration || '').trim())
    .filter(Boolean);
  return parts.join('。').replace(/。+/g, '。').trim();
}

async function waitVoiceboxTask(voicebox: VoiceboxAdapter, taskId: string, timeoutSec: number): Promise<boolean> {
  const maxAttempts = Math.ceil((timeoutSec * 1000) / 2000);
  for (let i = 0; i < maxAttempts; i++) {
    const st = await voicebox.getTaskStatus(taskId);
    if (st.status === 'succeeded') return true;
    if (st.status === 'failed' || st.status === 'cancelled') return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  try { await voicebox.cancelTask(taskId); } catch { /* ignore */ }
  return false;
}

async function downloadAudio(url: string, dest: string): Promise<void> {
  const base = (process.env.VOICEBOX_BASE_URL || 'http://ppt-audio-voicebox:17493').replace(/\/$/, '');
  let fetchUrl = url;
  try {
    const u = new URL(url);
    const b = new URL(base);
    if (u.pathname.startsWith('/audio/') || u.port === '17493' || u.port === b.port) {
      fetchUrl = `${b.origin}${u.pathname}${u.search}`;
    }
  } catch { /* keep */ }
  const res = await axios.get(fetchUrl, { responseType: 'arraybuffer', timeout: 120000 });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(res.data));
}

/** Inject a looping/controllable <audio> into the HTML so iframe sample stays self-contained. */
export function injectNarrationAudio(html: string, audioPath: string): string {
  if (!fs.existsSync(audioPath)) return html;
  const buf = fs.readFileSync(audioPath);
  const ext = path.extname(audioPath).toLowerCase();
  const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.ogg' ? 'audio/ogg' : 'audio/wav';
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  const snip = `
<audio id="explain-narration" src="${dataUri}" preload="auto" style="display:none"></audio>
<script>
(function(){
  var a=document.getElementById('explain-narration');
  if(!a) return;
  function syncPlay(playing){
    try {
      if(playing){ if(a.paused) a.play().catch(function(){}); }
      else { if(!a.paused) a.pause(); }
    } catch(e) {}
  }
  // Hook common custom player buttons if present
  document.addEventListener('click', function(ev){
    var t=ev.target;
    if(!t || !t.closest) return;
    if(t.closest('[data-play],.play,button.play,#btn-play')) syncPlay(true);
    if(t.closest('[data-pause],.pause,button.pause,#btn-pause')) syncPlay(false);
  }, true);
  // Autoplay attempt (may be blocked); user can press play on page controls
  a.volume=1;
  var tryPlay=function(){ a.play().catch(function(){}); };
  if(document.readyState==='complete') setTimeout(tryPlay, 400);
  else window.addEventListener('load', function(){ setTimeout(tryPlay, 400); });
})();
</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${snip}</body>`);
  return `${html}\n${snip}`;
}

/**
 * Synthesize narration with Voicebox and return local wav path (or null if skipped).
 */
export async function synthesizeExplainNarration(opts: {
  voicebox: VoiceboxAdapter;
  text: string;
  voiceId: string;
  modelId: string;
  language: 'zh' | 'en';
  outPath: string;
  timeoutSec?: number;
  maxChunkChars?: number;
}): Promise<string> {
  const text = String(opts.text || '').trim();
  if (!text) throw new Error('分镜旁白为空，无法配音');
  if (!opts.voiceId) throw new Error('请选择音色');
  if (!opts.modelId) throw new Error('请选择配音模型');

  await ensureVoiceboxRunningForAudio();
  await withVoiceboxGpu('explain:narration', async () => {
    const task = await opts.voicebox.generateDubbing({
      text,
      voiceId: opts.voiceId,
      modelId: opts.modelId,
      language: opts.language === 'en' ? 'en-US' : 'zh-CN',
      maxChunkChars: opts.maxChunkChars ?? 150,
      instruct: opts.language === 'en'
        ? 'Steady pace, clear diction, suitable for explainer narration.'
        : '语速平稳，吐字清晰，适合讲解动画旁白。',
    });
    const ok = await waitVoiceboxTask(opts.voicebox, task.id, opts.timeoutSec ?? 600);
    if (!ok) {
      const st = await opts.voicebox.getTaskStatus(task.id).catch(() => null);
      throw new Error(`配音失败${st?.error ? `：${st.error}` : ''}`);
    }
    const result = await opts.voicebox.getTaskResult(task.id);
    if (!result?.audioPath) throw new Error('配音完成但未返回音频');
    await downloadAudio(result.audioPath, opts.outPath);
  });
  return opts.outPath;
}

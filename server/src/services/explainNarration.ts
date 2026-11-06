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

/**
 * Soft-enforce subtitle preference after LLM generation.
 * When disabled, hide common caption/subtitle layers so they don't cover the scene.
 */
export function applySubtitlePreference(html: string, enabled: boolean): string {
  if (enabled) return html;
  const css = `
<style id="explain-hide-subtitles">
[class*="subtitle" i], [id*="subtitle" i],
[class*="caption" i], [id*="caption" i],
[class*="字幕"], [id*="字幕"],
.subtitles, #subtitles, .subtitle, #subtitle,
.caption, #caption, .caption-bar, .subtitle-bar,
[data-subtitle], [data-captions], [data-caption] {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${css}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${css}`);
  return `${css}\n${html}`;
}

/** Sync script for injected <audio id="explain-narration"> with page play/pause UI. */
export function buildNarrationSyncScript(): string {
  // Handles LLM players that use a single #playBtn toggle (not separate .play/.pause).
  return `<script id="explain-narration-sync">
(function(){
  var a=document.getElementById('explain-narration');
  if(!a) return;
  a.volume=1;
  try { a.loop = true; } catch (e) {}

  function syncPlay(playing){
    try {
      if(playing){ if(a.paused) a.play().catch(function(){}); }
      else { if(!a.paused) a.pause(); }
    } catch(e) {}
  }

  function iconLooksPlaying(){
    var icon = document.getElementById('playIcon');
    if(!icon) return null;
    var h = String(icon.innerHTML || '');
    // triangle play icon => animation paused
    if (/M8\\s+5v14l11/i.test(h)) return false;
    // two-bar pause icon => animation playing
    if (/M6\\s+5h4v14|M14\\s+5h4v14/i.test(h)) return true;
    return null;
  }

  function syncFromUi(){
    var playing = iconLooksPlaying();
    if (playing == null) {
      var btn = document.getElementById('playBtn');
      if (btn) {
        var label = String(btn.getAttribute('aria-label') || '') + String(btn.textContent || '');
        if (/暂停|Pause/i.test(label) && !/播放\\s*\\/\\s*暂停|Play\\s*\\/\\s*Pause/i.test(label)) playing = true;
        else if (/播放|Play/i.test(label) && !/暂停|Pause/i.test(label)) playing = false;
      }
    }
    if (playing == null) return;
    syncPlay(playing);
  }

  function seekAudioFromTimeLabel(){
    var el = document.getElementById('time');
    if (!el || !isFinite(a.duration) || a.duration <= 0) return;
    var m = String(el.textContent || '').match(/(\\d+):(\\d+)/);
    if (!m) return;
    var sec = Number(m[1]) * 60 + Number(m[2]);
    if (!isFinite(sec)) return;
    if (Math.abs((a.currentTime || 0) - sec) > 0.4) {
      try { a.currentTime = Math.max(0, Math.min(sec, a.duration)); } catch (e) {}
    }
  }

  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.closest) return;
    // Single toggle used by讲解动画 HTML（#playBtn）
    if (t.closest('#playBtn,[data-play-toggle],.play-toggle,button[aria-label*=\"播放\"],button[aria-label*=\"Play\"],button[aria-label*=\"暂停\"],button[aria-label*=\"Pause\"]')) {
      setTimeout(syncFromUi, 0);
      return;
    }
    if (t.closest('[data-play],.play,button.play,#btn-play')) syncPlay(true);
    if (t.closest('[data-pause],.pause,button.pause,#btn-pause')) syncPlay(false);
  }, true);

  ['mousedown','mouseup','touchend','click'].forEach(function(evt){
    document.addEventListener(evt, function(ev){
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('#track,#knob,#fill')) setTimeout(seekAudioFromTimeLabel, 0);
    }, true);
  });

  // Catch icon updates / loop resets while playing
  var icon = document.getElementById('playIcon');
  if (icon && typeof MutationObserver !== 'undefined') {
    try {
      new MutationObserver(function(){ syncFromUi(); }).observe(icon, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
  }
  setInterval(function(){
    if (!a.paused) seekAudioFromTimeLabel();
  }, 500);

  function boot(){
    setTimeout(function(){
      syncFromUi();
      // If UI already playing (common) but icon heuristic failed, still try autoplay
      if (iconLooksPlaying() !== false && a.paused) a.play().catch(function(){});
    }, 350);
  }
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
</script>`;
}

const NARRATION_SYNC_RE =
  /<script(?:\s+id=["']explain-narration-sync["'])?>\s*\(function\(\)\{\s*var a=document\.getElementById\(['"]explain-narration['"]\);[\s\S]*?<\/script>/i;

/** Upgrade old narration sync scripts in already-generated HTML (preview serve / re-inject). */
export function patchNarrationAudioSync(html: string): string {
  if (!html.includes('id="explain-narration"') && !html.includes("id='explain-narration'")) {
    return html;
  }
  const script = buildNarrationSyncScript();
  if (NARRATION_SYNC_RE.test(html)) {
    return html.replace(NARRATION_SYNC_RE, script);
  }
  // Audio present but sync missing / unrecognized — append before </body>
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}</body>`);
  return `${html}\n${script}`;
}

/** Inject a looping/controllable <audio> into the HTML so iframe sample stays self-contained. */
export function injectNarrationAudio(html: string, audioPath: string): string {
  if (!fs.existsSync(audioPath)) return html;
  const buf = fs.readFileSync(audioPath);
  const ext = path.extname(audioPath).toLowerCase();
  const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.ogg' ? 'audio/ogg' : 'audio/wav';
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  // Drop any previous narration block before re-injecting
  let out = html
    .replace(/<audio\b[^>]*\bid\s*=\s*["']explain-narration["'][^>]*>[\s\S]*?<\/audio>/gi, '')
    .replace(NARRATION_SYNC_RE, '');
  const snip = `
<audio id="explain-narration" src="${dataUri}" preload="auto" style="display:none"></audio>
${buildNarrationSyncScript()}`;
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${snip}</body>`);
  return `${out}\n${snip}`;
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

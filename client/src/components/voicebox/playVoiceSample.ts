import { voiceboxApi } from '../../api';

async function fetchVoiceSampleBlob(voiceId: string, failLabel = '试听失败'): Promise<{ blob: Blob; contentType: string }> {
  const token = localStorage.getItem('ppt_audio_token');
  const res = await fetch(voiceboxApi.getVoiceSampleUrl(voiceId), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    let msg = failLabel;
    try {
      const body = await res.json();
      msg = body?.error?.message || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const contentType = res.headers.get('Content-Type') || 'audio/wav';
  const blob = await res.blob();
  return { blob, contentType };
}

function extFromContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('ogg')) return 'ogg';
  if (ct.includes('mp4') || ct.includes('m4a')) return 'm4a';
  return 'wav';
}

/** Unified sample playback with auth header (works for <audio> behind token). */
export async function fetchVoiceSampleObjectUrl(voiceId: string): Promise<string> {
  const { blob } = await fetchVoiceSampleBlob(voiceId);
  return URL.createObjectURL(blob);
}

/** Download the voice sample / clone reference audio. */
export async function downloadVoiceSample(voiceId: string, filenameHint?: string): Promise<void> {
  const { blob, contentType } = await fetchVoiceSampleBlob(voiceId, '下载失败');
  const ext = extFromContentType(contentType);
  const raw = (filenameHint || `voice-${voiceId.slice(0, 8)}`).trim() || 'voice-sample';
  const safe = raw.replace(/[\\/:*?"<>|]+/g, '_');
  const filename = safe.toLowerCase().endsWith(`.${ext}`) ? safe : `${safe}.${ext}`;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

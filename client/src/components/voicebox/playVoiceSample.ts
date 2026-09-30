import { voiceboxApi } from '../../api';

/** Unified sample playback with auth header (works for <audio> behind token). */
export async function fetchVoiceSampleObjectUrl(voiceId: string): Promise<string> {
  const token = localStorage.getItem('ppt_audio_token');
  const res = await fetch(voiceboxApi.getVoiceSampleUrl(voiceId), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    let msg = '试听失败';
    try {
      const body = await res.json();
      msg = body?.error?.message || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

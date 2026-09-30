/** Shared Voicebox helpers — keep VoiceFactory / VoiceWorkshop / MOOC filters consistent. */

export function isTtsModel(model: { id?: string } | null | undefined): boolean {
  const id = String(model?.id || '').toLowerCase();
  if (id.startsWith('whisper')) return false;
  if (/^qwen3-/.test(id) && !id.includes('tts')) return false;
  return true;
}

export function isCustomVoiceModel(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').toLowerCase().replace(/-/g, '_');
  return id.includes('custom');
}

export function preferredModelForVoices(opts: {
  models: Array<{ id: string; status?: string; isRecommended?: boolean }>;
  hasPresetVoice: boolean;
}): string | null {
  const list = opts.models.filter(isTtsModel);
  const ready = list.filter((m) => m.status === 'available' || m.status === 'downloaded');
  const pool = opts.hasPresetVoice
    ? ready.filter((m) => isCustomVoiceModel(m.id))
    : ready.filter((m) => !isCustomVoiceModel(m.id));
  const pick = (arr: typeof ready) =>
    arr.find((m) => m.isRecommended) || arr[0] || null;
  return (pick(pool) || pick(ready))?.id || null;
}

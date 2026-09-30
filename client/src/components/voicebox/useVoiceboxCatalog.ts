import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { voiceboxApi } from '../../api';
import { isTtsModel, preferredModelForVoices } from '../../utils/voiceboxModels';

export function useVoiceboxCatalog(opts?: { autoLoad?: boolean }) {
  const autoLoad = opts?.autoLoad !== false;
  const [voices, setVoices] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [voiceboxAvailable, setVoiceboxAvailable] = useState<boolean | null>(null);

  const loadVoices = useCallback(async () => {
    setLoadingVoices(true);
    try {
      const res = await voiceboxApi.listVoices();
      setVoices(res.data.data || []);
      return res.data.data || [];
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '音色列表加载失败');
      return [];
    } finally {
      setLoadingVoices(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const res = await voiceboxApi.listModels();
      const all = res.data.data || [];
      setModels(all);
      return all;
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '模型列表加载失败');
      return [];
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await voiceboxApi.healthCheck();
      const ok = res.data?.data?.available ?? false;
      setVoiceboxAvailable(ok);
      return ok;
    } catch {
      setVoiceboxAvailable(false);
      return false;
    }
  }, []);

  const reloadAll = useCallback(async () => {
    const ok = await refreshHealth();
    if (!ok) return { voices: [] as any[], models: [] as any[], available: false };
    const [vs, ms] = await Promise.all([loadVoices(), loadModels()]);
    return { voices: vs, models: ms, available: true };
  }, [refreshHealth, loadVoices, loadModels]);

  useEffect(() => {
    if (!autoLoad) return;
    void reloadAll();
  }, [autoLoad, reloadAll]);

  const ttsModels = models.filter(isTtsModel);
  const pickDefaultModelId = (hasPresetVoice: boolean) =>
    preferredModelForVoices({ models: ttsModels, hasPresetVoice });

  return {
    voices,
    models,
    ttsModels,
    loadingVoices,
    loadingModels,
    voiceboxAvailable,
    setVoiceboxAvailable,
    loadVoices,
    loadModels,
    refreshHealth,
    reloadAll,
    pickDefaultModelId,
  };
}

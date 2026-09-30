import { create } from 'zustand';
import { voiceboxApi } from '../api';
import type { VoiceProfile, DubbingModel } from '../types';

interface VoiceStore {
  voices: VoiceProfile[];
  selectedVoiceId: string | null;
  models: DubbingModel[];
  selectedModelId: string | null;
  isLoadingVoices: boolean;
  isLoadingModels: boolean;

  // 录音状态
  isRecording: boolean;
  recordingDuration: number;
  recordingVolume: number;

  loadVoices: () => Promise<void>;
  selectVoice: (voiceId: string) => void;
  deleteVoice: (voiceId: string) => Promise<void>;
  setRecordingState: (isRecording: boolean, duration?: number, volume?: number) => void;

  loadModels: () => Promise<void>;
  selectModel: (modelId: string) => void;
  downloadModel: (modelId: string) => Promise<void>;
  pauseModelDownload: (modelId: string) => Promise<void>;
  resumeModelDownload: (modelId: string) => Promise<void>;
  cancelModelDownload: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;

  setSelectedVoiceId: (id: string | null) => void;
  setSelectedModelId: (id: string | null) => void;
}

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  voices: [],
  selectedVoiceId: null,
  models: [],
  selectedModelId: null,
  isLoadingVoices: false,
  isLoadingModels: false,
  isRecording: false,
  recordingDuration: 0,
  recordingVolume: 0,

  loadVoices: async () => {
    set({ isLoadingVoices: true });
    try {
      const res = await voiceboxApi.listVoices();
      set({ voices: res.data.data || [] });
    } finally {
      set({ isLoadingVoices: false });
    }
  },

  selectVoice: (voiceId: string) => set({ selectedVoiceId: voiceId }),

  deleteVoice: async (voiceId: string) => {
    await voiceboxApi.deleteVoice(voiceId);
    await get().loadVoices();
    if (get().selectedVoiceId === voiceId) {
      set({ selectedVoiceId: null });
    }
  },

  setRecordingState: (isRecording: boolean, duration?: number, volume?: number) => {
    const updates: Partial<VoiceStore> = { isRecording };
    if (duration !== undefined) updates.recordingDuration = duration;
    if (volume !== undefined) updates.recordingVolume = volume;
    set(updates);
  },

  loadModels: async () => {
    set({ isLoadingModels: true });
    try {
      const res = await voiceboxApi.listModels();
      set({ models: res.data.data || [] });
    } finally {
      set({ isLoadingModels: false });
    }
  },

  selectModel: (modelId: string) => set({ selectedModelId: modelId }),

  downloadModel: async (modelId: string) => {
    await voiceboxApi.downloadModel(modelId);
    await get().loadModels();
  },

  pauseModelDownload: async (modelId: string) => {
    await voiceboxApi.pauseModelDownload(modelId);
    await get().loadModels();
  },

  resumeModelDownload: async (modelId: string) => {
    await voiceboxApi.resumeModelDownload(modelId);
    await get().loadModels();
  },

  cancelModelDownload: async (modelId: string) => {
    await voiceboxApi.cancelModelDownload(modelId);
    await get().loadModels();
  },

  deleteModel: async (modelId: string) => {
    await voiceboxApi.deleteModel(modelId);
    await get().loadModels();
    if (get().selectedModelId === modelId) {
      set({ selectedModelId: null });
    }
  },

  setSelectedVoiceId: (id) => set({ selectedVoiceId: id }),
  setSelectedModelId: (id) => set({ selectedModelId: id }),
}));

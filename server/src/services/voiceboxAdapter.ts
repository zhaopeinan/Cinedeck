import axios from 'axios';
import { withVoiceboxGpu, noteVoiceboxTaskStarted, noteVoiceboxTaskEnded } from './voiceboxGpuQueue';
import { normalizeTtsText } from '../utils/ttsTextNormalize';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

const VOICEBOX_BASE_URL = process.env.VOICEBOX_BASE_URL || 'http://localhost:17493';

export class VoiceboxAdapter {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || VOICEBOX_BASE_URL;
  }

  async healthCheck(): Promise<{ available: boolean; version: string }> {
    try {
      const res = await axios.get(`${this.baseUrl}/health`, { timeout: 5000 });
      return { available: res.data.status === 'healthy', version: res.data.backend_type || 'unknown' };
    } catch {
      return { available: false, version: '' };
    }
  }

  /**
   * List voice profiles from Voicebox.
   * Maps Voicebox /profiles response to the VoiceProfile format expected by PPT_audio.
   */
  async listVoices(filter?: { language?: string }): Promise<any[]> {
    const res = await axios.get(`${this.baseUrl}/profiles`, { params: filter, timeout: 10000 });
    const profiles = res.data;
    // Transform Voicebox profiles to PPT_audio voice format
    return (Array.isArray(profiles) ? profiles : []).map((p: any) => ({
      id: p.id,
      name: p.name,
      language: p.language,
      source: p.voice_type === 'preset' ? 'preset' : 'personal',
      description: p.description || '',
      sampleAudioUrl: p.sample_count > 0 ? `${this.baseUrl}/profiles/${p.id}/samples` : null,
      isAvailable: true,
      authorizationStatus: 'authorized',
      createdAt: p.created_at,
      lastUsedAt: null,
      // Keep original fields for reference
      _voiceboxProfile: p,
    }));
  }

  async getVoice(voiceId: string): Promise<any> {
    const res = await axios.get(`${this.baseUrl}/profiles/${voiceId}`, { timeout: 10000 });
    const p = res.data;
    return {
      id: p.id,
      name: p.name,
      language: p.language,
      source: p.voice_type === 'preset' ? 'preset' : 'personal',
      description: p.description || '',
      sampleAudioUrl: p.sample_count > 0 ? `${this.baseUrl}/profiles/${p.id}/samples` : null,
      isAvailable: true,
      authorizationStatus: 'authorized',
      createdAt: p.created_at,
      lastUsedAt: null,
      _voiceboxProfile: p,
    };
  }

  /**
   * Create a voice profile in Voicebox.
   * Voicebox requires two steps: create profile, then add sample audio.
   * Params: { name, language, description, recordingPath (path to audio file) }
   */
  async createVoice(params: { name: string; language: string; description?: string; recordingPath: string; authorize: boolean }): Promise<any> {
    // Step 1: Create the profile
    const createRes = await axios.post(`${this.baseUrl}/profiles`, {
      name: params.name,
      language: params.language,
      description: params.description || '',
      voice_type: 'cloned',
    }, { timeout: 30000 });

    const profile = createRes.data;

    // Step 2: Add the audio sample
    if (params.recordingPath && fs.existsSync(params.recordingPath)) {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(params.recordingPath));
      formData.append('reference_text', params.name); // Use name as reference text

      await axios.post(`${this.baseUrl}/profiles/${profile.id}/samples`, formData, {
        headers: formData.getHeaders(),
        timeout: 30000,
      });
    }

    return this.getVoice(profile.id);
  }

  /**
   * Create a voice profile from a multer file upload.
   * Used when the proxy receives multipart form data from the frontend.
   */
  async createVoiceFromUpload(params: { name: string; language: string; description?: string; audioPath: string; originalName?: string }): Promise<any> {
    // Step 1: Create the profile
    const createRes = await axios.post(`${this.baseUrl}/profiles`, {
      name: params.name,
      language: params.language,
      description: params.description || '',
      voice_type: 'cloned',
    }, { timeout: 30000 });

    const profile = createRes.data;

    // Step 2: Add the audio sample
    if (params.audioPath && fs.existsSync(params.audioPath)) {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(params.audioPath), {
        filename: params.originalName || 'recording.webm',
        contentType: 'audio/webm',
      });
      formData.append('reference_text', params.name);

      await axios.post(`${this.baseUrl}/profiles/${profile.id}/samples`, formData, {
        headers: formData.getHeaders(),
        timeout: 30000,
      });
    }

    return this.getVoice(profile.id);
  }

  async deleteVoice(voiceId: string): Promise<void> {
    await axios.delete(`${this.baseUrl}/profiles/${voiceId}`, { timeout: 10000 });
  }

  /**
   * Get the URL for a voice sample audio (internal Voicebox URL).
   * Prefer getVoiceSampleBuffer for browser-facing proxying.
   */
  async getVoiceSample(voiceId: string): Promise<string> {
    const res = await axios.get(`${this.baseUrl}/profiles/${voiceId}/samples`, { timeout: 10000 });
    const samples = res.data;
    if (Array.isArray(samples) && samples.length > 0) {
      return `${this.baseUrl}/samples/${samples[0].id}`;
    }
    throw new Error('该音色没有可试听的样本');
  }

  private _previewCachePath(voiceId: string): string {
    const dir = path.resolve(process.cwd(), '..', 'data', 'voice-previews');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${voiceId}.wav`);
  }

  private _previewText(language: string): string {
    const lang = String(language || 'zh').split('-')[0].toLowerCase();
    if (lang === 'en') return 'Hello, this is a short voice preview.';
    if (lang === 'ja') return 'こんにちは、これは短い音声の試聴です。';
    if (lang === 'ko') return '안녕하세요, 짧은 음성 미리듣기입니다.';
    return '各位好，这是一段短音色试听。';
  }

  /**
   * Fetch voice sample audio bytes from Voicebox (for proxying to the browser).
   * Preset voices have no clone samples — synthesize a short preview and cache it.
   */
  async getVoiceSampleBuffer(voiceId: string): Promise<{ data: Buffer; contentType: string }> {
    try {
      const url = await this.getVoiceSample(voiceId);
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const contentType = String(res.headers['content-type'] || 'audio/wav');
      return { data: Buffer.from(res.data), contentType };
    } catch {
      // fall through to preview synthesis for preset / sample-less voices
    }

    const cachePath = this._previewCachePath(voiceId);
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1000) {
      return { data: fs.readFileSync(cachePath), contentType: 'audio/wav' };
    }

    const profile = await this.getVoice(voiceId);
    const lang = String(profile.language || 'zh').split('-')[0] || 'zh';
    const isPreset = profile.source === 'preset'
      || profile._voiceboxProfile?.voice_type === 'preset'
      || !!profile._voiceboxProfile?.preset_voice_id;

    const modelId = isPreset ? 'qwen-custom-voice-1.7B' : 'qwen-tts-1.7B';
    const task = await this.generateDubbing({
      text: this._previewText(lang),
      voiceId,
      modelId,
      language: lang,
      maxChunkChars: 150,
    });

    const started = Date.now();
    while (Date.now() - started < 120000) {
      const st = await this.getTaskStatus(task.id);
      if (st.status === 'succeeded') break;
      if (st.status === 'failed') {
        throw new Error(st.error || '预置音色试听合成失败');
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    const final = await this.getTaskStatus(task.id);
    if (final.status !== 'succeeded') {
      throw new Error('预置音色试听超时，请稍后重试');
    }

    const { data, contentType } = await this.getTaskAudioBuffer(task.id);
    try {
      fs.writeFileSync(cachePath, data);
    } catch {
      /* ignore cache write errors */
    }
    return { data, contentType: contentType || 'audio/wav' };
  }

  /**
   * List models from Voicebox.
   * Maps Voicebox /models/status response to the DubbingModel format expected by PPT_audio.
   */
  async listModels(filter?: { language?: string }): Promise<any[]> {
    const res = await axios.get(`${this.baseUrl}/models/status`, { timeout: 10000 });
    const modelList = res.data.models || [];
    // Transform Voicebox model status to PPT_audio model format
    return modelList.map((m: any) => {
      // Voicebox: downloaded = ready to use (auto-loads on generation)
      // Only distinguish: not_downloaded, downloading, available
      let status = 'not_downloaded';
      if (m.downloaded || m.loaded) {
        status = 'available';
      } else if (m.downloading) {
        status = 'downloading';
      }
      return {
        id: m.model_name,
        name: m.display_name || m.model_name,
        version: m.model_name,
        language: 'multi', // Voicebox models support multiple languages
        capabilities: ['tts'],
        downloadSize: (m.size_mb || 0) * 1024 * 1024, // Convert MB to bytes
        installedSize: m.downloaded ? (m.size_mb || 0) * 1024 * 1024 : null,
        runDevice: 'auto',
        status,
        downloadProgress: m.downloading ? 0 : (m.downloaded || m.loaded ? 100 : 0),
        isRecommended: m.model_name.includes('qwen'),
        recommendReason: m.model_name.includes('qwen') ? '推荐使用 Qwen 引擎，支持多语言高质量语音克隆' : null,
      };
    });
  }

  /**
   * Download a model in Voicebox.
   * Voicebox uses POST /models/download with { model_name } body.
   */
  async downloadModel(modelId: string): Promise<void> {
    await axios.post(`${this.baseUrl}/models/download`, { model_name: modelId }, { timeout: 300000 });
  }

  /**
   * Voicebox doesn't have pause/resume download endpoints.
   * These are no-ops that return success.
   */
  async pauseModelDownload(_modelId: string): Promise<void> {
    // Not supported by Voicebox API - no-op
  }

  async resumeModelDownload(_modelId: string): Promise<void> {
    // Not supported by Voicebox API - no-op
  }

  async cancelModelDownload(modelId: string): Promise<void> {
    await axios.post(`${this.baseUrl}/models/download/cancel`, { model_name: modelId }, { timeout: 10000 });
  }

  async deleteModel(modelId: string): Promise<void> {
    // Voicebox uses unload instead of delete
    await axios.post(`${this.baseUrl}/models/${modelId}/unload`, {}, { timeout: 10000 });
  }

  async getModelStatus(modelId: string): Promise<any> {
    const res = await axios.get(`${this.baseUrl}/models/status`, { timeout: 10000 });
    const model = (res.data.models || []).find((m: any) => m.model_name === modelId);
    if (!model) {
      return { status: 'unavailable' };
    }
    let status = 'not_downloaded';
    if (model.downloaded || model.loaded) {
      status = 'available';
    } else if (model.downloading) {
      status = 'downloading';
    }
    return {
      id: model.model_name,
      name: model.display_name,
      status,
      downloaded: model.downloaded,
      downloading: model.downloading,
      loaded: model.loaded,
      sizeMb: model.size_mb,
    };
  }

  /**
   * Generate dubbing via Voicebox.
   * Maps PPT_audio params to Voicebox GenerationRequest format.
   *
   * Qwen3-TTS drifts faster on long single-shot generations (~30s+).
   * Pass a smaller max_chunk_chars so Voicebox splits at sentence
   * boundaries and stitches with crossfade — keeps speaking rate stable.
   */
  async generateDubbing(params: {
    text: string;
    voiceId?: string;
    modelId?: string;
    language?: string;
    maxChunkChars?: number;
    instruct?: string;
    voice_id?: string;
    model_id?: string;
    max_chunk_chars?: number;
  }): Promise<any> {
    const voiceId = params.voiceId || params.voice_id;
    let modelId = params.modelId || params.model_id || '';
    if (!params.text?.trim()) throw new Error('缺少文本');
    if (!voiceId) throw new Error('缺少音色');
    if (!modelId) throw new Error('缺少模型');
    // Map language format: zh-CN -> zh, en-US -> en, etc.
    const lang = String(params.language || 'zh-CN').split('-')[0];
    // Voicebox enforces ge=100; clamp here so misconfigured settings don't 422.
    const maxChunkChars = Math.max(100, Math.min(5000, Math.floor(params.maxChunkChars ?? params.max_chunk_chars ?? 150)));

    // Preset voices require CustomVoice engine; cloned voices require Base TTS.
    // Auto-correct model when the selected model conflicts with voice type.
    try {
      const profile = await this.getVoice(voiceId);
      const isPreset = profile.source === 'preset'
        || profile._voiceboxProfile?.voice_type === 'preset'
        || !!profile._voiceboxProfile?.preset_voice_id;
      const size = this._resolveModelSize(modelId);
      if (isPreset && this._resolveEngine(modelId) !== 'qwen_custom_voice') {
        modelId = `qwen-custom-voice-${size}`;
      } else if (!isPreset && this._resolveEngine(modelId) === 'qwen_custom_voice') {
        modelId = `qwen-tts-${size}`;
      }
    } catch {
      /* keep caller modelId if profile lookup fails */
    }

    const body: Record<string, unknown> = {
      profile_id: voiceId,
      text: normalizeTtsText(params.text),
      language: lang,
      engine: this._resolveEngine(modelId),
      model_size: this._resolveModelSize(modelId),
      max_chunk_chars: maxChunkChars,
      crossfade_ms: 50,
    };
    if (params.instruct) {
      body.instruct = params.instruct;
    }

        try {
      // Chunked long-form TTS can take several minutes; keep generous timeout.
      const res = await axios.post(`${this.baseUrl}/generate`, body, { timeout: 300000 });
      const gen = res.data;
      if (gen?.id) noteVoiceboxTaskStarted(String(gen.id), `tts:${voiceId}`);
      return {
        id: gen.id,
        status: gen.status || 'processing',
        error: gen.error,
      };
    } catch (err: any) {
      const detail = err?.response?.data?.detail
        || err?.response?.data?.error?.message
        || err?.response?.data?.message;
      const status = err?.response?.status;
      if (detail) {
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }
      if (status) throw new Error(`Voicebox 请求失败（HTTP ${status}）`);
      throw err;
    }
  }

  /**
   * Get task/generation status.
   * Uses Voicebox /history/{id} for JSON response instead of SSE.
   */
  async getTaskStatus(taskId: string): Promise<any> {
    try {
      const res = await axios.get(`${this.baseUrl}/history/${taskId}`, { timeout: 10000 });
      const gen = res.data;
      // Map Voicebox status to PPT_audio expected status
      let status = gen.status || 'completed';
      if (status === 'completed') {
        status = 'succeeded';
      }
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
        noteVoiceboxTaskEnded(taskId);
      } else if (status === 'generating' || status === 'loading_model') {
        status = 'processing';
      }
      return {
        id: gen.id,
        status,
        error: gen.error,
      };
    } catch (err: any) {
      if (err.response?.status === 404) {
        return { id: taskId, status: 'failed', error: 'Generation not found' };
      }
      throw err;
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    await axios.post(`${this.baseUrl}/generate/${taskId}/cancel`, {}, { timeout: 10000 });
  }

  /**
   * Get the result of a completed generation.
   * Uses Voicebox /history/{id} for metadata and /audio/{id} for audio URL.
   */
  async getTaskResult(taskId: string): Promise<{ audioPath: string; duration: number }> {
    const res = await axios.get(`${this.baseUrl}/history/${taskId}`, { timeout: 10000 });
    const gen = res.data;
    return {
      audioPath: `${this.baseUrl}/audio/${taskId}`,
      duration: gen.duration || 0,
    };
  }

  /**
   * Transcribe an audio file via Voicebox Whisper.
   * `model` is Voicebox size: base | small | medium | large | turbo
   */
  async transcribeAudio(params: {
    audioPath: string;
    originalName?: string;
    language?: string | null;
    model?: string | null;
  }): Promise<{ text: string; duration: number }> {
    if (!params.audioPath || !fs.existsSync(params.audioPath)) {
      throw new Error('音频文件不存在');
    }
    const formData = new FormData();
    formData.append('file', fs.createReadStream(params.audioPath), {
      filename: params.originalName || path.basename(params.audioPath),
    });
    if (params.language) formData.append('language', params.language);
    if (params.model) formData.append('model', params.model);

    return withVoiceboxGpu(`whisper:${params.model || 'base'}`, async () => {
      try {
        // ~28s audio chunk; 3 min is plenty. Long timeouts left jobs looking "stuck" forever.
        const res = await axios.post(`${this.baseUrl}/transcribe`, formData, {
          headers: formData.getHeaders(),
          timeout: 3 * 60 * 1000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });
        return {
          text: String(res.data?.text || '').trim(),
          duration: Number(res.data?.duration || 0),
        };
      } catch (err: any) {
        const body = err?.response?.data;
        const detail = typeof body === 'object' ? JSON.stringify(body) : String(body || '');
        const msg = err?.message || '转写失败';
        if (/out of memory|CUDA/i.test(msg + detail)) {
          throw new Error('GPU 显存不足，转写失败。请等其他 GPU 任务结束后重试。');
        }
        throw new Error(detail ? `${msg}: ${detail.slice(0, 500)}` : msg);
      }
    });
  }

  /** Fetch generated audio bytes for browser proxy / download. */
  async getTaskAudioBuffer(taskId: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await axios.get(`${this.baseUrl}/audio/${taskId}`, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    const contentType = String(res.headers['content-type'] || 'audio/wav');
    return { data: Buffer.from(res.data), contentType };
  }

  /**
   * Resolve the Voicebox engine name from the model ID.
   */
  private _resolveEngine(modelId: string): string {
    const id = String(modelId || '').toLowerCase().replace(/-/g, '_');
    if (id.includes('kokoro')) return 'kokoro';
    if (id.includes('chatterbox_turbo')) return 'chatterbox_turbo';
    if (id.includes('chatterbox')) return 'chatterbox';
    if (id.includes('luxtts')) return 'luxtts';
    if (id.includes('tada')) return 'tada';
    if (id.includes('qwen_custom') || id.includes('custom_voice') || id.includes('customvoice')) {
      return 'qwen_custom_voice';
    }
    return 'qwen';
  }

  /**
   * Resolve the model size from the model ID.
   */
  private _resolveModelSize(modelId: string): string {
    if (modelId.includes('0.6B')) return '0.6B';
    if (modelId.includes('1.7B')) return '1.7B';
    if (modelId.includes('1B')) return '1B';
    if (modelId.includes('3B')) return '3B';
    return '1.7B';
  }
}

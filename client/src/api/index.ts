import axios from 'axios';
import type { ApiResponse } from '../types';
import { toCamelCase, toSnakeCase } from '../utils/transform';
import { message } from 'antd';

const TOKEN_KEY = 'ppt_audio_token';

/** 给媒体 URL 附加 token（用于 img/audio/video 标签，这些标签无法设置 Authorization header） */
export function withToken(url: string): string {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

const apiClient = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
});

// 请求拦截器 - 注入 Authorization 头 + POST/PUT 数据自动转 snake_case
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (config.data && !(config.data instanceof FormData) && (config.method === 'post' || config.method === 'put')) {
    config.data = toSnakeCase(config.data);
  }
  return config;
});

// 响应拦截器 - 响应数据自动转 camelCase + 401 跳转登录
apiClient.interceptors.response.use(
  (response) => {
    if (response.data && response.data.data) {
      response.data.data = toCamelCase(response.data.data);
    }
    return response;
  },
  (error) => {
    console.error('API Error:', error);
    if (!error.response) {
      message.error('网络异常，请检查网络连接');
    } else if (error.response.status === 401) {
      // 登录过期，清除 token 并跳转登录页
      localStorage.removeItem(TOKEN_KEY);
      if (!window.location.pathname.startsWith('/login')) {
        message.warning('登录已过期，请重新登录');
        window.location.href = '/login';
      }
    } else if (error.response.status === 403) {
      message.error('没有权限执行此操作');
    } else if (error.response.status >= 500) {
      message.error('服务器错误，请稍后重试');
    }
    return Promise.reject(error);
  }
);

// 项目API
export const projectApi = {
  create: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post<ApiResponse<any>>('/projects', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    });
  },
  get: (id: string) => apiClient.get<ApiResponse<any>>(`/projects/${id}`),
  list: () => apiClient.get<ApiResponse<any[]>>('/projects'),
  listAll: () => apiClient.get<ApiResponse<any[]>>('/projects', { params: { all: 1 } }),
  update: (id: string, data: Record<string, any>) => apiClient.put<ApiResponse<any>>(`/projects/${id}`, data),
  delete: (id: string) => apiClient.delete<ApiResponse<any>>(`/projects/${id}`),
  parse: (id: string) => apiClient.post<ApiResponse<any>>(`/projects/${id}/parse`, {}, { timeout: 120000 }),
  getSlides: (id: string) => apiClient.get<ApiResponse<any[]>>(`/projects/${id}/slides`),
  reparseSlide: (id: string, pageIndex: number) => apiClient.post<ApiResponse<any>>(`/projects/${id}/slides/${pageIndex}/reparse`),
  updateNote: (id: string, pageIndex: number, noteContent: string) =>
    apiClient.patch<ApiResponse<any>>(`/projects/${id}/slides/${pageIndex}/note`, { note_content: noteContent }),
  getSlideImageUrl: (id: string, pageIndex: number) => withToken(`/api/v1/projects/${id}/slides/${pageIndex}/image`),
  getSlideThumbnailUrl: (id: string, pageIndex: number) => withToken(`/api/v1/projects/${id}/slides/${pageIndex}/thumbnail`),
  getSlideAudioUrl: (id: string, pageIndex: number, opts?: { download?: boolean }) => {
    const q = opts?.download ? '?download=1' : '';
    return withToken(`/api/v1/projects/${id}/slides/${pageIndex}/audio${q}`);
  },
  /** 拉取单页配音并触发浏览器本地下载 */
  // PPT 流程内数字人
  getAvatarSettings: (id: string) => apiClient.get<ApiResponse<any>>(`/projects/${id}/avatar/settings`),
  updateAvatarSettings: (id: string, data: Record<string, any>) =>
    apiClient.put<ApiResponse<any>>(`/projects/${id}/avatar/settings`, data),
  uploadAvatarPhoto: (id: string, photo: File) => {
    const formData = new FormData();
    formData.append('photo', photo);
    return apiClient.post<ApiResponse<any>>(`/projects/${id}/avatar/photo`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    });
  },
  updateAvatarPages: (id: string, pages: any[]) =>
    apiClient.put<ApiResponse<any>>(`/projects/${id}/avatar/pages`, { pages }),
  generateAvatar: (id: string, data?: { pageIndexes?: number[]; markSkipped?: boolean }) =>
    apiClient.post<ApiResponse<any>>(`/projects/${id}/avatar/generate`, data || {}, { timeout: 60000 }),
  cancelAvatar: (id: string) =>
    apiClient.post<ApiResponse<any>>(`/projects/${id}/avatar/cancel`),
  getAvatarProgress: (id: string) => apiClient.get<ApiResponse<any>>(`/projects/${id}/avatar/progress`),
  getAvatarPageVideoUrl: (id: string, pageIndex: number) =>
    withToken(`/api/v1/projects/${id}/avatar/pages/${pageIndex}/video`),

  downloadSlideAudio: async (id: string, pageIndex: number) => {
    const token = localStorage.getItem(TOKEN_KEY);
    const url = `/api/v1/projects/${id}/slides/${pageIndex}/audio?download=1`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) {
      throw new Error(`下载失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const matched = /filename="?([^";]+)"?/i.exec(cd);
    const filename = matched?.[1] || `slide_${pageIndex}.wav`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },
  autosave: (id: string, data: Record<string, any>) => apiClient.post<ApiResponse<any>>(`/projects/${id}/autosave`, data),
  markDubbingRegenerate: (id: string) => apiClient.put<ApiResponse<any>>(`/projects/${id}/dubbing/mark-regenerate`),
  reimport: (id: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post<ApiResponse<any>>(`/projects/${id}/reimport`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    });
  },
};

// Voicebox API
export const voiceboxApi = {
  healthCheck: () => apiClient.get<ApiResponse<any>>('/voicebox/health'),
  listVoices: (filter?: { language?: string }) => apiClient.get<ApiResponse<any[]>>('/voicebox/voices', { params: filter }),
  createVoice: (data: any) => apiClient.post<ApiResponse<any>>('/voicebox/voices', data),
  deleteVoice: (id: string) => apiClient.delete<ApiResponse<any>>(`/voicebox/voices/${id}`),
  getVoiceSampleUrl: (id: string) => withToken(`/api/v1/voicebox/voices/${id}/sample`),
  listModels: (filter?: { language?: string }) => apiClient.get<ApiResponse<any[]>>('/voicebox/models', { params: filter }),
  downloadModel: (id: string) => apiClient.post<ApiResponse<any>>(`/voicebox/models/${id}/download`),
  pauseModelDownload: (id: string) => apiClient.post<ApiResponse<any>>(`/voicebox/models/${id}/download/pause`),
  resumeModelDownload: (id: string) => apiClient.post<ApiResponse<any>>(`/voicebox/models/${id}/download/resume`),
  cancelModelDownload: (id: string) => apiClient.post<ApiResponse<any>>(`/voicebox/models/${id}/download/cancel`),
  deleteModel: (id: string) => apiClient.delete<ApiResponse<any>>(`/voicebox/models/${id}`),
  getModelStatus: (id: string) => apiClient.get<ApiResponse<any>>(`/voicebox/models/${id}/status`),
  generateDubbing: (data: {
    text: string;
    voiceId: string;
    modelId: string;
    language: string;
    instruct?: string;
    maxChunkChars?: number;
  }) => apiClient.post<ApiResponse<any>>('/voicebox/generate', data, { timeout: 300000 }),
  getTaskStatus: (id: string) => apiClient.get<ApiResponse<any>>(`/voicebox/tasks/${id}`),
  getTaskResult: (id: string) => apiClient.get<ApiResponse<any>>(`/voicebox/tasks/${id}/result`),
  getTaskAudioUrl: (id: string) => withToken(`/api/v1/voicebox/tasks/${id}/audio`),
  getTaskDownloadUrl: (id: string) => withToken(`/api/v1/voicebox/tasks/${id}/audio?download=1`),
  downloadTaskAudio: async (id: string, filenameHint?: string) => {
    const token = localStorage.getItem(TOKEN_KEY);
    const url = `/api/v1/voicebox/tasks/${id}/audio?download=1`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const matched = /filename="?([^";]+)"?/i.exec(cd);
    const filename = matched?.[1] || `${filenameHint || 'voice-factory'}.wav`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },
  cancelTask: (id: string) => apiClient.post<ApiResponse<any>>(`/voicebox/tasks/${id}/cancel`),

  // 多人对话（造声工厂）
  previewDialogue: (script: string) =>
    apiClient.post<ApiResponse<any>>('/voicebox/dialogue/preview', { script }),
  listDialogueJobs: () =>
    apiClient.get<ApiResponse<{ jobs: any[]; queue: { hasRunning: boolean } }>>('/voicebox/dialogue'),
  createDialogueJob: (data: {
    name?: string;
    script: string;
    cast: Record<string, string>;
    modelId: string;
    language?: string;
    instruct?: string;
    gapMs?: number;
    maxChunkChars?: number;
  }) => apiClient.post<ApiResponse<any>>('/voicebox/dialogue', data, { timeout: 60000 }),
  getDialogueJob: (id: string) =>
    apiClient.get<ApiResponse<any>>(`/voicebox/dialogue/${id}`),
  cancelDialogueJob: (id: string) =>
    apiClient.post<ApiResponse<any>>(`/voicebox/dialogue/${id}/cancel`),
  deleteDialogueJob: (id: string) =>
    apiClient.delete<ApiResponse<any>>(`/voicebox/dialogue/${id}`),
  getDialogueAudioUrl: (id: string) => withToken(`/api/v1/voicebox/dialogue/${id}/audio`),
  getDialogueDownloadUrl: (id: string) => withToken(`/api/v1/voicebox/dialogue/${id}/audio?download=1`),
  /** 长音频用原生下载，避免整文件进内存 */
  downloadDialogueAudio: (id: string) => {
    const url = voiceboxApi.getDialogueDownloadUrl(id);
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
};

// 配音API
export const dubbingApi = {
  generate: (projectId: string) => apiClient.post<ApiResponse<any>>(`/projects/${projectId}/dubbing/generate`, {}, { timeout: 600000 }),
  generateSingle: (projectId: string, pageIndex: number) => apiClient.post<ApiResponse<any>>(`/projects/${projectId}/dubbing/generate/${pageIndex}`, {}, { timeout: 300000 }),
  getStatus: (projectId: string) => apiClient.get<ApiResponse<any>>(`/projects/${projectId}/dubbing/status`),
  cancel: (projectId: string) => apiClient.post<ApiResponse<any>>(`/projects/${projectId}/dubbing/cancel`),
};

// 视频API
export const videoApi = {
  compose: (projectId: string, data?: Record<string, any>) => apiClient.post<ApiResponse<any>>(`/projects/${projectId}/video/compose`, data || {}, { timeout: 300000 }),
  getStatus: (projectId: string) => apiClient.get<ApiResponse<any>>(`/projects/${projectId}/video/status`),
  getProgress: (projectId: string) => apiClient.get<ApiResponse<any>>(`/projects/${projectId}/video/progress`),
  getPlayUrl: (projectId: string) => withToken(`/api/v1/projects/${projectId}/video/play`),
  getDownloadUrl: (projectId: string) => withToken(`/api/v1/projects/${projectId}/video/download`),
  /**
   * 触发浏览器原生下载（流式，不等整文件进内存）。
   * 大体积 MOOC 视频若用 fetch+blob，会长时间停在「正在准备下载…」。
   */
  download: (projectId: string, _filenameHint?: string) => {
    const url = videoApi.getDownloadUrl(projectId);
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    // 不设 download 属性：由服务端 Content-Disposition 决定文件名，并允许边下边写磁盘
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
  retry: (projectId: string, data?: Record<string, any>) => apiClient.post<ApiResponse<any>>(`/projects/${projectId}/video/retry`, data || {}, { timeout: 300000 }),
  cancel: (projectId: string) => apiClient.post<ApiResponse<any>>(`/projects/${projectId}/video/cancel`),
};

// 任务队列API
export const taskApi = {
  getStatus: (taskId: string) => apiClient.get<ApiResponse<any>>(`/workers/tasks/${taskId}`),
  getProjectTasks: (projectId: string) => apiClient.get<ApiResponse<any[]>>(`/workers/projects/${projectId}/tasks`),
  retryTask: (taskId: string) => apiClient.post<ApiResponse<any>>(`/workers/tasks/${taskId}/retry`),
  getStats: () => apiClient.get<ApiResponse<any>>('/workers/stats'),
};

// OpenCut 编辑器API
export const opencutApi = {
  init: (projectId: string) => apiClient.post<ApiResponse<any>>(`/projects/${projectId}/opencut/init`, {}, { timeout: 60000 }),
  getProject: (projectId: string) => apiClient.get<ApiResponse<any>>(`/projects/${projectId}/opencut/project`),
  updateTimeline: (projectId: string, timeline: any) => apiClient.put<ApiResponse<any>>(`/projects/${projectId}/opencut/timeline`, { timeline }),
  export: (projectId: string, params?: { format?: string; speed?: number; pauseDuration?: number; aspectRatio?: string; crop?: { xPct: number; yPct: number; widthPct: number; heightPct: number } }) =>
    apiClient.post<ApiResponse<any>>(`/projects/${projectId}/opencut/export`, params || {}, { timeout: 300000 }),
  getExportStatus: (projectId: string) => apiClient.get<ApiResponse<any>>(`/projects/${projectId}/opencut/export/status`),
  cancelExport: (projectId: string) => apiClient.post<ApiResponse<any>>(`/projects/${projectId}/opencut/export/cancel`),
  retryExport: (projectId: string) => apiClient.post<ApiResponse<any>>(`/projects/${projectId}/opencut/export/retry`, {}, { timeout: 300000 }),
  getDownloadUrl: (projectId: string) => withToken(`/api/v1/projects/${projectId}/opencut/download`),
};

// LLM 大模型配置 & 解说词生成 API
export const llmApi = {
  // 配置 CRUD
  listConfigs: () => apiClient.get<ApiResponse<any>>('/llm/configs'),
  getActiveConfig: () => apiClient.get<ApiResponse<any>>('/llm/configs/active'),
  createConfig: (data: { name: string; baseUrl: string; modelName: string; apiKey?: string; temperature?: number }) =>
    apiClient.post<ApiResponse<any>>('/llm/configs', data),
  updateConfig: (id: string, data: { name?: string; baseUrl?: string; modelName?: string; apiKey?: string; temperature?: number }) =>
    apiClient.put<ApiResponse<any>>(`/llm/configs/${id}`, data),
  deleteConfig: (id: string) => apiClient.delete<ApiResponse<any>>(`/llm/configs/${id}`),
  activateConfig: (id: string) => apiClient.post<ApiResponse<any>>(`/llm/configs/${id}/activate`),
  testConfig: (id: string, testImageId?: string) => apiClient.post<ApiResponse<any>>(`/llm/configs/${id}/test`, { test_image_id: testImageId }, { timeout: 60000 }),
  getTestImages: () => apiClient.get<ApiResponse<any>>('/llm/test-images'),
  // 解说词生成
  generateScripts: (projectId: string, params: { targetDuration?: number; useExistingNote?: boolean }) =>
    apiClient.post<ApiResponse<any>>(`/llm/projects/${projectId}/script/generate`, params),
  getScriptProgress: (projectId: string) => apiClient.get<ApiResponse<any>>(`/llm/projects/${projectId}/script/progress`),
  cancelScriptGeneration: (projectId: string) => apiClient.post<ApiResponse<any>>(`/llm/projects/${projectId}/script/cancel`),
  generateSingleScript: (projectId: string, pageIndex: number, targetDuration: number) =>
    apiClient.post<ApiResponse<any>>(`/llm/projects/${projectId}/script/generate-page/${pageIndex}`, { target_duration: targetDuration }, { timeout: 120000 }),
  optimizeSingleScript: (projectId: string, pageIndex: number) =>
    apiClient.post<ApiResponse<any>>(`/llm/projects/${projectId}/script/optimize-page/${pageIndex}`, {}, { timeout: 120000 }),
  adjustSingleScriptLength: (projectId: string, pageIndex: number, targetDuration: number) =>
    apiClient.post<ApiResponse<any>>(`/llm/projects/${projectId}/script/adjust-page/${pageIndex}`, { target_duration: targetDuration }, { timeout: 120000 }),
  optimizeScripts: (projectId: string) =>
    apiClient.post<ApiResponse<any>>(`/llm/projects/${projectId}/script/optimize`),
  optimizeNotes: (projectId: string) =>
    apiClient.post<ApiResponse<any>>(`/llm/projects/${projectId}/notes/optimize`),
  adjustScriptsLength: (projectId: string, targetDurationMin: number) =>
    apiClient.post<ApiResponse<any>>(`/llm/projects/${projectId}/script/adjust-length`, { target_duration: targetDurationMin }),
};

// 认证 API（不走 snake_case 转换，手动管理 key 格式）
export const authApi = {
  getCaptcha: () => apiClient.get<ApiResponse<any>>('/auth/captcha'),
  verifyCaptcha: (captchaId: string, sliderX: number) =>
    apiClient.post<ApiResponse<any>>('/auth/captcha/verify', { captcha_id: captchaId, slider_x: sliderX }),
  login: (username: string, password: string, captchaToken: string) =>
    apiClient.post<ApiResponse<any>>('/auth/login', { username, password, captcha_token: captchaToken }),
  getMe: () => apiClient.get<ApiResponse<any>>('/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) =>
    apiClient.post<ApiResponse<any>>('/auth/change-password', { old_password: oldPassword, new_password: newPassword }),
  // 用户管理（管理员）
  getUsers: () => apiClient.get<ApiResponse<any[]>>('/auth/users'),
  createUser: (data: { username: string; password: string; role?: string }) =>
    apiClient.post<ApiResponse<any>>('/auth/users', data),
  updateUser: (id: string, data: { password?: string; role?: string; status?: string }) =>
    apiClient.put<ApiResponse<any>>(`/auth/users/${id}`, data),
  deleteUser: (id: string) => apiClient.delete<ApiResponse<any>>(`/auth/users/${id}`),
  resetPassword: (id: string, newPassword: string) =>
    apiClient.post<ApiResponse<any>>(`/auth/users/${id}/reset-password`, { new_password: newPassword }),
  // 操作日志（管理员）
  getLogs: (params: { page?: number; pageSize?: number; action?: string; status?: string }) =>
    apiClient.get<ApiResponse<any>>('/auth/logs', { params: { page: params.page, page_size: params.pageSize, action: params.action, status: params.status } }),
  // 系统统计
  getStats: () => apiClient.get<ApiResponse<any>>('/auth/stats'),
};

export const systemSettingsApi = {
  list: () => apiClient.get<ApiResponse<any[]>>('/system-settings'),
  update: (key: string, value: string) =>
    apiClient.put<ApiResponse<any>>(`/system-settings/${key}`, { value }),
};

export interface GpuDeviceStatus {
  index: number;
  name: string;
  utilizationGpu: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
}

export interface GpuStatusSnapshot {
  available: boolean;
  gpus: GpuDeviceStatus[];
  error: string | null;
  queriedAt: string;
}

export type ServiceRunState = 'running' | 'stopped' | 'missing' | 'unknown';

export interface ServiceStatusItem {
  id: string;
  label: string;
  target: string;
  kind: 'container' | 'image';
  state: ServiceRunState;
  detail: string | null;
  healthy: boolean | null;
  note: string | null;
}

export interface ServiceStatusSnapshot {
  services: ServiceStatusItem[];
  queriedAt: string;
}

export const systemApi = {
  getGpu: () => apiClient.get<ApiResponse<GpuStatusSnapshot>>('/system/gpu', { timeout: 5000 }),
  getServices: () => apiClient.get<ApiResponse<ServiceStatusSnapshot>>('/system/services', { timeout: 10000 }),
};

export type AvatarDriveMode = 'photo' | 'video';

export interface AvatarRefVideo {
  id: string;
  name: string;
  fileName: string;
  fileSize: number;
  durationSec?: number | null;
  /** 用户勾选：绿幕模板，合成时抠绿成透明 */
  isGreenscreen?: boolean;
  createdAt: string;
  updatedAt: string;
}

// 数字人解说 API（仅 Duix）
export const avatarApi = {
  listRefs: () => apiClient.get<ApiResponse<AvatarRefVideo[]>>('/avatar/refs'),
  uploadRef: (video: File, name?: string, opts?: { isGreenscreen?: boolean }) => {
    const formData = new FormData();
    formData.append('video', video);
    if (name) formData.append('name', name);
    if (opts?.isGreenscreen) formData.append('isGreenscreen', '1');
    return apiClient.post<ApiResponse<AvatarRefVideo>>('/avatar/refs', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 180000,
    });
  },
  renameRef: (id: string, name: string) =>
    apiClient.patch<ApiResponse<AvatarRefVideo>>(`/avatar/refs/${id}`, { name }),
  updateRef: (id: string, patch: { name?: string; isGreenscreen?: boolean }) =>
    apiClient.patch<ApiResponse<AvatarRefVideo>>(`/avatar/refs/${id}`, patch),
  deleteRef: (id: string) => apiClient.delete<ApiResponse<any>>(`/avatar/refs/${id}`),
  getRefPreviewUrl: (id: string) => withToken(`/api/v1/avatar/refs/${id}/preview`),

  createJob: (opts: {
    driveMode: AvatarDriveMode;
    audio: File;
    photo?: File | null;
    template?: File | null;
    refVideoId?: string | null;
    saveToLibrary?: boolean;
    refName?: string;
    isGreenscreen?: boolean;
  }) => {
    const formData = new FormData();
    formData.append('driveMode', opts.driveMode);
    formData.append('audio', opts.audio);
    if (opts.driveMode === 'photo' && opts.photo) {
      formData.append('photo', opts.photo);
    }
    if (opts.driveMode === 'video') {
      if (opts.refVideoId) formData.append('refVideoId', opts.refVideoId);
      if (opts.template) formData.append('template', opts.template);
      if (opts.saveToLibrary) formData.append('saveToLibrary', '1');
      if (opts.refName) formData.append('refName', opts.refName);
      if (opts.isGreenscreen) formData.append('isGreenscreen', '1');
    }
    return apiClient.post<ApiResponse<any>>('/avatar/jobs', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 180000,
    });
  },
  getJob: (id: string) => apiClient.get<ApiResponse<any>>(`/avatar/jobs/${id}`),
  getVideoUrl: (id: string) => withToken(`/api/v1/avatar/jobs/${id}/video`),
};

/** 一键 MOOC 异步任务 */
export const moocApi = {
  listJobs: () => apiClient.get<ApiResponse<any>>('/mooc/jobs'),
  getJob: (id: string) => apiClient.get<ApiResponse<any>>(`/mooc/jobs/${id}`),
  createJob: (formData: FormData) =>
    apiClient.post<ApiResponse<any>>('/mooc/jobs', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 180000,
    }),
  /** 渲染真实幻灯片图，供数字人布局编辑 */
  previewSlides: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiClient.post<ApiResponse<{ previewId: string; pageCount: number; pages: number[]; fileName: string }>>(
      '/mooc/preview-slides',
      fd,
      { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 },
    );
  },
  getPreviewPageUrl: (previewId: string, pageIndex: number) =>
    withToken(`/api/v1/mooc/preview/${previewId}/pages/${pageIndex}`),
  cancelJob: (id: string) => apiClient.post<ApiResponse<any>>(`/mooc/jobs/${id}/cancel`),
  /** resume=true 断点续跑；false 全部重跑 */
  retryJob: (id: string, opts?: { resume?: boolean }) =>
    apiClient.post<ApiResponse<any>>(
      `/mooc/jobs/${id}/retry`,
      { resume: opts?.resume !== false },
      { params: opts?.resume === false ? { mode: 'restart' } : undefined },
    ),
  deleteJob: (id: string) => apiClient.delete<ApiResponse<any>>(`/mooc/jobs/${id}`),
  getPptDownloadUrl: (id: string) => withToken(`/api/v1/mooc/jobs/${id}/ppt`),
  /** 下载用户提交的原始 PPTX */
  downloadPpt: async (id: string, filenameHint?: string) => {
    const token = localStorage.getItem(TOKEN_KEY);
    const url = `/api/v1/mooc/jobs/${id}/ppt`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) {
      let msg = `下载失败（HTTP ${res.status}）`;
      try {
        const j = await res.json();
        if (j?.error?.message) msg = j.error.message;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const asciiMatch = /filename="?([^";]+)"?/i.exec(cd);
    const filename = utf8Match
      ? decodeURIComponent(utf8Match[1])
      : (asciiMatch?.[1] || `${filenameHint || 'presentation'}.pptx`);
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },
  getProjectVideoUrl: (projectId: string) => withToken(`/api/v1/projects/${projectId}/video/play`),
};

export const transcribeApi = {
  listJobs: () => apiClient.get<ApiResponse<any[]>>('/transcribe/jobs'),
  getJob: (id: string) => apiClient.get<ApiResponse<any>>(`/transcribe/jobs/${id}`),
  createJob: (formData: FormData) =>
    apiClient.post<ApiResponse<any>>('/transcribe/jobs', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 600000,
    }),
  deleteJob: (id: string) => apiClient.delete<ApiResponse<any>>(`/transcribe/jobs/${id}`),
  retryJob: (id: string) => apiClient.post<ApiResponse<any>>(`/transcribe/jobs/${id}/retry`),
  resetJob: (id: string) => apiClient.post<ApiResponse<any>>(`/transcribe/jobs/${id}/reset`),
  downloadUrl: (id: string) => withToken(`/api/v1/transcribe/jobs/${id}/download`),
  downloadText: async (id: string, filenameHint?: string) => {
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch(`/api/v1/transcribe/jobs/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `${filenameHint || 'transcript'}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },
};

export const hyperframeApi = {
  listJobs: () => apiClient.get<ApiResponse<any>>('/hyperframe/jobs'),
  getJob: (id: string) => apiClient.get<ApiResponse<any>>(`/hyperframe/jobs/${id}`),
  createJob: (formData: FormData) =>
    apiClient.post<ApiResponse<any>>('/hyperframe/jobs', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 600000,
    }),
  saveScripts: (id: string, scripts: any[]) =>
    apiClient.put<ApiResponse<any>>(`/hyperframe/jobs/${id}/scripts`, { scripts }),
  confirm: (id: string, body: {
    selectedVoiceId: string;
    selectedModelId: string;
    scripts?: any[];
    selectedPageIndexes?: number[];
  }) =>
    apiClient.post<ApiResponse<any>>(`/hyperframe/jobs/${id}/confirm`, body),
  deleteJob: (id: string) => apiClient.delete<ApiResponse<any>>(`/hyperframe/jobs/${id}`),
  downloadUrl: (id: string) => withToken(`/api/v1/hyperframe/jobs/${id}/download`),
  compositionUrl: (id: string) => withToken(`/api/v1/hyperframe/jobs/${id}/composition`),
};

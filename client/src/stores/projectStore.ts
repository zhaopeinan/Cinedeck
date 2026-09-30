import { create } from 'zustand';
import { projectApi, dubbingApi, videoApi } from '../api';
import type { Project, Slide } from '../types';
import { ParseStatus } from '../types';

interface ProjectStore {
  currentProject: Project | null;
  slides: Slide[];
  isParsing: boolean;
  isComposing: boolean;
  dubbingSummary: {
    total: number;
    generated: number;
    generating: number;
    failed: number;
    pending: number;
    active?: boolean;
    progress?: {
      status: string;
      currentPageIndex: number | null;
      currentPage: number | null;
      activePages?: number[];
      concurrency?: number;
      stage: string;
      message: string;
      startedAt: string | null;
      updatedAt: string;
      completedCount: number;
      failedCount: number;
      totalToGenerate: number;
      taskId: string | null;
      waitSeconds: number;
      logs: Array<{ time: string; level: string; message: string }>;
    } | null;
  } | null;
  currentPlayingPageIndex: number | null;
  isFullPreview: boolean;

  createProject: (file: File) => Promise<Project>;
  loadProject: (id: string) => Promise<void>;
  updateProject: (id: string, updates: Record<string, any>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  parseProject: (id: string) => Promise<void>;
  loadSlides: (id: string) => Promise<void>;
  reparseSlide: (id: string, pageIndex: number) => Promise<void>;
  reimportProject: (id: string, file: File) => Promise<void>;
  listProjects: () => Promise<void>;
  projects: any[];

  startDubbing: (projectId: string) => Promise<void>;
  retryDubbing: (projectId: string, pageIndex: number) => Promise<void>;
  loadDubbingStatus: (projectId: string) => Promise<void>;
  cancelDubbing: (projectId: string) => Promise<void>;

  composeVideo: (projectId: string) => Promise<void>;
  retryCompose: (projectId: string) => Promise<void>;
  loadVideoStatus: (projectId: string) => Promise<void>;

  playPage: (pageIndex: number) => void;
  playFullPreview: () => void;
  stopPlayback: () => void;

  setCurrentProject: (project: Project | null) => void;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  currentProject: null,
  slides: [],
  isParsing: false,
  isComposing: false,
  dubbingSummary: null,
  currentPlayingPageIndex: null,
  isFullPreview: false,
  projects: [],

  createProject: async (file: File) => {
    const res = await projectApi.create(file);
    const project = res.data.data;
    set({ currentProject: project });
    return project;
  },

  loadProject: async (id: string) => {
    const res = await projectApi.get(id);
    set({ currentProject: res.data.data });
  },

  updateProject: async (id: string, updates: Record<string, any>) => {
    const res = await projectApi.update(id, updates);
    set({ currentProject: res.data.data });
  },

  deleteProject: async (id: string) => {
    await projectApi.delete(id);
    set({ currentProject: null, slides: [] });
  },

  parseProject: async (id: string) => {
    set({ isParsing: true });
    try {
      const res = await projectApi.parse(id);
      set({ currentProject: { ...get().currentProject!, parseStatus: res.data.data.parseStatus } });
      await get().loadSlides(id);
    } finally {
      set({ isParsing: false });
    }
  },

  loadSlides: async (id: string) => {
    const res = await projectApi.getSlides(id);
    set({ slides: res.data.data || [] });
  },

  reparseSlide: async (id: string, pageIndex: number) => {
    await projectApi.reparseSlide(id, pageIndex);
    await get().loadSlides(id);
  },

  reimportProject: async (id: string, file: File) => {
    await projectApi.reimport(id, file);
    const project = get().currentProject;
    if (project) {
      set({ currentProject: { ...project, parseStatus: ParseStatus.PENDING } });
    }
    await get().loadSlides(id);
  },

  listProjects: async () => {
    const res = await projectApi.list();
    set({ projects: res.data.data || [] });
  },

  startDubbing: async (projectId: string) => {
    const res = await dubbingApi.generate(projectId);
    await get().loadSlides(projectId);
    await get().loadDubbingStatus(projectId);
    return res.data.data;
  },

  retryDubbing: async (projectId: string, pageIndex: number) => {
    await dubbingApi.generateSingle(projectId, pageIndex);
    await get().loadSlides(projectId);
    await get().loadDubbingStatus(projectId);
  },

  loadDubbingStatus: async (projectId: string) => {
    const res = await dubbingApi.getStatus(projectId);
    set({ dubbingSummary: res.data.data });
  },

  cancelDubbing: async (projectId: string) => {
    await dubbingApi.cancel(projectId);
    await get().loadSlides(projectId);
  },

  composeVideo: async (projectId: string) => {
    set({ isComposing: true });
    try {
      await videoApi.compose(projectId);
      await get().loadVideoStatus(projectId);
    } finally {
      set({ isComposing: false });
    }
  },

  retryCompose: async (projectId: string) => {
    set({ isComposing: true });
    try {
      await videoApi.retry(projectId);
      await get().loadVideoStatus(projectId);
    } finally {
      set({ isComposing: false });
    }
  },

  loadVideoStatus: async (projectId: string) => {
    const res = await videoApi.getStatus(projectId);
    const project = get().currentProject;
    if (project) {
      set({ currentProject: { ...project, videoStatus: res.data.data.videoStatus, videoFilePath: res.data.data.videoFilePath } });
    }
  },

  playPage: (pageIndex: number) => set({ currentPlayingPageIndex: pageIndex, isFullPreview: false }),
  playFullPreview: () => set({ isFullPreview: true, currentPlayingPageIndex: 0 }),
  stopPlayback: () => set({ currentPlayingPageIndex: null, isFullPreview: false }),

  setCurrentProject: (project) => set({ currentProject: project }),
}));

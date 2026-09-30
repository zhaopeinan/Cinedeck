import { create } from 'zustand';
import type { EditProject, TimelineData } from '../types';

interface EditorStore {
  editProject: EditProject | null;
  isInitializing: boolean;
  isExporting: boolean;
  exportProgress: number;

  initEditor: (projectId: string) => Promise<void>;
  updateTimeline: (timeline: TimelineData) => Promise<void>;
  startExport: (projectId: string, params: { format: string; resolution?: string; frameRate?: number }) => Promise<void>;
  retryExport: (projectId: string) => Promise<void>;
  setEditProject: (project: EditProject | null) => void;
}

export const useEditorStore = create<EditorStore>((set) => ({
  editProject: null,
  isInitializing: false,
  isExporting: false,
  exportProgress: 0,

  initEditor: async (_projectId: string) => {
    set({ isInitializing: true });
    try {
      // TODO: Call OpenCut adapter API
      set({ isInitializing: false });
    } catch {
      set({ isInitializing: false });
    }
  },

  updateTimeline: async (_timeline: TimelineData) => {
    // TODO: Call OpenCut adapter API
  },

  startExport: async (_projectId: string, _params: any) => {
    set({ isExporting: true, exportProgress: 0 });
    // TODO: Call OpenCut export API
    set({ isExporting: false, exportProgress: 100 });
  },

  retryExport: async (_projectId: string) => {
    // TODO: Retry export
  },

  setEditProject: (project) => set({ editProject: project }),
}));

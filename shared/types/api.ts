export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: {
    code: string;
    message: string;
    details?: unknown;
  } | null;
}

export enum EditStatus {
  INITIALIZING = 'initializing',
  EDITING = 'editing',
  UNSAVED = 'unsaved',
}

export enum ExportStatus {
  NONE = 'none',
  EXPORTING = 'exporting',
  SUCCESS = 'success',
  FAILED = 'failed',
}

export interface Clip {
  id: string;
  slideIndex: number;
  startTime: number;
  endTime: number;
  sourcePath: string;
  duration: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  muted?: boolean;
}

export interface Track {
  id: string;
  type: 'video' | 'audio';
  clips: Clip[];
}

export interface TimelineData {
  tracks: Track[];
  duration: number;
}

export interface EditProject {
  id: string;
  projectId: string;
  sourceVideoPath: string;
  status: EditStatus;
  timeline: TimelineData | null;
  editVersion: number;
  exportStatus: ExportStatus;
  exportFilePath: string | null;
  createdAt: string;
  updatedAt: string;
}

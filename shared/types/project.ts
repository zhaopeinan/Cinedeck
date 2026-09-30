export enum ParseStatus {
  PENDING = 'pending',
  PARSING = 'parsing',
  SUCCESS = 'success',
  PARTIAL = 'partial',
  FAILED = 'failed',
}

export enum VideoStatus {
  NONE = 'none',
  PENDING = 'pending',
  GENERATING = 'generating',
  SUCCESS = 'success',
  FAILED = 'failed',
}

export enum NoteStatus {
  LOADED = 'loaded',
  EMPTY = 'empty',
  READ_FAILED = 'read_failed',
  TOO_LONG = 'too_long',
  PAGE_FAILED = 'page_failed',
}

export enum DubbingStatus {
  PENDING = 'pending',
  VOICE_PROCESSING = 'voice_processing',
  MODEL_PREPARING = 'model_preparing',
  MODEL_PENDING = 'model_pending',
  GENERATING = 'generating',
  GENERATED = 'generated',
  FAILED = 'failed',
  PLAYING = 'playing',
  REGENERATE_PENDING = 'regenerate_pending',
}

export type AvatarDriveMode = 'photo' | 'video';

/** Normalized PiP box on slide canvas (0–1). */
export interface AvatarLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export enum AvatarStatus {
  NONE = 'none',
  PENDING = 'pending',
  QUEUED = 'queued',
  RUNNING = 'running',
  GENERATED = 'generated',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

export interface Project {
  id: string;
  name: string;
  fileName: string;
  fileSize: number;
  filePath: string;
  parseStatus: ParseStatus;
  selectedVoiceId: string | null;
  selectedModelId: string | null;
  videoStatus: VideoStatus;
  videoFilePath: string | null;
  allowSilentPages: boolean;
  defaultSilentPageDuration: number;
  avatarDriveMode?: AvatarDriveMode;
  avatarRefVideoId?: string | null;
  avatarPhotoPath?: string | null;
  avatarLayoutJson?: string | null;
  lastSavedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Slide {
  id: string;
  projectId: string;
  pageIndex: number;
  thumbnailPath: string;
  imagePath: string;
  noteStatus: NoteStatus;
  noteContent: string | null;
  noteCharCount: number;
  estimatedDuration: number;
  dubbingStatus: DubbingStatus;
  dubbingAudioPath: string | null;
  dubbingDuration: number | null;
  dubbingVersion: number;
  dubbingError: string | null;
  avatarStatus?: AvatarStatus | string;
  avatarEnabled?: boolean;
  avatarVisible?: boolean;
  avatarVideoPath?: string | null;
  avatarError?: string | null;
  avatarLayoutJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export enum VoiceSource {
  PRESET = 'preset',
  PERSONAL = 'personal',
}

export enum AuthStatus {
  PENDING = 'pending',
  AUTHORIZED = 'authorized',
  EXPIRED = 'expired',
}

export enum ModelStatus {
  NOT_DOWNLOADED = 'not_downloaded',
  DOWNLOADING = 'downloading',
  DOWNLOADED = 'downloaded',
  LOADING = 'loading',
  AVAILABLE = 'available',
  UNAVAILABLE = 'unavailable',
}

export interface VoiceProfile {
  id: string;
  name: string;
  language: string;
  source: VoiceSource;
  description: string;
  sampleAudioUrl: string | null;
  isAvailable: boolean;
  authorizationStatus: AuthStatus;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface DubbingModel {
  id: string;
  name: string;
  version: string;
  language: string;
  capabilities: string[];
  downloadSize: number;
  installedSize: number | null;
  runDevice: string;
  status: ModelStatus;
  downloadProgress: number;
  isRecommended: boolean;
  recommendReason: string | null;
}

export interface QualityCheckResult {
  passed: boolean;
  issues: QualityIssue[];
}

export interface QualityIssue {
  type: 'no_audio' | 'too_short' | 'too_low_volume' | 'persistent_noise' | 'corrupt_file';
  message: string;
}

export interface GenerateTask {
  id: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
  result?: {
    audioPath: string;
    duration: number;
  };
}

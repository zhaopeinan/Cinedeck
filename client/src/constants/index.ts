import { NoteStatus, DubbingStatus, ModelStatus } from '../types';

export const NOTE_STATUS_LABELS: Record<string, { text: string; color: string }> = {
  [NoteStatus.LOADED]: { text: '已读取', color: 'green' },
  [NoteStatus.EMPTY]: { text: '无备注', color: 'default' },
  [NoteStatus.READ_FAILED]: { text: '读取失败', color: 'red' },
  [NoteStatus.TOO_LONG]: { text: '内容过长', color: 'orange' },
  [NoteStatus.PAGE_FAILED]: { text: '页面异常', color: 'red' },
};

export const DUBBING_STATUS_LABELS: Record<string, { text: string; color: string }> = {
  [DubbingStatus.PENDING]: { text: '待生成', color: 'default' },
  [DubbingStatus.VOICE_PROCESSING]: { text: '音色处理中', color: 'processing' },
  [DubbingStatus.MODEL_PREPARING]: { text: '模型准备中', color: 'processing' },
  [DubbingStatus.MODEL_PENDING]: { text: '模型加载中', color: 'processing' },
  [DubbingStatus.GENERATING]: { text: '生成中', color: 'blue' },
  [DubbingStatus.GENERATED]: { text: '已生成', color: 'green' },
  [DubbingStatus.FAILED]: { text: '生成失败', color: 'red' },
  [DubbingStatus.PLAYING]: { text: '播放中', color: 'blue' },
  [DubbingStatus.REGENERATE_PENDING]: { text: '重新生成中', color: 'processing' },
};

export const MODEL_STATUS_LABELS: Record<string, { text: string; color: string }> = {
  [ModelStatus.NOT_DOWNLOADED]: { text: '未下载', color: 'default' },
  [ModelStatus.DOWNLOADING]: { text: '下载中', color: 'blue' },
  [ModelStatus.DOWNLOADED]: { text: '已下载', color: 'cyan' },
  [ModelStatus.LOADING]: { text: '加载中', color: 'processing' },
  [ModelStatus.AVAILABLE]: { text: '可用', color: 'green' },
  [ModelStatus.UNAVAILABLE]: { text: '不可用', color: 'red' },
};

import type { AvatarDriveMode } from '../api';
import type { AvatarLayout } from '../types';

export const DEFAULT_AVATAR_LAYOUT: AvatarLayout = { x: 0.72, y: 0.52, w: 0.25, h: 0.444 };

export const AVATAR_DRIVE_HINT: Record<AvatarDriveMode, string> = {
  photo: '用一张正面照片生成：仅口型会动，身体保持静止',
  video: '使用参考视频驱动：保留点头、手势等动作，再对齐解说音频口型（推荐）',
};

export const GREENSCREEN_SELECT_INFO = '该模板为绿幕：叠到 PPT 时会自动抠绿做成透明';

export const GREENSCREEN_ALERT = {
  message: '绿幕模板',
  description: '合成到 PPT 时会抠掉绿色背景，人物做成透明叠在幻灯片上。',
} as const;

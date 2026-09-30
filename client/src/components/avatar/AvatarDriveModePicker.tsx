import React from 'react';
import { Radio, Typography } from 'antd';
import type { AvatarDriveMode } from '../../api';
import { AVATAR_DRIVE_HINT } from '../../constants/avatarDefaults';

const { Paragraph } = Typography;

export interface AvatarDriveModePickerProps {
  value: AvatarDriveMode;
  onChange: (mode: AvatarDriveMode) => void;
  disabled?: boolean;
  /** Button labels: standalone vs project wording */
  labels?: { video: string; photo: string };
  showHint?: boolean;
  style?: React.CSSProperties;
}

const DEFAULT_LABELS = { video: '参考视频驱动', photo: '静照口型' };

export const AvatarDriveModePicker: React.FC<AvatarDriveModePickerProps> = ({
  value,
  onChange,
  disabled,
  labels = DEFAULT_LABELS,
  showHint = true,
  style,
}) => (
  <div style={style}>
    <Radio.Group
      value={value}
      onChange={(e) => onChange(e.target.value as AvatarDriveMode)}
      disabled={disabled}
      optionType="button"
      buttonStyle="solid"
      options={[
        { label: labels.video, value: 'video' },
        { label: labels.photo, value: 'photo' },
      ]}
    />
    {showHint && (
      <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        {AVATAR_DRIVE_HINT[value]}
      </Paragraph>
    )}
  </div>
);

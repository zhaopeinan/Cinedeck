import React from 'react';
import { Alert } from 'antd';
import { GREENSCREEN_ALERT } from '../../constants/avatarDefaults';

export interface GreenscreenAlertProps {
  visible?: boolean;
  style?: React.CSSProperties;
  message?: string;
  /** Pass null to hide description; omit to use default copy. */
  description?: string | null;
}

export const GreenscreenAlert: React.FC<GreenscreenAlertProps> = ({
  visible = true,
  style,
  message = GREENSCREEN_ALERT.message,
  description,
}) => {
  if (!visible) return null;
  const desc = description === null
    ? undefined
    : (description ?? GREENSCREEN_ALERT.description);
  return (
    <Alert
      style={style}
      type="warning"
      showIcon
      message={message}
      description={desc}
    />
  );
};

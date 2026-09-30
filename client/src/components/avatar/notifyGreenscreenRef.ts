import { message } from 'antd';
import { GREENSCREEN_SELECT_INFO } from '../../constants/avatarDefaults';
import type { AvatarRefVideo } from '../../api';

/** Toast when user picks a greenscreen ref template. */
export function notifyGreenscreenRef(item: AvatarRefVideo | null | undefined) {
  if (item?.isGreenscreen) {
    message.info(GREENSCREEN_SELECT_INFO);
  }
}

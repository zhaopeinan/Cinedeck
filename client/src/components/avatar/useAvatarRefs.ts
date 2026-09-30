import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { avatarApi, type AvatarRefVideo } from '../../api';

export function useAvatarRefs(opts?: { autoLoad?: boolean }) {
  const autoLoad = opts?.autoLoad !== false;
  const [refs, setRefs] = useState<AvatarRefVideo[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRefs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await avatarApi.listRefs();
      const list = (res.data.data || []) as AvatarRefVideo[];
      setRefs(list);
      return list;
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '加载参考视频失败');
      return [] as AvatarRefVideo[];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoLoad) void loadRefs();
  }, [autoLoad, loadRefs]);

  return { refs, setRefs, loading, loadRefs };
}

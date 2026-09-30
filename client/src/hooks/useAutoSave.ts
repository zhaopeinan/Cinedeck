import { useEffect, useRef, useState } from 'react';
import { projectApi } from '../api';

interface AutoSaveState {
  status: 'idle' | 'saving' | 'saved' | 'failed';
  lastSavedAt: string | null;
}

export function useAutoSave(projectId: string | undefined, data: Record<string, any>, debounceMs: number = 1000) {
  const [saveState, setSaveState] = useState<AutoSaveState>({ status: 'idle', lastSavedAt: null });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!projectId || !data) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(async () => {
      setSaveState(prev => ({ ...prev, status: 'saving' }));
      try {
        await projectApi.autosave(projectId, data);
        setSaveState({ status: 'saved', lastSavedAt: new Date().toISOString() });
        retryCountRef.current = 0;
      } catch {
        setSaveState({ status: 'failed', lastSavedAt: null });
        retryCountRef.current++;
        // Auto-retry up to 3 times
        if (retryCountRef.current < 3) {
          setTimeout(() => {
            projectApi.autosave(projectId!, data).catch(() => {});
          }, 2000 * retryCountRef.current);
        }
      }
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [projectId, JSON.stringify(data), debounceMs]);

  return saveState;
}

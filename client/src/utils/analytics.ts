// 数据埋点 SDK
interface TrackEvent {
  name: string;
  params: Record<string, any>;
  timestamp: string;
}

class Analytics {
  private queue: TrackEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  track(eventName: string, params: Record<string, any> = {}) {
    const event: TrackEvent = {
      name: eventName,
      params: {
        ...params,
        timestamp: new Date().toISOString(),
        url: window.location.href,
      },
      timestamp: new Date().toISOString(),
    };

    this.queue.push(event);
    console.debug('[Analytics]', event.name, event.params);

    // Batch flush
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 5000);
    }
  }

  private async flush() {
    if (this.queue.length === 0) return;
    const events = [...this.queue];
    this.queue = [];
    this.flushTimer = null;

    try {
      // For now, just log to console. Replace with actual analytics endpoint.
      console.debug('[Analytics] Flush', events.length, 'events');
      // await axios.post('/api/v1/analytics/batch', { events });
    } catch {
      // Re-queue on failure
      this.queue.unshift(...events);
    }
  }
}

export const analytics = new Analytics();

// PRD defined events
export const AnalyticsEvents = {
  PAGE_ENTRY_SHOW: 'ppt_voice_entry_show',
  FILE_SELECT: 'ppt_file_select',
  PARSE_START: 'ppt_parse_start',
  PARSE_SUCCESS: 'ppt_parse_success',
  PARSE_FAIL: 'ppt_parse_fail',
  VOICE_LIST_SHOW: 'voice_list_show',
  VOICE_SAMPLE_PLAY: 'voice_sample_play',
  VOICE_SELECT: 'voice_select',
  VOICE_RECORD_START: 'voice_record_start',
  VOICE_RECORD_QUALITY_FAIL: 'voice_record_quality_fail',
  VOICE_PROFILE_SAVE: 'voice_profile_save',
  VOICE_PROFILE_DELETE: 'voice_profile_delete',
  MODEL_LIST_SHOW: 'model_list_show',
  MODEL_DOWNLOAD_START: 'model_download_start',
  MODEL_DOWNLOAD_SUCCESS: 'model_download_success',
  MODEL_DOWNLOAD_FAIL: 'model_download_fail',
  MODEL_LOAD_FAIL: 'model_load_fail',
  NARRATION_GENERATE_START: 'narration_generate_start',
  NARRATION_GENERATE_SUCCESS: 'narration_generate_success',
  NARRATION_GENERATE_FAIL: 'narration_generate_fail',
  NARRATION_PREVIEW_PLAY: 'narration_preview_play',
  VIDEO_GENERATE_START: 'video_generate_start',
  VIDEO_GENERATE_SUCCESS: 'video_generate_success',
  VIDEO_GENERATE_FAIL: 'video_generate_fail',
  OPENCUT_PROJECT_OPEN: 'opencut_project_open',
  OPENCUT_EDIT_CHANGE: 'opencut_edit_change',
  OPENCUT_EXPORT_START: 'opencut_export_start',
  OPENCUT_EXPORT_SUCCESS: 'opencut_export_success',
  OPENCUT_EXPORT_FAIL: 'opencut_export_fail',
  PROJECT_AUTOSAVE_FAIL: 'project_autosave_fail',
} as const;

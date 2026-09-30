import { ProjectService } from './projectService';
import { VoiceboxAdapter } from './voiceboxAdapter';
import { VideoComposerService } from './videoComposer';
import { SystemSettingsService } from './systemSettingsService';
import {
  appendDubbingLog,
  finishDubbingProgress,
  isDubbingCancelled,
  setActivePage,
  updateDubbingProgress,
} from './dubbingProgress';
import { invalidateSlideMediaCache } from '../utils/mediaCache';
import { ensureVoiceboxRunningForAudio } from './avatarWorker';

/**
 * Build a detailed error log string from a thrown error (typically axios error
 * from Voicebox API). Captures HTTP status, response body, request payload
 * summary, and stack trace — everything needed to diagnose failures.
 */
export function buildDubbingErrorLog(error: any, context: { slidePageIndex: number; voiceId: string; modelId: string; textPreview: string }): string {
  const parts: string[] = [];
  parts.push(`[页面 ${context.slidePageIndex}] 配音生成失败`);
  parts.push(`时间: ${new Date().toISOString()}`);
  parts.push(`音色ID: ${context.voiceId}`);
  parts.push(`模型ID: ${context.modelId}`);
  parts.push(`文本预览(前100字): ${context.textPreview}`);
  parts.push(`错误类型: ${error?.constructor?.name || 'Unknown'}`);
  parts.push(`错误消息: ${error?.message || '无消息'}`);

  // Axios-specific details (HTTP status, response body, request URL)
  if (error?.response) {
    parts.push(`HTTP状态: ${error.response.status} ${error.response.statusText || ''}`);
    let respBody = error.response.data;
    if (typeof respBody === 'object' && respBody !== null) {
      try { respBody = JSON.stringify(respBody); } catch { respBody = String(respBody); }
    }
    parts.push(`接口响应: ${String(respBody).slice(0, 2000)}`);
  } else if (error?.request) {
    parts.push('HTTP状态: 无响应（请求已发出但未收到回复，可能是超时或服务未启动）');
  } else {
    parts.push('HTTP状态: 请求未发出（可能是配置或代码错误）');
  }

  if (error?.code) parts.push(`错误码: ${error.code}`);
  if (error?.config?.url) parts.push(`请求URL: ${error.config.method?.toUpperCase() || 'GET'} ${error.config.url}`);
  if (error?.stack) parts.push(`堆栈:\n${error.stack}`);

  return parts.join('\n');
}

/**
 * Run async tasks with limited concurrency.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

/**
 * Generate dubbing for all slides in the background (with concurrency).
 */
export async function generateAllInBackground(
  projectId: string,
  noteSlides: any[],
  voiceId: string,
  modelId: string,
  voicebox: VoiceboxAdapter,
  projectService: ProjectService,
  videoComposer: VideoComposerService,
  project: any,
  systemSettings: SystemSettingsService,
  concurrency: number,
) {
  const pendingSlides = noteSlides.filter(s => s.dubbing_status !== 'generated');
  console.log(`[Dubbing] Starting background generation for project ${projectId}, ${pendingSlides.length} slides, concurrency=${concurrency}`);
  const timeoutSeconds = systemSettings.getDubbingTimeoutSeconds();
  const maxChunkChars = systemSettings.getDubbingMaxChunkChars();
  const pollIntervalMs = 2000;
  const maxAttempts = Math.ceil((timeoutSeconds * 1000) / pollIntervalMs);

  // Avatar/GPU 步骤可能停掉 Voicebox；配音前先拉起
  appendDubbingLog(projectId, '正在确保 Voicebox 服务可用…', 'info');
  await ensureVoiceboxRunningForAudio();

  let completedCount = 0;
  let failedCount = 0;
  let cancelled = false;

  await runWithConcurrency(pendingSlides, concurrency, async (slide) => {
    if (isDubbingCancelled(projectId) || cancelled) {
      cancelled = true;
      return;
    }

    // page_index is 1-based (see pptParser)
    const pageNo = slide.page_index;
    const charCount = (slide.note_content || '').length;
    setActivePage(projectId, pageNo, true);

    try {
      projectService.updateSlide(projectId, slide.page_index, { dubbing_status: 'generating', dubbing_error: null });
      appendDubbingLog(projectId, `开始第 ${pageNo} 页（约 ${charCount} 字，分块≤${maxChunkChars}）`, 'info');

      const task = await voicebox.generateDubbing({
        text: slide.note_content,
        voiceId,
        modelId,
        language: 'zh-CN',
        maxChunkChars,
        instruct: '语速平稳，吐字清晰，不要越说越快。',
      });

      console.log(`[Dubbing] Slide ${slide.page_index}: generation started (task ${task.id})`);
      appendDubbingLog(projectId, `第 ${pageNo} 页任务已提交（task ${task.id}）`, 'info');

      let completed = false;
      let attempts = 0;
      while (!completed && attempts < maxAttempts) {
        if (isDubbingCancelled(projectId)) {
          cancelled = true;
          appendDubbingLog(projectId, `第 ${pageNo} 页生成过程中被取消`, 'warn');
          completed = true;
          break;
        }

        const checkSlide = projectService.getSlide(projectId, slide.page_index) as any;
        if (checkSlide?.dubbing_status !== 'generating') {
          cancelled = true;
          appendDubbingLog(projectId, `第 ${pageNo} 页状态已变更，停止等待`, 'warn');
          completed = true;
          break;
        }

        let status;
        try {
          status = await voicebox.getTaskStatus(task.id);
        } catch (statErr: any) {
          const errLog = buildDubbingErrorLog(statErr, {
            slidePageIndex: slide.page_index,
            voiceId,
            modelId,
            textPreview: (slide.note_content || '').slice(0, 100),
          });
          projectService.updateSlide(projectId, slide.page_index, {
            dubbing_status: 'failed',
            dubbing_error: `[查询状态失败] ${errLog}`,
          });
          failedCount++;
          updateDubbingProgress(projectId, { failedCount, completedCount });
          appendDubbingLog(projectId, `第 ${pageNo} 页查询状态失败: ${statErr.message}`, 'error');
          completed = true;
          break;
        }

        if (status.status === 'succeeded') {
          try {
            const result = await voicebox.getTaskResult(task.id);
            projectService.updateSlide(projectId, slide.page_index, {
              dubbing_status: 'generated',
              dubbing_audio_path: result.audioPath,
              dubbing_duration: result.duration,
              dubbing_version: (slide.dubbing_version || 0) + 1,
              dubbing_error: null,
            });
            invalidateSlideMediaCache(projectId, slide.page_index);
            completedCount++;
            const dur = result.duration?.toFixed(1) || '?';
            updateDubbingProgress(projectId, { completedCount, failedCount });
            appendDubbingLog(projectId, `第 ${pageNo} 页完成，时长 ${dur}s`, 'success');
            console.log(`[Dubbing] Slide ${slide.page_index}: completed (${dur}s)`);
          } catch (resultErr: any) {
            const errLog = buildDubbingErrorLog(resultErr, {
              slidePageIndex: slide.page_index,
              voiceId,
              modelId,
              textPreview: (slide.note_content || '').slice(0, 100),
            });
            projectService.updateSlide(projectId, slide.page_index, {
              dubbing_status: 'failed',
              dubbing_error: `[获取结果失败] ${errLog}`,
            });
            failedCount++;
            updateDubbingProgress(projectId, { failedCount, completedCount });
            appendDubbingLog(projectId, `第 ${pageNo} 页获取结果失败: ${resultErr.message}`, 'error');
          }
          completed = true;
        } else if (status.status === 'failed') {
          const errLog = buildDubbingErrorLog(new Error(status.error || 'Voicebox 返回 failed 状态'), {
            slidePageIndex: slide.page_index,
            voiceId,
            modelId,
            textPreview: (slide.note_content || '').slice(0, 100),
          });
          projectService.updateSlide(projectId, slide.page_index, {
            dubbing_status: 'failed',
            dubbing_error: errLog,
          });
          failedCount++;
          updateDubbingProgress(projectId, { failedCount, completedCount });
          appendDubbingLog(projectId, `第 ${pageNo} 页失败: ${status.error || 'Voicebox failed'}`, 'error');
          completed = true;
        } else {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          attempts++;
          const waitSeconds = attempts * (pollIntervalMs / 1000);
          if (attempts === 1 || attempts % 5 === 0) {
            appendDubbingLog(projectId, `第 ${pageNo} 页仍在合成中，已等待 ${waitSeconds}s`, 'info');
          }
        }
      }

      if (!completed) {
        try { await voicebox.cancelTask(task.id); } catch { /* ignore */ }
        projectService.updateSlide(projectId, slide.page_index, {
          dubbing_status: 'failed',
          dubbing_error: `[超时] [页面 ${pageNo}] 配音生成超时（等待 ${attempts * pollIntervalMs / 1000} 秒，上限 ${timeoutSeconds} 秒后未完成）。任务ID: ${task.id}。可能原因：Voicebox 服务处理过慢或卡死。可在系统配置中调大超时时间。`,
        });
        failedCount++;
        updateDubbingProgress(projectId, { failedCount, completedCount });
        appendDubbingLog(projectId, `第 ${pageNo} 页超时（>${timeoutSeconds}s）`, 'error');
      }
    } catch (error: any) {
      const errLog = buildDubbingErrorLog(error, {
        slidePageIndex: slide.page_index,
        voiceId,
        modelId,
        textPreview: (slide.note_content || '').slice(0, 100),
      });
      projectService.updateSlide(projectId, slide.page_index, {
        dubbing_status: 'failed',
        dubbing_error: errLog,
      });
      failedCount++;
      updateDubbingProgress(projectId, { failedCount, completedCount });
      appendDubbingLog(projectId, `第 ${pageNo} 页异常: ${error.message}`, 'error');
      console.error(`[Dubbing] Slide ${slide.page_index}: error - ${error.message}`);
    } finally {
      setActivePage(projectId, pageNo, false);
    }
  });

  cancelled = cancelled || isDubbingCancelled(projectId);
  finishDubbingProgress(projectId, { completedCount, failedCount, cancelled });

  const finalSlides = projectService.getSlides(projectId) as any[];
  const noteSlidesFinal = finalSlides.filter(s => s.note_status === 'loaded');
  const allSuccess = noteSlidesFinal.every(s => s.dubbing_status === 'generated');
  if (allSuccess && !cancelled) {
    // 数字人步骤插在配音与预览之间：不再自动合成，由预览页确认布局后手动合成
    appendDubbingLog(projectId, '全部配音完成。请进入「生成数字人」或「视频预览」继续。', 'success');
    console.log(`[Dubbing] All slides generated; auto video composition deferred to preview step.`);
  } else {
    console.log(`[Dubbing] Generation complete, but some slides failed or cancelled. Skipping video composition.`);
  }
}

/**
 * Generate dubbing for a single slide in the background.
 */
export async function generateSingleInBackground(
  projectId: string,
  pageIndex: number,
  slide: any,
  voiceId: string,
  modelId: string,
  voicebox: VoiceboxAdapter,
  projectService: ProjectService,
  systemSettings: SystemSettingsService,
) {
  console.log(`[Dubbing] Starting single page generation: slide ${pageIndex}`);
  const timeoutSeconds = systemSettings.getDubbingTimeoutSeconds();
  const maxChunkChars = systemSettings.getDubbingMaxChunkChars();
  const pollIntervalMs = 2000;
  const maxAttempts = Math.ceil((timeoutSeconds * 1000) / pollIntervalMs);
  const pageNo = pageIndex;
  const charCount = (slide.note_content || '').length;

  try {
    updateDubbingProgress(projectId, {
      status: 'running',
      currentPageIndex: pageIndex,
      activePages: [pageIndex],
      stage: 'submitting',
      message: `正在确保 Voicebox 可用并提交第 ${pageNo} 页（约 ${charCount} 字）`,
      completedCount: 0,
      failedCount: 0,
      totalToGenerate: 1,
    });
    appendDubbingLog(projectId, `第 ${pageNo} 页：正在确保 Voicebox 服务可用…`, 'info');
    await ensureVoiceboxRunningForAudio();

    updateDubbingProgress(projectId, {
      stage: 'submitting',
      message: `正在提交第 ${pageNo} 页到 Voicebox（约 ${charCount} 字，分块≤${maxChunkChars}）`,
    });

    const task = await voicebox.generateDubbing({
      text: slide.note_content,
      voiceId,
      modelId,
      language: 'zh-CN',
      maxChunkChars,
      instruct: '语速平稳，吐字清晰，不要越说越快。',
    });
    appendDubbingLog(projectId, `第 ${pageNo} 页任务已提交（task ${task.id}）`, 'info');
    updateDubbingProgress(projectId, {
      stage: 'waiting_voicebox',
      message: `第 ${pageNo} 页已提交，等待 Voicebox 合成`,
      taskId: task.id,
      waitSeconds: 0,
    });

    let completed = false;
    let attempts = 0;
    while (!completed && attempts < maxAttempts) {
      if (isDubbingCancelled(projectId)) {
        appendDubbingLog(projectId, `第 ${pageNo} 页生成过程中被取消`, 'warn');
        finishDubbingProgress(projectId, { completedCount: 0, failedCount: 0, cancelled: true });
        return;
      }

      let status;
      try {
        status = await voicebox.getTaskStatus(task.id);
      } catch (statErr: any) {
        const errLog = buildDubbingErrorLog(statErr, {
          slidePageIndex: pageIndex,
          voiceId,
          modelId,
          textPreview: (slide.note_content || '').slice(0, 100),
        });
        projectService.updateSlide(projectId, pageIndex, {
          dubbing_status: 'failed',
          dubbing_error: `[查询状态失败] ${errLog}`,
        });
        appendDubbingLog(projectId, `第 ${pageNo} 页查询状态失败: ${statErr.message}`, 'error');
        console.error(`[Dubbing] Slide ${pageIndex}: status query failed - ${statErr.message}`);
        finishDubbingProgress(projectId, { completedCount: 0, failedCount: 1 });
        completed = true;
        break;
      }

      if (status.status === 'succeeded') {
        try {
          const result = await voicebox.getTaskResult(task.id);
          projectService.updateSlide(projectId, pageIndex, {
            dubbing_status: 'generated',
            dubbing_audio_path: result.audioPath,
            dubbing_duration: result.duration,
            dubbing_version: (slide.dubbing_version || 0) + 1,
            dubbing_error: null,
          });
          invalidateSlideMediaCache(projectId, pageIndex);
          const dur = result.duration?.toFixed(1) || '?';
          appendDubbingLog(projectId, `第 ${pageNo} 页完成，时长 ${dur}s`, 'success');
          console.log(`[Dubbing] Slide ${pageIndex}: completed`);
          finishDubbingProgress(projectId, { completedCount: 1, failedCount: 0 });
        } catch (resultErr: any) {
          const errLog = buildDubbingErrorLog(resultErr, {
            slidePageIndex: pageIndex,
            voiceId,
            modelId,
            textPreview: (slide.note_content || '').slice(0, 100),
          });
          projectService.updateSlide(projectId, pageIndex, {
            dubbing_status: 'failed',
            dubbing_error: `[获取结果失败] ${errLog}`,
          });
          appendDubbingLog(projectId, `第 ${pageNo} 页获取结果失败: ${resultErr.message}`, 'error');
          console.error(`[Dubbing] Slide ${pageIndex}: get result failed - ${resultErr.message}`);
          finishDubbingProgress(projectId, { completedCount: 0, failedCount: 1 });
        }
        completed = true;
      } else if (status.status === 'failed') {
        const errLog = buildDubbingErrorLog(new Error(status.error || 'Voicebox 返回 failed 状态'), {
          slidePageIndex: pageIndex,
          voiceId,
          modelId,
          textPreview: (slide.note_content || '').slice(0, 100),
        });
        projectService.updateSlide(projectId, pageIndex, {
          dubbing_status: 'failed',
          dubbing_error: errLog,
        });
        appendDubbingLog(projectId, `第 ${pageNo} 页失败: ${status.error || 'Voicebox failed'}`, 'error');
        console.warn(`[Dubbing] Slide ${pageIndex}: failed - ${status.error}`);
        finishDubbingProgress(projectId, { completedCount: 0, failedCount: 1 });
        completed = true;
      } else {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        attempts++;
        const waitSeconds = attempts * (pollIntervalMs / 1000);
        updateDubbingProgress(projectId, {
          stage: 'waiting_voicebox',
          message: `第 ${pageNo} 页合成中，已等待 ${waitSeconds}s`,
          waitSeconds,
          taskId: task.id,
        });
        if (attempts === 1 || attempts % 5 === 0) {
          appendDubbingLog(projectId, `第 ${pageNo} 页仍在合成中，已等待 ${waitSeconds}s`, 'info');
        }
      }
    }

    if (!completed) {
      try { await voicebox.cancelTask(task.id); } catch { /* ignore */ }
      projectService.updateSlide(projectId, pageIndex, {
        dubbing_status: 'failed',
        dubbing_error: `[超时] [页面 ${pageIndex}] 配音生成超时（等待 ${attempts * pollIntervalMs / 1000} 秒，上限 ${timeoutSeconds} 秒后未完成）。任务ID: ${task.id}。可能原因：Voicebox 服务处理过慢或卡死。可在系统配置中调大超时时间。`,
      });
      appendDubbingLog(projectId, `第 ${pageNo} 页超时（>${timeoutSeconds}s）`, 'error');
      finishDubbingProgress(projectId, { completedCount: 0, failedCount: 1 });
    }
  } catch (error: any) {
    const errLog = buildDubbingErrorLog(error, {
      slidePageIndex: pageIndex,
      voiceId,
      modelId,
      textPreview: (slide.note_content || '').slice(0, 100),
    });
    projectService.updateSlide(projectId, pageIndex, {
      dubbing_status: 'failed',
      dubbing_error: errLog,
    });
    appendDubbingLog(projectId, `第 ${pageNo} 页异常: ${error.message}`, 'error');
    console.error(`[Dubbing] Slide ${pageIndex}: error - ${error.message}`);
    finishDubbingProgress(projectId, { completedCount: 0, failedCount: 1 });
  }
}

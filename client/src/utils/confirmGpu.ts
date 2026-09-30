import { Modal } from 'antd';
import { systemApi, type GpuStatusSnapshot } from '../api';

type GpuSnapWithQueue = GpuStatusSnapshot & {
  voiceboxQueue?: {
    active: string | null;
    waitingCount?: number;
    ttsHolds?: Array<{ id: string }>;
  };
};

/** Warn when GPU VRAM / Voicebox queue is already busy before Whisper/TTS work. */
export async function confirmGpuIfBusy(actionLabel: string): Promise<boolean> {
  try {
    const res = await systemApi.getGpu();
    const snap = res.data.data as GpuSnapWithQueue | undefined;
    const gpu = snap?.gpus?.[0];
    if (!gpu || !gpu.memoryTotalMb || gpu.memoryTotalMb <= 0) return true;

    const used = gpu.memoryUsedMb || 0;
    const ratio = used / gpu.memoryTotalMb;
    const q = snap?.voiceboxQueue;
    const queueBusy = !!(q?.active || (q?.waitingCount ?? 0) > 0 || (q?.ttsHolds?.length ?? 0) > 0);
    if (ratio < 0.82 && !queueBusy) return true;

    const pct = Math.round(ratio * 100);
    const queueHint = q?.active
      ? `\n当前 Voicebox：${q.active}`
      : queueBusy
        ? '\nVoicebox 队列中仍有任务'
        : '';

    return await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: 'GPU 占用较高',
        content: `当前显存约 ${Math.round(used)}/${Math.round(gpu.memoryTotalMb)} MB（${pct}%）。${queueHint}\n\n此时开始「${actionLabel}」可能变慢或因显存不足失败。是否继续？`,
        okText: '继续',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  } catch {
    return true;
  }
}

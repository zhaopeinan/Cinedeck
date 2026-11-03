/** Resolve getUserMedia in a way that fails with a clear reason, not a TypeError. */
export function getMicrophoneUnsupportedReason(): string | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return '当前环境不支持麦克风录音';
  }
  if (!window.isSecureContext) {
    const host = window.location.hostname || '当前地址';
    return `浏览器仅允许在安全上下文使用麦克风（HTTPS 或 localhost）。当前为 http://${host}，请改用 https://${host}/ 或 http://localhost:5173 后再试`;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return '当前浏览器不支持麦克风录音，请换用较新的 Chrome / Edge / Safari';
  }
  return null;
}

export async function requestMicrophoneStream(
  constraints: MediaStreamConstraints = { audio: true },
): Promise<MediaStream> {
  const reason = getMicrophoneUnsupportedReason();
  if (reason) {
    throw new Error(reason);
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

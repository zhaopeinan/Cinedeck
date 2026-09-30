/**
 * Whisper emits Traditional Chinese by default. Convert to Simplified for this product.
 */
import * as OpenCC from 'opencc-js';

const converter = OpenCC.Converter({ from: 'tw', to: 'cn' });

export function shouldSimplifyTranscript(language: string | null | undefined): boolean {
  const lang = String(language || 'auto').toLowerCase();
  if (lang === 'en' || lang === 'ja' || lang === 'ko') return false;
  return true;
}

export function toSimplifiedChinese(text: string): string {
  const raw = String(text || '');
  if (!raw || !/[\u4e00-\u9fff]/.test(raw)) return raw;
  try {
    return converter(raw);
  } catch {
    return raw;
  }
}

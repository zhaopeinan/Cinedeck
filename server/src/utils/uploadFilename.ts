/**
 * Browsers send UTF-8 filenames; Multer/Busboy often treat them as latin1.
 * Restore Chinese (and other) names when this mojibake pattern is detected.
 */
export function decodeUploadFilename(name: string): string {
  const raw = String(name || '').trim();
  if (!raw) return 'upload';
  if (/[\u4e00-\u9fff]/.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (!decoded || decoded.includes('\uFFFD')) return raw;
    const looksMojibake = /[åæçéøÅÆÇÃÂ]/.test(raw);
    const decodedHasCjk = /[\u4e00-\u9fff]/.test(decoded);
    if (decodedHasCjk || (looksMojibake && decoded !== raw)) return decoded;
    return raw;
  } catch {
    return raw;
  }
}

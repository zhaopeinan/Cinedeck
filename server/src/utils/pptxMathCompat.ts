import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/fix_pptx_omml.py');

/**
 * LibreOffice cannot render Office OMML (a14) equations in PPTX.
 * Use PowerPoint fallback bitmaps or rasterize OMML before export.
 */
export function preparePptxEquationsForExport(filePath: string): boolean {
  if (!filePath || !fs.existsSync(filePath)) return false;
  if (!fs.existsSync(SCRIPT_PATH)) {
    console.warn('[PPTX] fix_pptx_omml.py missing, skip equation prep');
    return false;
  }
  try {
    const out = execFileSync('python3', [SCRIPT_PATH, filePath], {
      timeout: 120000,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
    if (out.startsWith('FIXED:')) {
      console.log(`[PPTX] Equation compat: ${out} (${path.basename(filePath)})`);
      return true;
    }
    if (out.startsWith('ERROR:')) {
      console.warn(`[PPTX] Equation compat failed: ${out}`);
    }
    return false;
  } catch (err: any) {
    const msg = (err?.stderr || err?.message || String(err)).toString().slice(0, 300);
    console.warn(`[PPTX] Equation compat error: ${msg}`);
    return false;
  }
}

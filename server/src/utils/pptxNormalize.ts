import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * Some Windows / WPS PPTX files store ZIP entry names with backslashes
 * (`ppt\\slides\\slide1.xml`). LibreOffice and python-pptx require forward
 * slashes. Rewrite the archive in-place when needed.
 *
 * @returns true if the file was rewritten
 */
export function normalizePptxZipPaths(filePath: string): boolean {
  if (!filePath || !fs.existsSync(filePath)) return false;

  // Use Python zipfile — Node may not have a zip dependency in this project.
  const script = `
import zipfile, os, sys, tempfile, shutil
src = sys.argv[1]
needs = False
with zipfile.ZipFile(src, 'r') as zin:
    for name in zin.namelist():
        if '\\\\' in name or (chr(92) in name):
            needs = True
            break
if not needs:
    print('SKIP')
    sys.exit(0)
fd, tmp = tempfile.mkstemp(suffix='.pptx')
os.close(fd)
try:
    with zipfile.ZipFile(src, 'r') as zin, zipfile.ZipFile(tmp, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            new_name = info.filename.replace(chr(92), '/')
            ni = zipfile.ZipInfo(filename=new_name, date_time=info.date_time)
            ni.compress_type = zipfile.ZIP_DEFLATED
            ni.external_attr = info.external_attr
            zout.writestr(ni, data)
    shutil.move(tmp, src)
    print('FIXED')
except Exception as e:
    try: os.unlink(tmp)
    except Exception: pass
    print('ERROR:' + str(e))
    sys.exit(1)
`;
  try {
    const out = execFileSync('python3', ['-c', script, filePath], {
      timeout: 60000,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
    }).trim();
    if (out.includes('FIXED')) {
      console.log(`[PPTX] Normalized ZIP path separators: ${path.basename(filePath)}`);
      return true;
    }
    return false;
  } catch (err: any) {
    console.warn(`[PPTX] normalizePptxZipPaths failed: ${err?.message || err}`);
    return false;
  }
}

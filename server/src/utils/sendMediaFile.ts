import fs from 'fs';
import { Request, Response } from 'express';

/**
 * Stream a local media file with Content-Length + HTTP Range (bytes).
 * Fixes slow full-file downloads and HTML5 video progressive playback.
 */
export function sendMediaFile(
  req: Request,
  res: Response,
  filePath: string,
  opts: { contentType: string; fileName: string; disposition?: 'inline' | 'attachment' },
): void {
  if (!fs.existsSync(filePath)) {
    res.status(404).json({
      success: false,
      data: null,
      error: { code: '404', message: '文件不存在' },
    });
    return;
  }

  const stat = fs.statSync(filePath);
  const size = stat.size;
  const disposition = opts.disposition || 'inline';
  const asciiName = opts.fileName.replace(/[^\x20-\x7E]+/g, '_') || 'media.bin';

  res.setHeader('Content-Type', opts.contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`,
  );
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    end = Math.min(end, size - 1);
    const chunk = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(chunk));
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(size));
  fs.createReadStream(filePath).pipe(res);
}

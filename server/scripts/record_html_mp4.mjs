#!/usr/bin/env node
/**
 * Record a self-contained HTML animation to MP4 (frames → ffmpeg).
 * Intended to run inside ppt-audio-hyperframes (Chromium + puppeteer-core + ffmpeg).
 *
 * Usage:
 *   node record_html_mp4.mjs --html /work/index.html --out /work/export.mp4 \
 *     --width 1920 --height 1080 --fps 24 --seconds 20 [--audio /work/narration.wav]
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (${code}): ${stderr.slice(-800)}`));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const htmlPath = path.resolve(arg('html', '/work/index.html'));
  const outPath = path.resolve(arg('out', '/work/export.mp4'));
  const audioPath = arg('audio');
  const width = Math.max(640, Number(arg('width', '1920')) || 1920);
  const height = Math.max(360, Number(arg('height', '1080')) || 1080);
  // 24fps is enough for explainer motion; fewer frames = much faster capture
  const fps = Math.max(12, Math.min(60, Number(arg('fps', '24')) || 24));
  const seconds = Math.max(3, Math.min(300, Number(arg('seconds', '20')) || 20));

  if (!fs.existsSync(htmlPath)) throw new Error(`HTML not found: ${htmlPath}`);

  let puppeteer;
  const candidates = [
    '/usr/local/lib/node_modules/hyperframes/node_modules/puppeteer-core',
    'puppeteer-core',
    'puppeteer',
  ];
  for (const c of candidates) {
    try {
      puppeteer = require(c);
      break;
    } catch { /* next */ }
  }
  if (!puppeteer) throw new Error('puppeteer-core not found');

  const frameDir = path.join(path.dirname(outPath), `_frames_${Date.now()}`);
  fs.mkdirSync(frameDir, { recursive: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu',
      `--window-size=${width},${height}`,
    ],
    defaultViewport: { width, height, deviceScaleFactor: 1 },
  });

  const total = Math.ceil(seconds * fps);
  const interval = 1000 / fps;
  let captured = 0;

  try {
    const page = await browser.newPage();
    // Prefer setContent over file:// goto: avoids networkidle hangs on huge
    // data: URIs / lingering timers, and is more reliable offline.
    const html = fs.readFileSync(htmlPath, 'utf-8');
    const baseHref = pathToFileURL(path.dirname(htmlPath) + path.sep).href;
    const withBase = /<base\s/i.test(html)
      ? html
      : html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
    await page.setContent(withBase, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    // Give rAF / fonts a brief settle; do not wait for networkidle
    await sleep(800);
    // Try to start page animation (audio is muxed by ffmpeg separately)
    await page.evaluate(() => {
      const a = document.getElementById('explain-narration');
      if (a) {
        try { a.remove(); } catch { /* ignore */ }
      }
      const candidates = [
        '[data-play]', '.play', '#btn-play', 'button.play',
        'button[aria-label*="播放"]', 'button[title*="播放"]',
        'button',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
        if (sel === 'button' && !/播放|play|▶|start/i.test(label)) continue;
        el.click();
        break;
      }
    }).catch(() => {});

    const t0 = Date.now();
    for (let i = 0; i < total; i++) {
      const target = t0 + i * interval;
      const wait = target - Date.now();
      if (wait > 0) await sleep(wait);
      const file = path.join(frameDir, `f${String(i).padStart(6, '0')}.jpg`);
      // JPEG is much faster to encode/write than PNG at 1080p
      await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
      captured = i + 1;
      if (i % Math.max(1, Math.floor(fps)) === 0 || i === total - 1) {
        process.stdout.write(`frame ${captured}/${total}\n`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (captured < total) {
    throw new Error(`screenshot incomplete: ${captured}/${total}`);
  }

  const pattern = path.join(frameDir, 'f%06d.jpg');
  const ffArgs = [
    '-y',
    '-framerate', String(fps),
    '-i', pattern,
  ];
  if (audioPath && fs.existsSync(audioPath)) {
    ffArgs.push('-i', audioPath, '-c:a', 'aac', '-b:a', '192k', '-shortest');
  } else {
    ffArgs.push('-an');
  }
  ffArgs.push(
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
    '-crf', '20',
    '-movflags', '+faststart',
    outPath,
  );
  process.stdout.write(`ffmpeg encoding ${captured} frames…\n`);
  await run('ffmpeg', ffArgs);

  // cleanup frames
  try {
    for (const f of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, f));
    fs.rmdirSync(frameDir);
  } catch { /* ignore */ }

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
    throw new Error('export mp4 missing or too small');
  }
  process.stdout.write(`OK ${outPath} ${fs.statSync(outPath).size}\n`);
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});

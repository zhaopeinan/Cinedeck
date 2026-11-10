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

/**
 * Force animation timeline to `timeSec`. Prefer __explainRec bridge; fall back to scrubber.
 * Must NOT click play toggles — many explain HTMLs start with playing=true and click pauses them.
 */
async function seekTo(page, timeSec, fallbackTotal) {
  await page.evaluate((sec, fallback) => {
    const rec = window.__explainRec;
    if (rec && typeof rec.seek === 'function') {
      try { rec.pause && rec.pause(); } catch (e) { /* ignore */ }
      rec.seek(sec);
      return;
    }
    // Fallback: scrub the progress track (common explain player pattern)
    const track = document.getElementById('track');
    const timeEl = document.getElementById('time');
    let total = fallback;
    if (timeEl && timeEl.textContent) {
      const m = String(timeEl.textContent).match(/\/\s*(\d+):(\d+)/);
      if (m) total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }
    if (!track || !(total > 0)) return;
    const ratio = Math.max(0, Math.min(1, sec / total));
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const x = rect.left + ratio * rect.width;
    const y = rect.top + rect.height / 2;
    track.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
  }, timeSec, fallbackTotal);

  // Let one paint happen at the seeked time
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function main() {
  const htmlPath = path.resolve(arg('html', '/work/index.html'));
  const outPath = path.resolve(arg('out', '/work/export.mp4'));
  const audioPath = arg('audio');
  const width = Math.max(640, Number(arg('width', '1920')) || 1920);
  const height = Math.max(360, Number(arg('height', '1080')) || 1080);
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
  let captured = 0;
  let animTotal = seconds;

  try {
    const page = await browser.newPage();
    const html = fs.readFileSync(htmlPath, 'utf-8');
    const baseHref = pathToFileURL(path.dirname(htmlPath) + path.sep).href;
    const withBase = /<base\s/i.test(html)
      ? html
      : html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
    await page.setContent(withBase, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await sleep(600);

    // Discover animation length; pause clock — we drive time per frame.
    animTotal = await page.evaluate((fallback) => {
      try {
        if (window.__explainRec && typeof window.__explainRec.total === 'function') {
          const n = Number(window.__explainRec.total());
          if (n > 1) return n;
        }
      } catch (e) { /* ignore */ }
      const timeEl = document.getElementById('time');
      if (timeEl && timeEl.textContent) {
        const m = String(timeEl.textContent).match(/\/\s*(\d+):(\d+)/);
        if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      }
      return fallback;
    }, seconds);
    if (!(animTotal > 1)) animTotal = seconds;

    await page.evaluate(() => {
      try { window.__explainRec && window.__explainRec.pause && window.__explainRec.pause(); } catch (e) { /* ignore */ }
      // Remove hidden narration audio if any remnant
      const a = document.getElementById('explain-narration');
      if (a) try { a.remove(); } catch (e) { /* ignore */ }
    });

    process.stdout.write(`record seek-mode animTotal=${animTotal}s frames=${total} fps=${fps}\n`);

    // Preflight motion QC: seek start/mid/end and compare via ffmpeg PSNR.
    // JPEG byte-diff is unreliable; frozen decks still look "different" at byte level.
    {
      const shotPath = async (sec, name) => {
        await seekTo(page, sec, animTotal);
        const file = path.join(frameDir, `_pre_${name}.png`);
        await page.screenshot({ path: file, type: 'png' });
        return file;
      };
      const p0 = await shotPath(Math.min(0.35, animTotal * 0.02), 't0');
      const pMid = await shotPath(animTotal * 0.45, 'mid');
      const pEnd = await shotPath(Math.max(0.5, animTotal * 0.88), 'end');
      const psnrOf = (a, b) => new Promise((resolve) => {
        const child = spawn('ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', () => {
          const m = stderr.match(/average:([inf\d.]+)/i);
          if (!m) return resolve(0);
          if (/^inf$/i.test(m[1])) return resolve(99);
          const n = Number(m[1]);
          resolve(Number.isFinite(n) ? n : 0);
        });
      });
      const mid = await psnrOf(p0, pMid);
      const end = await psnrOf(p0, pEnd);
      process.stdout.write(`motion preflight psnr mid=${mid.toFixed(1)}dB end=${end.toFixed(1)}dB\n`);

      // DOM occupancy: starfield/background can change enough to pass PSNR while
      // content nodes stay opacity=0 because seek missed currentTime/updateElements.
      await seekTo(page, animTotal * 0.45, animTotal);
      const midProbe = await page.evaluate(() => {
        const skip = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'HTML', 'BR']);
        const effectiveOpacity = (el) => {
          let o = 1;
          let cur = el;
          while (cur && cur !== document.documentElement) {
            const st = window.getComputedStyle(cur);
            if (st.display === 'none' || st.visibility === 'hidden') return 0;
            const op = parseFloat(st.opacity || '1');
            if (Number.isFinite(op)) o *= op;
            if (o <= 0.18) return o;
            cur = cur.parentElement;
          }
          return o;
        };
        let n = 0;
        let centerTextBlocks = 0;
        const titleHits = [];
        for (const el of document.body.querySelectorAll('*')) {
          if (skip.has(el.tagName)) continue;
          if (el.id === 'player' || el.closest?.('#player')) continue;
          const op = effectiveOpacity(el);
          if (!(op > 0.18)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 36 || r.height < 18) continue;
          // Prefer mid-canvas content; ignore tiny corner chrome
          if (r.top < 8 && r.left < 8 && r.width < 420 && r.height < 120) continue;
          n += 1;
          // Only leaf-ish text nodes: avoid counting parent wrappers that include child text.
          const ownText = String(el.childNodes && [...el.childNodes]
            .filter((c) => c.nodeType === 3)
            .map((c) => c.textContent || '')
            .join('') || '').replace(/\s+/g, '');
          if ([...ownText].length >= 2
            && r.top > window.innerHeight * 0.12
            && r.bottom < window.innerHeight * 0.72
            && r.width >= 60) {
            centerTextBlocks += 1;
            const fs = parseFloat(getComputedStyle(el).fontSize || '0') || 0;
            if (op > 0.45 && fs >= 28 && r.height >= 30) {
              titleHits.push({
                id: el.id || el.className || el.tagName,
                op: Math.round(op * 100) / 100,
                y: Math.round(r.top),
                h: Math.round(r.height),
                text: ownText.slice(0, 16),
              });
            }
          }
        }
        // Intro title that should have faded by mid — stuck exports keep it fully visible.
        const big = document.getElementById('bigTitle');
        const bigOp = big ? effectiveOpacity(big) : 0;
        // Overlapping large-font title leaves in the same vertical band ⇒ stacked text.
        let stackedPairs = 0;
        for (let i = 0; i < titleHits.length; i++) {
          for (let j = i + 1; j < titleHits.length; j++) {
            const a = titleHits[i];
            const b = titleHits[j];
            if (Math.abs(a.y - b.y) < Math.max(a.h, b.h) * 0.7) stackedPairs += 1;
          }
        }
        return { visible: n, bigTitleOp: bigOp, centerTextBlocks, stackedPairs, titleHits: titleHits.slice(0, 8) };
      });
      process.stdout.write(
        `motion preflight visibleNodes@mid=${midProbe.visible} bigTitleOp=${midProbe.bigTitleOp.toFixed(2)}`
        + ` stackedPairs=${midProbe.stackedPairs} centerText=${midProbe.centerTextBlocks}\n`,
      );

      for (const f of [p0, pMid, pEnd]) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
      // Canvas backgrounds are common, but many decks still drive titles/cards via DOM.
      // Never skip bigTitle / DOM occupancy checks just because a <canvas> exists —
      // that previously let stacked intro titles pass when PSNR still moved (starfield).
      const hasCanvas = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        if (!c) return false;
        const r = c.getBoundingClientRect();
        return r.width >= 320 && r.height >= 180;
      });
      // Full-frame PSNR is dominated by static dark backgrounds; local text/card motion
      // often lands at 40–48dB even when seek works. Treat PSNR as soft evidence and
      // require corroborating DOM freeze signals before failing.
      const psnrLooksStill = mid >= 28 && end >= 28;
      const psnrNearIdentical = mid >= 50 && end >= 50;
      const psnrShowsMotion = mid < 28 || end < 28;
      // Header/page chrome alone is not enough: scroll-decks with a hidden #track
      // still show kicker/title/PAGE while the body is blank cream.
      const domSaysSeekOk = midProbe.visible >= 3
        && midProbe.bigTitleOp <= 0.35
        && midProbe.stackedPairs < 2
        && midProbe.centerTextBlocks >= 1;
      if (psnrLooksStill && !domSaysSeekOk) {
        throw new Error(
          `讲解动画画面几乎无变化（PSNR mid=${mid.toFixed(1)}dB, end=${end.toFixed(1)}dB`
          + `, visibleNodes=${midProbe.visible}, centerText=${midProbe.centerTextBlocks}`
          + `, bigTitleOp=${midProbe.bigTitleOp.toFixed(2)}`
          + `, stackedPairs=${midProbe.stackedPairs}）：疑似 seek 失效、正文未绘出或卡在初始叠字帧`,
        );
      }
      if (psnrNearIdentical && midProbe.visible < 3) {
        throw new Error(
          `讲解动画画面近乎静止（PSNR mid=${mid.toFixed(1)}dB, end=${end.toFixed(1)}dB）且中段几乎无 DOM 内容：疑似 seek 失效`,
        );
      }
      if (psnrLooksStill && midProbe.centerTextBlocks < 1) {
        throw new Error(
          `讲解动画中段正文区无文字（centerText=0, PSNR mid=${mid.toFixed(1)}dB）：疑似内容轨道被隐藏或未渲染`,
        );
      }
      if (psnrLooksStill && domSaysSeekOk) {
        process.stdout.write(
          `motion preflight soft-pass: high PSNR but DOM seek ok`
          + ` (visible=${midProbe.visible}, centerText=${midProbe.centerTextBlocks}`
          + `, bigTitleOp=${midProbe.bigTitleOp.toFixed(2)})\n`,
        );
      }
      // Pure-canvas decks (no mid DOM) may have visibleNodes≈0; allow only if PSNR moved.
      if (midProbe.visible < 3 && !(hasCanvas && psnrShowsMotion && midProbe.bigTitleOp < 0.05)) {
        throw new Error(
          `讲解动画中段可见内容过少（visibleNodes=${midProbe.visible}）：疑似 seek 未驱动 currentTime/updateElements，导出将是空白片`,
        );
      }
      // Intro #bigTitle must be gone by mid — otherwise export shows stacked titles.
      if (midProbe.bigTitleOp > 0.35) {
        throw new Error(
          `讲解动画中段仍停在片头大标题（bigTitleOp=${midProbe.bigTitleOp.toFixed(2)}）：疑似 seek 未调用 render，导出将叠字`,
        );
      }
      if (midProbe.stackedPairs >= 2) {
        throw new Error(
          `讲解动画中段检测到叠字（stackedPairs=${midProbe.stackedPairs}）：同一区域多个高不透明标题块同时可见`,
        );
      }
    }

    for (let i = 0; i < total; i++) {
      // Wall-clock follows the export/audio length; clamp seek into [0, animTotal).
      // Stretching the whole animation across a longer narration (old behavior) makes
      // speech and on-screen cues drift, which users report as 音轨错乱.
      const wallSec = (i / Math.max(1, total - 1)) * seconds;
      const timeSec = Math.min(animTotal - 0.001, wallSec);
      await seekTo(page, timeSec, animTotal);
      const file = path.join(frameDir, `f${String(i).padStart(6, '0')}.jpg`);
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

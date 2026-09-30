/**
 * HyperFrames lecture composition — cinematic classroom style.
 * Intro/outro + split layout (Ken Burns slide + script panel) + rotating transitions.
 */
import fs from 'fs';
import path from 'path';
import type { HfPageScript } from './hyperframeJobService';

const W = 1920;
const H = 1080;
const TRANSITION_SEC = 0.85;
const INTRO_SEC = 3.2;
const OUTRO_SEC = 2.8;

type TransitionKind = 'crossfade' | 'push' | 'blur' | 'cover';

export function writeHyperframeComposition(opts: {
  outDir: string;
  title: string;
  pages: Array<{
    pageIndex: number;
    imageRel: string;
    audioRel: string | null;
    lecture: string;
    durationSec: number;
  }>;
}): string {
  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.mkdirSync(path.join(opts.outDir, 'assets'), { recursive: true });

  const gsapRel = 'assets/gsap.min.js';
  fs.copyFileSync(resolveGsapAsset(), path.join(opts.outDir, gsapRel));

  if (!opts.pages.length) throw new Error('没有可写入的页面');

  const pageCount = opts.pages.length;
  const holds = opts.pages.map((p) => Math.max(3.2, Number(p.durationSec) || 4));

  const pageStarts: number[] = [];
  let cursor = INTRO_SEC;
  for (let i = 0; i < holds.length; i++) {
    pageStarts.push(cursor);
    cursor += holds[i];
  }
  for (let i = 1; i < pageStarts.length; i++) {
    pageStarts[i] = pageStarts[i - 1] + holds[i - 1] - TRANSITION_SEC;
  }

  const lastPageEnd = pageStarts[pageStarts.length - 1] + holds[holds.length - 1];
  const outroStart = lastPageEnd - 0.2;
  const total = outroStart + OUTRO_SEC;

  const sceneCss: string[] = [];
  const sceneHtml: string[] = [];
  const audioHtml: string[] = [];
  const tweens: string[] = [];

  // ── Intro ──
  sceneCss.push(`
    #sceneIntro {
      z-index: 1;
      background: radial-gradient(ellipse at 28% 18%, #1e3a5f 0%, #0b1220 55%, #05080f 100%);
    }`);
  sceneHtml.push(`
    <div id="sceneIntro" class="scene">
      <div class="deco-orb orb-a"></div>
      <div class="deco-orb orb-b"></div>
      <div class="intro-wrap">
        <div id="introBadge" class="intro-badge">HYPERFRAME 讲授动画</div>
        <div id="introTitle" class="intro-title">${escapeHtml(opts.title)}</div>
        <div id="introSub" class="intro-sub">共 ${pageCount} 页精选讲解 · 自动配音与电影级转场</div>
        <div id="introBar" class="intro-bar"></div>
      </div>
      <div class="vignette"></div>
      <div class="film-grain"></div>
    </div>`);
  tweens.push(`
    tl.from("#introBadge", { y: 24, opacity: 0, duration: 0.5, ease: "power3.out" }, 0.15);
    tl.from("#introTitle", { y: 52, opacity: 0, duration: 0.85, ease: "expo.out" }, 0.3);
    tl.from("#introSub", { y: 20, opacity: 0, duration: 0.5, ease: "power2.out" }, 0.55);
    tl.fromTo("#introBar", { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: "power3.inOut", transformOrigin: "left center" }, 0.72);
    tl.to(".orb-a", { x: 70, y: -36, duration: ${INTRO_SEC}, ease: "sine.inOut" }, 0);
    tl.to(".orb-b", { x: -50, y: 46, duration: ${INTRO_SEC}, ease: "sine.inOut" }, 0);
  `);
  tweens.push(buildTransition('crossfade', 'sceneIntro', 'scene1', INTRO_SEC - TRANSITION_SEC, 1));

  // ── Content pages ──
  for (let i = 0; i < opts.pages.length; i++) {
    const p = opts.pages[i];
    const start = pageStarts[i];
    const hold = holds[i];
    const sid = `scene${i + 1}`;
    const z = i + 2;
    const lines = splitLectureLines(p.lecture, 4);
    const headline = lines[0] || `第 ${p.pageIndex} 页`;
    const bodyLines = lines.length > 1 ? lines.slice(1) : lines;
    const kind = pickTransition(i);
    const ambient = i % 4;

    sceneCss.push(`
      #${sid} {
        z-index: ${z};
        background: #070b14;
        opacity: 0;
      }`);

    const bulletHtml = bodyLines
      .map(
        (line, li) =>
          `<div id="${sid}_line${li}" class="script-line"><span class="line-dot"></span><span class="line-text">${escapeHtml(line)}</span></div>`,
      )
      .join('\n');

    sceneHtml.push(`
      <div id="${sid}" class="scene">
        <div class="layout">
          <div class="slide-pane">
            <div id="${sid}_kb" class="kb-wrap">
              <img class="slide-img" src="${p.imageRel}" alt="第 ${p.pageIndex} 页" />
            </div>
            <div class="slide-shine"></div>
            <div class="slide-frame"></div>
            <div id="${sid}_pageBadge" class="page-badge">第 ${p.pageIndex} 页 · ${i + 1}/${pageCount}</div>
          </div>
          <div class="script-pane">
            <div class="script-accent"></div>
            <div id="${sid}_label" class="script-label">讲授要点</div>
            <div id="${sid}_head" class="script-head">${escapeHtml(truncate(headline, 42))}</div>
            <div class="script-lines">${bulletHtml}</div>
            <div class="script-meter"><div id="${sid}_meterFill" class="script-meter-fill"></div></div>
          </div>
        </div>
        <div class="top-progress"><div class="top-progress-fill" style="width:${(((i + 1) / pageCount) * 100).toFixed(1)}%"></div></div>
        <div class="vignette"></div>
        <div class="film-grain"></div>
      </div>`);

    const enterAt = start + TRANSITION_SEC * 0.5;
    const enterDir = i % 3;
    if (enterDir === 0) {
      tweens.push(`
        tl.from("#${sid}_label", { x: -30, opacity: 0, duration: 0.42, ease: "power3.out" }, ${enterAt.toFixed(3)});
        tl.from("#${sid}_head", { y: 36, opacity: 0, duration: 0.68, ease: "expo.out" }, ${(enterAt + 0.08).toFixed(3)});
      `);
    } else if (enterDir === 1) {
      tweens.push(`
        tl.from("#${sid}_label", { y: -16, opacity: 0, duration: 0.38, ease: "sine.out" }, ${enterAt.toFixed(3)});
        tl.from("#${sid}_head", { x: 40, opacity: 0, duration: 0.62, ease: "power4.out" }, ${(enterAt + 0.1).toFixed(3)});
      `);
    } else {
      tweens.push(`
        tl.from("#${sid}_label", { opacity: 0, duration: 0.32, ease: "power1.out" }, ${enterAt.toFixed(3)});
        tl.from("#${sid}_head", { scale: 0.94, opacity: 0, duration: 0.58, ease: "back.out(1.35)" }, ${(enterAt + 0.08).toFixed(3)});
      `);
    }

    bodyLines.forEach((_, li) => {
      const delay = enterAt + 0.2 + li * 0.15;
      tweens.push(
        `tl.from("#${sid}_line${li}", { x: 24, opacity: 0, duration: 0.45, ease: "power2.out" }, ${delay.toFixed(3)});`,
      );
    });

    tweens.push(`
      tl.from("#${sid}_pageBadge", { y: -14, opacity: 0, duration: 0.38, ease: "power2.out" }, ${enterAt.toFixed(3)});
      tl.fromTo("#${sid}_meterFill", { scaleX: 0 }, { scaleX: 1, duration: ${Math.max(1.2, hold - 1.1).toFixed(2)}, ease: "none", transformOrigin: "left center" }, ${enterAt.toFixed(3)});
    `);

    const kbDur = Math.min(hold + 0.35, 8).toFixed(2);
    if (ambient === 0) {
      tweens.push(`tl.fromTo("#${sid}_kb", { scale: 1 }, { scale: 1.08, duration: ${kbDur}, ease: "none" }, ${start.toFixed(3)});`);
    } else if (ambient === 1) {
      tweens.push(`tl.fromTo("#${sid}_kb", { scale: 1.08, x: -16 }, { scale: 1, x: 12, duration: ${kbDur}, ease: "none" }, ${start.toFixed(3)});`);
    } else if (ambient === 2) {
      tweens.push(`tl.fromTo("#${sid}_kb", { scale: 1.04, y: 10 }, { scale: 1.1, y: -12, duration: ${kbDur}, ease: "none" }, ${start.toFixed(3)});`);
    } else {
      tweens.push(`tl.fromTo("#${sid}_kb", { scale: 1.06, x: 10, y: -6 }, { scale: 1.02, x: -10, y: 8, duration: ${kbDur}, ease: "sine.inOut" }, ${start.toFixed(3)});`);
    }

    if (i < opts.pages.length - 1) {
      const T = start + hold - TRANSITION_SEC;
      tweens.push(buildTransition(kind, sid, `scene${i + 2}`, T, z));
    } else {
      const T = Math.max(start + 0.8, lastPageEnd - TRANSITION_SEC);
      tweens.push(buildTransition('crossfade', sid, 'sceneOutro', T, z));
    }

    if (p.audioRel) {
      audioHtml.push(`
      <audio id="a${i + 1}" class="clip"
        data-start="${start.toFixed(3)}" data-duration="${hold.toFixed(3)}"
        data-track-index="2" data-volume="1" src="${p.audioRel}"></audio>`);
    }
  }

  // ── Outro ──
  sceneCss.push(`
    #sceneOutro {
      z-index: ${pageCount + 8};
      background: radial-gradient(ellipse at 72% 68%, #16324f 0%, #0b1220 58%, #05080f 100%);
      opacity: 0;
    }`);
  sceneHtml.push(`
    <div id="sceneOutro" class="scene">
      <div class="deco-orb orb-c"></div>
      <div class="outro-wrap">
        <div id="outroLabel" class="intro-badge">本节讲解完成</div>
        <div id="outroTitle" class="intro-title">${escapeHtml(truncate(opts.title, 28))}</div>
        <div id="outroSub" class="intro-sub">感谢聆听 · 共 ${pageCount} 页</div>
      </div>
      <div class="vignette"></div>
      <div class="film-grain"></div>
    </div>`);
  tweens.push(`
    tl.from("#outroLabel", { y: 18, opacity: 0, duration: 0.42, ease: "power2.out" }, ${(outroStart + 0.3).toFixed(3)});
    tl.from("#outroTitle", { y: 36, opacity: 0, duration: 0.65, ease: "expo.out" }, ${(outroStart + 0.45).toFixed(3)});
    tl.from("#outroSub", { opacity: 0, duration: 0.45, ease: "sine.out" }, ${(outroStart + 0.8).toFixed(3)});
    tl.to("#sceneOutro", { opacity: 0, duration: 0.55, ease: "power2.in" }, ${(total - 0.6).toFixed(3)});
  `);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(opts.title)}</title>
  <script src="${gsapRel}"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #000;
      font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      color: #f1f5f9;
    }
    #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #05080f; }
    .scene { position: absolute; top: 0; left: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
    .layout { display: flex; width: 100%; height: 100%; }
    .slide-pane { position: relative; width: 58%; height: 100%; overflow: hidden; background: #0a101c; }
    .kb-wrap { position: absolute; inset: -4%; width: 108%; height: 108%; will-change: transform; }
    .slide-img { width: 100%; height: 100%; object-fit: cover; display: block; filter: saturate(1.05) contrast(1.04); }
    .slide-shine { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(115deg, transparent 40%, rgba(255,255,255,0.07) 48%, transparent 56%); mix-blend-mode: soft-light; }
    .slide-frame { position: absolute; inset: 28px; border: 1px solid rgba(148,163,184,0.22); border-radius: 18px; pointer-events: none; }
    .page-badge { position: absolute; top: 44px; left: 48px; padding: 8px 16px; border-radius: 999px; background: rgba(15,23,42,0.72); border: 1px solid rgba(56,189,248,0.35); color: #e0f2fe; font-size: 18px; font-weight: 600; backdrop-filter: blur(8px); }
    .script-pane { position: relative; width: 42%; height: 100%; padding: 72px 56px 64px 48px; background: linear-gradient(165deg, rgba(30,58,95,0.55) 0%, rgba(11,18,32,0.96) 42%, #070b14 100%); display: flex; flex-direction: column; gap: 18px; overflow: hidden; }
    .script-accent { position: absolute; top: 0; left: 0; width: 6px; height: 100%; background: linear-gradient(180deg, #38bdf8, #818cf8 50%, #c084fc); }
    .script-label { font-size: 18px; font-weight: 700; letter-spacing: 0.18em; color: #7dd3fc; }
    .script-head { font-size: 40px; font-weight: 800; line-height: 1.25; color: #f8fafc; }
    .script-lines { display: flex; flex-direction: column; gap: 16px; margin-top: 8px; flex: 1; }
    .script-line { display: flex; gap: 14px; align-items: flex-start; font-size: 26px; line-height: 1.45; color: #cbd5e1; }
    .line-dot { width: 10px; height: 10px; margin-top: 12px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 12px rgba(56,189,248,0.7); flex-shrink: 0; }
    .line-text { flex: 1; }
    .script-meter { height: 4px; border-radius: 4px; background: rgba(148,163,184,0.2); overflow: hidden; margin-top: auto; }
    .script-meter-fill { height: 100%; width: 100%; background: linear-gradient(90deg, #38bdf8, #a78bfa); transform-origin: left center; }
    .top-progress { position: absolute; top: 0; left: 0; right: 0; height: 4px; background: rgba(255,255,255,0.06); z-index: 20; }
    .top-progress-fill { height: 100%; background: linear-gradient(90deg, #22d3ee, #818cf8); }
    .vignette { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse at center, transparent 48%, rgba(0,0,0,0.35) 100%); z-index: 8; }
    .film-grain { position: absolute; inset: -20%; pointer-events: none; opacity: 0.045; z-index: 9; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); mix-blend-mode: overlay; }
    .intro-wrap, .outro-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 0 160px; z-index: 2; }
    .intro-badge { display: inline-flex; align-self: flex-start; padding: 10px 18px; border-radius: 999px; border: 1px solid rgba(125,211,252,0.35); background: rgba(14,165,233,0.12); color: #7dd3fc; font-size: 20px; font-weight: 700; letter-spacing: 0.12em; margin-bottom: 28px; }
    .intro-title { font-size: 72px; font-weight: 900; line-height: 1.15; max-width: 1400px; color: #f8fafc; text-shadow: 0 12px 40px rgba(0,0,0,0.35); }
    .intro-sub { margin-top: 24px; font-size: 28px; color: #94a3b8; }
    .intro-bar { margin-top: 36px; width: 220px; height: 5px; border-radius: 5px; background: linear-gradient(90deg, #38bdf8, #a78bfa); transform-origin: left center; }
    .deco-orb { position: absolute; border-radius: 50%; filter: blur(40px); opacity: 0.55; pointer-events: none; }
    .orb-a { width: 520px; height: 520px; left: -80px; top: -120px; background: #1d4ed8; }
    .orb-b { width: 420px; height: 420px; right: -60px; bottom: -80px; background: #7c3aed; }
    .orb-c { width: 480px; height: 480px; left: 30%; top: 20%; background: #0ea5e9; opacity: 0.35; }
${sceneCss.join('\n')}
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-width="${W}" data-height="${H}" data-start="0" data-duration="${total.toFixed(3)}"
       style="position:relative;width:${W}px;height:${H}px;overflow:hidden;">
${sceneHtml.join('\n')}
${audioHtml.join('\n')}
    <script>
      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true });
${tweens.join('\n')}
      tl.set({}, {}, ${total.toFixed(3)});
      window.__timelines["main"] = tl;
    </script>
  </div>
</body>
</html>
`;

  const indexPath = path.join(opts.outDir, 'index.html');
  fs.writeFileSync(indexPath, html, 'utf8');
  fs.writeFileSync(
    path.join(opts.outDir, 'design.md'),
    `# ${opts.title}\n\nDark premium lecture · split layout · rotating transitions · Ken Burns.\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(opts.outDir, 'package.json'),
    JSON.stringify({ name: 'cinedeck-hyperframe-lecture', private: true }, null, 2),
    'utf8',
  );
  return indexPath;
}

function pickTransition(i: number): TransitionKind {
  const kinds: TransitionKind[] = ['crossfade', 'push', 'blur', 'cover'];
  return kinds[i % kinds.length];
}

function buildTransition(kind: TransitionKind, fromId: string, toId: string, T: number, fromZ: number): string {
  const dur = TRANSITION_SEC;
  const t = T.toFixed(3);
  const lift = fromZ + 20;
  if (kind === 'push') {
    return `
      tl.set("#${toId}", { zIndex: ${lift}, opacity: 1, x: ${W} }, ${t});
      tl.set("#${fromId}", { zIndex: ${lift + 1} }, ${t});
      tl.to("#${fromId}", { x: -${W}, duration: ${dur}, ease: "power3.inOut" }, ${t});
      tl.to("#${toId}", { x: 0, duration: ${dur}, ease: "power3.inOut" }, ${t});
      tl.set("#${fromId}", { opacity: 0, x: 0 }, ${(T + dur).toFixed(3)});
    `;
  }
  if (kind === 'cover') {
    return `
      tl.set("#${toId}", { zIndex: ${lift + 1}, opacity: 1, y: ${H} }, ${t});
      tl.set("#${fromId}", { zIndex: ${lift} }, ${t});
      tl.to("#${toId}", { y: 0, duration: ${dur}, ease: "power4.out" }, ${t});
      tl.to("#${fromId}", { scale: 0.94, opacity: 0.45, duration: ${dur}, ease: "power2.in" }, ${t});
      tl.set("#${fromId}", { opacity: 0, scale: 1 }, ${(T + dur).toFixed(3)});
    `;
  }
  if (kind === 'blur') {
    return `
      tl.set("#${toId}", { zIndex: ${lift}, filter: "blur(16px)", scale: 0.96, opacity: 0 }, ${t});
      tl.set("#${fromId}", { zIndex: ${lift + 1} }, ${t});
      tl.to("#${fromId}", { filter: "blur(16px)", scale: 1.04, opacity: 0, duration: ${dur}, ease: "power2.in" }, ${t});
      tl.to("#${toId}", { filter: "blur(0px)", scale: 1, opacity: 1, duration: ${dur}, ease: "power2.out" }, ${(T + 0.12).toFixed(3)});
      tl.set("#${fromId}", { filter: "none", scale: 1 }, ${(T + dur + 0.05).toFixed(3)});
    `;
  }
  return `
      tl.set("#${toId}", { zIndex: ${lift}, opacity: 0 }, ${t});
      tl.set("#${fromId}", { zIndex: ${lift + 1} }, ${t});
      tl.to("#${fromId}", { opacity: 0, duration: ${dur}, ease: "power2.inOut" }, ${t});
      tl.to("#${toId}", { opacity: 1, duration: ${dur}, ease: "power2.inOut" }, ${t});
    `;
}

function splitLectureLines(text: string, maxLines: number): string[] {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return ['（本页暂无讲义）'];
  const parts = raw.split(/(?<=[。！？；!?;])\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const chunkSize = Math.ceil(raw.length / Math.min(maxLines, 3));
    const chunks: string[] = [];
    for (let i = 0; i < raw.length && chunks.length < maxLines; i += chunkSize) {
      chunks.push(raw.slice(i, i + chunkSize).trim());
    }
    return chunks.filter(Boolean);
  }
  if (parts.length <= maxLines) return parts.map((p) => truncate(p, 70));
  const out: string[] = [];
  const bucket = Math.ceil(parts.length / maxLines);
  for (let i = 0; i < parts.length && out.length < maxLines; i += bucket) {
    out.push(truncate(parts.slice(i, i + bucket).join(''), 78));
  }
  return out;
}

function truncate(s: string, n: number): string {
  const t = String(s || '').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function resolveGsapAsset(): string {
  const candidates = [
    path.join(__dirname, '../../assets/gsap.min.js'),
    path.join(__dirname, '../assets/gsap.min.js'),
    path.join(process.cwd(), 'assets/gsap.min.js'),
    path.join(process.cwd(), 'server/assets/gsap.min.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('缺少本地 GSAP：server/assets/gsap.min.js');
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function scriptsToPagesMeta(scripts: HfPageScript[]) {
  return scripts.map((s) => ({
    pageIndex: s.pageIndex,
    lecture: s.lecture,
    durationSec: s.durationSec || Math.max(3, Math.round((s.lecture || '').length / 5.5)),
    audioPath: s.audioPath || null,
  }));
}

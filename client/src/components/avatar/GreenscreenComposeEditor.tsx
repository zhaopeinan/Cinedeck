import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Slider, Space, Typography } from 'antd';
import type { AvatarLayout } from '../../types';
import { DEFAULT_AVATAR_LAYOUT } from '../../constants/avatarDefaults';

const { Text } = Typography;

export type GreenscreenComposeEditorProps = {
  backgroundUrl: string;
  greenscreenUrl: string;
  layout: AvatarLayout;
  onLayoutChange: (layout: AvatarLayout) => void;
  /** Chromakey similarity ≈ 抠绿强度，越高抠得越狠 */
  chromaSimilarity: number;
  onChromaSimilarityChange: (v: number) => void;
  disabled?: boolean;
};

/**
 * Real-time PiP editor: background video + canvas-keyed greenscreen overlay.
 * Layout x/y/w/h are normalized 0–1 relative to the background frame.
 */
export const GreenscreenComposeEditor: React.FC<GreenscreenComposeEditorProps> = ({
  backgroundUrl,
  greenscreenUrl,
  layout,
  onLayoutChange,
  chromaSimilarity,
  onChromaSimilarityChange,
  disabled,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLVideoElement | null>(null);
  const gsRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [bgAr, setBgAr] = useState(16 / 9);
  const [gsAr, setGsAr] = useState(1);
  const [drag, setDrag] = useState<null | {
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    origin: AvatarLayout;
  }>(null);
  const chromaRef = useRef(chromaSimilarity);
  chromaRef.current = chromaSimilarity;

  const heightForWidth = useCallback(
    (w: number) => {
      const ar = Math.max(0.2, Math.min(3, gsAr || 1));
      return w * (bgAr / ar);
    },
    [bgAr, gsAr],
  );

  const clampLayout = useCallback(
    (l: AvatarLayout): AvatarLayout => {
      let w = Math.min(0.85, Math.max(0.08, l.w));
      let h = heightForWidth(w);
      if (h > 0.9) {
        h = 0.9;
        w = h / (bgAr / Math.max(0.2, gsAr || 1));
        w = Math.min(0.85, Math.max(0.08, w));
        h = heightForWidth(w);
      }
      const x = Math.min(1 - w, Math.max(0, l.x));
      const y = Math.min(1 - h, Math.max(0, l.y));
      return { x, y, w, h };
    },
    [bgAr, gsAr, heightForWidth],
  );

  useEffect(() => {
    const next = clampLayout(layout);
    if (Math.abs(next.h - layout.h) > 0.004 || Math.abs(next.w - layout.w) > 0.004) {
      onLayoutChange(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgAr, gsAr]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dx = (e.clientX - drag.startX) / rect.width;
      const dy = (e.clientY - drag.startY) / rect.height;
      if (drag.mode === 'move') {
        onLayoutChange(clampLayout({
          ...drag.origin,
          x: drag.origin.x + dx,
          y: drag.origin.y + dy,
        }));
      } else {
        const delta = (dx + dy) / 2;
        const w = drag.origin.w + delta;
        onLayoutChange(clampLayout({ ...drag.origin, w, h: heightForWidth(w) }));
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, onLayoutChange, clampLayout, heightForWidth]);

  // Sync play + canvas chroma key loop
  useEffect(() => {
    const bg = bgRef.current;
    const gs = gsRef.current;
    const canvas = canvasRef.current;
    if (!bg || !gs || !canvas) return;

    let raf = 0;
    let stopped = false;
    const offscreen = document.createElement('canvas');
    const offCtx = offscreen.getContext('2d', { willReadFrequently: true });
    const ctx = canvas.getContext('2d');

    const paint = () => {
      if (stopped || !offCtx || !ctx) return;
      const gw = gs.videoWidth || 0;
      const gh = gs.videoHeight || 0;
      if (gw > 0 && gh > 0) {
        // Downscale for realtime performance
        const maxW = 480;
        const scale = Math.min(1, maxW / gw);
        const dw = Math.max(2, Math.floor(gw * scale));
        const dh = Math.max(2, Math.floor(gh * scale));
        if (offscreen.width !== dw || offscreen.height !== dh) {
          offscreen.width = dw;
          offscreen.height = dh;
          canvas.width = dw;
          canvas.height = dh;
        }
        offCtx.drawImage(gs, 0, 0, dw, dh);
        const frame = offCtx.getImageData(0, 0, dw, dh);
        const data = frame.data;
        // Map similarity (0.05–0.6) → green-dominance threshold
        const sim = Math.min(0.6, Math.max(0.05, chromaRef.current));
        const greenBias = 25 + sim * 180; // how much G must exceed R/B
        const maxRb = 200 - sim * 120;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          if (g > r + greenBias * 0.35 && g > b + greenBias * 0.35 && r < maxRb && b < maxRb) {
            data[i + 3] = 0;
          } else if (g > r + 10 && g > b + 10 && g > 80) {
            // soft edge
            const excess = Math.min(g - r, g - b);
            const alpha = Math.max(0, Math.min(255, 255 - excess * sim * 4));
            data[i + 3] = alpha;
          }
        }
        ctx.putImageData(frame, 0, 0);
      }
      raf = requestAnimationFrame(paint);
    };

    const syncPlay = async () => {
      try {
        bg.muted = true;
        gs.muted = true;
        await Promise.all([bg.play().catch(() => undefined), gs.play().catch(() => undefined)]);
      } catch { /* ignore */ }
    };

    const onMetaBg = () => {
      if (bg.videoWidth && bg.videoHeight) setBgAr(bg.videoWidth / bg.videoHeight);
    };
    const onMetaGs = () => {
      if (gs.videoWidth && gs.videoHeight) setGsAr(gs.videoWidth / gs.videoHeight);
    };
    bg.addEventListener('loadedmetadata', onMetaBg);
    gs.addEventListener('loadedmetadata', onMetaGs);
    if (bg.readyState >= 1) onMetaBg();
    if (gs.readyState >= 1) onMetaGs();

    void syncPlay();
    raf = requestAnimationFrame(paint);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      bg.removeEventListener('loadedmetadata', onMetaBg);
      gs.removeEventListener('loadedmetadata', onMetaGs);
      bg.pause();
      gs.pause();
    };
  }, [backgroundUrl, greenscreenUrl]);

  const sizePercent = Math.round(layout.w * 100);
  const chromaPercent = Math.round(chromaSimilarity * 100);

  return (
    <div>
      <div
        ref={wrapRef}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 800,
          margin: '0 auto',
          userSelect: 'none',
          background: '#111',
          borderRadius: 8,
          overflow: 'visible',
        }}
      >
        <video
          ref={bgRef}
          src={backgroundUrl}
          muted
          loop
          playsInline
          style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 8 }}
        />
        {/* Hidden source for chroma sampling */}
        <video
          ref={gsRef}
          src={greenscreenUrl}
          muted
          loop
          playsInline
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        />
        <div
          style={{
            position: 'absolute',
            left: `${layout.x * 100}%`,
            top: `${layout.y * 100}%`,
            width: `${layout.w * 100}%`,
            height: `${layout.h * 100}%`,
            border: '2px solid #1677ff',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.7), 0 4px 14px rgba(0,0,0,0.35)',
            boxSizing: 'border-box',
            cursor: disabled ? 'default' : 'move',
            overflow: 'hidden',
            borderRadius: 4,
            background: 'transparent',
          }}
          onPointerDown={(e) => {
            if (disabled) return;
            e.preventDefault();
            setDrag({ mode: 'move', startX: e.clientX, startY: e.clientY, origin: layout });
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              pointerEvents: 'none',
              display: 'block',
            }}
          />
          {!disabled && (
            <div
              title="拖拽缩放"
              style={{
                position: 'absolute',
                right: 2,
                bottom: 2,
                width: 22,
                height: 22,
                background: '#1677ff',
                border: '2px solid #fff',
                borderRadius: 4,
                cursor: 'nwse-resize',
                boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1,
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDrag({ mode: 'resize', startX: e.clientX, startY: e.clientY, origin: layout });
              }}
            >
              ↘
            </div>
          )}
        </div>
      </div>

      {!disabled && (
        <div style={{ maxWidth: 800, margin: '12px auto 0', padding: '0 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Text type="secondary" style={{ whiteSpace: 'nowrap', width: 72 }}>大小</Text>
            <Slider
              style={{ flex: 1, margin: 0 }}
              min={8}
              max={60}
              value={sizePercent}
              tooltip={{ formatter: (v) => `${v}% 宽` }}
              onChange={(v) => {
                const w = (v as number) / 100;
                onLayoutChange(clampLayout({ ...layout, w, h: heightForWidth(w) }));
              }}
            />
            <Text style={{ width: 48, textAlign: 'right' }}>{sizePercent}%</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text type="secondary" style={{ whiteSpace: 'nowrap', width: 72 }}>抠绿强度</Text>
            <Slider
              style={{ flex: 1, margin: 0 }}
              min={10}
              max={50}
              value={chromaPercent}
              tooltip={{ formatter: (v) => `${v}` }}
              onChange={(v) => onChromaSimilarityChange((v as number) / 100)}
            />
            <Text style={{ width: 48, textAlign: 'right' }}>{chromaPercent}</Text>
          </div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            拖蓝框移动；右下角缩放。实时预览为浏览器近似抠绿；下一步服务端预览与导出使用相同 ffmpeg 参数。
          </Text>
          <Space style={{ marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              默认布局可用「重置」：x={DEFAULT_AVATAR_LAYOUT.x}
            </Text>
          </Space>
        </div>
      )}
    </div>
  );
};

export default GreenscreenComposeEditor;

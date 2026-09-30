import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Slider, Typography } from 'antd';
import type { AvatarLayout } from '../types';

const { Text } = Typography;

type Props = {
  imageUrl: string;
  layout: AvatarLayout;
  onChange: (layout: AvatarLayout) => void;
  disabled?: boolean;
  /** 数字人画面宽高比（宽/高）。默认 1（Duix 常见 1:1） */
  aspectRatio?: number;
  /** 可选：在框内预览真实数字人画面 */
  avatarVideoUrl?: string;
};

/**
 * Drag + resize PiP box over a slide image.
 * Layout x/y/w/h are normalized 0–1 relative to the slide.
 * Box aspect is locked to the avatar video aspect ratio.
 */
const AvatarPipEditor: React.FC<Props> = ({
  imageUrl,
  layout,
  onChange,
  disabled,
  aspectRatio = 1,
  avatarVideoUrl,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [slideAr, setSlideAr] = useState(16 / 9);
  const [drag, setDrag] = useState<null | {
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    origin: AvatarLayout;
  }>(null);

  const syncSlideAr = useCallback(() => {
    const img = imgRef.current;
    if (img?.naturalWidth && img.naturalHeight) {
      setSlideAr(img.naturalWidth / img.naturalHeight);
    }
  }, []);

  /** Given width fraction, compute height fraction so on-screen box matches avatar AR. */
  const heightForWidth = useCallback(
    (w: number) => {
      const ar = Math.max(0.2, Math.min(3, aspectRatio || 1));
      return w * (slideAr / ar);
    },
    [aspectRatio, slideAr],
  );

  const clampLayout = useCallback(
    (l: AvatarLayout, lockAr = true): AvatarLayout => {
      let w = Math.min(0.85, Math.max(0.08, l.w));
      let h = lockAr ? heightForWidth(w) : Math.min(0.9, Math.max(0.08, l.h));
      if (h > 0.9) {
        h = 0.9;
        w = lockAr ? h / (slideAr / Math.max(0.2, aspectRatio || 1)) : w;
        w = Math.min(0.85, Math.max(0.08, w));
        h = heightForWidth(w);
      }
      const x = Math.min(1 - w, Math.max(0, l.x));
      const y = Math.min(1 - h, Math.max(0, l.y));
      return { x, y, w, h };
    },
    [aspectRatio, heightForWidth, slideAr],
  );

  // Keep stored layout AR in sync when slide/avatar AR becomes known
  useEffect(() => {
    const next = clampLayout(layout, true);
    if (
      Math.abs(next.h - layout.h) > 0.004
      || Math.abs(next.w - layout.w) > 0.004
    ) {
      onChange(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideAr, aspectRatio]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dx = (e.clientX - drag.startX) / rect.width;
      const dy = (e.clientY - drag.startY) / rect.height;
      if (drag.mode === 'move') {
        onChange(clampLayout({
          ...drag.origin,
          x: drag.origin.x + dx,
          y: drag.origin.y + dy,
        }));
      } else {
        // Resize from bottom-right; use average of dx/dy so drag feels natural
        const delta = (dx + dy) / 2;
        const w = drag.origin.w + delta;
        onChange(clampLayout({ ...drag.origin, w, h: heightForWidth(w) }));
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, onChange, clampLayout, heightForWidth]);

  const sizePercent = Math.round(layout.w * 100);

  return (
    <div>
      <div
        ref={wrapRef}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 720,
          margin: '0 auto',
          userSelect: 'none',
          background: '#111',
          borderRadius: 8,
          // keep handles visible (do NOT clip)
          overflow: 'visible',
        }}
      >
        <img
          ref={imgRef}
          src={imageUrl}
          alt="slide"
          style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 8 }}
          draggable={false}
          onLoad={syncSlideAr}
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
            background: avatarVideoUrl ? '#000' : 'rgba(22,119,255,0.22)',
            boxSizing: 'border-box',
            cursor: disabled ? 'default' : 'move',
            overflow: 'hidden',
            borderRadius: 4,
          }}
          onPointerDown={(e) => {
            if (disabled) return;
            e.preventDefault();
            setDrag({ mode: 'move', startX: e.clientX, startY: e.clientY, origin: layout });
          }}
        >
          {avatarVideoUrl ? (
            <video
              src={avatarVideoUrl}
              muted
              loop
              autoPlay
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
            />
          ) : (
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 12,
              textShadow: '0 1px 2px rgba(0,0,0,.6)',
              pointerEvents: 'none',
            }}
            >
              数字人
            </div>
          )}
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
        <div style={{ maxWidth: 720, margin: '12px auto 0', padding: '0 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>大小</Text>
            <Slider
              style={{ flex: 1, margin: 0 }}
              min={8}
              max={60}
              value={sizePercent}
              tooltip={{ formatter: (v) => `${v}% 宽` }}
              onChange={(v) => {
                const w = (v as number) / 100;
                onChange(clampLayout({ ...layout, w, h: heightForWidth(w) }));
              }}
            />
            <Text style={{ width: 48, textAlign: 'right' }}>{sizePercent}%</Text>
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            拖蓝框移动；拖右下角 ↘ 或用滑条缩放。比例锁定为数字人画面（当前 {aspectRatio >= 0.99 && aspectRatio <= 1.01 ? '1:1' : aspectRatio.toFixed(2)}）。
          </Text>
        </div>
      )}
    </div>
  );
};

export default AvatarPipEditor;

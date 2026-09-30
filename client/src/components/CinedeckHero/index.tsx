import React, { useMemo } from 'react';

/**
 * Cinedeck 首页 Hero — 电影感动画
 * 主题：PPT 幻灯片 → 影像 + 旁白 的转化
 * 配色：深炭灰 + 暖琥珀（投影机灯泡光），刻意避开 AI 套路的青/紫暗色
 */
const CinedeckHero: React.FC = () => {
  // 随机生成浮动胶片齿孔位置
  const perforations = useMemo(
    () =>
      Array.from({ length: 14 }, () => ({
        left: Math.random() * 100,
        top: Math.random() * 100,
        size: 6 + Math.random() * 10,
        delay: Math.random() * 8,
        duration: 8 + Math.random() * 6,
      })),
    []
  );

  // 波形条
  const waveformBars = useMemo(() => Array.from({ length: 28 }, (_, i) => i), []);

  const brand = 'Cinedeck';

  return (
    <>
      <style>{`
        @keyframes cinedeck-letter {
          0% { opacity: 0; transform: translateY(28px) rotateX(40deg); filter: blur(10px); }
          60% { opacity: 1; filter: blur(0); }
          100% { opacity: 1; transform: translateY(0) rotateX(0); filter: blur(0); }
        }
        @keyframes cinedeck-perf {
          0% { transform: translateY(0) rotate(0deg); opacity: 0; }
          15% { opacity: 0.55; }
          85% { opacity: 0.55; }
          100% { transform: translateY(-60px) rotate(180deg); opacity: 0; }
        }
        @keyframes cinedeck-glow {
          0%, 100% { opacity: 0.35; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.08); }
        }
        @keyframes cinedeck-wave {
          0%, 100% { transform: scaleY(0.25); }
          50% { transform: scaleY(1); }
        }
        @keyframes cinedeck-frame {
          0%, 18% { opacity: 0.18; transform: scale(0.94); }
          28%, 45% { opacity: 1; transform: scale(1); }
          55%, 100% { opacity: 0.18; transform: scale(0.94); }
        }
        @keyframes cinedeck-flow {
          0% { transform: translateX(-100%); opacity: 0; }
          30%, 70% { opacity: 1; }
          100% { transform: translateX(100%); opacity: 0; }
        }
        @keyframes cinedeck-fadeup {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes cinedeck-filmscroll {
          from { background-position: 0 0; }
          to { background-position: 0 -24px; }
        }
        @keyframes cinedeck-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(245, 185, 66, 0.5); }
          50% { box-shadow: 0 0 0 14px rgba(245, 185, 66, 0); }
        }
      `}</style>

      <section
        style={{
          position: 'relative',
          width: '100%',
          minHeight: 460,
          marginTop: -40,
          marginLeft: -24,
          marginRight: -24,
          padding: '72px 24px 56px',
          overflow: 'hidden',
          background:
            'radial-gradient(120% 80% at 50% -10%, oklch(0.32 0.05 60) 0%, oklch(0.2 0.025 60) 45%, oklch(0.16 0.02 60) 100%)',
          color: 'oklch(0.93 0.015 70)',
          fontFamily: "'Manrope', system-ui, sans-serif",
          borderBottom: '1px solid oklch(0.28 0.03 60)',
        }}
      >
        {/* 投影机光晕 */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '-30%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 700,
            height: 500,
            background:
              'radial-gradient(circle, oklch(0.82 0.13 68 / 0.28) 0%, oklch(0.82 0.13 68 / 0.08) 35%, transparent 70%)',
            filter: 'blur(20px)',
            animation: 'cinedeck-glow 6s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />

        {/* 浮动胶片齿孔 */}
        {perforations.map((p, i) => (
          <div
            key={i}
            aria-hidden
            style={{
              position: 'absolute',
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: p.size,
              height: p.size * 1.3,
              borderRadius: 2,
              background: 'oklch(0.82 0.13 68 / 0.4)',
              animation: `cinedeck-perf ${p.duration}s linear ${p.delay}s infinite`,
              pointerEvents: 'none',
            }}
          />
        ))}

        {/* 胶片纹理底纹 */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'repeating-linear-gradient(90deg, transparent 0, transparent 38px, oklch(0.82 0.13 68 / 0.04) 38px, oklch(0.82 0.13 68 / 0.04) 40px)',
            opacity: 0.5,
            pointerEvents: 'none',
          }}
        />

        <div style={{ position: 'relative', maxWidth: 960, margin: '0 auto', textAlign: 'center' }}>
          {/* 品牌名：逐字入场 */}
          <h1
            style={{
              fontFamily: "'Big Shoulders Display', sans-serif",
              fontWeight: 900,
              fontSize: 'clamp(56px, 11vw, 124px)',
              lineHeight: 0.9,
              letterSpacing: '-0.02em',
              margin: 0,
              color: 'oklch(0.95 0.02 70)',
              perspective: '600px',
            }}
          >
            {brand.split('').map((ch, i) => (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  opacity: 0,
                  animation: `cinedeck-letter 0.9s cubic-bezier(0.16, 1, 0.3, 1) ${0.1 + i * 0.07}s forwards`,
                  textShadow: i === 4 ? '0 0 32px oklch(0.82 0.14 68 / 0.5)' : 'none',
                }}
              >
                {ch}
              </span>
            ))}
          </h1>

          {/* 中文标语 */}
          <p
            style={{
              fontFamily: "'Manrope', system-ui, sans-serif",
              fontWeight: 500,
              fontSize: 'clamp(15px, 2vw, 19px)',
              letterSpacing: '0.08em',
              margin: '18px 0 0',
              color: 'oklch(0.8 0.04 65)',
              opacity: 0,
              animation: 'cinedeck-fadeup 0.8s ease-out 1s forwards',
            }}
          >
            让每一页幻灯片 &nbsp;·&nbsp; 化作一段影像
          </p>

          {/* 转化流水线动画 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'clamp(12px, 3vw, 32px)',
              marginTop: 44,
              opacity: 0,
              animation: 'cinedeck-fadeup 0.9s ease-out 1.3s forwards',
              flexWrap: 'wrap',
            }}
          >
            {/* 阶段一：幻灯片 */}
            <PipelineStage label="幻灯片" delay={0}>
              <div
                style={{
                  width: 56,
                  height: 42,
                  borderRadius: 4,
                  background: 'oklch(0.95 0.02 70)',
                  border: '1px solid oklch(0.6 0.02 60)',
                  padding: 5,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  justifyContent: 'center',
                }}
              >
                <div style={{ height: 3, background: 'oklch(0.55 0.04 60)', borderRadius: 1, width: '80%' }} />
                <div style={{ height: 3, background: 'oklch(0.55 0.04 60)', borderRadius: 1, width: '60%' }} />
                <div style={{ height: 3, background: 'oklch(0.7 0.1 65)', borderRadius: 1, width: '40%' }} />
              </div>
            </PipelineStage>

            <FlowArrow delay={1.4} />

            {/* 阶段二：胶片条 */}
            <PipelineStage label="胶片流转" delay={1.6}>
              <div
                style={{
                  width: 72,
                  height: 42,
                  borderRadius: 3,
                  background: 'oklch(0.12 0.02 60)',
                  border: '1px solid oklch(0.4 0.05 60)',
                  padding: '0 4px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  position: 'relative',
                  backgroundImage:
                    'repeating-linear-gradient(0deg, oklch(0.82 0.13 68 / 0.25) 0, oklch(0.82 0.13 68 / 0.25) 3px, transparent 3px, transparent 8px)',
                  backgroundSize: '100% 24px',
                  animation: 'cinedeck-filmscroll 1.2s linear infinite',
                }}
              >
                {[0, 1, 2].map((f) => (
                  <div
                    key={f}
                    style={{
                      flex: 1,
                      height: 26,
                      borderRadius: 2,
                      background: 'oklch(0.82 0.13 68)',
                      animation: `cinedeck-frame 2.4s ease-in-out ${f * 0.5}s infinite`,
                    }}
                  />
                ))}
              </div>
            </PipelineStage>

            <FlowArrow delay={1.8} />

            {/* 阶段三：播放 + 波形 */}
            <PipelineStage label="影像成片" delay={2}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: 'oklch(0.82 0.14 68)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    animation: 'cinedeck-pulse 2.4s ease-out infinite',
                  }}
                >
                  <div
                    style={{
                      width: 0,
                      height: 0,
                      borderTop: '8px solid transparent',
                      borderBottom: '8px solid transparent',
                      borderLeft: '12px solid oklch(0.16 0.02 60)',
                      marginLeft: 3,
                    }}
                  />
                </div>
              </div>
            </PipelineStage>
          </div>

          {/* 音频波形可视化 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              marginTop: 40,
              height: 40,
              opacity: 0,
              animation: 'cinedeck-fadeup 0.9s ease-out 1.6s forwards',
            }}
            aria-hidden
          >
            {waveformBars.map((i) => (
              <div
                key={i}
                style={{
                  width: 3,
                  height: '100%',
                  background:
                    i % 3 === 0
                      ? 'oklch(0.82 0.14 68)'
                      : i % 3 === 1
                      ? 'oklch(0.72 0.1 65 / 0.7)'
                      : 'oklch(0.6 0.08 60 / 0.5)',
                  borderRadius: 2,
                  transformOrigin: 'center',
                  animation: `cinedeck-wave ${0.8 + (i % 5) * 0.12}s ease-in-out ${(i % 7) * 0.09}s infinite`,
                }}
              />
            ))}
          </div>
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: 'oklch(0.62 0.04 60)',
              opacity: 0,
              animation: 'cinedeck-fadeup 0.9s ease-out 1.9s forwards',
            }}
          >
            AI Voiceover · Auto Narration
          </div>
        </div>
      </section>
    </>
  );
};

/** 流水线阶段容器 */
const PipelineStage: React.FC<{ label: string; delay: number; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
    <div
      style={{
        width: 76,
        height: 60,
        borderRadius: 8,
        background: 'oklch(0.22 0.025 60 / 0.6)',
        border: '1px solid oklch(0.38 0.05 60)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(4px)',
      }}
    >
      {children}
    </div>
    <span style={{ fontSize: 12, letterSpacing: '0.15em', color: 'oklch(0.7 0.04 60)' }}>{label}</span>
  </div>
);

/** 流动的箭头 */
const FlowArrow: React.FC<{ delay: number }> = ({ delay }) => (
  <div
    style={{
      width: 48,
      height: 2,
      position: 'relative',
      overflow: 'hidden',
      background: 'oklch(0.38 0.05 60)',
      borderRadius: 1,
    }}
    aria-hidden
  >
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'linear-gradient(90deg, transparent, oklch(0.82 0.14 68), transparent)',
        animation: `cinedeck-flow 1.8s ease-in-out ${delay}s infinite`,
      }}
    />
    <div
      style={{
        position: 'absolute',
        right: -2,
        top: -3,
        width: 0,
        height: 0,
        borderTop: '4px solid transparent',
        borderBottom: '4px solid transparent',
        borderLeft: '6px solid oklch(0.5 0.06 60)',
      }}
    />
  </div>
);

export default CinedeckHero;

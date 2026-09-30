import React, { useState, useMemo } from 'react';
import { Form, Input, Button, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { SliderCaptcha } from '../../components/SliderCaptcha';
import { useAuthStore } from '../../stores/authStore';

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [loading, setLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  const resetCaptcha = () => {
    setCaptchaToken(null);
    setCaptchaKey((k) => k + 1);
  };

  const onFinish = async (values: { username: string; password: string }) => {
    if (!captchaToken) {
      message.warning('请先完成滑块验证');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: values.username,
          password: values.password,
          captcha_token: captchaToken,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setAuth(data.data.token, data.data.user);
        message.success('登录成功');
        navigate('/');
      } else {
        message.error(data.error?.message || '登录失败');
        // 验证码 token 已在服务端消费；密码错误后必须重新滑块验证
        resetCaptcha();
      }
    } catch (err: any) {
      message.error('登录失败：' + (err.message || '网络错误'));
      resetCaptcha();
    } finally {
      setLoading(false);
    }
  };

  // 浮动胶片齿孔
  const perforations = useMemo(
    () =>
      Array.from({ length: 18 }, () => ({
        left: Math.random() * 100,
        top: Math.random() * 100,
        size: 6 + Math.random() * 10,
        delay: Math.random() * 8,
        duration: 8 + Math.random() * 6,
      })),
    []
  );

  // 波形条
  const waveformBars = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const brand = 'Cinedeck';

  return (
    <div style={{ minHeight: '100vh', display: 'flex' }}>
      <style>{`
        @keyframes login-letter {
          0% { opacity: 0; transform: translateY(28px) rotateX(40deg); filter: blur(10px); }
          60% { opacity: 1; filter: blur(0); }
          100% { opacity: 1; transform: translateY(0) rotateX(0); filter: blur(0); }
        }
        @keyframes login-perf {
          0% { transform: translateY(0) rotate(0deg); opacity: 0; }
          15% { opacity: 0.5; }
          85% { opacity: 0.5; }
          100% { transform: translateY(-60px) rotate(180deg); opacity: 0; }
        }
        @keyframes login-glow {
          0%, 100% { opacity: 0.35; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.08); }
        }
        @keyframes login-wave {
          0%, 100% { transform: scaleY(0.25); }
          50% { transform: scaleY(1); }
        }
        @keyframes login-fadeup {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes login-filmscroll {
          from { background-position: 0 0; }
          to { background-position: 0 -24px; }
        }
        @keyframes login-frame {
          0%, 18% { opacity: 0.18; }
          28%, 45% { opacity: 1; }
          55%, 100% { opacity: 0.18; }
        }
        @keyframes login-flow {
          0% { transform: translateX(-100%); opacity: 0; }
          30%, 70% { opacity: 1; }
          100% { transform: translateX(100%); opacity: 0; }
        }
      `}</style>

      {/* ===== 左侧：电影感动画 ===== */}
      <div
        style={{
          flex: '1 1 55%',
          position: 'relative',
          overflow: 'hidden',
          background:
            'radial-gradient(120% 80% at 50% -10%, oklch(0.32 0.05 60) 0%, oklch(0.2 0.025 60) 45%, oklch(0.16 0.02 60) 100%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 48,
        }}
      >
        {/* 投影机光晕 */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '-20%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 600,
            height: 500,
            background:
              'radial-gradient(circle, oklch(0.82 0.13 68 / 0.28) 0%, oklch(0.82 0.13 68 / 0.08) 35%, transparent 70%)',
            filter: 'blur(20px)',
            animation: 'login-glow 6s ease-in-out infinite',
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
              animation: `login-perf ${p.duration}s linear ${p.delay}s infinite`,
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

        {/* 品牌名 */}
        <h1
          style={{
            position: 'relative',
            fontFamily: "'Big Shoulders Display', sans-serif",
            fontWeight: 900,
            fontSize: 'clamp(56px, 8vw, 110px)',
            lineHeight: 0.9,
            letterSpacing: '-0.02em',
            margin: 0,
            color: 'oklch(0.95 0.02 70)',
            perspective: '600px',
            textAlign: 'center',
          }}
        >
          {brand.split('').map((ch, i) => (
            <span
              key={i}
              style={{
                display: 'inline-block',
                opacity: 0,
                animation: `login-letter 0.9s cubic-bezier(0.16, 1, 0.3, 1) ${0.1 + i * 0.07}s forwards`,
                textShadow: i === 4 ? '0 0 32px oklch(0.82 0.14 68 / 0.5)' : 'none',
              }}
            >
              {ch}
            </span>
          ))}
        </h1>

        {/* 标语 */}
        <p
          style={{
            position: 'relative',
            fontFamily: "'Manrope', system-ui, sans-serif",
            fontWeight: 500,
            fontSize: 'clamp(15px, 2vw, 19px)',
            letterSpacing: '0.08em',
            margin: '18px 0 0',
            color: 'oklch(0.8 0.04 65)',
            opacity: 0,
            animation: 'login-fadeup 0.8s ease-out 1s forwards',
            textAlign: 'center',
          }}
        >
          让每一页幻灯片 · 化作一段影像
        </p>

        {/* 转化流水线 */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'clamp(8px, 2vw, 20px)',
            marginTop: 48,
            opacity: 0,
            animation: 'login-fadeup 0.9s ease-out 1.3s forwards',
            flexWrap: 'wrap',
          }}
        >
          {/* 幻灯片 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 72,
                height: 56,
                borderRadius: 8,
                background: 'oklch(0.22 0.025 60 / 0.6)',
                border: '1px solid oklch(0.38 0.05 60)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 36,
                  borderRadius: 4,
                  background: 'oklch(0.95 0.02 70)',
                  padding: 4,
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
            </div>
            <span style={{ fontSize: 12, letterSpacing: '0.12em', color: 'oklch(0.7 0.04 60)' }}>幻灯片</span>
          </div>

          {/* 流动箭头 */}
          <div style={{ width: 40, height: 2, position: 'relative', overflow: 'hidden', background: 'oklch(0.38 0.05 60)', borderRadius: 1 }} aria-hidden>
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, transparent, oklch(0.82 0.14 68), transparent)', animation: 'login-flow 1.8s ease-in-out 1.4s infinite' }} />
          </div>

          {/* 胶片条 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 72,
                height: 56,
                borderRadius: 8,
                background: 'oklch(0.22 0.025 60 / 0.6)',
                border: '1px solid oklch(0.38 0.05 60)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 36,
                  borderRadius: 3,
                  background: 'oklch(0.12 0.02 60)',
                  border: '1px solid oklch(0.4 0.05 60)',
                  padding: '0 3px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  backgroundImage:
                    'repeating-linear-gradient(0deg, oklch(0.82 0.13 68 / 0.25) 0, oklch(0.82 0.13 68 / 0.25) 3px, transparent 3px, transparent 8px)',
                  backgroundSize: '100% 24px',
                  animation: 'login-filmscroll 1.2s linear infinite',
                }}
              >
                {[0, 1, 2].map((f) => (
                  <div
                    key={f}
                    style={{
                      flex: 1,
                      height: 24,
                      borderRadius: 2,
                      background: 'oklch(0.82 0.13 68)',
                      animation: `login-frame 2.4s ease-in-out ${f * 0.5}s infinite`,
                    }}
                  />
                ))}
              </div>
            </div>
            <span style={{ fontSize: 12, letterSpacing: '0.12em', color: 'oklch(0.7 0.04 60)' }}>胶片流转</span>
          </div>

          {/* 流动箭头 */}
          <div style={{ width: 40, height: 2, position: 'relative', overflow: 'hidden', background: 'oklch(0.38 0.05 60)', borderRadius: 1 }} aria-hidden>
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, transparent, oklch(0.82 0.14 68), transparent)', animation: 'login-flow 1.8s ease-in-out 1.8s infinite' }} />
          </div>

          {/* 播放按钮 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 72,
                height: 56,
                borderRadius: 8,
                background: 'oklch(0.22 0.025 60 / 0.6)',
                border: '1px solid oklch(0.38 0.05 60)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: 'oklch(0.82 0.14 68)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div
                  style={{
                    width: 0,
                    height: 0,
                    borderTop: '7px solid transparent',
                    borderBottom: '7px solid transparent',
                    borderLeft: '11px solid oklch(0.16 0.02 60)',
                    marginLeft: 3,
                  }}
                />
              </div>
            </div>
            <span style={{ fontSize: 12, letterSpacing: '0.12em', color: 'oklch(0.7 0.04 60)' }}>影像成片</span>
          </div>
        </div>

        {/* 音频波形 */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            marginTop: 48,
            height: 36,
            opacity: 0,
            animation: 'login-fadeup 0.9s ease-out 1.6s forwards',
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
                animation: `login-wave ${0.8 + (i % 5) * 0.12}s ease-in-out ${(i % 7) * 0.09}s infinite`,
              }}
            />
          ))}
        </div>
        <div
          style={{
            position: 'relative',
            marginTop: 10,
            fontSize: 12,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'oklch(0.62 0.04 60)',
            opacity: 0,
            animation: 'login-fadeup 0.9s ease-out 1.9s forwards',
          }}
        >
          AI Voiceover · Auto Narration
        </div>
      </div>

      {/* ===== 右侧：登录表单 ===== */}
      <div
        style={{
          flex: '1 1 45%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'oklch(0.98 0.005 70)',
          padding: 48,
        }}
      >
        <div style={{ width: '100%', maxWidth: 360 }}>
          <h2
            style={{
              fontFamily: "'Manrope', system-ui, sans-serif",
              fontWeight: 700,
              fontSize: 26,
              margin: '0 0 8px',
              color: 'oklch(0.25 0.02 60)',
            }}
          >
            欢迎回来
          </h2>
          <p style={{ margin: '0 0 32px', color: 'oklch(0.55 0.02 60)', fontSize: 14 }}>
            登录以开始你的创作
          </p>

          <Form name="login" onFinish={onFinish} size="large" layout="vertical">
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined style={{ color: 'oklch(0.55 0.02 60)' }} />} placeholder="用户名" />
            </Form.Item>

            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined style={{ color: 'oklch(0.55 0.02 60)' }} />} placeholder="密码" />
            </Form.Item>

            <Form.Item>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <SliderCaptcha
                  key={captchaKey}
                  onVerified={(token) => setCaptchaToken(token)}
                  onReset={() => setCaptchaToken(null)}
                />
              </div>
            </Form.Item>

            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={loading}
                disabled={!captchaToken}
                style={{ height: 44, fontWeight: 600 }}
              >
                登录
              </Button>
            </Form.Item>
          </Form>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;

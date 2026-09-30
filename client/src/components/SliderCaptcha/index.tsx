import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button, Spin, message } from 'antd';
import { ReloadOutlined, CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { authApi } from '../../api';

interface SliderCaptchaProps {
  onVerified: (token: string) => void;
  /** 刷新或重置时回调（登录失败后父组件可清空 token） */
  onReset?: () => void;
}

interface CaptchaData {
  captchaId: string;
  backgroundImage: string;
  sliderImage: string;
  sliderY: number;
  canvasWidth: number;
  canvasHeight: number;
  sliderSize: number;
}

const TRACK_WIDTH = 320;

export const SliderCaptcha: React.FC<SliderCaptchaProps> = ({ onVerified, onReset }) => {
  const [loading, setLoading] = useState(false);
  const [captcha, setCaptcha] = useState<CaptchaData | null>(null);
  const [sliderX, setSliderX] = useState(0);
  const [status, setStatus] = useState<'idle' | 'dragging' | 'success' | 'failed'>('idle');
  const [hint, setHint] = useState('向右拖动滑块完成验证');
  const dragStartRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;

  const loadCaptcha = useCallback(async () => {
    setLoading(true);
    setStatus('idle');
    setSliderX(0);
    setHint('向右拖动滑块完成验证');
    onResetRef.current?.();
    try {
      const res = await authApi.getCaptcha();
      const data = res.data.data;
      setCaptcha({
        captchaId: data.captchaId,
        backgroundImage: data.backgroundImage,
        sliderImage: data.sliderImage,
        sliderY: data.sliderY,
        canvasWidth: data.canvasWidth,
        canvasHeight: data.canvasHeight,
        sliderSize: data.sliderSize,
      });
    } catch {
      message.error('获取验证码失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCaptcha();
  }, [loadCaptcha]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (status === 'success' || !captcha) return;
    dragStartRef.current = e.clientX - sliderX;
    setStatus('dragging');
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (status !== 'dragging') return;
    const deltaX = e.clientX - dragStartRef.current;
    const maxX = TRACK_WIDTH - 40; // 滑块宽度 40
    const newX = Math.max(0, Math.min(maxX, deltaX));
    setSliderX(newX);
  }, [status]);

  const handleMouseUp = useCallback(async () => {
    if (status !== 'dragging' || !captcha) return;
    setStatus('idle');
    try {
      const res = await authApi.verifyCaptcha(captcha.captchaId, sliderX);
      if (res.data.success) {
        setStatus('success');
        setHint('验证通过');
        onVerified(res.data.data.token);
      } else {
        setStatus('failed');
        setHint(res.data.error?.message || '验证失败，请重试');
        setTimeout(() => loadCaptcha(), 800);
      }
    } catch {
      setStatus('failed');
      setHint('验证失败，请重试');
      setTimeout(() => loadCaptcha(), 800);
    }
  }, [status, sliderX, captcha, onVerified, loadCaptcha]);

  useEffect(() => {
    if (status === 'dragging') {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [status, handleMouseMove, handleMouseUp]);

  return (
    <div style={{ width: TRACK_WIDTH }}>
      <Spin spinning={loading}>
        <div
          ref={containerRef}
          style={{
            position: 'relative',
            width: TRACK_WIDTH,
            height: captcha?.canvasHeight || 160,
            background: '#f0f0f0',
            borderRadius: 4,
            overflow: 'hidden',
            marginBottom: 8,
          }}
        >
          {captcha && (
            <>
              <img
                src={captcha.backgroundImage}
                alt="captcha bg"
                style={{ display: 'block', width: TRACK_WIDTH, height: captcha.canvasHeight }}
                draggable={false}
              />
              <img
                src={captcha.sliderImage}
                alt="slider"
                style={{
                  position: 'absolute',
                  left: `${sliderX}px`,
                  top: `${captcha.sliderY}px`,
                  width: captcha.sliderSize,
                  height: captcha.sliderSize,
                  cursor: status === 'success' ? 'default' : 'grab',
                }}
                draggable={false}
              />
            </>
          )}
        </div>
      </Spin>

      {/* 滑块轨道 */}
      <div
        style={{
          position: 'relative',
          width: TRACK_WIDTH,
          height: 40,
          background: '#f5f5f5',
          borderRadius: 4,
          border: '1px solid #e8e8e8',
          overflow: 'hidden',
        }}
      >
        {/* 提示文字 */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: status === 'success' ? '#52c41a' : status === 'failed' ? '#ff4d4f' : '#999',
            fontSize: 13,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        >
          {status === 'success' && <CheckCircleFilled style={{ marginRight: 6 }} />}
          {status === 'failed' && <CloseCircleFilled style={{ marginRight: 6 }} />}
          {hint}
        </div>

        {/* 已滑动进度 */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${sliderX + 40}px`,
            height: '100%',
            background: status === 'success' ? 'rgba(82,196,26,0.2)' : status === 'failed' ? 'rgba(255,77,79,0.2)' : 'rgba(24,144,255,0.15)',
            zIndex: 0,
          }}
        />

        {/* 可拖动滑块 */}
        <div
          onMouseDown={handleMouseDown}
          style={{
            position: 'absolute',
            top: 0,
            left: `${sliderX}px`,
            width: 40,
            height: 40,
            background: status === 'success' ? '#52c41a' : status === 'failed' ? '#ff4d4f' : '#fff',
            border: '1px solid #d9d9d9',
            borderRadius: 4,
            cursor: status === 'success' ? 'default' : 'grab',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2,
            boxShadow: '0 0 3px rgba(0,0,0,0.1)',
            transition: status === 'dragging' ? 'none' : 'background 0.2s',
          }}
        >
          {status === 'success' ? (
            <CheckCircleFilled style={{ color: '#fff' }} />
          ) : (
            <span style={{ color: '#999', fontSize: 16 }}>≡</span>
          )}
        </div>
      </div>

      <div style={{ textAlign: 'right', marginTop: 4 }}>
        <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => void loadCaptcha()} disabled={loading}>
          刷新验证码
        </Button>
      </div>
    </div>
  );
};

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Steps, Button, Space, Typography, message, Spin, Progress, Tag, Alert, Select, Switch, InputNumber, Divider, Radio, Slider } from 'antd';
import { ExportOutlined, PlayCircleOutlined, PauseCircleOutlined, PauseOutlined, UndoOutlined, RedoOutlined, DownloadOutlined, ReloadOutlined, ClockCircleOutlined, ScissorOutlined, AimOutlined, StopOutlined } from '@ant-design/icons';
import { useProjectStore } from '../../stores/projectStore';
import { opencutApi, withToken } from '../../api';
import { analytics, AnalyticsEvents } from '../../utils/analytics';

const { Title, Text } = Typography;

const SPEED_OPTIONS = [
  { label: '0.5x (慢速)', value: 0.5 },
  { label: '0.75x', value: 0.75 },
  { label: '1.0x (正常)', value: 1.0 },
  { label: '1.25x', value: 1.25 },
  { label: '1.5x', value: 1.5 },
  { label: '2.0x (快速)', value: 2.0 },
];

type CropMode = 'original' | 'custom' | '16:9' | '9:16' | '1:1' | '4:3';

const CROP_OPTIONS: { label: string; value: CropMode }[] = [
  { label: '原始', value: 'original' },
  { label: '自定义', value: 'custom' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '1:1', value: '1:1' },
  { label: '4:3', value: '4:3' },
];

interface CropBox {
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
}

interface DragState {
  type: 'move' | 'resize';
  handle?: string;
  startMouseX: number;
  startMouseY: number;
  startBox: CropBox;
  containerRect: DOMRect;
  lockRatio: CropMode;
  videoRatio: number;
}

const MIN_CROP_SIZE = 5; // 最小裁切框百分比

// 根据比例预设计算居中裁切框
function computeCenteredCrop(mode: CropMode, videoW: number, videoH: number): CropBox {
  if (mode === 'original' || mode === 'custom') {
    return { xPct: 10, yPct: 10, widthPct: 80, heightPct: 80 };
  }
  const [tw, th] = mode.split(':').map(Number);
  const targetRatio = tw / th;
  const displayRatio = videoW / videoH;
  const pctRatio = targetRatio / displayRatio; // widthPct / heightPct
  let widthPct: number, heightPct: number;
  if (pctRatio >= 1) {
    widthPct = 100;
    heightPct = 100 / pctRatio;
  } else {
    heightPct = 100;
    widthPct = 100 * pctRatio;
  }
  return {
    xPct: (100 - widthPct) / 2,
    yPct: (100 - heightPct) / 2,
    widthPct,
    heightPct,
  };
}

// 计算缩放后的裁切框
function computeResize(ds: DragState, deltaX: number, deltaY: number): CropBox {
  const { startBox, handle, lockRatio, videoRatio } = ds;
  let left = startBox.xPct;
  let top = startBox.yPct;
  let right = startBox.xPct + startBox.widthPct;
  let bottom = startBox.yPct + startBox.heightPct;

  if (handle!.includes('w')) left = startBox.xPct + deltaX;
  if (handle!.includes('e')) right = startBox.xPct + startBox.widthPct + deltaX;
  if (handle!.includes('n')) top = startBox.yPct + deltaY;
  if (handle!.includes('s')) bottom = startBox.yPct + startBox.heightPct + deltaY;

  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(100, right);
  bottom = Math.min(100, bottom);

  let newWidth = right - left;
  let newHeight = bottom - top;

  if (newWidth < MIN_CROP_SIZE) {
    if (handle!.includes('w')) left = right - MIN_CROP_SIZE;
    else right = left + MIN_CROP_SIZE;
    newWidth = MIN_CROP_SIZE;
  }
  if (newHeight < MIN_CROP_SIZE) {
    if (handle!.includes('n')) top = bottom - MIN_CROP_SIZE;
    else bottom = top + MIN_CROP_SIZE;
    newHeight = MIN_CROP_SIZE;
  }

  // 比例锁定
  if (lockRatio !== 'original' && lockRatio !== 'custom') {
    const [tw, th] = lockRatio.split(':').map(Number);
    const pctRatio = (tw / th) / videoRatio;
    const impliedH = newWidth / pctRatio;
    const impliedW = newHeight * pctRatio;
    if (impliedH <= newHeight) {
      newHeight = impliedH;
      if (handle!.includes('n')) top = bottom - newHeight;
      else bottom = top + newHeight;
    } else {
      newWidth = impliedW;
      if (handle!.includes('w')) left = right - newWidth;
      else right = left + newWidth;
    }
  }

  return { xPct: left, yPct: top, widthPct: newWidth, heightPct: newHeight };
}

const EditorPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentProject, loadProject } = useProjectStore();

  const [isInitializing, setIsInitializing] = useState(false);
  const [editorAvailable, setEditorAvailable] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [timeline, setTimeline] = useState<any>(null);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoNaturalSize, setVideoNaturalSize] = useState({ width: 1920, height: 1080 });

  // 播放设置（实时预览生效，导出保留）
  const [speed, setSpeed] = useState(1.0);
  const [pauseEnabled, setPauseEnabled] = useState(false);
  const [pauseDuration, setPauseDuration] = useState(2);
  const [cropMode, setCropMode] = useState<CropMode>('original');
  const [cropBox, setCropBox] = useState<CropBox>({ xPct: 10, yPct: 10, widthPct: 80, heightPct: 80 });
  const [isDragging, setIsDragging] = useState(false);

  // 页间停顿预览
  const [pauseCountdown, setPauseCountdown] = useState(0); // >0 表示正在停顿中，值为剩余秒数
  const pauseCountdownRef = useRef(0);
  const pauseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seekInProgressRef = useRef(false); // 防止 seek 后的 timeupdate 误触发停顿
  const videoTrackRef = useRef<HTMLDivElement>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportDone, setExportDone] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const [exportDuration, setExportDuration] = useState<number | null>(null);
  const [exportStage, setExportStage] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const exportTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (id) {
      loadProject(id);
      analytics.track(AnalyticsEvents.OPENCUT_PROJECT_OPEN, { projectId: id });
      initEditor();
    }
    return () => {
      if (exportTimerRef.current) clearInterval(exportTimerRef.current);
      if (pauseTimerRef.current) clearInterval(pauseTimerRef.current);
    };
  }, [id]);

  // 清理停顿状态
  const clearPause = useCallback(() => {
    if (pauseTimerRef.current) {
      clearInterval(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
    pauseCountdownRef.current = 0;
    setPauseCountdown(0);
  }, []);

  // 启动页间停顿倒计时
  const startPauseCountdown = useCallback((duration: number, nextClipStartTime: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    setIsPlaying(false);
    pauseCountdownRef.current = duration;
    setPauseCountdown(duration);

    pauseTimerRef.current = setInterval(() => {
      pauseCountdownRef.current -= 0.1;
      if (pauseCountdownRef.current <= 0) {
        clearPause();
        seekInProgressRef.current = true;
        video.currentTime = nextClipStartTime;
        video.play().then(() => setIsPlaying(true)).catch(() => {});
        // 短暂延迟后重置 flag，让 seek 后的 timeupdate 过渡过去
        setTimeout(() => { seekInProgressRef.current = false; }, 200);
      } else {
        setPauseCountdown(pauseCountdownRef.current);
      }
    }, 100);
  }, [clearPause]);

  // 关闭停顿时立即清理
  useEffect(() => {
    if (!pauseEnabled) clearPause();
  }, [pauseEnabled, clearPause]);

  // 变速实时预览
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  }, [speed]);

  // 拖拽全局事件
  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      const mouseX = ((e.clientX - ds.containerRect.left) / ds.containerRect.width) * 100;
      const mouseY = ((e.clientY - ds.containerRect.top) / ds.containerRect.height) * 100;
      const deltaX = mouseX - ds.startMouseX;
      const deltaY = mouseY - ds.startMouseY;

      if (ds.type === 'move') {
        const newX = Math.max(0, Math.min(100 - ds.startBox.widthPct, ds.startBox.xPct + deltaX));
        const newY = Math.max(0, Math.min(100 - ds.startBox.heightPct, ds.startBox.yPct + deltaY));
        setCropBox({ ...ds.startBox, xPct: newX, yPct: newY });
      } else if (ds.type === 'resize') {
        setCropBox(computeResize(ds, deltaX, deltaY));
      }
    };

    const handleUp = () => {
      dragStateRef.current = null;
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isDragging]);

  const initEditor = async () => {
    if (!id) return;
    setIsInitializing(true);
    try {
      const res = await opencutApi.init(id);
      if (res.data.success) {
        setTimeline(res.data.data.timeline);
        setEditorAvailable(true);
      }
    } catch (error: any) {
      const msg = error.response?.data?.error?.message || '编辑器初始化失败';
      if (msg.includes('不可用')) {
        setEditorAvailable(false);
      }
      message.warning(msg);
    } finally {
      setIsInitializing(false);
    }
  };

  const applyCropMode = (mode: CropMode) => {
    setCropMode(mode);
    if (mode === 'original') return;
    if (mode === 'custom' && cropMode !== 'original') return; // 保持当前框
    setCropBox(computeCenteredCrop(mode, videoNaturalSize.width, videoNaturalSize.height));
  };

  const resetCrop = () => {
    setCropBox(computeCenteredCrop(cropMode, videoNaturalSize.width, videoNaturalSize.height));
  };

  const startDrag = (e: React.MouseEvent, type: 'move' | 'resize', handle?: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (!videoContainerRef.current) return;
    const rect = videoContainerRef.current.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * 100;
    const mouseY = ((e.clientY - rect.top) / rect.height) * 100;
    dragStateRef.current = {
      type,
      handle,
      startMouseX: mouseX,
      startMouseY: mouseY,
      startBox: { ...cropBox },
      containerRect: rect,
      lockRatio: cropMode,
      videoRatio: videoNaturalSize.width / videoNaturalSize.height,
    };
    setIsDragging(true);
    // 手动拖动后切换到自定义模式（如果在预设模式下）
    if (type === 'move' && cropMode !== 'original' && cropMode !== 'custom') {
      setCropMode('custom');
    }
  };

  // 预估导出时长
  const estimatedDuration = useMemo(() => {
    if (!timeline) return 0;
    const numClips = timeline.tracks?.[0]?.clips?.length || 0;
    const originalDuration = timeline.duration || 0;
    const contentDuration = originalDuration / speed;
    const pauseTotal = pauseEnabled ? (numClips > 0 ? (numClips - 1) * pauseDuration : 0) : 0;
    return contentDuration + pauseTotal;
  }, [timeline, speed, pauseEnabled, pauseDuration]);

  const handleExport = async () => {
    if (!id) return;
    analytics.track(AnalyticsEvents.OPENCUT_EXPORT_START, { projectId: id, speed, cropMode });
    setIsExporting(true);
    setExportProgress(0);
    setExportDone(false);
    setExportFailed(false);
    setExportDuration(null);
    setExportStage('');

    try {
      const exportParams: any = {
        format: 'mp4',
        speed,
        pauseDuration: pauseEnabled ? pauseDuration : 0,
        aspectRatio: 'original',
      };
      if (cropMode !== 'original') {
        exportParams.crop = {
          xPct: cropBox.xPct,
          yPct: cropBox.yPct,
          widthPct: cropBox.widthPct,
          heightPct: cropBox.heightPct,
        };
      }
      await opencutApi.export(id, exportParams);
      // 后端异步渲染，开始轮询进度
      startExportPolling();
    } catch (error: any) {
      analytics.track(AnalyticsEvents.OPENCUT_EXPORT_FAIL, { projectId: id, error: error.message });
      setExportFailed(true);
      setIsExporting(false);
      message.error('导出失败：' + (error.response?.data?.error?.message || error.message));
    }
  };

  const handleCancelExport = async () => {
    if (!id) return;
    try {
      await opencutApi.cancelExport(id);
      message.info('已强制停止导出');
    } catch (error: any) {
      message.error(error.response?.data?.error?.message || '取消失败');
    }
  };

  const startExportPolling = useCallback(() => {
    if (exportTimerRef.current) clearInterval(exportTimerRef.current);
    exportTimerRef.current = setInterval(async () => {
      if (!id) return;
      try {
        const res = await opencutApi.getExportStatus(id);
        const data = res.data.data;
        const progress = data?.progress;
        if (progress) {
          setExportStage(progress.stage || '');
          if (progress.totalPages > 0 && progress.stage !== 'export_failed') {
            const pct = Math.round((progress.currentPage / progress.totalPages) * 100);
            setExportProgress(progress.stage === 'export_done' ? 100 : pct);
          }
        }
        // 检查状态
        if (data?.export_status === 'success' || progress?.stage === 'export_done') {
          clearExportPolling();
          setExportProgress(100);
          setExportDone(true);
          setExportDuration(estimatedDuration);
          setIsExporting(false);
          analytics.track(AnalyticsEvents.OPENCUT_EXPORT_SUCCESS, { projectId: id });
          message.success('导出成功，可点击下载按钮下载视频');
        } else if (data?.export_status === 'cancelled' || progress?.stage === 'export_cancelled') {
          clearExportPolling();
          setIsExporting(false);
          setExportFailed(false);
          setExportDone(false);
          message.info('已取消导出');
        } else if (data?.export_status === 'failed' || progress?.stage === 'export_failed') {
          clearExportPolling();
          setExportFailed(true);
          setIsExporting(false);
          const errMsg = progress?.error || '导出失败';
          analytics.track(AnalyticsEvents.OPENCUT_EXPORT_FAIL, { projectId: id, error: errMsg });
          message.error('导出失败：' + errMsg);
        }
      } catch {
        // 轮询失败，忽略
      }
    }, 1500);
  }, [id, estimatedDuration]);

  const clearExportPolling = useCallback(() => {
    if (exportTimerRef.current) {
      clearInterval(exportTimerRef.current);
      exportTimerRef.current = null;
    }
  }, []);

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.pause();
      else videoRef.current.play();
    }
  };

  const seekToTime = useCallback((rawTime: number, opts?: { selectClip?: boolean }) => {
    const duration = timeline?.duration || 0;
    if (!duration) return;
    const t = Math.max(0, Math.min(duration - 0.01, rawTime));
    clearPause();
    seekInProgressRef.current = true;
    if (videoRef.current) {
      videoRef.current.currentTime = t;
    }
    setCurrentTime(t);
    if (opts?.selectClip !== false && timeline?.tracks?.[0]?.clips) {
      const clip = timeline.tracks[0].clips.find(
        (c: any) => t >= c.startTime && t < c.endTime,
      );
      if (clip) setSelectedClip(clip.id);
    }
    setTimeout(() => { seekInProgressRef.current = false; }, 200);
  }, [timeline, clearPause]);

  const timeFromClientX = useCallback((clientX: number) => {
    const el = videoTrackRef.current;
    const duration = timeline?.duration || 0;
    if (!el || !duration) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return ratio * duration;
  }, [timeline]);

  useEffect(() => {
    if (!isScrubbing) return;
    const onMove = (e: PointerEvent) => {
      seekToTime(timeFromClientX(e.clientX));
    };
    const onUp = () => setIsScrubbing(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isScrubbing, seekToTime, timeFromClientX]);

  const startTimelineScrub = (e: React.PointerEvent) => {
    e.preventDefault();
    // pause while scrubbing for precise preview
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    setIsScrubbing(true);
    seekToTime(timeFromClientX(e.clientX));
  };

  const handleClipClick = (clip: any, e?: React.MouseEvent) => {
    // Prefer seek to click position inside the track; fall back to clip start
    if (e && videoTrackRef.current) {
      seekToTime(timeFromClientX(e.clientX));
      return;
    }
    setSelectedClip(clip.id);
    seekToTime(clip.startTime);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
  };

  const getCurrentClipId = useCallback(() => {
    if (!timeline?.tracks?.[0]?.clips) return null;
    const clip = timeline.tracks[0].clips.find((c: any) => currentTime >= c.startTime && currentTime < c.endTime);
    return clip?.id || null;
  }, [timeline, currentTime]);

  const activeClipId = getCurrentClipId();
  const hasSettingsChanged = speed !== 1.0 || (pauseEnabled && pauseDuration > 0) || cropMode !== 'original';
  const cropActive = cropMode !== 'original';

  const cornerHandles = useMemo(() => [
    { dir: 'nw', style: { top: -6, left: -6, cursor: 'nw-resize' } },
    { dir: 'ne', style: { top: -6, right: -6, cursor: 'ne-resize' } },
    { dir: 'sw', style: { bottom: -6, left: -6, cursor: 'sw-resize' } },
    { dir: 'se', style: { bottom: -6, right: -6, cursor: 'se-resize' } },
  ], []);

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px' }}>
      <Steps current={6} items={['导入PPT', '读取备注', '选择音色', '生成配音', '生成数字人', '视频预览', '编辑导出'].map(t => ({ title: t }))} style={{ marginBottom: 24 }} />

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Title level={4} style={{ margin: 0 }}>编辑工作台</Title>
          <Space>
            <Button onClick={() => navigate(`/project/${id}/preview`)}>上一步：视频预览</Button>
            <Button icon={<UndoOutlined />} disabled>撤销</Button>
            <Button icon={<RedoOutlined />} disabled>重做</Button>
            <Button type="primary" icon={<ExportOutlined />} loading={isExporting} onClick={handleExport} disabled={isExporting}>
              导出视频
            </Button>
            {isExporting && (
              <Button danger icon={<StopOutlined />} onClick={() => void handleCancelExport()}>
                取消导出
              </Button>
            )}
          </Space>
        </div>

        {isInitializing && <Spin tip="正在初始化编辑项目..." style={{ display: 'block', margin: '80px auto' }} />}

        {!isInitializing && !editorAvailable && currentProject?.videoFilePath && (
          <div style={{ textAlign: 'center' }}>
            <Text type="warning" style={{ display: 'block', marginBottom: 16 }}>编辑器暂不可用，您可以预览原始视频</Text>
            <video ref={videoRef} src={withToken(`/api/v1/projects/${id}/video/play`)} controls style={{ width: '100%', maxHeight: 400, borderRadius: 8 }} />
            <div style={{ marginTop: 16 }}>
              <Button onClick={initEditor}>稍后重试编辑</Button>
            </div>
          </div>
        )}

        {!isInitializing && editorAvailable && timeline && (
          <div>
            {degraded && (
              <Alert type="info" showIcon message="当前为简化编辑模式" description="OpenCut 编辑器未集成，已降级为视频预览与导出。导出将直接使用已合成的讲解视频。" style={{ marginBottom: 16 }} />
            )}

            {/* Video Preview — 带可拖动裁切框 */}
            <div style={{ display: 'flex', justifyContent: 'center', background: '#000', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
              <div ref={videoContainerRef} style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: 450 }}>
                <video
                  ref={videoRef}
                  src={withToken(`/api/v1/projects/${id}/video/play`)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                  onTimeUpdate={(e) => {
                    const t = e.currentTarget.currentTime;
                    setCurrentTime(t);
                    // 检测是否到达当前 clip 末尾，触发页间停顿
                    if (!pauseEnabled || isDragging || isScrubbing || pauseCountdownRef.current > 0 || seekInProgressRef.current) return;
                    const clips = timeline?.tracks?.[0]?.clips;
                    if (!clips || clips.length === 0) return;
                    for (let i = 0; i < clips.length - 1; i++) {
                      const clip = clips[i];
                      // 到达 clip 末尾（允许 0.15s 容差）
                      if (Math.abs(t - clip.endTime) < 0.15 && t >= clip.startTime) {
                        startPauseCountdown(pauseDuration, clips[i + 1].startTime);
                        break;
                      }
                    }
                  }}
                  onLoadedMetadata={(e) => setVideoNaturalSize({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
                  style={{ display: 'block', maxWidth: '100%', maxHeight: 450, verticalAlign: 'top' }}
                />

                {/* 裁切框 */}
                {cropActive && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${cropBox.xPct}%`,
                      top: `${cropBox.yPct}%`,
                      width: `${cropBox.widthPct}%`,
                      height: `${cropBox.heightPct}%`,
                      border: '2px solid #1677ff',
                      boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                      cursor: 'move',
                      zIndex: 5,
                      userSelect: 'none',
                    }}
                    onMouseDown={(e) => startDrag(e, 'move')}
                  >
                    {/* 比例标签 */}
                    <div style={{
                      position: 'absolute', top: -24, left: 0,
                      background: '#1677ff', color: '#fff', fontSize: 11,
                      padding: '1px 6px', borderRadius: '2px', whiteSpace: 'nowrap',
                    }}>
                      {cropMode === 'custom' ? '自定义' : cropMode}
                    </div>

                    {/* 九宫格辅助线 */}
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                      <div style={{ position: 'absolute', top: '33.33%', left: 0, right: 0, height: 1, background: 'rgba(255,255,255,0.3)' }} />
                      <div style={{ position: 'absolute', top: '66.66%', left: 0, right: 0, height: 1, background: 'rgba(255,255,255,0.3)' }} />
                      <div style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.3)' }} />
                      <div style={{ position: 'absolute', left: '66.66%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.3)' }} />
                    </div>

                    {/* 4 角手柄 */}
                    {cornerHandles.map(h => (
                      <div
                        key={h.dir}
                        style={{
                          position: 'absolute',
                          width: 12, height: 12,
                          background: '#fff',
                          border: '2px solid #1677ff',
                          borderRadius: 2,
                          zIndex: 6,
                          ...h.style,
                        }}
                        onMouseDown={(e) => startDrag(e, 'resize', h.dir)}
                      />
                    ))}
                  </div>
                )}

                {/* 停顿标识（保留画面，仅右上角小标识） */}
                {pauseCountdown > 0 && (
                  <div style={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    background: 'rgba(22,119,255,0.9)',
                    color: '#fff',
                    padding: '4px 12px',
                    borderRadius: 16,
                    fontSize: 13,
                    fontWeight: 600,
                    zIndex: 8,
                    pointerEvents: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}>
                    <PauseCircleOutlined />
                    停顿 {Math.ceil(pauseCountdown)}s
                  </div>
                )}

                {/* 播放控制条 */}
                <div style={{ position: 'absolute', bottom: 8, left: 8, color: '#fff', background: 'rgba(0,0,0,0.6)', padding: '2px 8px', borderRadius: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, zIndex: 7 }}>
                  <Button type="text" icon={isPlaying ? <PauseOutlined /> : <PlayCircleOutlined />} onClick={togglePlay} style={{ color: '#fff' }} />
                  <span>{formatTime(currentTime)} / {formatTime(timeline.duration || 0)}</span>
                  {speed !== 1.0 && <Tag color="blue" style={{ margin: 0 }}>{speed}x</Tag>}
                </div>
              </div>
            </div>

            {/* Timeline — 可自由拖动定位 */}
            <div style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text strong>时间轴</Text>
                <Text type="secondary">
                  当前 {formatTime(currentTime)} / 总时长 {formatTime(timeline.duration || 0)}
                  {isScrubbing ? ' · 拖动中' : ' · 点击或拖动红线定位'}
                </Text>
              </div>

              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>视频轨道</Text>
                <div
                  ref={videoTrackRef}
                  onPointerDown={startTimelineScrub}
                  style={{
                    position: 'relative',
                    height: 60,
                    background: '#fafafa',
                    borderRadius: 4,
                    overflow: 'visible',
                    cursor: 'ew-resize',
                    touchAction: 'none',
                    userSelect: 'none',
                  }}
                >
                  {timeline.tracks?.[0]?.clips?.map((clip: any) => {
                    const leftPercent = (clip.startTime / (timeline.duration || 1)) * 100;
                    const widthPercent = (clip.duration / (timeline.duration || 1)) * 100;
                    const isActive = activeClipId === clip.id;
                    const isSelected = selectedClip === clip.id;
                    return (
                      <div
                        key={clip.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleClipClick(clip, e);
                        }}
                        style={{
                          position: 'absolute',
                          left: `${leftPercent}%`,
                          width: `${widthPercent}%`,
                          minWidth: 30,
                          height: '100%',
                          background: isSelected ? '#1677ff' : (isActive ? '#4096ff' : '#91caff'),
                          borderLeft: '1px solid #fff',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'ew-resize',
                          fontSize: 12,
                          color: (isSelected || isActive) ? '#fff' : '#333',
                          boxSizing: 'border-box',
                          overflow: 'hidden',
                          borderRadius: 2,
                          pointerEvents: 'none', // 让下层轨道统一接收拖动；点击由轨道处理
                        }}
                      >
                        {widthPercent > 3 && `P${clip.slideIndex}`}
                      </div>
                    );
                  })}
                  {timeline.duration > 0 && (
                    <div
                      style={{
                        position: 'absolute',
                        top: -4,
                        bottom: -4,
                        left: `${(currentTime / timeline.duration) * 100}%`,
                        width: 14,
                        marginLeft: -7,
                        zIndex: 10,
                        cursor: 'ew-resize',
                        pointerEvents: 'auto',
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        startTimelineScrub(e);
                      }}
                      title="拖动定位"
                    >
                      <div style={{
                        position: 'absolute',
                        left: '50%',
                        top: 0,
                        bottom: 0,
                        width: 2,
                        marginLeft: -1,
                        background: '#ff4d4f',
                      }}
                      />
                      <div style={{
                        position: 'absolute',
                        left: '50%',
                        top: -2,
                        width: 12,
                        height: 12,
                        marginLeft: -6,
                        background: '#ff4d4f',
                        borderRadius: '50%',
                        border: '2px solid #fff',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
                      }}
                      />
                    </div>
                  )}
                </div>
              </div>

              <div style={{ marginBottom: 8 }}>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>音频轨道</Text>
                <div
                  onPointerDown={startTimelineScrub}
                  style={{
                    position: 'relative',
                    height: 40,
                    background: '#fafafa',
                    borderRadius: 4,
                    overflow: 'hidden',
                    cursor: 'ew-resize',
                    touchAction: 'none',
                    userSelect: 'none',
                  }}
                >
                  {timeline.tracks?.[1]?.clips?.length > 0 ? (
                    timeline.tracks[1].clips.map((clip: any) => {
                      const leftPercent = (clip.startTime / (timeline.duration || 1)) * 100;
                      const widthPercent = (clip.duration / (timeline.duration || 1)) * 100;
                      const isActive = activeClipId === clip.id;
                      const isSelected = selectedClip === clip.id;
                      return (
                        <div
                          key={clip.id}
                          style={{
                            position: 'absolute',
                            left: `${leftPercent}%`,
                            width: `${widthPercent}%`,
                            minWidth: 30,
                            height: '100%',
                            background: isSelected ? '#52c41a' : (isActive ? '#73d13d' : '#b7eb8f'),
                            borderLeft: '1px solid #fff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 12,
                            color: (isSelected || isActive) ? '#fff' : '#333',
                            boxSizing: 'border-box',
                            overflow: 'hidden',
                            pointerEvents: 'none',
                          }}
                        >
                          {widthPercent > 3 && `P${clip.slideIndex}`}
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999', fontSize: 12 }}>
                      无音频轨（所有页面均为静音页）
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 4px' }}>
                <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>精确定位</Text>
                <Slider
                  style={{ flex: 1, margin: 0 }}
                  min={0}
                  max={Math.max(0.1, timeline.duration || 0.1)}
                  step={0.1}
                  value={Math.min(currentTime, timeline.duration || 0)}
                  tooltip={{ formatter: (v) => formatTime(Number(v || 0)) }}
                  onChange={(v) => {
                    if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
                    seekToTime(Number(v));
                  }}
                />
              </div>
            </div>

            {/* 播放设置面板 */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <Space>
                  <Text strong>播放设置</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>调整后实时预览，导出时保留效果</Text>
                </Space>
                <Tag color={hasSettingsChanged ? 'orange' : 'default'}>
                  {hasSettingsChanged ? '已调整' : '默认'}
                </Tag>
              </div>

              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
                {/* 变速 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Text>播放速度</Text>
                  <Select value={speed} onChange={setSpeed} options={SPEED_OPTIONS} style={{ width: 150 }} />
                </div>

                <Divider type="vertical" style={{ height: 32 }} />

                {/* 页间停顿 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Text>页间停顿</Text>
                  <Switch checked={pauseEnabled} onChange={setPauseEnabled} />
                  {pauseEnabled && (
                    <InputNumber min={0.5} max={10} step={0.5} value={pauseDuration} onChange={(v) => setPauseDuration(v ?? 2)} size="small" style={{ width: 70 }} addonAfter="秒" />
                  )}
                </div>

                <Divider type="vertical" style={{ height: 32 }} />

                {/* 裁切 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ScissorOutlined />
                  <Text>画面裁切</Text>
                  <Radio.Group value={cropMode} onChange={(e) => applyCropMode(e.target.value)} size="small">
                    {CROP_OPTIONS.map(r => (
                      <Radio.Button key={r.value} value={r.value}>{r.label}</Radio.Button>
                    ))}
                  </Radio.Group>
                  {cropActive && (
                    <Button size="small" icon={<AimOutlined />} onClick={resetCrop}>重置</Button>
                  )}
                </div>
              </div>

              {/* 裁切提示 */}
              {cropActive && (
                <div style={{ marginTop: 8, padding: '4px 8px', background: '#e6f4ff', borderRadius: 4, fontSize: 12, color: '#1677ff' }}>
                  拖动蓝色边框移动裁切区域，拖动四角白色手柄调整大小{cropMode !== 'custom' ? '（当前锁定比例，手动拖动将切换为自定义）' : '（自由比例）'}
                </div>
              )}

              {/* 预估时长 */}
              <div style={{ marginTop: 12, padding: '8px 12px', background: '#f6ffed', borderRadius: 4, border: '1px solid #b7eb8f', display: 'flex', alignItems: 'center', gap: 8 }}>
                <ClockCircleOutlined style={{ color: '#52c41a' }} />
                <Text>
                  预估导出时长：<Text strong style={{ fontSize: 16, color: '#52c41a' }}>{formatTime(estimatedDuration)}</Text>
                </Text>
                {hasSettingsChanged && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    （原始 {formatTime(timeline.duration || 0)}
                    {speed !== 1.0 && ` → 变速 ${formatTime((timeline.duration || 0) / speed)}`}
                    {pauseEnabled && ` + 停顿 ${formatTime(((timeline.tracks?.[0]?.clips?.length || 0) - 1) * pauseDuration)}`}
                    {cropMode !== 'original' && `，画面裁切 ${cropMode === 'custom' ? '自定义' : cropMode}`}）
                  </Text>
                )}
              </div>
            </Card>

            {/* Export Progress / Result */}
            {isExporting && (
              <Card style={{ marginTop: 16 }}>
                <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text strong>
                    {exportStage === 'export_preparing' ? '准备导出...' :
                     exportStage === 'export_rendering' ? `渲染视频片段 ${exportProgress}%` :
                     exportStage === 'export_merging' ? '合并视频片段...' :
                     '导出中...'}
                  </Text>
                  <Text type="secondary">{exportProgress}%</Text>
                </div>
                <Progress percent={exportProgress} status="active" />
                <div style={{ marginTop: 12, textAlign: 'center' }}>
                  <Button danger icon={<StopOutlined />} onClick={() => void handleCancelExport()}>
                    取消导出
                  </Button>
                </div>
              </Card>
            )}

            {exportDone && (
              <Card style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Space>
                    <Tag color="success">导出成功</Tag>
                    <Text type="secondary">视频时长: {formatTime(exportDuration ?? estimatedDuration)}</Text>
                  </Space>
                  <Space>
                    <Button icon={<DownloadOutlined />} type="primary" href={id ? opencutApi.getDownloadUrl(id) : undefined}>下载视频</Button>
                    <Button icon={<ReloadOutlined />} onClick={handleExport}>重新导出</Button>
                  </Space>
                </div>
              </Card>
            )}

            {exportFailed && !isExporting && (
              <Card style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Space>
                    <Tag color="error">导出失败</Tag>
                    <Text type="secondary">请重试</Text>
                  </Space>
                  <Button icon={<ReloadOutlined />} type="primary" onClick={handleExport}>重试导出</Button>
                </div>
              </Card>
            )}
          </div>
        )}
      </Card>
    </div>
  );
};

export default EditorPage;

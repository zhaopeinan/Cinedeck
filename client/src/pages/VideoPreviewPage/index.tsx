import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card, Steps, Button, Space, Typography, message, Switch, InputNumber, Alert, Progress, Spin, Table, Tag,
} from 'antd';
import { PlayCircleOutlined, EditOutlined, ReloadOutlined, WarningOutlined, ClockCircleOutlined, StopOutlined } from '@ant-design/icons';
import { useProjectStore } from '../../stores/projectStore';
import { projectApi, videoApi, withToken } from '../../api';
import { NoteStatus, type AvatarLayout } from '../../types';
import { analytics, AnalyticsEvents } from '../../utils/analytics';
import { PPT_STEP, PPT_WORKFLOW_STEPS } from '../../constants/workflowSteps';
import { DEFAULT_AVATAR_LAYOUT } from '../../constants/avatarDefaults';
import AvatarPipEditor from '../../components/AvatarPipEditor';

const { Title, Text } = Typography;

const STAGE_LABELS: Record<string, string> = {
  preparing: '准备页面素材',
  audio: '合成音频',
  video: '合成视频',
  final: '生成完成',
  failed: '合成失败',
  cancelled: '已取消',
};

const VideoPreviewPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    currentProject, slides, loadProject, loadSlides, composeVideo, retryCompose,
    isComposing, updateProject, loadVideoStatus,
  } = useProjectStore();

  const [allowSilentPages, setAllowSilentPages] = useState(true);
  const [defaultSilentPageDuration, setDefaultSilentPageDuration] = useState(5);
  const [composeProgress, setComposeProgress] = useState<any>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [layout, setLayout] = useState<AvatarLayout>(DEFAULT_AVATAR_LAYOUT);
  const [previewPage, setPreviewPage] = useState<number | null>(null);
  const [savingLayout, setSavingLayout] = useState(false);
  const [avatarAspect, setAvatarAspect] = useState(1);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const composeStartTimeRef = useRef<number>(0);
  const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (id) {
      loadProject(id);
      loadSlides(id);
      projectApi.getAvatarSettings(id).then((res) => {
        const l = res.data.data?.layout;
        if (l) setLayout(l);
      }).catch(() => undefined);
    }
  }, [id]);

  useEffect(() => {
    if (currentProject) {
      setAllowSilentPages(currentProject.allowSilentPages ?? true);
      setDefaultSilentPageDuration(currentProject.defaultSilentPageDuration ?? 5);
    }
  }, [currentProject?.allowSilentPages, currentProject?.defaultSilentPageDuration]);

  useEffect(() => {
    const withAvatar = slides.find((s: any) =>
      (s.avatarStatus || s.avatar_status) === 'generated'
      && (s.avatarVisible ?? s.avatar_visible ?? 1),
    );
    if (withAvatar && previewPage == null) {
      setPreviewPage((withAvatar as any).pageIndex ?? (withAvatar as any).page_index);
    } else if (slides[0] && previewPage == null) {
      setPreviewPage((slides[0] as any).pageIndex ?? (slides[0] as any).page_index);
    }
  }, [slides]);

  const silentPages = slides.filter((s: any) => s.noteStatus === NoteStatus.EMPTY || s.note_status === 'empty');
  const silentPageNumbers = silentPages.map((s: any) => (s.pageIndex ?? s.page_index));
  const blockCompose = !allowSilentPages && silentPages.length > 0;

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const stopElapsed = useCallback(() => {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  const startElapsed = useCallback(() => {
    composeStartTimeRef.current = Date.now();
    setElapsedSeconds(0);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - composeStartTimeRef.current) / 1000));
    }, 1000);
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(async () => {
      if (!id) return;
      try {
        const [progressRes, statusRes] = await Promise.all([
          videoApi.getProgress(id),
          videoApi.getStatus(id),
        ]);
        setComposeProgress(progressRes.data.data);
        const status = statusRes.data.data?.videoStatus;
        const stage = progressRes.data.data?.stage;
        if (status === 'success' || status === 'failed' || status === 'pending' || stage === 'cancelled') {
          stopPolling();
          stopElapsed();
          await loadVideoStatus(id);
          if (stage === 'cancelled' || status === 'pending') {
            message.info('已取消视频合成');
          } else if (status === 'success') {
            analytics.track(AnalyticsEvents.VIDEO_GENERATE_SUCCESS, { projectId: id });
            message.success('视频合成成功');
          } else if (status === 'failed') {
            analytics.track(AnalyticsEvents.VIDEO_GENERATE_FAIL, { projectId: id });
            const errMsg = progressRes.data.data?.error;
            message.error(errMsg ? `视频合成失败：${errMsg}` : '视频合成失败');
          }
        }
      } catch {
        // ignore
      }
    }, 2000);
  }, [id, loadVideoStatus, stopPolling, stopElapsed]);

  useEffect(() => () => {
    stopPolling();
    stopElapsed();
  }, [stopPolling, stopElapsed]);

  const handleAllowSilentChange = async (checked: boolean) => {
    setAllowSilentPages(checked);
    if (!id) return;
    try {
      await updateProject(id, { allowSilentPages: checked ? 1 : 0 });
    } catch (err: any) {
      setAllowSilentPages(!checked);
      message.error(err.response?.data?.error?.message || '更新失败');
    }
  };

  const handleDurationChange = async (value: number | null) => {
    const v = value || 5;
    setDefaultSilentPageDuration(v);
    if (id) await updateProject(id, { default_silent_page_duration: v });
  };

  const persistLayout = (next: AvatarLayout) => {
    setLayout(next);
    if (!id) return;
    if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = setTimeout(async () => {
      setSavingLayout(true);
      try {
        await projectApi.updateAvatarSettings(id, { layout: next });
      } catch (err: any) {
        message.error(err.response?.data?.error?.message || '布局保存失败');
      } finally {
        setSavingLayout(false);
      }
    }, 350);
  };

  const togglePageVisible = async (pageIndex: number, visible: boolean) => {
    if (!id) return;
    try {
      await projectApi.updateAvatarPages(id, [{ pageIndex, visible }]);
      await loadSlides(id);
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '更新失败');
    }
  };

  const handleCompose = async () => {
    if (!id || blockCompose) return;
    analytics.track(AnalyticsEvents.VIDEO_GENERATE_START, { projectId: id });
    startElapsed();
    startPolling();
    try {
      await composeVideo(id);
    } catch (err: any) {
      stopPolling();
      stopElapsed();
      message.error(err.response?.data?.error?.message || '合成失败');
    }
  };

  const handleCancelCompose = async () => {
    if (!id) return;
    try {
      await videoApi.cancel(id);
      message.info('已强制停止合成');
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '取消失败');
    }
  };

  const handleRetry = async () => {
    if (!id) return;
    startElapsed();
    startPolling();
    try {
      await retryCompose(id);
    } catch (err: any) {
      stopPolling();
      stopElapsed();
      message.error(err.response?.data?.error?.message || '重试失败');
    }
  };

  const videoUrl = id ? withToken(`/api/v1/projects/${id}/video/play`) : '';
  const formatElapsed = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const previewImageUrl = id && previewPage != null
    ? projectApi.getSlideImageUrl(id, previewPage)
    : '';

  const avatarPages = slides.filter((s: any) => (s.avatarStatus || s.avatar_status) === 'generated');
  const previewHasAvatar = avatarPages.some(
    (s: any) => (s.pageIndex ?? s.page_index) === previewPage,
  );
  const avatarPreviewUrl = id && previewPage != null && previewHasAvatar
    ? projectApi.getAvatarPageVideoUrl(id, previewPage)
    : undefined;

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px' }}>
      <Steps current={PPT_STEP.PREVIEW} items={[...PPT_WORKFLOW_STEPS]} style={{ marginBottom: 24 }} />

      <Card style={{ marginBottom: 16 }}>
        <Title level={5} style={{ marginTop: 0 }}>数字人布局（整份共用）</Title>
        <Text type="secondary">
          比例跟随已生成的数字人画面（由参考视频/静照决定，无需另选）。
          拖蓝框移动，拖右下角 ↘ 或下方滑条缩放；改完后需重新合成。
        </Text>
        {avatarPreviewUrl && (
          <video
            key={avatarPreviewUrl}
            src={avatarPreviewUrl}
            muted
            playsInline
            style={{ display: 'none' }}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0) {
                setAvatarAspect(v.videoWidth / v.videoHeight);
              }
            }}
          />
        )}
        {previewImageUrl ? (
          <div style={{ marginTop: 12 }}>
            <AvatarPipEditor
              imageUrl={previewImageUrl}
              layout={layout}
              onChange={(l) => void persistLayout(l)}
              disabled={isComposing || currentProject?.videoStatus === 'generating'}
              aspectRatio={avatarAspect}
              avatarVideoUrl={avatarPreviewUrl}
            />
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">
                预览页：第 {previewPage} 页
                {savingLayout ? ' · 保存中…' : ''}
                {' · '}宽 {(layout.w * 100).toFixed(0)}%
                {' · '}比例 {avatarAspect >= 0.99 && avatarAspect <= 1.01 ? '1:1' : avatarAspect.toFixed(2)}
              </Text>
            </div>
          </div>
        ) : (
          <Alert style={{ marginTop: 12 }} type="info" message="暂无幻灯片可预览布局" />
        )}

        {avatarPages.length > 0 && (
          <Table
            style={{ marginTop: 16 }}
            size="small"
            pagination={false}
            rowKey={(r: any) => String(r.pageIndex ?? r.page_index)}
            dataSource={avatarPages}
            columns={[
              {
                title: '页码',
                width: 80,
                render: (_: any, r: any) => r.pageIndex ?? r.page_index,
              },
              {
                title: '合成时显示数字人',
                render: (_: any, r: any) => {
                  const pageIndex = r.pageIndex ?? r.page_index;
                  const visible = (r.avatarVisible ?? r.avatar_visible ?? 1) !== 0;
                  return (
                    <Switch
                      checked={!!visible}
                      disabled={isComposing}
                      onChange={(v) => void togglePageVisible(pageIndex, v)}
                    />
                  );
                },
              },
              {
                title: '布局预览',
                width: 100,
                render: (_: any, r: any) => (
                  <Button
                    size="small"
                    type="link"
                    onClick={() => setPreviewPage(r.pageIndex ?? r.page_index)}
                  >
                    查看此页
                  </Button>
                ),
              },
              {
                title: '状态',
                width: 100,
                render: () => <Tag color="success">已生成</Tag>,
              },
            ]}
          />
        )}
        {avatarPages.length === 0 && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message="尚未生成数字人视频。可返回上一步生成，或直接合成纯幻灯片+配音视频。"
          />
        )}
      </Card>

      {(currentProject?.videoStatus === 'none' || !currentProject?.videoStatus || currentProject?.videoStatus === 'pending') && (
        <Card style={{ marginBottom: 16 }}>
          <Title level={5} style={{ marginTop: 0 }}>视频合成配置</Title>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Text>允许静音页</Text>
              <Switch checked={allowSilentPages} onChange={handleAllowSilentChange} />
              <Text type="secondary">（无备注的页面将以静音方式加入视频）</Text>
            </div>
            {allowSilentPages && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Text>静音页默认时长(秒)</Text>
                <InputNumber
                  min={1}
                  max={30}
                  value={defaultSilentPageDuration}
                  onChange={handleDurationChange}
                  size="small"
                  style={{ width: 80 }}
                />
              </div>
            )}
            {silentPages.length > 0 && (
              <Text type="secondary">检测到 {silentPages.length} 个静音页：第 {silentPageNumbers.join('、')} 页</Text>
            )}
            {blockCompose && (
              <Alert
                type="warning"
                showIcon
                icon={<WarningOutlined />}
                message="存在静音页且未开启允许静音页，无法合成视频"
              />
            )}
          </Space>
        </Card>
      )}

      <Card>
        <Title level={4}>讲解视频预览</Title>

        {(currentProject?.videoStatus === 'none' || !currentProject?.videoStatus || currentProject?.videoStatus === 'pending') && (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <Space direction="vertical" size={12}>
              <Button type="primary" size="large" icon={<PlayCircleOutlined />} onClick={handleCompose} loading={isComposing} disabled={blockCompose}>
                按当前布局合成讲解视频
              </Button>
              <Button onClick={() => navigate(`/project/${id}/avatar`)}>上一步：生成数字人</Button>
            </Space>
          </div>
        )}

        {currentProject?.videoStatus === 'generating' && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" style={{ marginBottom: 16 }} />
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ fontSize: 16 }}>
                {composeProgress?.stage ? STAGE_LABELS[composeProgress.stage] || '合成中...' : '视频合成中...'}
              </Text>
            </div>
            {composeProgress && (
              <div style={{ marginBottom: 16, maxWidth: 400, margin: '0 auto' }}>
                <Progress
                  percent={composeProgress.totalPages > 0
                    ? Math.round((composeProgress.currentPage / composeProgress.totalPages) * 100)
                    : 0}
                  status="active"
                  format={() => `${composeProgress.currentPage}/${composeProgress.totalPages}`}
                />
              </div>
            )}
            <div style={{ marginBottom: 16 }}>
              <ClockCircleOutlined /> <Text type="secondary">已用时 {formatElapsed(elapsedSeconds)}</Text>
            </div>
            <Button danger icon={<StopOutlined />} onClick={() => void handleCancelCompose()}>
              取消合成
            </Button>
          </div>
        )}

        {currentProject?.videoStatus === 'success' && videoUrl && (
          <div style={{ textAlign: 'center' }}>
            <video src={videoUrl} controls style={{ width: '100%', maxHeight: 500, borderRadius: 8 }} />
            <Space style={{ marginTop: 16 }} wrap>
              <Button onClick={() => navigate(`/project/${id}/avatar`)}>上一步：生成数字人</Button>
              <Button icon={<ReloadOutlined />} onClick={handleRetry}>按当前布局重新合成</Button>
              <Button type="primary" icon={<EditOutlined />} onClick={() => navigate(`/project/${id}/editor`)}>
                进入编辑
              </Button>
            </Space>
          </div>
        )}

        {currentProject?.videoStatus === 'failed' && (
          <div style={{ textAlign: 'center', padding: '80px 0' }}>
            <Text type="danger" style={{ display: 'block', marginBottom: 8 }}>视频合成失败</Text>
            {composeProgress?.error && (
              <Alert type="error" showIcon style={{ maxWidth: 640, margin: '0 auto 16px', textAlign: 'left' }} message={composeProgress.error} />
            )}
            <Space>
              <Button onClick={() => navigate(`/project/${id}/avatar`)}>上一步：生成数字人</Button>
              <Button type="primary" icon={<ReloadOutlined />} onClick={handleRetry}>重试</Button>
            </Space>
          </div>
        )}
      </Card>
    </div>
  );
};

export default VideoPreviewPage;

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Steps, Table, Tag, Button, Space, Typography, message, Progress, Alert, Modal } from 'antd';
import { PlayCircleOutlined, PauseOutlined, SoundOutlined, ReloadOutlined, StopOutlined, FileTextOutlined, DownloadOutlined } from '@ant-design/icons';
import { useProjectStore } from '../../stores/projectStore';
import { NoteStatus, DubbingStatus } from '../../types';
import { DUBBING_STATUS_LABELS } from '../../constants';
import { PPT_STEP, PPT_WORKFLOW_STEPS } from '../../constants/workflowSteps';
import { analytics, AnalyticsEvents } from '../../utils/analytics';
import { useAutoSave } from '../../hooks/useAutoSave';
import { projectApi, withToken } from '../../api';

const { Title, Text } = Typography;

function formatLogTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

const LOG_COLOR: Record<string, string> = {
  info: '#9cdcfe',
  success: '#6a9955',
  warn: '#dcdcaa',
  error: '#f44747',
};

const DubbingPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    currentProject, slides, dubbingSummary,
    startDubbing, retryDubbing, loadDubbingStatus,
    playPage, stopPlayback, currentPlayingPageIndex,
    loadProject, loadSlides,
  } = useProjectStore();
  const [isGenerating, setIsGenerating] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [errorLogModal, setErrorLogModal] = useState<{ open: boolean; pageIndex: number | null; content: string }>({ open: false, pageIndex: null, content: '' });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Full preview state
  const [fullPreviewPlaying, setFullPreviewPlaying] = useState(false);
  const [fullPreviewPaused, setFullPreviewPaused] = useState(false);
  const [currentPreviewPage, setCurrentPreviewPage] = useState<number>(0);
  const [failedPreviewPage, setFailedPreviewPage] = useState<number | null>(null);
  const generatedSlidesRef = useRef<any[]>([]);

  const saveState = useAutoSave(id, {
    selectedVoiceId: currentProject?.selectedVoiceId,
    selectedModelId: currentProject?.selectedModelId,
  });

  // Polling — self-managing lifecycle, decoupled from slides state
  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return; // already polling
    pollingRef.current = setInterval(async () => {
      if (!id) return;
      // Always refresh slides so each completed page shows up in real time
      await loadSlides(id);
      await loadDubbingStatus(id);
      // Decide whether to keep polling based on the latest dubbing summary.
      // read directly from the store to avoid stale closure.
      const summary = useProjectStore.getState().dubbingSummary;
      const stillActive = !!summary?.active || (summary?.generating || 0) > 0;
      if (summary && !stillActive) {
        // No more pages generating — generation finished (success or failed).
        stopPolling();
        setIsGenerating(false);
      }
    }, 2000);
  }, [id, loadSlides, loadDubbingStatus, stopPolling]);

  // Load project data on mount + auto-resume polling if generation already in progress
  useEffect(() => {
    if (!id) return;
    let mounted = true;
    (async () => {
      await loadProject(id);
      await loadSlides(id);
      await loadDubbingStatus(id);
      if (!mounted) return;
      // Auto-resume if backend already has pages generating (e.g. user navigated away and back)
      const summary = useProjectStore.getState().dubbingSummary;
      if (summary && (summary.active || summary.generating > 0)) {
        setIsGenerating(true);
        startPolling();
      }
    })();
    return () => {
      mounted = false;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const progressInfo = dubbingSummary?.progress || null;
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [progressInfo?.logs?.length, progressInfo?.message]);

  const handleGenerateAll = async () => {
    if (!id) return;
    setIsGenerating(true);
    try {
      analytics.track(AnalyticsEvents.NARRATION_GENERATE_START, { projectId: id });
      await startDubbing(id);
      message.info('配音生成已启动，请稍候...');
      // Start polling immediately. The poll callback self-stops when generating === 0.
      startPolling();
    } catch (error: any) {
      analytics.track(AnalyticsEvents.NARRATION_GENERATE_FAIL, { projectId: id, error: error.message });
      message.error('配音生成失败：' + (error.response?.data?.error?.message || error.message));
      setIsGenerating(false);
    }
  };

  const handleRetry = async (pageIndex: number) => {
    if (!id) return;
    const slide = slides.find((s: any) => s.pageIndex === pageIndex);
    const alreadyGenerated = slide?.dubbingStatus === DubbingStatus.GENERATED;

    const doRegen = async () => {
      try {
        await retryDubbing(id, pageIndex);
        message.info(`第 ${pageIndex} 页配音重新生成已启动`);
        setIsGenerating(true);
        startPolling();
      } catch (error: any) {
        message.error(error.response?.data?.error?.message || '重新生成失败');
      }
    };

    if (alreadyGenerated) {
      Modal.confirm({
        title: `重新生成第 ${pageIndex} 页配音？`,
        content: '将覆盖该页现有配音音频。',
        okText: '重新生成',
        cancelText: '取消',
        onOk: doRegen,
      });
      return;
    }
    await doRegen();
  };

  const handleCancel = () => {
    if (!id) return;
    stopPolling();
    setIsGenerating(false);
    // Reset generating slides to pending
    const { cancelDubbing } = useProjectStore.getState();
    cancelDubbing(id);
    message.info('已取消配音生成');
  };

  const handlePlayPage = (pageIndex: number) => {
    if (currentPlayingPageIndex === pageIndex) {
      stopPlayback();
      return;
    }
    analytics.track(AnalyticsEvents.NARRATION_PREVIEW_PLAY, { pageIndex });
    playPage(pageIndex);
  };

  const handleDownloadPage = async (pageIndex: number) => {
    if (!id) return;
    try {
      await projectApi.downloadSlideAudio(id, pageIndex);
      message.success(`第 ${pageIndex} 页音频已开始下载`);
    } catch (err: any) {
      message.error(err?.message || '下载失败');
    }
  };

  const handleDownloadAll = async () => {
    if (!id) return;
    const generated = slides.filter((s: any) => s.dubbingStatus === DubbingStatus.GENERATED);
    if (generated.length === 0) {
      message.warning('暂无已生成的音频');
      return;
    }
    setDownloadingAll(true);
    let hide = message.loading(`正在下载 0/${generated.length}…`, 0);
    let ok = 0;
    try {
      for (const slide of generated) {
        await projectApi.downloadSlideAudio(id, slide.pageIndex);
        ok += 1;
        hide();
        if (ok < generated.length) {
          hide = message.loading(`正在下载 ${ok}/${generated.length}…`, 0);
          // 避免浏览器拦截连续下载
          await new Promise((r) => setTimeout(r, 350));
        }
      }
      message.success(`已下载 ${ok} 个音频文件`);
    } catch (err: any) {
      hide();
      message.error(err?.message || `下载中断（已完成 ${ok}/${generated.length}）`);
    } finally {
      setDownloadingAll(false);
    }
  };

  // --- Full preview sequential playback ---
  const stopFullPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    setFullPreviewPlaying(false);
    setFullPreviewPaused(false);
    setCurrentPreviewPage(0);
  }, []);

  const playAudioForPage = useCallback((pageIndex: number) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
    }
    const audio = new Audio(withToken(`/api/v1/projects/${id}/slides/${pageIndex}/audio`));
    audioRef.current = audio;
    setFailedPreviewPage(null);

    audio.play().catch(() => {
      message.error(`第${pageIndex}页音频加载失败`);
      setFailedPreviewPage(pageIndex);
      stopFullPreview();
    });

    audio.onended = () => {
      const currentIdx = slides.findIndex((s: any) => s.pageIndex === pageIndex);
      for (let i = currentIdx + 1; i < slides.length; i++) {
        if (slides[i].dubbingStatus === DubbingStatus.GENERATED) {
          setCurrentPreviewPage(slides[i].pageIndex);
          playAudioForPage(slides[i].pageIndex);
          return;
        }
      }
      // No more pages
      stopFullPreview();
    };
  }, [id, slides, stopFullPreview]);

  const startFullPreview = () => {
    const generatedSlides = slides.filter((s: any) => s.dubbingStatus === DubbingStatus.GENERATED);
    if (generatedSlides.length === 0) {
      message.warning('暂无可播放的配音');
      return;
    }
    generatedSlidesRef.current = generatedSlides;
    setFullPreviewPlaying(true);
    setFullPreviewPaused(false);
    setCurrentPreviewPage(generatedSlides[0].pageIndex);
    playAudioForPage(generatedSlides[0].pageIndex);
  };

  const toggleFullPreviewPause = () => {
    if (!audioRef.current) return;
    if (fullPreviewPaused) {
      audioRef.current.play().catch(() => {});
      setFullPreviewPaused(false);
    } else {
      audioRef.current.pause();
      setFullPreviewPaused(true);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.onended = null;
        audioRef.current = null;
      }
      stopPolling();
    };
  }, []);

  const canGenerate = currentProject?.selectedVoiceId && currentProject?.selectedModelId;
  const allDubbed = slides.filter((s: any) => s.noteStatus === NoteStatus.LOADED)
    .every((s: any) => s.dubbingStatus === DubbingStatus.GENERATED);

  // Progress calculation — prefer run progress when available
  const totalToGenerate = progressInfo?.totalToGenerate || dubbingSummary?.total || 0;
  const completedCount = progressInfo
    ? progressInfo.completedCount
    : (dubbingSummary?.generated || 0);
  const progressPercent = totalToGenerate > 0 ? Math.round((completedCount / totalToGenerate) * 100) : 0;
  const showProgressPanel = isGenerating || !!progressInfo?.logs?.length;

  const columns = [
    {
      title: '页码',
      dataIndex: 'pageIndex',
      key: 'pageIndex',
      width: 80,
      render: (pageIndex: number) => {
        const isCurrent = isGenerating && (
          progressInfo?.activePages?.includes(pageIndex)
          || progressInfo?.currentPageIndex === pageIndex
        );
        return (
          <span>
            {pageIndex}
            {isCurrent ? <Tag color="processing" style={{ marginLeft: 6 }}>当前</Tag> : null}
          </span>
        );
      },
    },
    {
      title: '备注摘要',
      dataIndex: 'noteContent',
      key: 'noteContent',
      ellipsis: true,
      width: 200,
    },
    {
      title: '配音状态',
      dataIndex: 'dubbingStatus',
      key: 'dubbingStatus',
      width: 160,
      render: (status: string, record: any) => {
        const label = DUBBING_STATUS_LABELS[status] || { text: status, color: 'default' };
        const isCurrent = isGenerating && (
          progressInfo?.activePages?.includes(record.pageIndex)
          || progressInfo?.currentPageIndex === record.pageIndex
        );
        return (
          <Space size={4} wrap>
            <Tag color={isCurrent ? 'processing' : label.color}>{label.text}</Tag>
            {isCurrent && progressInfo?.waitSeconds ? (
              <Text type="secondary" style={{ fontSize: 12 }}>已等 {progressInfo.waitSeconds}s</Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '时长',
      dataIndex: 'dubbingDuration',
      key: 'dubbingDuration',
      width: 80,
      render: (duration: number | null) => duration ? `${duration.toFixed(1)}s` : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 300,
      render: (_: any, record: any) => {
        const isPageGenerating = record.dubbingStatus === DubbingStatus.GENERATING
          || record.dubbingStatus === DubbingStatus.REGENERATE_PENDING
          || (isGenerating && (
            progressInfo?.activePages?.includes(record.pageIndex)
            || progressInfo?.currentPageIndex === record.pageIndex
          ));
        const canRegenPage = record.noteStatus === NoteStatus.LOADED && !isPageGenerating;

        return (
          <Space wrap>
            {record.dubbingStatus === DubbingStatus.GENERATED && (
              <>
                <Button
                  size="small"
                  icon={currentPlayingPageIndex === record.pageIndex ? <PauseOutlined /> : <PlayCircleOutlined />}
                  onClick={() => handlePlayPage(record.pageIndex)}
                >
                  {currentPlayingPageIndex === record.pageIndex ? '停止' : '播放'}
                </Button>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={() => handleDownloadPage(record.pageIndex)}
                >
                  下载
                </Button>
              </>
            )}
            {canRegenPage && (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => handleRetry(record.pageIndex)}
              >
                {record.dubbingStatus === DubbingStatus.FAILED ? '重试' : '重新生成'}
              </Button>
            )}
            {record.dubbingStatus === DubbingStatus.FAILED && record.dubbingError && (
              <Button
                size="small"
                type="link"
                icon={<FileTextOutlined />}
                onClick={() => setErrorLogModal({ open: true, pageIndex: record.pageIndex, content: record.dubbingError })}
              >
                日志
              </Button>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px' }}>
      <Steps
        current={PPT_STEP.DUBBING}
        items={[...PPT_WORKFLOW_STEPS]}
        style={{ marginBottom: 24 }}
      />

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Space>
            <Title level={4} style={{ margin: 0 }}>按备注生成配音</Title>
            {saveState.status === 'saving' && <Tag color="processing">正在保存...</Tag>}
            {saveState.status === 'saved' && <Tag color="success">已自动保存</Tag>}
            {saveState.status === 'failed' && <Tag color="error">保存失败，请检查网络</Tag>}
          </Space>
          <Space>
            <Button
              type="primary"
              loading={isGenerating}
              disabled={!canGenerate || isGenerating}
              onClick={handleGenerateAll}
              icon={<SoundOutlined />}
            >
              {isGenerating ? '生成中...' : '按备注生成配音'}
            </Button>
            {isGenerating && (
              <Button
                icon={<StopOutlined />}
                danger
                onClick={handleCancel}
              >
                取消
              </Button>
            )}
            <Button
              disabled={!allDubbed || fullPreviewPlaying}
              onClick={startFullPreview}
              icon={<PlayCircleOutlined />}
            >
              全片试听
            </Button>
            <Button
              disabled={downloadingAll || !slides.some((s: any) => s.dubbingStatus === DubbingStatus.GENERATED)}
              loading={downloadingAll}
              onClick={handleDownloadAll}
              icon={<DownloadOutlined />}
            >
              下载全部音频
            </Button>
          </Space>
        </div>

        {/* Progress bar + live status during generation */}
        {showProgressPanel && (
          <Alert
            type={isGenerating ? 'info' : (progressInfo?.failedCount ? 'warning' : 'success')}
            showIcon
            style={{ marginBottom: 16 }}
            message={
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, gap: 12 }}>
                  <span>
                    {isGenerating
                      ? (progressInfo?.message || '正在生成配音…')
                      : (progressInfo?.message || '配音任务已结束')}
                  </span>
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {completedCount} / {totalToGenerate || '-'} 页
                    {progressInfo?.activePages?.length
                      ? ` · 进行中第 ${progressInfo.activePages.join('、')} 页`
                      : (progressInfo?.currentPage ? ` · 当前第 ${progressInfo.currentPage} 页` : '')}
                    {progressInfo?.concurrency && progressInfo.concurrency > 1
                      ? ` · 并发 ${progressInfo.concurrency}`
                      : ''}
                  </span>
                </div>
                <Progress
                  percent={progressPercent}
                  status={isGenerating ? 'active' : (progressInfo?.failedCount ? 'exception' : 'success')}
                  size="small"
                  format={() => `${completedCount}/${totalToGenerate || 0}`}
                />
                {progressInfo?.taskId && isGenerating && (
                  <div style={{ marginTop: 6 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Voicebox 任务: {progressInfo.taskId}
                      {progressInfo.waitSeconds > 0 ? ` · 已等待 ${progressInfo.waitSeconds}s` : ''}
                    </Text>
                  </div>
                )}
              </div>
            }
            description={
              progressInfo?.logs?.length ? (
                <div
                  style={{
                    marginTop: 8,
                    background: '#1e1e1e',
                    color: '#d4d4d4',
                    padding: '10px 12px',
                    borderRadius: 6,
                    maxHeight: 220,
                    overflow: 'auto',
                    fontSize: 12,
                    lineHeight: 1.55,
                    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                  }}
                >
                  {progressInfo.logs.map((log, idx) => (
                    <div key={`${log.time}-${idx}`} style={{ color: LOG_COLOR[log.level] || '#d4d4d4' }}>
                      <span style={{ color: '#858585', marginRight: 8 }}>[{formatLogTime(log.time)}]</span>
                      {log.message}
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              ) : null
            }
          />
        )}

        {dubbingSummary && (
          <div style={{ marginBottom: 16 }}>
            <Space wrap>
              <Text>总计: {dubbingSummary.total}页</Text>
              <Tag color="green">已生成: {dubbingSummary.generated}</Tag>
              <Tag color="blue">生成中: {dubbingSummary.generating}</Tag>
              <Tag color="red">失败: {dubbingSummary.failed}</Tag>
              <Tag>待生成: {dubbingSummary.pending}</Tag>
              {dubbingSummary.active && <Tag color="processing">任务进行中</Tag>}
            </Space>
          </div>
        )}

        <Table
          dataSource={slides}
          columns={columns}
          rowKey="pageIndex"
          pagination={false}
          size="middle"
          rowClassName={(record: any) =>
            fullPreviewPlaying && record.pageIndex === currentPreviewPage
              ? 'ant-table-row-selected'
              : failedPreviewPage !== null && record.pageIndex === failedPreviewPage
              ? 'ant-table-row-type-danger'
              : isGenerating && (
                progressInfo?.activePages?.includes(record.pageIndex)
                || progressInfo?.currentPageIndex === record.pageIndex
              )
              ? 'ant-table-row-selected'
              : ''
          }
        />
      </Card>

      {/* 当前单页播放音频 */}
      {!fullPreviewPlaying && currentPlayingPageIndex !== null && id && (
        <audio
          src={withToken(`/api/v1/projects/${id}/slides/${currentPlayingPageIndex}/audio`)}
          autoPlay
          onEnded={() => stopPlayback()}
        />
      )}

      {/* 全片试听控制面板 */}
      {fullPreviewPlaying && (
        <Card style={{ marginTop: 16, background: '#f6f8fa' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Space size="large">
              <Text strong>
                {fullPreviewPaused ? '已暂停' : '全片试听中'} - 第 {currentPreviewPage} 页
              </Text>
              {failedPreviewPage !== null && (
                <Tag color="error">第{failedPreviewPage + 1}页加载失败</Tag>
              )}
            </Space>
            <Space>
              <Button
                icon={fullPreviewPaused ? <PlayCircleOutlined /> : <PauseOutlined />}
                onClick={toggleFullPreviewPause}
              >
                {fullPreviewPaused ? '继续' : '暂停'}
              </Button>
              <Button
                icon={<StopOutlined />}
                danger
                onClick={stopFullPreview}
              >
                停止
              </Button>
            </Space>
          </div>
          <div style={{ marginTop: 12 }}>
            <Progress
              percent={
                (() => {
                  const generated = slides.filter((s: any) => s.dubbingStatus === DubbingStatus.GENERATED);
                  const currentIdx = generated.findIndex((s: any) => s.pageIndex === currentPreviewPage);
                  return generated.length > 0 ? Math.round(((currentIdx + 1) / generated.length) * 100) : 0;
                })()
              }
              format={() => {
                const generated = slides.filter((s: any) => s.dubbingStatus === DubbingStatus.GENERATED);
                const currentIdx = generated.findIndex((s: any) => s.pageIndex === currentPreviewPage);
                return `${currentIdx + 1} / ${generated.length} 页`;
              }}
              size="small"
            />
          </div>
        </Card>
      )}

      <div style={{ marginTop: 24, textAlign: 'center' }}>
        <Space>
          <Button onClick={() => navigate(`/project/${id}/voice`)}>上一步</Button>
          <Button
            type="primary"
            size="large"
            disabled={!allDubbed}
            onClick={() => navigate(`/project/${id}/avatar`)}
          >
            下一步：生成数字人
          </Button>
        </Space>
      </div>

      {/* 失败日志弹窗 */}
      <Modal
        title={`配音失败日志 — 第 ${errorLogModal.pageIndex ?? '-'} 页`}
        open={errorLogModal.open}
        onCancel={() => setErrorLogModal({ open: false, pageIndex: null, content: '' })}
        footer={[
          <Button key="close" onClick={() => setErrorLogModal({ open: false, pageIndex: null, content: '' })}>
            关闭
          </Button>,
          <Button
            key="copy"
            type="primary"
            onClick={() => {
              navigator.clipboard.writeText(errorLogModal.content).then(
                () => message.success('日志已复制到剪贴板'),
                () => message.error('复制失败'),
              );
            }}
          >
            复制日志
          </Button>,
        ]}
        width={720}
      >
        <pre style={{
          background: '#1e1e1e',
          color: '#d4d4d4',
          padding: 16,
          borderRadius: 6,
          maxHeight: '60vh',
          overflow: 'auto',
          fontSize: 12,
          lineHeight: 1.6,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          margin: 0,
        }}>
          {errorLogModal.content || '无日志内容'}
        </pre>
      </Modal>
    </div>
  );
};

export default DubbingPage;

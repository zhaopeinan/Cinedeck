import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert, Button, Card, Checkbox, Modal, Progress, Space, Steps, Table, Tag, Typography, message,
} from 'antd';
import { PictureOutlined, StopOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useProjectStore } from '../../stores/projectStore';
import { projectApi } from '../../api';
import { PPT_STEP, PPT_WORKFLOW_STEPS } from '../../constants/workflowSteps';
import type { AvatarDriveMode } from '../../api';
import { DubbingStatus } from '../../types';
import {
  AvatarDriveModePicker,
  AvatarPhotoUpload,
  AvatarRefLibraryPanel,
  useAvatarRefs,
} from '../../components/avatar';

const { Title, Text, Paragraph } = Typography;

const AVATAR_STATUS_LABEL: Record<string, { text: string; color: string }> = {
  none: { text: '未生成', color: 'default' },
  pending: { text: '等待中', color: 'default' },
  caching: { text: '缓存配音', color: 'processing' },
  queued: { text: '排队中', color: 'processing' },
  running: { text: '生成中', color: 'processing' },
  generated: { text: '已生成', color: 'success' },
  failed: { text: '失败', color: 'error' },
  skipped: { text: '已跳过', color: 'default' },
};

const ProjectAvatarPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { slides, loadProject, loadSlides } = useProjectStore();
  const [driveMode, setDriveMode] = useState<AvatarDriveMode>('video');
  const { refs, setRefs, loadRefs } = useAvatarRefs({ autoLoad: false });
  const [refVideoId, setRefVideoId] = useState<string | null>(null);
  const [hasPhoto, setHasPhoto] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<any>(null);
  const [previewPage, setPreviewPage] = useState<number | null>(null);
  const pollRef = useRef<number | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  const dubbedPages = slides.filter((s: any) =>
    (s.dubbingStatus || s.dubbing_status) === DubbingStatus.GENERATED
    || (s.dubbingStatus || s.dubbing_status) === 'generated',
  );

  const refreshSettings = useCallback(async () => {
    if (!id) return;
    const [settingsRes, refsList] = await Promise.all([
      projectApi.getAvatarSettings(id),
      loadRefs(),
    ]);
    const data = settingsRes.data.data;
    setDriveMode((data.driveMode || 'video') as AvatarDriveMode);
    setRefVideoId(data.refVideoId || null);
    setHasPhoto(!!data.hasPhoto);
    setRefs(refsList);
    setProgress(data.progress);
    setGenerating(!!data.running || data.progress?.status === 'running');
  }, [id, loadRefs, setRefs]);

  useEffect(() => {
    if (!id) return;
    void loadProject(id);
    void loadSlides(id);
    void refreshSettings()
      .then((_) => undefined)
      .catch((e) => message.error(e.response?.data?.error?.message || '加载失败'));
  }, [id]);

  // resume progress polling after refresh if job still running
  useEffect(() => {
    if (!id) return;
    if (generating && progress?.status === 'running' && !pollRef.current) {
      startPoll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, generating, progress?.status]);

  useEffect(() => {
    // default select all dubbed pages that are not skipped
    const pages = dubbedPages
      .filter((s: any) => {
        const enabled = s.avatarEnabled ?? s.avatar_enabled;
        const status = s.avatarStatus ?? s.avatar_status;
        if (status === 'skipped') return false;
        return enabled === undefined || enabled === 1 || enabled === true;
      })
      .map((s: any) => s.pageIndex ?? s.page_index);
    setSelected(pages);
  }, [slides.length]);

  const stopPoll = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPoll = () => {
    stopPoll();
    let tick = 0;
    pollRef.current = window.setInterval(async () => {
      if (!id) return;
      try {
        const res = await projectApi.getAvatarProgress(id);
        const p = res.data.data;
        setProgress(p);
        tick += 1;
        // refresh slide statuses every poll so table shows per-page state
        if (tick % 1 === 0) await loadSlides(id);
        if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled') {
          stopPoll();
          setGenerating(false);
          await loadSlides(id);
          if (p.status === 'cancelled') {
            message.info(p.message || '已取消数字人生成');
          } else if (p.status === 'completed' && !(p.failed > 0)) {
            message.success(p.message || '数字人生成完成');
          } else {
            message.warning(p.message || '数字人生成结束（含失败）');
          }
        }
      } catch {
        // ignore
      }
    }, 1500);
  };

  useEffect(() => () => stopPoll(), []);

  const saveDriveMode = async (mode: AvatarDriveMode) => {
    if (!id) return;
    setDriveMode(mode);
    await projectApi.updateAvatarSettings(id, { driveMode: mode });
  };

  const saveRef = async (rid: string) => {
    if (!id) return;
    setRefVideoId(rid);
    await projectApi.updateAvatarSettings(id, { refVideoId: rid });
  };

  const handleGenerate = async (pageIndexes?: number[]) => {
    if (!id) return;
    if (driveMode === 'video' && !refVideoId) {
      message.warning('请先选择参考视频');
      return;
    }
    if (driveMode === 'photo' && !hasPhoto) {
      message.warning('请先上传静照');
      return;
    }
    const pages = pageIndexes || selected;
    if (!pages.length) {
      message.warning('请至少勾选一页');
      return;
    }
    const singlePage = !!pageIndexes && pageIndexes.length === 1;
    setGenerating(true);
    try {
      // Only touch pages being generated. Do NOT mark other pages as skipped
      // (that previously wiped P1 status when regenerating P19).
      await projectApi.updateAvatarPages(
        id,
        pages.map((pageIndex) => ({
          pageIndex,
          enabled: true,
          visible: true,
        })),
      );
      await projectApi.generateAvatar(id, {
        pageIndexes: pages,
        // bulk checkbox run may hide unselected; single-page regen must not
        markSkipped: !singlePage && !pageIndexes,
      });
      startPoll();
      message.info(singlePage ? `已开始生成第 ${pages[0]} 页` : '已开始生成，将独占 GPU');
    } catch (err: any) {
      setGenerating(false);
      message.error(err.response?.data?.error?.message || '启动失败');
    }
  };

  const handleCancel = async () => {
    if (!id) return;
    try {
      await projectApi.cancelAvatar(id);
      message.info('已请求取消，当前页处理完后停止');
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '取消失败');
    }
  };

  const isPageGenerated = (r: any) => {
    const pageIndex = r.pageIndex ?? r.page_index;
    const live = (progress?.pages || []).find((p: any) => p.pageIndex === pageIndex);
    let st = live?.status || r.avatarStatus || r.avatar_status || 'none';
    if (st === 'skipped' && (r.avatarVideoPath || r.avatar_video_path)) st = 'generated';
    return st === 'generated' || !!(r.avatarVideoPath || r.avatar_video_path);
  };

  const openPreview = (pageIndex: number) => {
    setPreviewPage(pageIndex);
  };

  const closePreview = () => {
    if (previewVideoRef.current) {
      previewVideoRef.current.pause();
      previewVideoRef.current.removeAttribute('src');
      previewVideoRef.current.load();
    }
    setPreviewPage(null);
  };

  const previewVideoUrl =
    id && previewPage != null
      ? `${projectApi.getAvatarPageVideoUrl(id, previewPage)}&t=${Date.now()}`
      : '';

  const columns = [
    {
      title: '选择',
      width: 70,
      render: (_: any, record: any) => {
        const pageIndex = record.pageIndex ?? record.page_index;
        return (
          <Checkbox
            checked={selected.includes(pageIndex)}
            disabled={generating}
            onChange={(e) => {
              setSelected((prev) =>
                e.target.checked ? [...prev, pageIndex] : prev.filter((p) => p !== pageIndex),
              );
            }}
          />
        );
      },
    },
    {
      title: '页码',
      width: 80,
      render: (_: any, r: any) => r.pageIndex ?? r.page_index,
    },
    {
      title: '备注',
      ellipsis: true,
      dataIndex: 'noteContent',
      render: (v: any, r: any) => v || r.note_content || '-',
    },
    {
      title: '数字人状态',
      width: 120,
      render: (_: any, r: any) => {
        const pageIndex = r.pageIndex ?? r.page_index;
        const live = (progress?.pages || []).find((p: any) => p.pageIndex === pageIndex);
        let st = live?.status || r.avatarStatus || r.avatar_status || 'none';
        // File still on disk but status was wrongly marked skipped
        if (st === 'skipped' && (r.avatarVideoPath || r.avatar_video_path)) {
          st = 'generated';
        }
        const meta = AVATAR_STATUS_LABEL[st] || { text: st, color: 'default' };
        const pct = live?.percent;
        return (
          <Space size={4}>
            <Tag color={meta.color}>{meta.text}</Tag>
            {st === 'running' && typeof pct === 'number' ? (
              <Text type="secondary" style={{ fontSize: 12 }}>{pct}%</Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '本页进度',
      width: 260,
      ellipsis: true,
      render: (_: any, r: any) => {
        const pageIndex = r.pageIndex ?? r.page_index;
        const live = (progress?.pages || []).find((p: any) => p.pageIndex === pageIndex);
        const err = live?.error || r.avatarError || r.avatar_error;
        if (live?.message) {
          return (
            <Text type={err ? 'danger' : 'secondary'}>
              {typeof live.percent === 'number' && live.status === 'running'
                ? `${live.message}`
                : live.message}
            </Text>
          );
        }
        if (err) return <Text type="danger" title={err}>{String(err).slice(0, 80)}</Text>;
        return <Text type="secondary">—</Text>;
      },
    },
    {
      title: '操作',
      width: 200,
      render: (_: any, r: any) => {
        const pageIndex = r.pageIndex ?? r.page_index;
        const canPreview = isPageGenerated(r);
        return (
          <Space size={4}>
            <Button
              size="small"
              type={canPreview ? 'link' : 'default'}
              icon={<PlayCircleOutlined />}
              disabled={!canPreview}
              onClick={() => openPreview(pageIndex)}
            >
              预览
            </Button>
            <Button
              size="small"
              disabled={generating}
              onClick={() => void handleGenerate([pageIndex])}
            >
              仅生成此页
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <Steps current={PPT_STEP.AVATAR} items={[...PPT_WORKFLOW_STEPS]} style={{ marginBottom: 24 }} />

      <Card>
        <Title level={4} style={{ marginTop: 0 }}>生成数字人（Duix）</Title>
        <Paragraph type="secondary">
          整份 PPT 统一驱动方式与素材；可勾选部分页生成，未勾选页将跳过。生成期间会独占 GPU。
        </Paragraph>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="也可完全跳过本步，直接进入视频预览（仅幻灯片+配音，无数字人）。"
        />

        <div style={{ marginBottom: 16 }}>
          <Text strong>驱动方式（整份统一）</Text>
          <div style={{ marginTop: 8 }}>
            <AvatarDriveModePicker
              value={driveMode}
              disabled={generating}
              showHint={false}
              labels={{ video: '视频模仿', photo: '静照口型' }}
              onChange={(mode) => void saveDriveMode(mode)}
            />
          </div>
        </div>

        {driveMode === 'video' ? (
          <AvatarRefLibraryPanel
            mode="pick"
            cardSize="small"
            refs={refs}
            selectedId={refVideoId}
            disabled={generating}
            style={{ marginBottom: 16 }}
            onSelect={(rid) => void saveRef(rid)}
            onRefsChange={setRefs}
            onManageLibrary={() => navigate('/avatar')}
          />
        ) : (
          <Card size="small" title={<Space><PictureOutlined /> 静照（整份共用）</Space>} style={{ marginBottom: 16 }}>
            <Space wrap>
              <AvatarPhotoUpload
                variant="button"
                disabled={generating}
                hasExisting={hasPhoto}
                onFile={(file) => {
                  if (!id) return;
                  void projectApi.uploadAvatarPhoto(id, file).then(() => {
                    setHasPhoto(true);
                    message.success('静照已上传');
                  }).catch((err) => message.error(err.response?.data?.error?.message || '上传失败'));
                }}
              />
              {hasPhoto && <Tag color="success">已设置</Tag>}
            </Space>
          </Card>
        )}

        {(generating || progress?.status === 'running' || (progress?.pages || []).length > 0) && progress?.status !== 'idle' && (
          <Alert
            style={{ marginBottom: 16 }}
            type={progress?.status === 'failed' ? 'error' : progress?.status === 'completed' && progress?.failed ? 'warning' : 'info'}
            showIcon
            message={progress?.message || '生成中…'}
            description={
              <div>
                <Progress
                  percent={
                    typeof progress?.percent === 'number'
                      ? progress.percent
                      : (progress?.total
                        ? Math.round((((progress.completed || 0) + (progress.failed || 0)) / progress.total) * 100)
                        : 0)
                  }
                  status={progress?.status === 'running' ? 'active' : progress?.failed ? 'exception' : 'success'}
                  format={(pct) => `${pct ?? 0}% · 成功 ${progress?.completed || 0} / 失败 ${progress?.failed || 0} / 共 ${progress?.total || 0}`}
                />
                {(progress?.pages || []).length > 0 && (
                  <div style={{ marginTop: 8, maxHeight: 160, overflow: 'auto' }}>
                    {(progress.pages as any[]).map((p) => {
                      const meta = AVATAR_STATUS_LABEL[p.status] || { text: p.status, color: 'default' };
                      return (
                        <div key={p.pageIndex} style={{ fontSize: 12, marginBottom: 4 }}>
                          <Tag color={meta.color} style={{ marginInlineEnd: 8 }}>
                            第 {p.pageIndex} 页 · {meta.text}
                            {typeof p.percent === 'number' && p.status === 'running' ? ` ${p.percent}%` : ''}
                          </Tag>
                          <Text type={p.error ? 'danger' : 'secondary'}>
                            {p.error || p.message || ''}
                          </Text>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            }
          />
        )}

        <Space style={{ marginBottom: 12 }}>
          <Button
            type="primary"
            loading={generating}
            disabled={!dubbedPages.length || generating}
            onClick={() => void handleGenerate()}
          >
            {generating ? '生成中...' : '生成勾选页'}
          </Button>
          {generating && (
            <Button danger icon={<StopOutlined />} onClick={() => void handleCancel()}>
              取消生成
            </Button>
          )}
          <Button
            disabled={generating || !dubbedPages.length}
            onClick={() => {
              setSelected(dubbedPages.map((s: any) => s.pageIndex ?? s.page_index));
            }}
          >
            全选已配音页
          </Button>
          <Button disabled={generating} onClick={() => setSelected([])}>清空选择</Button>
        </Space>

        <Table
          rowKey={(r: any) => String(r.pageIndex ?? r.page_index)}
          dataSource={dubbedPages}
          columns={columns as any}
          pagination={false}
          size="small"
        />
      </Card>

      <Modal
        title={previewPage != null ? `预览第 ${previewPage} 页数字人（含配音）` : '预览'}
        open={previewPage != null}
        onCancel={closePreview}
        footer={[
          <Button key="close" onClick={closePreview}>关闭</Button>,
        ]}
        width={720}
        destroyOnClose
        afterOpenChange={(open) => {
          if (open && previewVideoRef.current) {
            void previewVideoRef.current.play().catch(() => undefined);
          }
        }}
      >
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          播放生成的数字人视频（已带配音音轨），可直接核对口型是否对齐。
        </Paragraph>
        {previewVideoUrl ? (
          <video
            key={previewVideoUrl}
            ref={previewVideoRef}
            src={previewVideoUrl}
            controls
            playsInline
            style={{ width: '100%', maxHeight: 480, background: '#111', borderRadius: 8 }}
          />
        ) : null}
      </Modal>

      <div style={{ marginTop: 24, textAlign: 'center' }}>
        <Space>
          <Button onClick={() => navigate(`/project/${id}/dubbing`)}>上一步：生成配音</Button>
          <Button onClick={() => navigate(`/project/${id}/preview`)}>
            跳过数字人，去视频预览
          </Button>
          <Button type="primary" onClick={() => navigate(`/project/${id}/preview`)}>
            下一步：视频预览（布局+合成）
          </Button>
        </Space>
      </div>
    </div>
  );
};

export default ProjectAvatarPage;

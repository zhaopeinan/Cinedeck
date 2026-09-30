import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Checkbox, Col, Divider, Form, InputNumber, Modal, Progress, Radio, Row,
  Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography, Upload, message,
} from 'antd';
import {
  CloudUploadOutlined, DeleteOutlined, DownloadOutlined, ExclamationCircleOutlined, PlayCircleOutlined, PlusOutlined,
  ReloadOutlined, RocketOutlined, StopOutlined,
} from '@ant-design/icons';
import { moocApi, videoApi, voiceboxApi } from '../../api';
import AvatarPipEditor from '../../components/AvatarPipEditor';
import { ModelSelectField, VoiceSelectField } from '../../components/voicebox';
import { AvatarRefLibraryPanel, useAvatarRefs } from '../../components/avatar';
import { DEFAULT_AVATAR_LAYOUT } from '../../constants/avatarDefaults';
import { countPptxSlides } from '../../utils/pptxSlideCount';
import { isTtsModel } from '../../utils/voiceboxModels';
import type { AvatarLayout } from '../../types';

const { Title, Text, Paragraph } = Typography;

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  creating: '创建项目',
  parsing: '解析 PPT',
  script: '生成解说词',
  dubbing: '生成配音',
  avatar: '生成数字人',
  compose: '合成视频',
  done: '已完成',
  failed: '失败',
};

const STATUS_COLOR: Record<string, string> = {
  queued: 'default',
  running: 'processing',
  success: 'success',
  failed: 'error',
  cancelled: 'warning',
};

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};

function truncateText(s: string, max = 28) {
  if (!s) return '-';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

type SubmitMode = 'single' | 'batch';

function buildMoocFormData(
  pptFile: File,
  values: Record<string, any>,
  opts: {
    photo: File | null;
    avatarPages: number[];
    layout: AvatarLayout;
    avatarFirstPageOnly?: boolean;
  },
): FormData {
  const fd = new FormData();
  fd.append('file', pptFile);
  fd.append('target_duration', String(values.targetDuration ?? 0));
  fd.append('use_existing_note', values.useExistingNote ? '1' : '0');
  fd.append('selected_voice_id', values.selectedVoiceId);
  fd.append('selected_model_id', values.selectedModelId);
  fd.append('enable_avatar', values.enableAvatar ? '1' : '0');
  fd.append('avatar_drive_mode', values.avatarDriveMode || 'video');
  if (values.avatarRefVideoId) fd.append('avatar_ref_video_id', values.avatarRefVideoId);
  if (opts.photo) fd.append('photo', opts.photo);
  if (values.enableAvatar) {
    if (opts.avatarFirstPageOnly) {
      fd.append('avatar_first_page_only', '1');
      fd.append('avatar_page_indexes', JSON.stringify([1]));
    } else {
      fd.append('avatar_page_indexes', JSON.stringify(opts.avatarPages));
    }
    fd.append('avatar_layout', JSON.stringify(opts.layout));
  }
  fd.append('allow_silent_pages', values.allowSilentPages ? '1' : '0');
  fd.append('default_silent_page_duration', String(values.defaultSilentPageDuration ?? 5));
  const pauseSec = values.pauseEnabled === false ? 0 : Number(values.pauseDuration ?? 2);
  fd.append('pause_duration', String(Number.isFinite(pauseSec) ? pauseSec : 2));
  const maxRetries = Number(values.maxRetries);
  fd.append('max_retries', String(Number.isFinite(maxRetries) ? Math.max(0, Math.min(20, Math.round(maxRetries))) : 5));
  return fd;
}

const MoocPage: React.FC = () => {
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [submitMode, setSubmitMode] = useState<SubmitMode>('single');
  const [photo, setPhoto] = useState<File | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const [avatarPages, setAvatarPages] = useState<number[]>([]);
  const [layout, setLayout] = useState<AvatarLayout>(DEFAULT_AVATAR_LAYOUT);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [layoutPage, setLayoutPage] = useState(1);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [voices, setVoices] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const { refs, loadRefs } = useAvatarRefs({ autoLoad: false });
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<any[]>([]);
  const [queueInfo, setQueueInfo] = useState<{ hasRunning?: boolean; queuedCount?: number }>({});
  const [errorModal, setErrorModal] = useState<{ open: boolean; title: string; content: string }>({
    open: false, title: '', content: '',
  });
  const pollRef = useRef<number | null>(null);
  const previewReqRef = useRef(0);

  const [form] = Form.useForm();
  const enableAvatar = Form.useWatch('enableAvatar', form);
  const driveMode = Form.useWatch('avatarDriveMode', form);
  const selectedAvatarRefId = Form.useWatch('avatarRefVideoId', form);

  const activePreviewFile = submitMode === 'batch' ? (batchFiles[0] || null) : file;
  const isBatchMode = submitMode === 'batch';
  const avatarFirstPageOnly = isBatchMode && enableAvatar;

  const pageOptions = useMemo(
    () => Array.from({ length: slideCount }, (_, i) => i + 1),
    [slideCount],
  );

  const layoutImageUrl = previewId
    ? moocApi.getPreviewPageUrl(previewId, avatarFirstPageOnly ? 1 : layoutPage)
    : '';

  const resetPreview = () => {
    setPreviewId(null);
    setLayoutPage(1);
    setPreviewError(null);
    setPreviewLoading(false);
  };

  const loadSlidePreview = useCallback(async (f: File) => {
    const reqId = ++previewReqRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await moocApi.previewSlides(f);
      if (reqId !== previewReqRef.current) return;
      const data = res.data.data;
      setPreviewId(data.previewId);
      setSlideCount(data.pageCount);
      setLayoutPage(1);
      const pages = data.pages?.length
        ? data.pages
        : Array.from({ length: data.pageCount }, (_, i) => i + 1);
      setAvatarPages(pages);
      message.success(`已渲染 ${data.pageCount} 页真实幻灯片，可选择一页调整布局`);
    } catch (err: any) {
      if (reqId !== previewReqRef.current) return;
      setPreviewId(null);
      setPreviewError(err.response?.data?.error?.message || err.message || '幻灯片预览失败');
    } finally {
      if (reqId === previewReqRef.current) setPreviewLoading(false);
    }
  }, []);

  const handlePickFile = async (f: File) => {
    if (!f.name.toLowerCase().endsWith('.pptx')) {
      message.error('仅支持 PPTX');
      return;
    }
    setFile(f);
    setBatchFiles([]);
    resetPreview();
    try {
      const n = await countPptxSlides(f);
      setSlideCount(n);
      const pages = Array.from({ length: n }, (_, i) => i + 1);
      setAvatarPages(pages);
      if (!n) message.warning('未能识别页数，开启数字人后将尝试服务端渲染');
    } catch {
      setSlideCount(0);
      setAvatarPages([]);
    }
    if (form.getFieldValue('enableAvatar')) {
      void loadSlidePreview(f);
    }
  };

  const handlePickBatchFiles = async (incoming: File[]) => {
    const valid = incoming.filter((f) => f.name.toLowerCase().endsWith('.pptx'));
    if (!valid.length) {
      message.error('仅支持 PPTX');
      return;
    }
    setFile(null);
    setBatchFiles(valid);
    resetPreview();
    setSlideCount(0);
    setAvatarPages([1]);
    setLayoutPage(1);
    if (form.getFieldValue('enableAvatar') && valid[0]) {
      void loadSlidePreview(valid[0]);
    }
  };

  const handleSubmitModeChange = (mode: SubmitMode) => {
    setSubmitMode(mode);
    resetPreview();
    if (mode === 'batch') {
      setFile(null);
      setSlideCount(0);
      if (form.getFieldValue('enableAvatar')) {
        setAvatarPages([1]);
        setLayoutPage(1);
        if (batchFiles[0]) void loadSlidePreview(batchFiles[0]);
      }
    } else {
      setBatchFiles([]);
    }
  };

  // 开启数字人且已有文件时，自动渲染真实幻灯片（失败后需手动重试，避免死循环）
  useEffect(() => {
    if (!enableAvatar || !activePreviewFile) return;
    if (previewId || previewLoading || previewError) return;
    void loadSlidePreview(activePreviewFile);
  }, [enableAvatar, activePreviewFile, previewId, previewLoading, previewError, loadSlidePreview]);

  useEffect(() => {
    if (avatarFirstPageOnly) {
      setAvatarPages([1]);
      setLayoutPage(1);
    }
  }, [avatarFirstPageOnly]);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await moocApi.listJobs();
      const data = res.data.data;
      setJobs(data.jobs || []);
      setQueueInfo(data.queue || {});
    } catch {
      // ignore polling errors
    }
  }, []);

  const loadVoiceOptions = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      const [vRes, mRes] = await Promise.all([
        voiceboxApi.listVoices(),
        voiceboxApi.listModels(),
      ]);
      if (vRes.data?.error || mRes.data?.error) {
        throw new Error(vRes.data?.error?.message || mRes.data?.error?.message || 'Voicebox 不可用');
      }
      const vs = vRes.data.data || [];
      const rawModels = (mRes.data.data || []).filter(isTtsModel);
      const ms = rawModels.filter((m: any) => (
        m.downloaded || m.loaded || m.status === 'ready' || m.status === 'available' || m.status === 'downloaded'
      ));
      setVoices(vs);
      setModels(ms.length ? ms : rawModels);
      if (vs[0] && !form.getFieldValue('selectedVoiceId')) {
        form.setFieldValue('selectedVoiceId', vs[0].id);
      }
      const preferred = (ms.length ? ms : rawModels).find((m: any) => m.isRecommended)
        || ms[0]
        || rawModels[0];
      if (preferred && !form.getFieldValue('selectedModelId')) {
        form.setFieldValue('selectedModelId', preferred.id);
      }
      if (!vs.length && !opts?.silent) {
        message.warning('暂无音色，请先在造声工厂克隆，或确认 Voicebox 已启动');
      }
      return vs.length > 0;
    } catch (err: any) {
      if (!opts?.silent) {
        message.warning(err.response?.data?.error?.message || '音色/模型列表加载失败，请确认 Voicebox 已启动');
      }
      return false;
    }
  }, [form]);

  useEffect(() => {
    document.title = 'Cinedeck · PPT 讲解视频 · 一键全自动';
    form.setFieldsValue({
      targetDuration: 0,
      useExistingNote: true,
      enableAvatar: false,
      avatarDriveMode: 'video',
      allowSilentPages: true,
      defaultSilentPageDuration: 5,
      pauseDuration: 2,
      pauseEnabled: true,
      maxRetries: 5,
    });

    void (async () => {
      // 数字人互斥可能刚停掉 Voicebox：失败时短暂重试
      for (let i = 0; i < 3; i++) {
        const ok = await loadVoiceOptions({ silent: i < 2 });
        if (ok) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      try {
        await loadRefs();
      } catch {
        // ignore
      }
    })();

    void refreshJobs();
    pollRef.current = window.setInterval(() => { void refreshJobs(); }, 3000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const handleSubmit = async () => {
    const filesToSubmit = isBatchMode ? batchFiles : (file ? [file] : []);
    if (!filesToSubmit.length) {
      message.error(isBatchMode ? '请先选择至少一个 PPTX 文件' : '请先选择 PPTX 文件');
      return;
    }
    try {
      const values = await form.validateFields();
      if (values.enableAvatar && values.avatarDriveMode === 'photo' && !photo) {
        message.error('请上传数字人静照');
        return;
      }
      if (values.enableAvatar && !avatarFirstPageOnly && !avatarPages.length) {
        message.error('请至少勾选一页生成数字人');
        return;
      }
      setSubmitting(true);
      let ok = 0;
      for (const pptFile of filesToSubmit) {
        const fd = buildMoocFormData(pptFile, values, {
          photo,
          avatarPages: avatarFirstPageOnly ? [1] : avatarPages,
          layout,
          avatarFirstPageOnly,
        });
        await moocApi.createJob(fd);
        ok += 1;
      }
      message.success(
        ok > 1
          ? `已加入 ${ok} 个任务，将按相同配置串行处理`
          : '任务已加入队列，后台将串行处理',
      );
      setFile(null);
      setBatchFiles([]);
      setPhoto(null);
      setSlideCount(0);
      setAvatarPages([]);
      setLayout(DEFAULT_AVATAR_LAYOUT);
      resetPreview();
      await refreshJobs();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err.response?.data?.error?.message || err.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResume = async (id: string) => {
    try {
      await moocApi.retryJob(id, { resume: true });
      message.success('已从断点继续排队');
      await refreshJobs();
    } catch (e: any) {
      message.error(e.response?.data?.error?.message || '继续失败');
    }
  };

  const handleRestart = async (id: string) => {
    Modal.confirm({
      title: '全部重跑？',
      content: '将丢弃当前进度，从头重新生成（解析→解说词→配音…）',
      okText: '全部重跑',
      okType: 'danger',
      onOk: async () => {
        try {
          await moocApi.retryJob(id, { resume: false });
          message.success('已重新排队（全部重跑）');
          await refreshJobs();
        } catch (e: any) {
          message.error(e.response?.data?.error?.message || '重跑失败');
        }
      },
    });
  };

  const columns = [
    {
      title: '任务',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      ellipsis: true,
      render: (_: any, r: any) => (
        <Tooltip title={`${r.name || ''}\n${r.fileName || ''}`}>
          <div style={{ maxWidth: 190, overflow: 'hidden' }}>
            <div style={{
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            >
              {truncateText(r.name, 24)}
            </div>
            <div style={{
              fontSize: 11,
              color: 'rgba(0,0,0,0.45)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            >
              {truncateText(r.fileName, 28)}
            </div>
          </div>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 78,
      render: (s: string) => (
        <Tag color={STATUS_COLOR[s] || 'default'} style={{ margin: 0 }}>
          {STATUS_LABEL[s] || s}
        </Tag>
      ),
    },
    {
      title: '进度',
      key: 'progress',
      width: 120,
      render: (_: any, r: any) => {
        const stageText = r.status === 'failed'
          ? (r.failedStageLabel || STAGE_LABEL[r.failedStage] || STAGE_LABEL[r.stage] || r.stage)
          : (r.stageLabel || STAGE_LABEL[r.stage] || r.stage);
        return (
          <div style={{ width: 108 }}>
            <div style={{ fontSize: 12, marginBottom: 2 }}>{stageText}</div>
            {(r.retryCount > 0 || (r.maxRetries != null && r.status !== 'success')) && (
              <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)', marginBottom: 2 }}>
                重试 {r.retryCount || 0}/{r.maxRetries ?? 5}
              </div>
            )}
            {(r.status === 'running' || r.status === 'queued') ? (
              <Progress
                percent={r.progress || 0}
                size="small"
                status={r.status === 'queued' ? 'normal' : 'active'}
                showInfo={false}
              />
            ) : r.status === 'success' ? (
              <Progress percent={100} size="small" status="success" showInfo={false} />
            ) : r.status === 'failed' ? (
              <Progress percent={r.progress || 0} size="small" status="exception" showInfo={false} />
            ) : null}
          </div>
        );
      },
    },
    {
      title: '说明',
      dataIndex: 'message',
      ellipsis: true,
      render: (msg: string, r: any) => {
        const text = r.error || msg || '-';
        const short = truncateText(text.replace(/\n/g, ' '), 56);
        const isFail = r.status === 'failed';
        return (
          <Space size={4}>
            <Tooltip title={text}>
              <Text
                type={isFail ? 'danger' : 'secondary'}
                style={{ fontSize: 12, maxWidth: 360, display: 'inline-block' }}
                ellipsis
              >
                {short}
              </Text>
            </Tooltip>
            {isFail && r.error && (
              <Button
                type="link"
                size="small"
                icon={<ExclamationCircleOutlined />}
                style={{ padding: 0, height: 'auto' }}
                onClick={() => setErrorModal({
                  open: true,
                  title: `失败详情 · ${r.failedStageLabel || STAGE_LABEL[r.stage] || ''}`,
                  content: r.error,
                })}
              >
                详情
              </Button>
            )}
          </Space>
        );
      },
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 90,
      render: (t: string) => {
        if (!t) return '-';
        const d = new Date(t);
        return (
          <Tooltip title={d.toLocaleString('zh-CN')}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {`${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 280,
      fixed: 'right' as const,
      render: (_: any, r: any) => (
        <Space size={4} wrap>
          {(r.pptAvailable || r.fileName) && (
            <Button
              size="small"
              type="link"
              icon={<DownloadOutlined />}
              onClick={async () => {
                try {
                  message.loading({ content: '正在下载 PPT…', key: `ppt-${r.id}`, duration: 0 });
                  await moocApi.downloadPpt(r.id, r.fileName || r.name);
                  message.success({ content: 'PPT 已开始下载', key: `ppt-${r.id}` });
                } catch (e: any) {
                  message.error({ content: e.message || 'PPT 下载失败', key: `ppt-${r.id}` });
                }
              }}
            >
              PPT
            </Button>
          )}
          {r.status === 'success' && r.projectId && (
            <>
              <Button
                size="small"
                type="link"
                icon={<PlayCircleOutlined />}
                onClick={() => window.open(videoApi.getPlayUrl(r.projectId), '_blank')}
              >
                播放
              </Button>
              <Button
                size="small"
                type="link"
                icon={<DownloadOutlined />}
                onClick={() => {
                  try {
                    videoApi.download(r.projectId, r.name);
                    message.success({ content: '已开始下载', key: `dl-${r.id}` });
                  } catch (e: any) {
                    message.error({ content: e.message || '下载失败', key: `dl-${r.id}` });
                  }
                }}
              >
                下载
              </Button>
              <Button size="small" type="link" onClick={() => navigate(`/project/${r.projectId}/preview`)}>
                项目
              </Button>
            </>
          )}
          {(r.status === 'queued' || r.status === 'running') && (
            <Button
              size="small"
              type="link"
              danger
              icon={<StopOutlined />}
              onClick={async () => {
                await moocApi.cancelJob(r.id);
                message.info('已请求取消');
                await refreshJobs();
              }}
            >
              取消
            </Button>
          )}
          {(r.status === 'failed' || r.status === 'cancelled') && (
            <>
              <Button
                size="small"
                type="link"
                icon={<ReloadOutlined />}
                onClick={() => void handleResume(r.id)}
              >
                {r.canResume ? '继续' : '重试'}
              </Button>
              {r.canResume && (
                <Button size="small" type="link" onClick={() => void handleRestart(r.id)}>
                  重跑
                </Button>
              )}
            </>
          )}
          {r.status !== 'running' && (
            <Button
              size="small"
              type="link"
              danger
              icon={<DeleteOutlined />}
              onClick={async () => {
                try {
                  await moocApi.deleteJob(r.id);
                  message.success('已删除');
                  await refreshJobs();
                } catch (e: any) {
                  message.error(e.response?.data?.error?.message || '删除失败');
                }
              }}
            />
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{
      maxWidth: 1680,
      width: '100%',
      margin: '0 auto',
      padding: '32px clamp(16px, 2.5vw, 40px)',
      boxSizing: 'border-box',
    }}
    >
      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ marginBottom: 4 }}>PPT 讲解视频 · 一键全自动</Title>
        <Text type="secondary">与分步向导共用同一套流水线；一次配置全部选项，支持单个或批量 PPT。</Text>
        <div style={{ marginTop: 12 }}>
          <Button size="small" onClick={() => navigate('/ppt')}>切换到分步向导</Button>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message="流水线：解析 PPT → 生成解说词 → 配音 →（可选）数字人 → 合成视频。全局一次只跑一个任务，跑完自动接下一个。"
      />

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={9} xl={7} xxl={6}>
          <Card
            title="新建任务"
            extra={<RocketOutlined />}
          >
            <div style={{ marginBottom: 16 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>提交方式</Text>
              <Radio.Group
                value={submitMode}
                onChange={(e) => handleSubmitModeChange(e.target.value)}
                optionType="button"
                buttonStyle="solid"
              >
                <Radio.Button value="single">单个 PPT</Radio.Button>
                <Radio.Button value="batch">批量 PPT</Radio.Button>
              </Radio.Group>
            </div>

            {isBatchMode ? (
              <>
                <Upload.Dragger
                  accept=".pptx"
                  multiple
                  showUploadList={false}
                  beforeUpload={(_f, list) => {
                    void handlePickBatchFiles(list as File[]);
                    return false;
                  }}
                >
                  <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
                  <p className="ant-upload-text">点击或拖拽上传多个 PPTX</p>
                  <p className="ant-upload-hint">
                    最大 200MB/个 · 已选 {batchFiles.length} 个文件
                  </p>
                </Upload.Dragger>
                {batchFiles.length > 0 && (
                  <div style={{ marginTop: 12, maxHeight: 160, overflow: 'auto' }}>
                    {batchFiles.map((f, idx) => (
                      <div
                        key={`${f.name}-${idx}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '4px 0',
                          borderBottom: '1px solid rgba(0,0,0,0.06)',
                        }}
                      >
                        <Text ellipsis style={{ flex: 1, marginRight: 8 }}>{f.name}</Text>
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => {
                            setBatchFiles((prev) => {
                              const next = prev.filter((_, i) => i !== idx);
                              if (!next.length) resetPreview();
                              else if (idx === 0 && form.getFieldValue('enableAvatar')) {
                                void loadSlidePreview(next[0]);
                              }
                              return next;
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <Upload.Dragger
                accept=".pptx"
                maxCount={1}
                showUploadList={false}
                beforeUpload={(f) => {
                  void handlePickFile(f);
                  return false;
                }}
              >
                <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
                <p className="ant-upload-text">{file ? file.name : '点击或拖拽上传 PPTX'}</p>
                <p className="ant-upload-hint">
                  最大 200MB
                  {slideCount > 0 ? ` · 识别到 ${slideCount} 页` : ''}
                </p>
              </Upload.Dragger>
            )}

            <Divider />

            <Form form={form} layout="vertical" requiredMark={false}>
              <Form.Item label="目标总时长（分钟）" name="targetDuration" tooltip="0 表示按内容自动估算">
                <InputNumber min={0} max={180} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="useExistingNote" valuePropName="checked">
                <Checkbox>参考 PPT 已有备注生成解说词</Checkbox>
              </Form.Item>

              <Form.Item
                label="配音音色"
                name="selectedVoiceId"
                rules={[{ required: true, message: '请选择音色' }]}
                extra={
                  <Space size={0}>
                    <Button type="link" size="small" onClick={() => navigate('/voice-factory')}>去造声工厂克隆</Button>
                    <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => void loadVoiceOptions()}>
                      刷新
                    </Button>
                  </Space>
                }
              >
                <VoiceSelectField voices={voices} />
              </Form.Item>
              <Form.Item
                label="配音模型"
                name="selectedModelId"
                rules={[{ required: true, message: '请选择模型' }]}
                extra={
                  <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => void loadVoiceOptions()}>
                    刷新模型列表
                  </Button>
                }
              >
                <ModelSelectField models={models} readyOnly={false} />
              </Form.Item>

              <Form.Item label="生成数字人" name="enableAvatar" valuePropName="checked">
                <Switch checkedChildren="开启" unCheckedChildren="跳过" />
              </Form.Item>

              {enableAvatar && (
                <>
                  <Form.Item label="驱动方式" name="avatarDriveMode">
                    <Radio.Group>
                      <Radio.Button value="video">参考视频</Radio.Button>
                      <Radio.Button value="photo">静照</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                  {driveMode === 'video' ? (
                    <>
                      <Form.Item
                        label="参考视频"
                        name="avatarRefVideoId"
                        rules={[{ required: true, message: '请选择参考视频' }]}
                      >
                        <AvatarRefLibraryPanel
                          mode="select"
                          refs={refs}
                          selectedId={selectedAvatarRefId || null}
                          onSelect={() => undefined}
                        />
                      </Form.Item>
                    </>
                  ) : (
                    <Form.Item label="静照" required>
                      <Upload
                        accept="image/*"
                        maxCount={1}
                        showUploadList={false}
                        beforeUpload={(f) => { setPhoto(f); return false; }}
                      >
                        <Button icon={<PlusOutlined />}>{photo ? photo.name : '上传照片'}</Button>
                      </Upload>
                    </Form.Item>
                  )}

                  <Form.Item
                    label={
                      avatarFirstPageOnly ? '数字人页码（批量）' : (
                        <Space>
                          <span>生成数字人的页码</span>
                          {pageOptions.length > 0 && (
                            <>
                              <Button
                                type="link"
                                size="small"
                                onClick={() => setAvatarPages([...pageOptions])}
                              >
                                全选
                              </Button>
                              <Button type="link" size="small" onClick={() => setAvatarPages([])}>
                                清空
                              </Button>
                            </>
                          )}
                        </Space>
                      )
                    }
                    required
                  >
                    {avatarFirstPageOnly ? (
                      <>
                        <Alert
                          type="info"
                          showIcon
                          message="批量模式：每个 PPT 仅第 1 页生成数字人"
                          description="各文件页数不同，无法统一勾选多页；布局在下方按第 1 页预览调整后，将全部 PPT 共用。"
                          style={{ marginBottom: 12 }}
                        />
                        <Tag color="blue">第 1 页</Tag>
                      </>
                    ) : pageOptions.length > 0 ? (
                      <Checkbox.Group
                        value={avatarPages}
                        onChange={(vals) => setAvatarPages(vals as number[])}
                        style={{ width: '100%' }}
                      >
                        <Row gutter={[4, 4]}>
                          {pageOptions.map((p) => (
                            <Col span={4} key={p}>
                              <Checkbox value={p}>{p}</Checkbox>
                            </Col>
                          ))}
                        </Row>
                      </Checkbox.Group>
                    ) : (
                      <Select
                        mode="tags"
                        placeholder="输入页码后回车，如 1、3、5"
                        tokenSeparators={[',', ' ', '，']}
                        value={avatarPages.map(String)}
                        onChange={(vals) => {
                          const pages = vals
                            .map((v) => Number(v))
                            .filter((n) => Number.isFinite(n) && n >= 1);
                          setAvatarPages([...new Set(pages)].sort((a, b) => a - b));
                        }}
                        style={{ width: '100%' }}
                      />
                    )}
                    {!avatarFirstPageOnly && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        已选 {avatarPages.length} 页
                        {slideCount > 0 ? ` / 共 ${slideCount} 页` : ''}
                      </Text>
                    )}
                  </Form.Item>

                  <Form.Item
                    label="数字人布局（位置与大小）"
                    tooltip={avatarFirstPageOnly
                      ? '用第一个 PPT 的第 1 页预览布局，批量任务共用'
                      : '请选择 PPT 中的真实页面作为底图再调整，布局会更准确'}
                  >
                    {!activePreviewFile ? (
                      <Alert type="warning" showIcon message="请先上传 PPTX，再渲染真实页面做布局" />
                    ) : previewLoading ? (
                      <div style={{ textAlign: 'center', padding: 32 }}>
                        <Spin tip="正在渲染真实幻灯片，请稍候…" />
                      </div>
                    ) : previewError ? (
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Alert type="error" showIcon message={previewError} />
                        <Button icon={<ReloadOutlined />} onClick={() => void loadSlidePreview(activePreviewFile)}>
                          重新渲染
                        </Button>
                      </Space>
                    ) : previewId ? (
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        {!avatarFirstPageOnly && (
                          <div>
                            <Text style={{ marginRight: 8 }}>布局参考页</Text>
                            <Select
                              value={layoutPage}
                              onChange={setLayoutPage}
                              style={{ width: 160 }}
                              options={pageOptions.map((p) => ({
                                value: p,
                                label: `第 ${p} 页`,
                              }))}
                            />
                            <Button
                              type="link"
                              size="small"
                              icon={<ReloadOutlined />}
                              onClick={() => void loadSlidePreview(activePreviewFile)}
                            >
                              重新渲染
                            </Button>
                          </div>
                        )}
                        {avatarFirstPageOnly && activePreviewFile && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            预览文件：{activePreviewFile.name}（第 1 页）
                          </Text>
                        )}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {avatarFirstPageOnly
                            ? '在真实幻灯片上拖拽蓝框调整位置与大小；所有批量 PPT 共用此布局。'
                            : '在真实幻灯片上拖拽蓝框调整位置与大小；参考页仅用于预览，不影响勾选生成的页码。'}
                        </Text>
                        <AvatarPipEditor
                          key={`${previewId}-${layoutPage}`}
                          imageUrl={layoutImageUrl}
                          layout={layout}
                          onChange={setLayout}
                          aspectRatio={1}
                        />
                      </Space>
                    ) : (
                      <Button type="primary" ghost onClick={() => void loadSlidePreview(activePreviewFile)}>
                        渲染真实幻灯片以配置布局
                      </Button>
                    )}
                  </Form.Item>
                </>
              )}

              <Divider style={{ margin: '12px 0' }}>播放设置</Divider>
              <Form.Item name="pauseEnabled" valuePropName="checked">
                <Checkbox>页间停顿</Checkbox>
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prev, cur) => prev.pauseEnabled !== cur.pauseEnabled}
              >
                {({ getFieldValue }) =>
                  getFieldValue('pauseEnabled') !== false ? (
                    <Form.Item label="停顿时长（秒）" name="pauseDuration" tooltip="默认 2 秒，与编辑导出页一致">
                      <InputNumber min={0.5} max={10} step={0.5} style={{ width: '100%' }} />
                    </Form.Item>
                  ) : null
                }
              </Form.Item>

              <Form.Item name="allowSilentPages" valuePropName="checked">
                <Checkbox>允许无配音页以静默时长占位</Checkbox>
              </Form.Item>
              <Form.Item label="静默页默认时长（秒）" name="defaultSilentPageDuration">
                <InputNumber min={1} max={30} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="出错自动重试次数"
                name="maxRetries"
                tooltip="单次任务失败后自动从断点重试的次数，默认 5；设为 0 则不自动重试，失败后直接进入下一任务"
              >
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>

              <Button
                type="primary"
                block
                size="large"
                icon={<PlusOutlined />}
                loading={submitting}
                onClick={handleSubmit}
              >
                {isBatchMode
                  ? (batchFiles.length > 1 ? `批量加入队列（${batchFiles.length} 个）` : '加入队列')
                  : '加入队列'}
              </Button>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={15} xl={17} xxl={18}>
          <Card
            title="任务队列"
            extra={
              <Space>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {queueInfo.hasRunning ? '有任务运行中' : '空闲'}
                  {typeof queueInfo.queuedCount === 'number' ? ` · 排队 ${queueInfo.queuedCount}` : ''}
                </Text>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => refreshJobs()}>刷新</Button>
              </Space>
            }
          >
            <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 12, fontSize: 12 }}>
              串行执行。出错会按配置自动从断点重试；次数用尽后失败并进入下一任务。也可手动点「继续 / 重跑」。
            </Paragraph>
            <Table
              rowKey="id"
              size="small"
              columns={columns as any}
              dataSource={jobs}
              pagination={{ pageSize: 8, size: 'small' }}
              scroll={{ x: 1100 }}
              locale={{ emptyText: '暂无任务，左侧配置后加入队列' }}
            />
          </Card>
        </Col>
      </Row>

      <Modal
        open={errorModal.open}
        title={errorModal.title || '失败详情'}
        onCancel={() => setErrorModal({ open: false, title: '', content: '' })}
        footer={[
          <Button key="close" type="primary" onClick={() => setErrorModal({ open: false, title: '', content: '' })}>
            关闭
          </Button>,
        ]}
        width={640}
      >
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="失败阶段与原因如下，可点「继续」仅重试未完成步骤"
        />
        <pre style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 360,
          overflow: 'auto',
          margin: 0,
          fontSize: 12,
          background: '#fafafa',
          padding: 12,
          borderRadius: 6,
        }}
        >
          {errorModal.content}
        </pre>
      </Modal>
    </div>
  );
};

export default MoocPage;

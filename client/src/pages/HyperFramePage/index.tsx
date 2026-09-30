import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Checkbox, Col, Input, List, Progress, Row, Select, Space, Switch, Tag,
  Typography, Upload, message, Image, Modal, Popconfirm,
} from 'antd';
import {
  ArrowLeftOutlined, CloudUploadOutlined, DeleteOutlined, DownloadOutlined,
  PlayCircleOutlined, ReloadOutlined, RocketOutlined, SaveOutlined,
} from '@ant-design/icons';
import { hyperframeApi, voiceboxApi } from '../../api';
import { confirmGpuIfBusy } from '../../utils/confirmGpu';
import { ModelSelectField, VoiceSelectField } from '../../components/voicebox';
import { isTtsModel } from '../../utils/voiceboxModels';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;
const { Dragger } = Upload;

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  queued: { text: '排队中', color: 'default' },
  running: { text: '运行中', color: 'processing' },
  review: { text: '待确认讲义', color: 'warning' },
  success: { text: '已完成', color: 'success' },
  failed: { text: '失败', color: 'error' },
  cancelled: { text: '已取消', color: 'default' },
};

interface PageScript {
  pageIndex: number;
  note: string;
  analysis: string;
  lecture: string;
  durationSec?: number;
}

const HyperFramePage: React.FC = () => {
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [useExistingNote, setUseExistingNote] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [scripts, setScripts] = useState<PageScript[]>([]);
  const [pageIdx, setPageIdx] = useState(0);
  const [voices, setVoices] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [voiceId, setVoiceId] = useState<string>();
  const [modelId, setModelId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const pollRef = useRef<number | null>(null);

  const loadJobs = useCallback(async () => {
    const res = await hyperframeApi.listJobs();
    const payload = res.data.data;
    const list = (payload?.jobs || payload || []) as any[];
    setJobs(list);
    return list;
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const res = await hyperframeApi.getJob(id);
    const data = res.data.data;
    setDetail(data);
    const cfg = data?.config || {};
    if (cfg.selectedVoiceId) setVoiceId(String(cfg.selectedVoiceId));
    if (cfg.selectedModelId) setModelId(String(cfg.selectedModelId));
    if (Array.isArray(data?.scripts)) {
      setScripts(data.scripts);
      setPageIdx((prev) => Math.min(prev, Math.max(0, data.scripts.length - 1)));
      const saved: number[] = Array.isArray(data?.config?.selectedPageIndexes)
        ? data.config.selectedPageIndexes.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
        : [];
      const allIdx = data.scripts.map((s: PageScript) => s.pageIndex);
      // Keep previous selection if still valid; else restore config or select all
      setSelectedPages((prev) => {
        const stillValid = prev.filter((p) => allIdx.includes(p));
        if (stillValid.length) return stillValid;
        if (saved.length) return saved.filter((p) => allIdx.includes(p));
        return allIdx;
      });
    }
    return data;
  }, []);

  useEffect(() => {
    document.title = 'Cinedeck · HyperFrame 工作台';
    void loadJobs();
    voiceboxApi.listVoices().then((res) => {
      const list = res.data.data || [];
      setVoices(list);
      if (list[0]?.id) setVoiceId(list[0].id);
    }).catch(() => {});
    voiceboxApi.listModels().then((res) => {
      const list = (res.data.data || []).filter((m: any) => {
        if (!isTtsModel(m)) return false;
        return m.status === 'available' || m.status === 'downloaded' || m.downloaded;
      });
      setModels(list);
      if (list[0]?.id) setModelId(list[0].id);
    }).catch(() => {});
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [loadJobs]);

  useEffect(() => {
    const busy = jobs.some((j) => j.status === 'queued' || j.status === 'running');
    if (busy && !pollRef.current) {
      pollRef.current = window.setInterval(() => {
        void loadJobs().then((list) => {
          const id = activeId || list[0]?.id;
          if (id) void loadDetail(id);
        });
      }, 2500);
    }
    if (!busy && pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [jobs, loadJobs, loadDetail, activeId]);

  useEffect(() => {
    if (!activeId && jobs[0]?.id) setActiveId(jobs[0].id);
  }, [jobs, activeId]);

  useEffect(() => {
    if (activeId) void loadDetail(activeId);
  }, [activeId, loadDetail]);

  const current = scripts[pageIdx];
  const slideMeta = useMemo(() => {
    const slides = detail?.slides || [];
    return slides.find((s: any) => s.pageIndex === current?.pageIndex) || slides[pageIdx];
  }, [detail, current, pageIdx]);

  const handleSubmit = async () => {
    if (!file) {
      message.warning('请先上传 PPT');
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('use_existing_note', String(useExistingNote));
      fd.append('name', file.name.replace(/\.(pptx|ppt)$/i, ''));
      const res = await hyperframeApi.createJob(fd);
      message.success('已提交，正在解析并生成讲义');
      setFile(null);
      setActiveId(res.data.data.id);
      await loadJobs();
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || err.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveScripts = async () => {
    if (!activeId) return;
    setSaving(true);
    try {
      await hyperframeApi.saveScripts(activeId, scripts);
      message.success('讲义已保存');
      await loadDetail(activeId);
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirm = async () => {
    if (!activeId) return;
    if (!voiceId || !modelId) {
      message.warning('请选择音色和配音模型');
      return;
    }
    if (!selectedPages.length) {
      message.warning('请至少勾选一页再生成动画');
      return;
    }
    const okGpu = await confirmGpuIfBusy('HyperFrame 配音与渲染');
    if (!okGpu) return;
    setConfirming(true);
    try {
      await hyperframeApi.confirm(activeId, {
        selectedVoiceId: voiceId,
        selectedModelId: modelId,
        scripts,
        selectedPageIndexes: selectedPages,
      });
      message.success(`已确认讲义，开始生成 ${selectedPages.length} 页动画`);
      await loadJobs();
      await loadDetail(activeId);
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || err.message || '确认失败');
    } finally {
      setConfirming(false);
    }
  };

  const canEdit = detail?.status === 'review' || detail?.status === 'failed';
  const canConfirm = (detail?.status === 'review' || detail?.status === 'failed')
    && scripts.length > 0
    && selectedPages.length > 0;

  const allPageIndexes = useMemo(() => scripts.map((s) => s.pageIndex), [scripts]);
  const selectedSet = useMemo(() => new Set(selectedPages), [selectedPages]);
  const togglePage = (pageIndex: number, checked: boolean) => {
    setSelectedPages((prev) => {
      if (checked) return [...new Set([...prev, pageIndex])].sort((a, b) => a - b);
      return prev.filter((p) => p !== pageIndex);
    });
  };

  return (
    <div style={{ maxWidth: 1360, width: '100%', margin: '0 auto', padding: '32px clamp(16px, 3vw, 40px)', boxSizing: 'border-box' }}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回工作台</Button>
      </Space>

      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ marginBottom: 4 }}>HyperFrame 工作台</Title>
        <Text type="secondary">
          上传 PPT → 多模态分析页面（含备注）→ 生成讲授讲义 → 确认后用 Voicebox 配音 → HyperFrames 动画预览与导出
        </Text>
      </div>

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={8}>
          <Card title="1. 上传课件">
            <Dragger
              accept=".pptx,.ppt"
              maxCount={1}
              fileList={file ? [{ uid: '1', name: file.name, status: 'done' as const }] : []}
              beforeUpload={(f) => { setFile(f); return false; }}
              onRemove={() => { setFile(null); return true; }}
            >
              <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
              <p>拖入或点击上传 PPTX</p>
            </Dragger>
            <Space direction="vertical" style={{ width: '100%', marginTop: 16 }} size={12}>
              <Space>
                <Switch checked={useExistingNote} onChange={setUseExistingNote} />
                <Text type="secondary">参考已有备注生成讲义</Text>
              </Space>
              <Button type="primary" block size="large" icon={<RocketOutlined />} loading={submitting} onClick={() => void handleSubmit()}>
                开始分析并生成讲义
              </Button>
              <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
                请先在「设置」中激活支持视觉的多模态模型。配音使用 Voicebox。
              </Paragraph>
            </Space>
          </Card>

          <Card title="任务列表" style={{ marginTop: 16 }}>
            <List
              dataSource={jobs}
              locale={{ emptyText: '暂无任务' }}
              renderItem={(item) => (
                <List.Item
                  onClick={() => setActiveId(item.id)}
                  style={{
                    cursor: 'pointer',
                    background: activeId === item.id ? '#e6f4ff' : undefined,
                    borderRadius: 8,
                    padding: '8px 10px',
                  }}
                  actions={[
                    item.status !== 'running' && (
                      <Popconfirm
                        key="del"
                        title="删除任务？"
                        onConfirm={(e) => {
                          e?.stopPropagation();
                          void hyperframeApi.deleteJob(item.id).then(() => {
                            if (activeId === item.id) {
                              setActiveId(null);
                              setDetail(null);
                            }
                            return loadJobs();
                          });
                        }}
                      >
                        <Button type="text" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                      </Popconfirm>
                    ),
                  ].filter(Boolean)}
                >
                  <List.Item.Meta
                    title={
                      <Space wrap>
                        <Text ellipsis style={{ maxWidth: 160 }}>{item.name}</Text>
                        <Tag color={STATUS_LABEL[item.status]?.color}>{STATUS_LABEL[item.status]?.text || item.status}</Tag>
                      </Space>
                    }
                    description={
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {item.stageLabel || item.stage} · {item.progress || 0}%
                        {item.message ? ` · ${item.message}` : ''}
                      </Text>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          <Card
            title="2. 讲义确认与动画生成"
            extra={detail ? (
              <Space>
                <Tag color={STATUS_LABEL[detail.status]?.color}>{STATUS_LABEL[detail.status]?.text || detail.status}</Tag>
                <Text type="secondary">{detail.stageLabel || detail.stage}</Text>
              </Space>
            ) : null}
          >
            {!detail ? (
              <Paragraph type="secondary">提交任务后，这里显示页面图像、备注与生成的讲授讲义。</Paragraph>
            ) : (
              <>
                {(detail.status === 'queued' || detail.status === 'running') && (
                  <>
                    <Progress percent={detail.progress || 0} status="active" />
                    <Paragraph type="secondary">{detail.message}</Paragraph>
                  </>
                )}
                {detail.error && (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="任务失败"
                    description={
                      /ECONNREFUSED|17493|Voicebox/i.test(String(detail.error))
                        ? `配音服务当时不可达（${detail.error}）。Voicebox 现已恢复时可在下方重新选择音色并点击「确认讲义并生成」。`
                        : detail.error
                    }
                  />
                )}

                {scripts.length > 0 && (
                  <Row gutter={16}>
                    <Col xs={24} md={10}>
                      <Card
                        size="small"
                        title={`生成页码（已选 ${selectedPages.length} / ${scripts.length}）`}
                        style={{ marginBottom: 12 }}
                        extra={
                          <Space size={4}>
                            <Button
                              type="link"
                              size="small"
                              disabled={!canEdit}
                              onClick={() => setSelectedPages(allPageIndexes)}
                            >
                              全选
                            </Button>
                            <Button
                              type="link"
                              size="small"
                              disabled={!canEdit}
                              onClick={() => setSelectedPages([])}
                            >
                              清空
                            </Button>
                          </Space>
                        }
                      >
                        <div style={{ maxHeight: 160, overflow: 'auto' }}>
                          <Checkbox.Group
                            style={{ width: '100%' }}
                            value={selectedPages}
                            disabled={!canEdit}
                            onChange={(vals) => setSelectedPages((vals as number[]).slice().sort((a, b) => a - b))}
                          >
                            <Space wrap size={[8, 8]}>
                              {scripts.map((s) => (
                                <Checkbox key={s.pageIndex} value={s.pageIndex}>
                                  第 {s.pageIndex} 页
                                </Checkbox>
                              ))}
                            </Space>
                          </Checkbox.Group>
                        </div>
                        <Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
                          仅对勾选页做 Voicebox 配音与 HyperFrames 动画，未勾选页仍可编辑讲义但不进入成片。
                        </Paragraph>
                      </Card>

                      <div style={{ marginBottom: 8 }}>
                        <Select
                          style={{ width: '100%' }}
                          value={pageIdx}
                          onChange={setPageIdx}
                          options={scripts.map((s, i) => ({
                            value: i,
                            label: `${selectedSet.has(s.pageIndex) ? '✓ ' : ''}第 ${s.pageIndex} 页${s.note ? ' · 有备注' : ''}`,
                          }))}
                        />
                      </div>
                      {slideMeta?.imageUrl || slideMeta?.thumbnailUrl ? (
                        <Image
                          src={slideMeta.thumbnailUrl || slideMeta.imageUrl}
                          style={{ width: '100%', borderRadius: 8, border: '1px solid #f0f0f0' }}
                        />
                      ) : (
                        <div style={{ padding: 40, textAlign: 'center', background: '#fafafa', borderRadius: 8 }}>无页面预览</div>
                      )}
                      {current && canEdit && (
                        <div style={{ marginTop: 8 }}>
                          <Checkbox
                            checked={selectedSet.has(current.pageIndex)}
                            onChange={(e) => togglePage(current.pageIndex, e.target.checked)}
                          >
                            将本页纳入动画
                          </Checkbox>
                        </div>
                      )}
                      <Card size="small" title="页面备注" style={{ marginTop: 12 }}>
                        <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                          {current?.note || slideMeta?.note || '（无备注）'}
                        </Paragraph>
                      </Card>
                      {current?.analysis && (
                        <Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>{current.analysis}</Paragraph>
                      )}
                    </Col>
                    <Col xs={24} md={14}>
                      <Text strong>讲授讲义</Text>
                      <TextArea
                        style={{ marginTop: 8 }}
                        value={current?.lecture || ''}
                        disabled={!canEdit}
                        autoSize={{ minRows: 12, maxRows: 22 }}
                        onChange={(e) => {
                          const next = [...scripts];
                          next[pageIdx] = { ...next[pageIdx], lecture: e.target.value };
                          setScripts(next);
                        }}
                      />
                      <Space wrap style={{ marginTop: 12 }}>
                        <Button disabled={pageIdx <= 0} onClick={() => setPageIdx((p) => p - 1)}>上一页</Button>
                        <Button disabled={pageIdx >= scripts.length - 1} onClick={() => setPageIdx((p) => p + 1)}>下一页</Button>
                        <Button icon={<SaveOutlined />} loading={saving} disabled={!canEdit} onClick={() => void handleSaveScripts()}>
                          保存讲义
                        </Button>
                      </Space>

                      <Card size="small" title="3. 选择音色并生成动画" style={{ marginTop: 16 }}>
                        <Space direction="vertical" style={{ width: '100%' }} size={10}>
                          <div>
                            <Text type="secondary">音色</Text>
                            <div style={{ marginTop: 4 }}>
                              <VoiceSelectField
                                value={voiceId}
                                onChange={setVoiceId}
                                voices={voices}
                                onReload={() => {
                                  voiceboxApi.listVoices().then((res) => {
                                    const list = res.data.data || [];
                                    setVoices(list);
                                  }).catch(() => {});
                                }}
                              />
                            </div>
                            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => navigate('/voice-factory')}>
                              去造声工厂克隆 / 试听
                            </Button>
                          </div>
                          <div>
                            <Text type="secondary">配音模型</Text>
                            <div style={{ marginTop: 4 }}>
                              <ModelSelectField
                                value={modelId}
                                onChange={setModelId}
                                models={models}
                                readyOnly={false}
                              />
                            </div>
                          </div>
                          <Button
                            type="primary"
                            block
                            icon={<PlayCircleOutlined />}
                            disabled={!canConfirm}
                            loading={confirming}
                            onClick={() => void handleConfirm()}
                          >
                            {detail.status === 'failed'
                              ? `重试生成动画（已选 ${selectedPages.length} 页）`
                              : `确认并生成动画（已选 ${selectedPages.length} 页）`}
                          </Button>
                        </Space>
                      </Card>
                    </Col>
                  </Row>
                )}

                {detail.status === 'success' && detail.videoUrl && (
                  <Card title="预览与导出" style={{ marginTop: 16 }}>
                    <video
                      key={detail.videoUrl}
                      src={detail.videoUrl}
                      controls
                      style={{ width: '100%', maxHeight: 480, background: '#000', borderRadius: 8 }}
                    />
                    <Space style={{ marginTop: 12 }}>
                      <Button
                        type="primary"
                        icon={<DownloadOutlined />}
                        href={hyperframeApi.downloadUrl(detail.id)}
                      >
                        导出 MP4
                      </Button>
                      <Button
                        icon={<ReloadOutlined />}
                        onClick={() => {
                          Modal.info({
                            title: '官方 HyperFrames 工程',
                            width: 720,
                            content: (
                              <div>
                                <Paragraph>
                                  本任务使用官方 CLI 渲染（<Text code>hyperframes render</Text>）。
                                  工程目录：<Text code>data/hyperframe-compositions/{detail.id}/</Text>
                                </Paragraph>
                                <Paragraph>
                                  本地预览：<Text code>npx hyperframes preview</Text><br />
                                  再次渲染：<Text code>npx hyperframes render --quality high</Text>
                                </Paragraph>
                              </div>
                            ),
                          });
                        }}
                      >
                        官方 CLI 说明
                      </Button>
                    </Space>
                  </Card>
                )}
              </>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default HyperFramePage;

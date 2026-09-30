import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatFileSize } from '../../utils/formatFileSize';
import { useNavigate } from 'react-router-dom';
import {
  Button, Card, Col, Input, List, Popconfirm, Progress, Row, Select, Space, Tag,
  Typography, Upload, message,
} from 'antd';
import {
  ArrowLeftOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined,
  FileTextOutlined, InboxOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { transcribeApi, voiceboxApi } from '../../api';
import { confirmGpuIfBusy } from '../../utils/confirmGpu';

const { Title, Text, Paragraph } = Typography;
const { Dragger } = Upload;
const { TextArea } = Input;

const VIDEO_EXTS = '.mp4,.mov,.mkv,.webm,.avi,.flv,.m4v,.mpeg,.mpg,.wmv,.3gp';
const AUDIO_EXTS = '.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus';
const ACCEPT = `${VIDEO_EXTS},${AUDIO_EXTS}`;
const MAX_MB = 500;

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  queued: { text: '排队中', color: 'default' },
  running: { text: '转写中', color: 'processing' },
  success: { text: '已完成', color: 'success' },
  failed: { text: '失败', color: 'error' },
  cancelled: { text: '已取消', color: 'warning' },
};

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  extracting: '提取音频',
  transcribing: '语音识别',
  done: '完成',
  failed: '失败',
};

function formatDuration(sec: number | null | undefined) {
  if (!sec || !Number.isFinite(sec)) return '-';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${r}秒` : `${r}秒`;
}

interface Job {
  id: string;
  fileName: string;
  language: string | null;
  model: string;
  status: string;
  stage: string;
  progress: number;
  message: string | null;
  error: string | null;
  text: string | null;
  durationSec: number | null;
  createdAt: string;
}

const TranscribePage: React.FC = () => {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState('zh');
  const [model, setModel] = useState('base');
  const [models, setModels] = useState<{ value: string; label: string }[]>([
    { value: 'base', label: 'Whisper Base（已下载）' },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadJobs = useCallback(async () => {
    const res = await transcribeApi.listJobs();
    const list = (res.data.data || []) as Job[];
    setJobs(list);
    return list;
  }, []);

  useEffect(() => {
    document.title = 'Cinedeck · 视频转写';
    void loadJobs();
    voiceboxApi.listModels().then((res) => {
      const list = (res.data.data || [])
        .filter((m: any) => String(m.id || '').toLowerCase().startsWith('whisper'))
        .map((m: any) => {
          const size = String(m.id).toLowerCase().replace(/^whisper-/, '');
          const ready = m.status === 'available' || m.status === 'downloaded';
          return {
            value: size,
            label: `${m.name || m.id}${ready ? '' : '（未下载）'}`,
            disabled: !ready,
          };
        });
      if (list.length) setModels(list);
    }).catch(() => {});
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [loadJobs]);

  useEffect(() => {
    const busy = jobs.some((j) => j.status === 'queued' || j.status === 'running');
    if (busy && !pollRef.current) {
      pollRef.current = window.setInterval(() => { void loadJobs(); }, 2000);
    }
    if (!busy && pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [jobs, loadJobs]);

  const active = jobs.find((j) => j.id === activeId) || jobs[0] || null;

  const handleSubmit = async () => {
    if (!file) {
      message.warning('请先选择视频或音频文件');
      return;
    }
    const ok = await confirmGpuIfBusy('视频转写');
    if (!ok) return;
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('language', language);
      fd.append('model', model);
      const res = await transcribeApi.createJob(fd);
      const job = res.data.data as Job;
      message.success('已提交转写任务');
      setFile(null);
      setActiveId(job.id);
      await loadJobs();
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || err.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制');
    } catch {
      message.error('复制失败');
    }
  };

  const handleDownloadTxt = (text: string, filenameHint: string) => {
    if (!text) {
      message.warning('还没有转写文本');
      return;
    }
    const base = (filenameHint || '转写结果').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim() || '转写结果';
    const blob = new Blob([`\uFEFF${text}`], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `${base}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
    message.success('已开始下载');
  };

  return (
    <div style={{ maxWidth: 1280, width: '100%', margin: '0 auto', padding: '32px clamp(16px, 3vw, 40px)', boxSizing: 'border-box' }}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回工作台</Button>
      </Space>

      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ marginBottom: 4 }}>视频转写</Title>
        <Text type="secondary">上传视频或音频，提取人声后转写成文本，可复制或下载。</Text>
      </div>

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={10}>
          <Card title="上传文件">
            <Dragger
              accept={ACCEPT}
              maxCount={1}
              fileList={file ? [{ uid: '1', name: `${file.name}（${formatFileSize(file.size)}）`, status: 'done' as const }] : []}
              beforeUpload={(f) => {
                if (f.size > MAX_MB * 1024 * 1024) {
                  message.error(`文件不能超过 ${MAX_MB}MB`);
                  return Upload.LIST_IGNORE;
                }
                setFile(f);
                return false;
              }}
              onRemove={() => { setFile(null); return true; }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p>拖入或点击上传</p>
              <p className="ant-upload-hint">
                视频：MP4 / MOV / MKV / WEBM / AVI 等<br />
                音频：MP3 / WAV / M4A / AAC / FLAC 等<br />
                最大 {MAX_MB}MB
              </p>
            </Dragger>

            <Space direction="vertical" style={{ width: '100%', marginTop: 16 }} size={12}>
              <div>
                <Text type="secondary">语言</Text>
                <Select
                  value={language}
                  onChange={setLanguage}
                  style={{ width: '100%', marginTop: 4 }}
                  options={[
                    { value: 'zh', label: '简体中文' },
                    { value: 'auto', label: '自动检测' },
                    { value: 'en', label: 'English' },
                    { value: 'ja', label: '日本語' },
                    { value: 'ko', label: '한국어' },
                  ]}
                />
              </div>
              <div>
                <Text type="secondary">识别模型</Text>
                <Select
                  value={model}
                  onChange={setModel}
                  style={{ width: '100%', marginTop: 4 }}
                  options={models}
                />
              </div>
              <Button type="primary" size="large" block loading={submitting} onClick={() => void handleSubmit()}>
                开始转写
              </Button>
              <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
                与配音共用同一张 GPU。若正在跑数字人或其它 GPU 任务，转写可能因显存不足失败。
              </Paragraph>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card
            title="转写结果"
            extra={active ? (
              <Space>
                {(active.status === 'success' || active.status === 'failed' || active.status === 'cancelled') && (
                  <Button icon={<ReloadOutlined />} onClick={() => {
                    void transcribeApi.retryJob(active.id).then(() => {
                      message.success('已重新排队（有断点则续跑）');
                      return loadJobs();
                    }).catch((err: any) => message.error(err.response?.data?.error?.message || err.message || '重试失败'));
                  }}>
                    重新转写
                  </Button>
                )}
                {(active.status === 'running' || active.status === 'queued') && (
                  <Button danger onClick={() => {
                    void transcribeApi.resetJob(active.id).then(() => {
                      message.success('已强制重新排队');
                      return loadJobs();
                    }).catch((err: any) => message.error(err.response?.data?.error?.message || err.message || '重置失败'));
                  }}>
                    卡住了？强制重排
                  </Button>
                )}
                {active.status === 'success' && active.text && (
                  <>
                    <Button icon={<CopyOutlined />} onClick={() => void handleCopy(active.text || '')}>复制</Button>
                    <Button
                      type="primary"
                      icon={<DownloadOutlined />}
                      onClick={() => handleDownloadTxt(active.text || '', active.fileName)}
                    >
                      下载文本
                    </Button>
                  </>
                )}
              </Space>
            ) : null}
          >
            {!active ? (
              <Paragraph type="secondary">提交任务后，文本会显示在这里。</Paragraph>
            ) : (
              <>
                <Space wrap style={{ marginBottom: 12 }}>
                  <Text strong>{active.fileName}</Text>
                  <Tag color={STATUS_LABEL[active.status]?.color}>{STATUS_LABEL[active.status]?.text || active.status}</Tag>
                  <Text type="secondary">{STAGE_LABEL[active.stage] || active.stage}</Text>
                  {active.durationSec ? <Text type="secondary">时长 {formatDuration(active.durationSec)}</Text> : null}
                </Space>
                {(active.status === 'queued' || active.status === 'running') && (
                  <Progress percent={active.progress || 0} status="active" />
                )}
                {active.message && <Paragraph type="secondary">{active.message}</Paragraph>}
                {active.error && <Paragraph type="danger">{active.error}</Paragraph>}
                {active.status === 'success' && (
                  <TextArea
                    value={active.text || '（未识别到文本）'}
                    readOnly
                    autoSize={{ minRows: 10, maxRows: 22 }}
                  />
                )}
              </>
            )}
          </Card>
        </Col>
      </Row>

      <Card title="历史任务" style={{ marginTop: 24 }}>
        {jobs.length === 0 ? (
          <Paragraph type="secondary" style={{ margin: 0 }}>暂无任务</Paragraph>
        ) : (
          <List
            dataSource={jobs}
            renderItem={(item) => (
              <List.Item
                onClick={() => setActiveId(item.id)}
                style={{
                  cursor: 'pointer',
                  background: active?.id === item.id ? '#e6f4ff' : undefined,
                  borderRadius: 8,
                  padding: '8px 12px',
                }}
                actions={[
                  item.status === 'success' && item.text && (
                    <Button key="dl" type="text" icon={<DownloadOutlined />} onClick={(e) => { e.stopPropagation(); handleDownloadTxt(item.text || '', item.fileName); }}>
                      下载
                    </Button>
                  ),
                  item.status === 'success' && item.text && (
                    <Button key="copy" type="text" icon={<CopyOutlined />} onClick={(e) => { e.stopPropagation(); void handleCopy(item.text || ''); }}>
                      复制
                    </Button>
                  ),
                  item.status !== 'running' && (
                    <Popconfirm
                      key="del"
                      title="删除此任务？"
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        void transcribeApi.deleteJob(item.id).then(() => {
                          if (activeId === item.id) setActiveId(null);
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
                  avatar={<FileTextOutlined style={{ fontSize: 20 }} />}
                  title={
                    <Space>
                      {item.fileName}
                      <Tag color={STATUS_LABEL[item.status]?.color}>{STATUS_LABEL[item.status]?.text || item.status}</Tag>
                    </Space>
                  }
                  description={
                    <Text type="secondary">
                      {new Date(item.createdAt).toLocaleString()}
                      {item.durationSec ? ` · ${formatDuration(item.durationSec)}` : ''}
                      {item.text ? ` · ${item.text.length} 字` : ''}
                      {item.error ? ` · ${item.error}` : ''}
                    </Text>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  );
};

export default TranscribePage;

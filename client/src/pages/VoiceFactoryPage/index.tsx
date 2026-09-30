import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Col, Input, List, Popconfirm, Progress, Radio,
  Row, Select, Space, Spin, Tag, Tooltip, Typography, Upload, message,
} from 'antd';
import {
  ArrowLeftOutlined, AudioOutlined, DeleteOutlined, DownloadOutlined,
  PauseOutlined, PlayCircleOutlined, PlusOutlined,
} from '@ant-design/icons';
import { voiceboxApi } from '../../api';
import { VoiceCloneModal, VoiceListPanel, ModelListPanel, fetchVoiceSampleObjectUrl } from '../../components/voicebox';
import { isTtsModel } from '../../utils/voiceboxModels';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

const SAMPLE_TEXT =
  '各位同学大家好。今天我们来学习基础软件知识总览。请注意吐字清晰，语速保持平稳，不要越说越快。';

const SAMPLE_DIALOGUE = `# 示例：双人讨论（支持「角色：对白」与「[角色] 对白」）
主持人：各位好，今天我们讨论信创建设的重点。
专家甲：我认为要从基础软件和操作系统抓起，夯实底座。
[专家乙] 同意。同时要加强人才培养，避免只会用、不会造。
主持人：总结一下，底座与人才要两手抓。`;

function formatDuration(sec: number | null | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '-';
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h${m}m`;
  }
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m${s}s`;
  }
  return `${sec.toFixed(1)}s`;
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  queued: { color: 'default', text: '排队中' },
  running: { color: 'processing', text: '生成中' },
  success: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
  cancelled: { color: 'warning', text: '已取消' },
};

interface HistoryItem {
  id: string;
  text: string;
  voiceName: string;
  modelName: string;
  duration: number;
  createdAt: string;
}

const VoiceFactoryPage: React.FC = () => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'single' | 'multi'>('single');
  const [voices, setVoices] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [voiceboxAvailable, setVoiceboxAvailable] = useState<boolean | null>(null);

  const [text, setText] = useState(SAMPLE_TEXT);
  const [instruct, setInstruct] = useState('语速平稳，吐字清晰，不要越说越快。');
  const [language, setLanguage] = useState('zh-CN');
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState('');
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);

  // 多人对话
  const [scriptText, setScriptText] = useState(SAMPLE_DIALOGUE);
  const [jobName, setJobName] = useState('');
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [cast, setCast] = useState<Record<string, string>>({});
  const [gapMs, setGapMs] = useState(600);
  const [segmentCount, setSegmentCount] = useState(0);
  const [parseError, setParseError] = useState('');
  const [submittingDialogue, setSubmittingDialogue] = useState(false);
  const [dialogueJobs, setDialogueJobs] = useState<any[]>([]);

  const [cloneOpen, setCloneOpen] = useState(false);

  const pollRef = useRef<number | null>(null);
  const dialoguePollRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sampleRef = useRef<HTMLAudioElement | null>(null);

  const ttsModels = models.filter(isTtsModel);
  const selectedVoice = voices.find((v) => v.id === selectedVoiceId);
  const selectedModel = ttsModels.find((m) => m.id === selectedModelId);
  const modelReady = selectedModel?.status === 'available' || selectedModel?.status === 'downloaded';
  const canGenerate = !!selectedVoiceId && !!selectedModelId && modelReady && text.trim().length > 0 && !generating;
  const castReady = speakers.length > 0 && speakers.every((s) => !!cast[s]);
  const canSubmitDialogue =
    !!selectedModelId && modelReady && castReady && segmentCount > 0 && !parseError && !submittingDialogue;

  const loadVoices = useCallback(async () => {
    setLoadingVoices(true);
    try {
      const res = await voiceboxApi.listVoices();
      setVoices(res.data.data || []);
    } finally {
      setLoadingVoices(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const res = await voiceboxApi.listModels();
      const list = (res.data.data || []).filter(isTtsModel);
      setModels(res.data.data || []);
      setSelectedModelId((prev) => {
        if (prev && list.some((m: any) => m.id === prev)) return prev;
        const preferred = list.find((m: any) => m.isRecommended && (m.status === 'available' || m.status === 'downloaded'))
          || list.find((m: any) => m.status === 'available' || m.status === 'downloaded');
        return preferred?.id || prev;
      });
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const loadDialogueJobs = useCallback(async () => {
    try {
      const res = await voiceboxApi.listDialogueJobs();
      setDialogueJobs(res.data.data?.jobs || []);
    } catch {
      /* ignore when endpoint not ready */
    }
  }, []);

  const previewScript = useCallback(async (script: string) => {
    const raw = script.trim();
    if (!raw) {
      setSpeakers([]);
      setSegmentCount(0);
      setParseError('');
      return;
    }
    try {
      const res = await voiceboxApi.previewDialogue(raw);
      const data = res.data.data;
      const nextSpeakers: string[] = data?.speakers || [];
      setSpeakers(nextSpeakers);
      setSegmentCount(Number(data?.segmentCount || 0));
      setParseError('');
      setCast((prev) => {
        const next: Record<string, string> = {};
        for (const s of nextSpeakers) {
          if (prev[s]) next[s] = prev[s];
        }
        return next;
      });
    } catch (err: any) {
      setSpeakers([]);
      setSegmentCount(0);
      setParseError(err.response?.data?.error?.message || err.message || '解析失败');
    }
  }, []);

  useEffect(() => {
    document.title = 'Cinedeck · 造声工厂';
    voiceboxApi.healthCheck().then((res) => {
      const ok = res.data?.data?.available ?? false;
      setVoiceboxAvailable(ok);
      if (ok) {
        void loadVoices();
        void loadModels();
      }
      void loadDialogueJobs();
    }).catch(() => {
      setVoiceboxAvailable(false);
      void loadDialogueJobs();
    });
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (dialoguePollRef.current) window.clearInterval(dialoguePollRef.current);
      audioRef.current?.pause();
      sampleRef.current?.pause();
    };
  }, [loadVoices, loadModels, loadDialogueJobs]);

  // 剧本变更时防抖预览
  useEffect(() => {
    if (mode !== 'multi') return;
    const t = window.setTimeout(() => { void previewScript(scriptText); }, 400);
    return () => window.clearTimeout(t);
  }, [scriptText, mode, previewScript]);

  // 有排队/运行中的对话任务时轮询
  useEffect(() => {
    const active = dialogueJobs.some((j) => j.status === 'queued' || j.status === 'running');
    if (!active) {
      if (dialoguePollRef.current) {
        window.clearInterval(dialoguePollRef.current);
        dialoguePollRef.current = null;
      }
      return;
    }
    if (dialoguePollRef.current) return;
    dialoguePollRef.current = window.setInterval(() => { void loadDialogueJobs(); }, 2500);
    return () => {
      if (dialoguePollRef.current) {
        window.clearInterval(dialoguePollRef.current);
        dialoguePollRef.current = null;
      }
    };
  }, [dialogueJobs, loadDialogueJobs]);

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setPlayingId(null);
  };

  const stopSample = () => {
    if (sampleRef.current) {
      sampleRef.current.pause();
      sampleRef.current.src = '';
      sampleRef.current = null;
    }
    setPlayingVoiceId(null);
  };

  const playTask = (taskId: string) => {
    if (playingId === taskId) {
      stopAudio();
      return;
    }
    stopAudio();
    stopSample();
    const audio = new Audio(voiceboxApi.getTaskAudioUrl(taskId));
    audioRef.current = audio;
    setPlayingId(taskId);
    audio.play().catch(() => {
      message.error('播放失败');
      stopAudio();
    });
    audio.onended = () => stopAudio();
  };

  const playSample = async (voiceId: string) => {
    if (playingVoiceId === voiceId) {
      stopSample();
      return;
    }
    stopSample();
    stopAudio();
    setPreviewingVoiceId(voiceId);
    const hide = message.loading('正在准备试听（预置音色首次可能需合成）…', 0);
    try {
      const objectUrl = await fetchVoiceSampleObjectUrl(voiceId);
      const audio = new Audio(objectUrl);
      sampleRef.current = audio;
      setPlayingVoiceId(voiceId);
      audio.onended = () => {
        stopSample();
        URL.revokeObjectURL(objectUrl);
      };
      await audio.play();
    } catch (err: any) {
      message.error(err.message || '试听失败');
      stopSample();
    } finally {
      hide();
      setPreviewingVoiceId(null);
    }
  };

  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const handleGenerate = async () => {
    if (!canGenerate || !selectedVoiceId || !selectedModelId) return;
    stopPolling();
    setGenerating(true);
    setGenStatus('提交生成任务…');
    try {
      const res = await voiceboxApi.generateDubbing({
        text: text.trim(),
        voiceId: selectedVoiceId,
        modelId: selectedModelId,
        language,
        instruct: instruct.trim() || undefined,
      });
      const taskId = res.data.data?.id;
      if (!taskId) throw new Error('未返回任务 ID');
      setCurrentTaskId(taskId);
      setGenStatus('Voicebox 正在合成…');

      const started = Date.now();
      pollRef.current = window.setInterval(async () => {
        try {
          if (Date.now() - started > 10 * 60 * 1000) {
            stopPolling();
            setGenerating(false);
            setGenStatus('');
            message.error('生成超时，请缩短文本后重试');
            return;
          }
          const st = await voiceboxApi.getTaskStatus(taskId);
          const status = st.data.data?.status;
          if (status === 'processing') {
            setGenStatus('合成中，请稍候…');
            return;
          }
          stopPolling();
          if (status === 'succeeded') {
            const result = await voiceboxApi.getTaskResult(taskId);
            const duration = Number(result.data.data?.duration || 0);
            setHistory((prev) => [{
              id: taskId,
              text: text.trim(),
              voiceName: selectedVoice?.name || selectedVoiceId,
              modelName: selectedModel?.name || selectedModelId,
              duration,
              createdAt: new Date().toLocaleTimeString(),
            }, ...prev].slice(0, 12));
            setGenerating(false);
            setGenStatus('生成完成');
            message.success(`生成完成${duration ? `，时长 ${duration.toFixed(1)}s` : ''}`);
            playTask(taskId);
          } else {
            setGenerating(false);
            setGenStatus('');
            message.error(st.data.data?.error || '生成失败');
          }
        } catch (err: any) {
          stopPolling();
          setGenerating(false);
          setGenStatus('');
          message.error(err.response?.data?.error?.message || err.message || '查询进度失败');
        }
      }, 1500);
    } catch (err: any) {
      setGenerating(false);
      setGenStatus('');
      message.error(err.response?.data?.error?.message || err.message || '提交失败');
    }
  };

  const handleDownload = async (taskId: string) => {
    try {
      await voiceboxApi.downloadTaskAudio(taskId, `造声工厂-${taskId.slice(0, 8)}`);
    } catch (err: any) {
      message.error(err.message || '下载失败');
    }
  };

  const playDialogue = (jobId: string) => {
    if (playingId === `dlg-${jobId}`) {
      stopAudio();
      return;
    }
    stopAudio();
    stopSample();
    const hide = message.loading('正在加载音频（长音频可能需要几秒）…', 0);
    const audio = new Audio(voiceboxApi.getDialogueAudioUrl(jobId));
    audio.preload = 'auto';
    audioRef.current = audio;
    setPlayingId(`dlg-${jobId}`);
    const fail = (msg?: string) => {
      hide();
      message.error(msg || '播放失败');
      stopAudio();
    };
    audio.oncanplay = () => {
      hide();
      audio.play().catch(() => fail('浏览器无法播放该音频，请改用下载'));
    };
    audio.onerror = () => fail('音频加载失败，请改用下载');
    audio.onended = () => {
      hide();
      stopAudio();
    };
  };

  const handleSubmitDialogue = async () => {
    if (!canSubmitDialogue || !selectedModelId) return;
    setSubmittingDialogue(true);
    try {
      await voiceboxApi.createDialogueJob({
        name: jobName.trim() || undefined,
        script: scriptText,
        cast,
        modelId: selectedModelId,
        language,
        instruct: instruct.trim() || undefined,
        gapMs,
      });
      message.success('已提交多人对话任务（可关闭页面，稍后回来下载）');
      await loadDialogueJobs();
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || err.message || '提交失败');
    } finally {
      setSubmittingDialogue(false);
    }
  };

  const onScriptFile = async (file: File) => {
    try {
      const textContent = await file.text();
      setScriptText(textContent);
      if (!jobName.trim()) {
        setJobName(file.name.replace(/\.[^.]+$/, '').slice(0, 80));
      }
      message.success('剧本已载入');
    } catch {
      message.error('读取文件失败');
    }
    return false;
  };

  return (
    <div style={{ maxWidth: 1280, width: '100%', margin: '0 auto', padding: '32px clamp(16px, 3vw, 40px)', boxSizing: 'border-box' }}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回工作台</Button>
      </Space>

      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ marginBottom: 4 }}>造声工厂</Title>
        <Text type="secondary">全局音色库：克隆/预置音色、单人试听、多人对话。PPT 项目与 MOOC 均从此处取音色。</Text>
        <div style={{ marginTop: 12 }}>
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={[
              { value: 'single', label: '单人配音' },
              { value: 'multi', label: '多人对话' },
            ]}
          />
        </div>
      </div>

      {voiceboxAvailable === false && (
        <Alert
          type="warning"
          showIcon
          message="Voicebox 服务启动中"
          description={
            <Button size="small" type="primary" onClick={() => {
              voiceboxApi.healthCheck().then((res) => {
                const ok = res.data?.data?.available ?? false;
                setVoiceboxAvailable(ok);
                if (ok) { void loadVoices(); void loadModels(); message.success('Voicebox 已连接'); }
                else message.info('仍在启动中，请稍后再试');
              }).catch(() => message.info('仍在启动中，请稍后再试'));
            }}>
              重新检测
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={10}>
          <Card
            title={mode === 'single' ? '1. 选择 / 克隆音色' : '1. 音色库（用于角色映射）'}
            extra={
              <Button icon={<PlusOutlined />} onClick={() => setCloneOpen(true)} disabled={voiceboxAvailable === false}>
                克隆音色
              </Button>
            }
          >
            <VoiceListPanel
              voices={voices}
              loading={loadingVoices}
              selectedVoiceId={mode === 'single' ? selectedVoiceId : null}
              onSelectVoice={mode === 'single' ? setSelectedVoiceId : undefined}
              playingVoiceId={playingVoiceId}
              previewLoadingVoiceId={previewingVoiceId}
              onPlaySample={playSample}
              onDeleteVoice={async (vid) => {
                await voiceboxApi.deleteVoice(vid);
                if (selectedVoiceId === vid) setSelectedVoiceId(null);
                await loadVoices();
              }}
            />
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card title="2. 选择模型">
            <ModelListPanel
              variant="simple"
              models={models}
              loading={loadingModels}
              selectedModelId={selectedModelId}
              onSelectModel={setSelectedModelId}
              onDownloadModel={async (mid) => {
                await voiceboxApi.downloadModel(mid);
                message.success('已开始下载');
                void loadModels();
              }}
            />
          </Card>
        </Col>
      </Row>

      {mode === 'single' ? (
        <>
          <Card title="3. 生成音频" style={{ marginTop: 24 }}>
            <Row gutter={16}>
              <Col xs={24} md={16}>
                <TextArea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={6}
                  maxLength={2000}
                  showCount
                  placeholder="输入要合成的文本"
                />
              </Col>
              <Col xs={24} md={8}>
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  <div>
                    <Text type="secondary">语言</Text>
                    <Select
                      value={language}
                      onChange={setLanguage}
                      style={{ width: '100%', marginTop: 4 }}
                      options={[
                        { value: 'zh-CN', label: '中文' },
                        { value: 'en-US', label: 'English' },
                      ]}
                    />
                  </div>
                  <div>
                    <Text type="secondary">风格指令（可选）</Text>
                    <Input
                      value={instruct}
                      onChange={(e) => setInstruct(e.target.value)}
                      style={{ marginTop: 4 }}
                      placeholder="例如：语速平稳，吐字清晰"
                    />
                  </div>
                  <Button type="link" style={{ padding: 0 }} onClick={() => setText(SAMPLE_TEXT)}>填入示例文本</Button>
                </Space>
              </Col>
            </Row>

            <Space style={{ marginTop: 16 }} wrap>
              <Tooltip title={!selectedVoiceId ? '请先选择音色' : !selectedModelId ? '请先选择模型' : !modelReady ? '模型尚未可用' : !text.trim() ? '请输入文本' : ''}>
                <Button
                  type="primary"
                  size="large"
                  icon={<AudioOutlined />}
                  loading={generating}
                  disabled={!canGenerate}
                  onClick={() => void handleGenerate()}
                >
                  生成音频
                </Button>
              </Tooltip>
              {generating && currentTaskId && (
                <Button onClick={() => {
                  stopPolling();
                  void voiceboxApi.cancelTask(currentTaskId);
                  setGenerating(false);
                  setGenStatus('');
                }}>
                  取消
                </Button>
              )}
              {genStatus && <Text type="secondary">{genStatus}</Text>}
            </Space>
          </Card>

          <Card title="4. 生成结果" style={{ marginTop: 24 }}>
            {history.length === 0 ? (
              <Paragraph type="secondary" style={{ margin: 0 }}>生成后可在此播放和下载。</Paragraph>
            ) : (
              <List
                dataSource={history}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Button
                        key="play"
                        type="text"
                        icon={playingId === item.id ? <PauseOutlined /> : <PlayCircleOutlined />}
                        onClick={() => playTask(item.id)}
                      >
                        {playingId === item.id ? '停止' : '播放'}
                      </Button>,
                      <Button
                        key="dl"
                        type="text"
                        icon={<DownloadOutlined />}
                        onClick={() => void handleDownload(item.id)}
                      >
                        下载
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space>
                          <Text>{item.createdAt}</Text>
                          <Tag>{item.voiceName}</Tag>
                          <Tag>{item.modelName}</Tag>
                          <Text type="secondary">{formatDuration(item.duration)}</Text>
                        </Space>
                      }
                      description={<Text type="secondary">{item.text.length > 80 ? `${item.text.slice(0, 80)}…` : item.text}</Text>}
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </>
      ) : (
        <>
          <Card title="3. 剧本与角色映射" style={{ marginTop: 24 }}>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="格式：每行「角色：对白」或「[角色] 对白」；以 # 开头为注释。预置音色请选 Qwen CustomVoice；克隆音色请选 Qwen TTS。系统也会按音色类型自动纠正引擎。"
            />
            <Row gutter={16}>
              <Col xs={24} md={14}>
                <Space style={{ marginBottom: 8 }} wrap>
                  <Upload accept=".txt,.md,.csv" showUploadList={false} beforeUpload={onScriptFile}>
                    <Button>上传剧本文件</Button>
                  </Upload>
                  <Button type="link" onClick={() => setScriptText(SAMPLE_DIALOGUE)}>填入示例</Button>
                  {segmentCount > 0 && !parseError && (
                    <Tag color="blue">{segmentCount} 段 · {speakers.length} 角色</Tag>
                  )}
                </Space>
                <TextArea
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  rows={12}
                  placeholder={'主持人：开场白…\n嘉宾：回应…'}
                  style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                />
                {parseError && <Text type="danger" style={{ display: 'block', marginTop: 8 }}>{parseError}</Text>}
              </Col>
              <Col xs={24} md={10}>
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  <div>
                    <Text type="secondary">任务名称</Text>
                    <Input
                      value={jobName}
                      onChange={(e) => setJobName(e.target.value)}
                      style={{ marginTop: 4 }}
                      placeholder="可选，便于事后查找"
                      maxLength={80}
                    />
                  </div>
                  <div>
                    <Text type="secondary">语言</Text>
                    <Select
                      value={language}
                      onChange={setLanguage}
                      style={{ width: '100%', marginTop: 4 }}
                      options={[
                        { value: 'zh-CN', label: '中文' },
                        { value: 'en-US', label: 'English' },
                      ]}
                    />
                  </div>
                  <div>
                    <Text type="secondary">风格指令（可选，全局）</Text>
                    <Input
                      value={instruct}
                      onChange={(e) => setInstruct(e.target.value)}
                      style={{ marginTop: 4 }}
                      placeholder="例如：语速平稳，吐字清晰"
                    />
                  </div>
                  <div>
                    <Text type="secondary">段间静音（毫秒）</Text>
                    <Input
                      type="number"
                      min={0}
                      max={2000}
                      value={gapMs}
                      onChange={(e) => setGapMs(Math.min(2000, Math.max(0, Number(e.target.value) || 0)))}
                      style={{ marginTop: 4 }}
                    />
                  </div>
                  <div>
                    <Text strong>角色 → 音色</Text>
                    {speakers.length === 0 ? (
                      <Paragraph type="secondary" style={{ margin: '8px 0 0' }}>解析剧本后显示角色列表</Paragraph>
                    ) : (
                      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={8}>
                        {speakers.map((sp) => (
                          <div key={sp}>
                            <Text type="secondary">{sp}</Text>
                            <Select
                              value={cast[sp] || undefined}
                              placeholder="选择音色"
                              style={{ width: '100%', marginTop: 4 }}
                              options={voices.map((v: any) => ({ value: v.id, label: v.name }))}
                              onChange={(vid) => setCast((prev) => ({ ...prev, [sp]: vid }))}
                              showSearch
                              optionFilterProp="label"
                            />
                          </div>
                        ))}
                      </Space>
                    )}
                  </div>
                </Space>
              </Col>
            </Row>

            <Space style={{ marginTop: 16 }} wrap>
              <Tooltip title={
                !selectedModelId ? '请先选择模型'
                  : !modelReady ? '模型尚未可用'
                    : parseError ? '请先修正剧本格式'
                      : !castReady ? '请为每个角色选择音色'
                        : !segmentCount ? '剧本为空'
                          : ''
              }>
                <Button
                  type="primary"
                  size="large"
                  icon={<AudioOutlined />}
                  loading={submittingDialogue}
                  disabled={!canSubmitDialogue}
                  onClick={() => void handleSubmitDialogue()}
                >
                  提交多人对话
                </Button>
              </Tooltip>
            </Space>
          </Card>

          <Card
            title="4. 对话任务（持久保存）"
            style={{ marginTop: 24 }}
            extra={<Button size="small" onClick={() => void loadDialogueJobs()}>刷新</Button>}
          >
            {dialogueJobs.length === 0 ? (
              <Paragraph type="secondary" style={{ margin: 0 }}>提交后任务会出现在这里，关闭页面也不会丢失。</Paragraph>
            ) : (
              <List
                dataSource={dialogueJobs}
                renderItem={(job: any) => {
                  const st = STATUS_TAG[job.status] || { color: 'default', text: job.status };
                  const busy = job.status === 'queued' || job.status === 'running';
                  return (
                    <List.Item
                      actions={[
                        job.hasAudio && (
                          <Button
                            key="play"
                            type="text"
                            icon={playingId === `dlg-${job.id}` ? <PauseOutlined /> : <PlayCircleOutlined />}
                            onClick={() => playDialogue(job.id)}
                          >
                            {playingId === `dlg-${job.id}` ? '停止' : '播放'}
                          </Button>
                        ),
                        job.hasAudio && (
                          <Button
                            key="dl"
                            type="text"
                            icon={<DownloadOutlined />}
                            onClick={() => voiceboxApi.downloadDialogueAudio(job.id)}
                          >
                            下载
                          </Button>
                        ),
                        busy && (
                          <Button
                            key="cancel"
                            type="text"
                            onClick={async () => {
                              await voiceboxApi.cancelDialogueJob(job.id);
                              await loadDialogueJobs();
                            }}
                          >
                            取消
                          </Button>
                        ),
                        !busy && (
                          <Popconfirm
                            key="del"
                            title="确认删除此任务及音频？"
                            onConfirm={async () => {
                              await voiceboxApi.deleteDialogueJob(job.id);
                              await loadDialogueJobs();
                            }}
                          >
                            <Button type="text" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        ),
                      ].filter(Boolean)}
                    >
                      <List.Item.Meta
                        title={
                          <Space wrap>
                            <Text>{job.name}</Text>
                            <Tag color={st.color}>{st.text}</Tag>
                            <Text type="secondary">
                              {job.completedSegments || 0}/{job.segmentCount || 0} 段
                            </Text>
                            {job.durationSec != null && (
                              <Text type="secondary">{formatDuration(job.durationSec)}</Text>
                            )}
                          </Space>
                        }
                        description={
                          <Space direction="vertical" size={4} style={{ width: '100%' }}>
                            {busy && <Progress percent={Number(job.progress || 0)} size="small" status="active" />}
                            <Text type="secondary">
                              {job.message || ''}
                              {job.error ? ` · ${job.error}` : ''}
                            </Text>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}
                            </Text>
                          </Space>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )}
          </Card>
        </>
      )}

      <VoiceCloneModal
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        onSuccess={async (voice) => {
          await loadVoices();
          if (voice.id) setSelectedVoiceId(voice.id);
        }}
      />
    </div>
  );
};

export default VoiceFactoryPage;

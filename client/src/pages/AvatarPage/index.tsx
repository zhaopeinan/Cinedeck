import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Col, Input, Progress, Radio, Row, Select, Space, Steps, Tabs, Typography, Upload, message, Checkbox, Modal,
} from 'antd';
import {
  ArrowLeftOutlined, InboxOutlined, SoundOutlined, PictureOutlined,
  DownloadOutlined, VideoCameraOutlined, ArrowRightOutlined,
} from '@ant-design/icons';
import {
  avatarApi, voiceboxApi, withToken, type AvatarDriveMode,
} from '../../api';
import type { AvatarLayout } from '../../types';
import { DEFAULT_AVATAR_LAYOUT } from '../../constants/avatarDefaults';
import {
  AvatarDriveModePicker,
  AvatarPhotoUpload,
  AvatarRefLibraryPanel,
  GreenscreenAlert,
  GreenscreenComposeEditor,
  useAvatarRefs,
} from '../../components/avatar';
import {
  ModelSelectField, VoiceSelectField, useVoiceboxCatalog,
} from '../../components/voicebox';
import { isCustomVoiceModel, preferredModelForVoices } from '../../utils/voiceboxModels';
import { formatFileSize } from '../../utils/formatFileSize';
import { formatQueueHint } from '../../utils/queueHint';

const { Title, Text, Paragraph } = Typography;
const { Dragger } = Upload;
const { TextArea } = Input;

type NarrationSource = 'tts' | 'upload';
const MAX_AVATAR_AUDIO_HINT_SEC = 120;
/** Rough Chinese speaking rate for soft length guidance. */
const CHARS_PER_SEC = 3.5;

async function waitForTtsTask(
  taskId: string,
  onStatus: (msg: string) => void,
): Promise<{ duration: number }> {
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
    const st = await voiceboxApi.getTaskStatus(taskId);
    const status = String(st.data.data?.status || '');
    if (status === 'succeeded' || status === 'completed' || status === 'success') {
      const result = await voiceboxApi.getTaskResult(taskId);
      return { duration: Number(result.data.data?.duration || 0) };
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw new Error(st.data.data?.error || '配音生成失败');
    }
    onStatus('正在合成解说音频…');
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('配音超时，请缩短文本后重试');
}

async function fetchTtsAudioFile(taskId: string): Promise<File> {
  const token = localStorage.getItem('ppt_audio_token');
  const res = await fetch(voiceboxApi.getTaskAudioUrl(taskId), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    let msg = '下载配音失败';
    try {
      const body = await res.json();
      msg = body?.error?.message || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const type = blob.type || 'audio/wav';
  const ext = /mpeg|mp3/i.test(type) ? 'mp3' : 'wav';
  return new File([blob], `avatar-tts-${taskId.slice(0, 8)}.${ext}`, { type });
}

type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

interface JobState {
  id: string;
  driveMode?: AvatarDriveMode;
  refVideoId?: string | null;
  status: JobStatus;
  stage: string;
  message: string;
  progress: number;
  error?: string | null;
  queuePosition?: number | null;
}

interface ComposeState {
  id: string;
  mode: 'preview' | 'export';
  status: JobStatus;
  stage: string;
  message: string;
  progress: number;
  error?: string | null;
  hasVideo?: boolean;
  queuePosition?: number | null;
}

type GreenscreenSource =
  | { kind: 'job'; jobId: string; previewUrl: string }
  | { kind: 'file'; file: File; previewUrl: string }
  | { kind: 'ref'; refId: string; previewUrl: string };

const AvatarPage: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  // --- Step1: Duix gen / greenscreen / background ---
  const [gsTab, setGsTab] = useState<'duix' | 'upload'>('duix');
  const [driveMode, setDriveMode] = useState<AvatarDriveMode>('video');
  const [photo, setPhoto] = useState<File | null>(null);
  const [template, setTemplate] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [templatePreview, setTemplatePreview] = useState<string | null>(null);
  const [audioPreview, setAudioPreview] = useState<string | null>(null);
  const [narrationSource, setNarrationSource] = useState<NarrationSource>('tts');
  const [scriptText, setScriptText] = useState('');
  const [voiceId, setVoiceId] = useState<string>('');
  const [modelId, setModelId] = useState<string>('');
  const [ttsLanguage, setTtsLanguage] = useState('zh');
  const [submitPhase, setSubmitPhase] = useState<string>('');
  const [selectedRefId, setSelectedRefId] = useState<string | null>(null);
  const [saveToLibrary, setSaveToLibrary] = useState(true);
  const [tempAsGreenscreen, setTempAsGreenscreen] = useState(true);
  const { refs, setRefs, loading: refsLoading } = useAvatarRefs();
  const {
    voices, ttsModels, loadingVoices, loadingModels, voiceboxAvailable,
    reloadAll, pickDefaultModelId,
  } = useVoiceboxCatalog({ autoLoad: true });
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const pollRef = useRef<number | null>(null);

  const [greenscreen, setGreenscreen] = useState<GreenscreenSource | null>(null);
  const [background, setBackground] = useState<File | null>(null);
  const [backgroundPreview, setBackgroundPreview] = useState<string | null>(null);
  const [gsUploadFile, setGsUploadFile] = useState<File | null>(null);
  const [gsUploadPreview, setGsUploadPreview] = useState<string | null>(null);
  const [gsRefId, setGsRefId] = useState<string | null>(null);

  // --- Step2 layout ---
  const [layout, setLayout] = useState<AvatarLayout>({ ...DEFAULT_AVATAR_LAYOUT });
  const [chromaSimilarity, setChromaSimilarity] = useState(0.28);

  // --- Step3/4 compose ---
  const [composeSubmitting, setComposeSubmitting] = useState(false);
  const [composeJob, setComposeJob] = useState<ComposeState | null>(null);
  const composePollRef = useRef<number | null>(null);
  const [gsLocalizing, setGsLocalizing] = useState(false);
  const [gsLocalProgress, setGsLocalProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  const gsBlobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    document.title = 'Cinedeck · 数字人解说';
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (composePollRef.current) window.clearInterval(composePollRef.current);
      [photoPreview, templatePreview, audioPreview, backgroundPreview, gsUploadPreview].forEach((u) => {
        if (u) URL.revokeObjectURL(u);
      });
      if (gsBlobUrlRef.current) URL.revokeObjectURL(gsBlobUrlRef.current);
      if (greenscreen?.kind === 'file' && greenscreen.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(greenscreen.previewUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!voices.length) return;
    if (!voiceId || !voices.some((v) => v.id === voiceId)) {
      setVoiceId(voices[0].id);
    }
  }, [voices, voiceId]);

  useEffect(() => {
    if (!ttsModels.length || !voiceId) return;
    const selected = voices.find((v) => v.id === voiceId);
    const hasPreset = selected?.source === 'preset';
    const pick = preferredModelForVoices({ models: ttsModels, hasPresetVoice: !!hasPreset })
      || pickDefaultModelId(!!hasPreset);
    if (!pick) return;
    const modelMissing = !modelId || !ttsModels.some((m) => m.id === modelId);
    const engineMismatch = !!modelId && isCustomVoiceModel(modelId) !== !!hasPreset;
    if (modelMissing || engineMismatch) setModelId(pick);
  }, [ttsModels, voices, voiceId, modelId, pickDefaultModelId]);

  /** Pull Duix job video to a local blob URL so摆位 Canvas can decode instantly. */
  const localizeJobGreenscreen = async (jobId: string): Promise<string> => {
    setGsLocalizing(true);
    setGsLocalProgress({ loaded: 0, total: null });
    try {
      const blob = await avatarApi.fetchJobVideoBlob(jobId, (loaded, total) => {
        setGsLocalProgress({ loaded, total });
      });
      if (gsBlobUrlRef.current) URL.revokeObjectURL(gsBlobUrlRef.current);
      const url = URL.createObjectURL(blob);
      gsBlobUrlRef.current = url;
      return url;
    } finally {
      setGsLocalizing(false);
      setGsLocalProgress(null);
    }
  };

  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const stopComposePolling = () => {
    if (composePollRef.current) {
      window.clearInterval(composePollRef.current);
      composePollRef.current = null;
    }
  };

  const startPolling = (jobId: string) => {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await avatarApi.getJob(jobId);
        const data = res.data.data as JobState;
        setJob(data);
        if (data.status === 'completed' || data.status === 'failed') {
          stopPolling();
          setSubmitting(false);
          if (data.status === 'completed') {
            message.success('绿幕数字人已生成，请点击「用作绿幕继续合成」');
          }
        }
      } catch {
        /* ignore transient */
      }
    }, 2000);
  };

  const startComposePolling = (composeId: string) => {
    stopComposePolling();
    composePollRef.current = window.setInterval(async () => {
      try {
        const res = await avatarApi.getCompose(composeId);
        const data = res.data.data as ComposeState;
        setComposeJob(data);
        if (data.status === 'completed' || data.status === 'failed') {
          stopComposePolling();
          setComposeSubmitting(false);
          if (data.status === 'completed') {
            message.success(data.mode === 'preview' ? '预览已就绪' : '导出完成');
          }
        }
      } catch {
        /* ignore */
      }
    }, 1500);
  };

  const handleDriveModeChange = (mode: AvatarDriveMode) => {
    setDriveMode(mode);
    if (mode === 'photo') {
      setSelectedRefId(null);
      setTemplate(null);
      setTemplatePreview((p) => { if (p) URL.revokeObjectURL(p); return null; });
    } else {
      setPhoto(null);
      setPhotoPreview((p) => { if (p) URL.revokeObjectURL(p); return null; });
    }
  };

  const estimatedScriptSec = Math.ceil(scriptText.trim().length / CHARS_PER_SEC);
  const scriptTooLong = narrationSource === 'tts' && estimatedScriptSec > MAX_AVATAR_AUDIO_HINT_SEC;

  const canSubmitDuix = (() => {
    if (driveMode === 'photo' ? !photo : !(selectedRefId || template)) return false;
    if (narrationSource === 'upload') return !!audio;
    return !!scriptText.trim() && !!voiceId && !!modelId && !scriptTooLong;
  })();

  const handleGenerateDuix = async () => {
    if (driveMode === 'video' && !(selectedRefId || template)) {
      message.warning('请先选择或上传参考视频模板');
      return;
    }
    if (driveMode === 'photo' && !photo) {
      message.warning('请先上传照片');
      return;
    }

    let audioFile = audio;
    setSubmitting(true);
    setJob(null);
    setSubmitPhase('');
    try {
      if (narrationSource === 'tts') {
        const text = scriptText.trim();
        if (!text) {
          message.warning('请输入解说文案');
          setSubmitting(false);
          return;
        }
        if (!voiceId || !modelId) {
          message.warning('请选择音色（及可用配音模型）');
          setSubmitting(false);
          return;
        }
        if (scriptTooLong) {
          message.warning(`文案偏长（约 ${estimatedScriptSec} 秒），请控制在约 ${MAX_AVATAR_AUDIO_HINT_SEC} 秒内`);
          setSubmitting(false);
          return;
        }
        if (voiceboxAvailable === false) {
          message.error('Voicebox 未就绪，无法用文字生成解说');
          setSubmitting(false);
          return;
        }
        setSubmitPhase('正在提交配音…');
        const voiceName = voices.find((v) => v.id === voiceId)?.name;
        const modelName = ttsModels.find((m) => m.id === modelId)?.name;
        const gen = await voiceboxApi.generateDubbing({
          text,
          voiceId,
          modelId,
          language: ttsLanguage,
          voiceName,
          modelName,
        });
        const taskId = gen.data.data?.id as string | undefined;
        if (!taskId) throw new Error('配音任务未返回 ID');
        setSubmitPhase('正在合成解说音频…');
        const { duration } = await waitForTtsTask(taskId, setSubmitPhase);
        if (duration > MAX_AVATAR_AUDIO_HINT_SEC + 15) {
          throw new Error(`配音约 ${duration.toFixed(0)} 秒，超过建议上限 ${MAX_AVATAR_AUDIO_HINT_SEC} 秒，请缩短文案`);
        }
        setSubmitPhase('正在准备音频并提交数字人…');
        audioFile = await fetchTtsAudioFile(taskId);
        setAudio(audioFile);
        setAudioPreview((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(audioFile!);
        });
      } else if (!audioFile) {
        message.warning('请上传解说音频');
        setSubmitting(false);
        return;
      }

      setSubmitPhase('正在提交 Duix 任务…');
      const res = await avatarApi.createJob({
        driveMode,
        audio: audioFile!,
        photo,
        template: selectedRefId ? null : template,
        refVideoId: selectedRefId,
        saveToLibrary: !selectedRefId && !!template && saveToLibrary,
        refName: template?.name,
        isGreenscreen: !selectedRefId && !!template ? tempAsGreenscreen : undefined,
      });
      const data = res.data.data as JobState;
      setJob(data);
      setSubmitPhase('');
      startPolling(data.id);
    } catch (e: any) {
      setSubmitting(false);
      setSubmitPhase('');
      message.error(e?.response?.data?.error?.message || e?.message || '提交失败');
    }
  };

  const applyGsUpload = () => {
    if (gsRefId) {
      setGreenscreen({
        kind: 'ref',
        refId: gsRefId,
        previewUrl: avatarApi.getRefPreviewUrl(gsRefId),
      });
      message.success('已选择素材库绿幕视频');
      return;
    }
    if (gsUploadFile && gsUploadPreview) {
      setGreenscreen({ kind: 'file', file: gsUploadFile, previewUrl: gsUploadPreview });
      message.success('已选择上传的绿幕视频');
      return;
    }
    message.warning('请上传绿幕视频或从素材库选择');
  };

  const canGoStep2 = !!greenscreen && !!background && !!backgroundPreview;
  const greenscreenPreviewUrl = greenscreen?.previewUrl || null;

  const submitCompose = async (mode: 'preview' | 'export') => {
    if (!background || !greenscreen) {
      message.warning('请先准备绿幕视频与底视频');
      return;
    }
    setComposeSubmitting(true);
    // 提交成功前不清空 composeJob，避免仍停在预览步时出现「请从摆位页…」空提示
    if (mode === 'export' && step === 2) {
      setComposeJob((prev) => (prev ? {
        ...prev,
        message: '正在提交导出…',
      } : prev));
    }
    try {
      const res = await avatarApi.createCompose({
        mode,
        background,
        greenscreen: greenscreen.kind === 'file' ? greenscreen.file : null,
        greenscreenJobId: greenscreen.kind === 'job' ? greenscreen.jobId : null,
        greenscreenRefId: greenscreen.kind === 'ref' ? greenscreen.refId : null,
        layout,
        chromaSimilarity,
      });
      const data = res.data.data as ComposeState;
      if (mode === 'preview') setStep(2);
      if (mode === 'export') setStep(3);
      setComposeJob(data);
      startComposePolling(data.id);
    } catch (e: any) {
      setComposeSubmitting(false);
      message.error(e?.response?.data?.error?.message || e?.message || '提交合成失败');
    }
  };

  const composeVideoUrl =
    composeJob?.status === 'completed' && composeJob.id
      ? avatarApi.getComposeVideoUrl(composeJob.id)
      : null;

  const resultVideoUrl = job?.status === 'completed' && job.id
    ? withToken(`/api/v1/avatar/jobs/${job.id}/video`)
    : null;

  const driveLabel = (job?.driveMode || driveMode) === 'video' ? '参考视频' : '静照口型';

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '40px 24px' }}>
      <Space style={{ marginBottom: 24 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>工作台</Button>
      </Space>

      <div style={{ marginBottom: 20 }}>
        <Title level={2} style={{ marginBottom: 4 }}>数字人解说</Title>
        <Text type="secondary">选视频模板 → 选音色写文案（或上传音频）→ 生成绿幕 → 摆位叠到底视频</Text>
      </div>

      <Steps
        current={step}
        style={{ marginBottom: 28 }}
        items={[
          { title: '素材' },
          { title: '摆位' },
          { title: '预览' },
          { title: '导出' },
        ]}
        onChange={(s) => {
          if (s === 0) setStep(0);
          else if (s === 1 && canGoStep2) setStep(1);
          else if (s === 2 && canGoStep2) setStep(2);
          else if (s === 3 && canGoStep2) setStep(3);
        }}
      />

      {step === 0 && (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={14}>
              <Card title="绿幕数字人" style={{ marginBottom: 16 }}>
                <Tabs
                  activeKey={gsTab}
                  onChange={(k) => setGsTab(k as 'duix' | 'upload')}
                  items={[
                    {
                      key: 'upload',
                      label: '上传 / 素材库',
                      children: (
                        <div>
                          <AvatarRefLibraryPanel
                            mode="select"
                            refs={refs}
                            loading={refsLoading}
                            selectedId={gsRefId}
                            disabled={submitting}
                            style={{ marginBottom: 12 }}
                            onSelect={(id) => {
                              setGsRefId(id);
                              setGsUploadFile(null);
                              setGsUploadPreview((p) => { if (p) URL.revokeObjectURL(p); return null; });
                            }}
                            onRefsChange={(next) => setRefs(next)}
                          />
                          <Dragger
                            accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                            maxCount={1}
                            showUploadList={false}
                            beforeUpload={(file) => {
                              if (!/\.(mp4|mov|webm)$/i.test(file.name)) {
                                message.error('仅支持 MP4 / MOV / WEBM');
                                return false;
                              }
                              if (file.size > 100 * 1024 * 1024) {
                                message.error('绿幕视频不超过 100MB');
                                return false;
                              }
                              setGsRefId(null);
                              setGsUploadPreview((p) => {
                                if (p) URL.revokeObjectURL(p);
                                return URL.createObjectURL(file);
                              });
                              setGsUploadFile(file);
                              return false;
                            }}
                          >
                            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                            <p className="ant-upload-text">或临时上传绿幕视频</p>
                          </Dragger>
                          {(gsUploadPreview || gsRefId) && (
                            <div style={{ marginTop: 12 }}>
                              {gsUploadPreview && (
                                <video src={gsUploadPreview} controls style={{ width: '100%', maxHeight: 200, background: '#000' }} />
                              )}
                              <Button type="primary" style={{ marginTop: 8 }} onClick={applyGsUpload}>
                                用作绿幕
                              </Button>
                            </div>
                          )}
                        </div>
                      ),
                    },
                    {
                      key: 'duix',
                      label: 'Duix 生成',
                      children: (
                        <div>
                          <Alert
                            type="info"
                            showIcon
                            style={{ marginBottom: 12 }}
                            message="选好视频模板后，可用音色 + 文案直接生成数字人；也可改用上传音频。单段建议不超过 2 分钟，生成期间会占用 GPU。"
                          />
                          <AvatarDriveModePicker
                            value={driveMode}
                            onChange={handleDriveModeChange}
                            disabled={submitting}
                          />
                          {driveMode === 'video' && (
                            <AvatarRefLibraryPanel
                              mode="manage"
                              refs={refs}
                              loading={refsLoading}
                              selectedId={selectedRefId}
                              disabled={submitting}
                              showTempHint
                              style={{ marginTop: 12, marginBottom: 12 }}
                              onSelect={(id) => {
                                setSelectedRefId(id);
                                setTemplate(null);
                                setTemplatePreview((p) => { if (p) URL.revokeObjectURL(p); return null; });
                              }}
                              onRefsChange={(next) => {
                                setRefs(next);
                                if (selectedRefId && !next.some((r) => r.id === selectedRefId)) {
                                  setSelectedRefId(null);
                                }
                              }}
                            />
                          )}
                          <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
                            <Col xs={24} md={12}>
                              {driveMode === 'photo' ? (
                                <Card size="small" title={<Space><PictureOutlined /> 照片</Space>}>
                                  <AvatarPhotoUpload
                                    variant="dragger"
                                    disabled={submitting}
                                    fileName={photo?.name}
                                    previewUrl={photoPreview}
                                    onFile={(file) => {
                                      setPhotoPreview((p) => { if (p) URL.revokeObjectURL(p); return URL.createObjectURL(file); });
                                      setPhoto(file);
                                    }}
                                  />
                                </Card>
                              ) : (
                                <Card size="small" title={<Space><VideoCameraOutlined /> 临时参考视频</Space>}>
                                  <Dragger
                                    accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                                    maxCount={1}
                                    showUploadList={false}
                                    beforeUpload={(file) => {
                                      if (!/\.(mp4|mov|webm)$/i.test(file.name)) {
                                        message.error('仅支持 MP4 / MOV / WEBM');
                                        return false;
                                      }
                                      setSelectedRefId(null);
                                      setTemplatePreview((p) => { if (p) URL.revokeObjectURL(p); return URL.createObjectURL(file); });
                                      setTemplate(file);
                                      return false;
                                    }}
                                    disabled={submitting}
                                  >
                                    <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                                    <p className="ant-upload-text">临时上传</p>
                                  </Dragger>
                                  {template && (
                                    <div style={{ marginTop: 8 }}>
                                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Checkbox
                                          checked={saveToLibrary}
                                          disabled={submitting}
                                          onChange={(e) => setSaveToLibrary(e.target.checked)}
                                        />
                                        <Text>保存到素材库</Text>
                                      </label>
                                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                                        <Checkbox
                                          checked={tempAsGreenscreen}
                                          disabled={submitting}
                                          onChange={(e) => setTempAsGreenscreen(e.target.checked)}
                                        />
                                        <Text>标记为绿幕</Text>
                                      </label>
                                      {tempAsGreenscreen && <GreenscreenAlert style={{ marginTop: 8 }} />}
                                    </div>
                                  )}
                                </Card>
                              )}
                            </Col>
                            <Col xs={24} md={12}>
                              <Card size="small" title={<Space><SoundOutlined /> 解说</Space>}>
                                <Radio.Group
                                  value={narrationSource}
                                  onChange={(e) => setNarrationSource(e.target.value)}
                                  optionType="button"
                                  buttonStyle="solid"
                                  disabled={submitting}
                                  style={{ marginBottom: 12 }}
                                  options={[
                                    { value: 'tts', label: '音色 + 文案' },
                                    { value: 'upload', label: '上传音频' },
                                  ]}
                                />
                                {narrationSource === 'tts' ? (
                                  <Space direction="vertical" style={{ width: '100%' }} size={10}>
                                    {voiceboxAvailable === false && (
                                      <Alert type="warning" showIcon message="Voicebox 未就绪，请稍后再试或改用上传音频" />
                                    )}
                                    <div>
                                      <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>音色</Text>
                                      <VoiceSelectField
                                        value={voiceId || undefined}
                                        onChange={setVoiceId}
                                        voices={voices}
                                        loading={loadingVoices}
                                        disabled={submitting}
                                        onReload={() => { void reloadAll(); }}
                                      />
                                    </div>
                                    <div>
                                      <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>语言</Text>
                                      <Select
                                        value={ttsLanguage}
                                        onChange={setTtsLanguage}
                                        disabled={submitting}
                                        style={{ width: '100%' }}
                                        options={[
                                          { value: 'zh', label: '中文' },
                                          { value: 'en', label: 'English' },
                                        ]}
                                      />
                                    </div>
                                    <div>
                                      <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>配音模型</Text>
                                      <ModelSelectField
                                        value={modelId || undefined}
                                        onChange={setModelId}
                                        models={ttsModels}
                                        loading={loadingModels}
                                        disabled={submitting}
                                        onReload={() => { void reloadAll(); }}
                                      />
                                    </div>
                                    <div>
                                      <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>解说文案</Text>
                                      <TextArea
                                        value={scriptText}
                                        onChange={(e) => setScriptText(e.target.value)}
                                        disabled={submitting}
                                        rows={6}
                                        placeholder="输入要让数字人说的内容…"
                                        showCount
                                        maxLength={900}
                                      />
                                      <Text
                                        type={scriptTooLong ? 'danger' : 'secondary'}
                                        style={{ display: 'block', marginTop: 4 }}
                                      >
                                        {scriptText.trim()
                                          ? `约 ${estimatedScriptSec} 秒（建议不超过 ${MAX_AVATAR_AUDIO_HINT_SEC} 秒）`
                                          : `建议单段不超过约 ${MAX_AVATAR_AUDIO_HINT_SEC} 秒`}
                                      </Text>
                                    </div>
                                    {audioPreview && narrationSource === 'tts' && (
                                      <audio controls src={audioPreview} style={{ width: '100%' }} />
                                    )}
                                  </Space>
                                ) : (
                                  <>
                                    <Dragger
                                      accept="audio/wav,audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,audio/aac,.wav,.mp3,.m4a,.aac"
                                      maxCount={1}
                                      showUploadList={false}
                                      beforeUpload={(file) => {
                                        if (!/\.(wav|mp3|m4a|aac)$/i.test(file.name)) {
                                          message.error('仅支持 WAV / MP3 / M4A / AAC');
                                          return false;
                                        }
                                        setAudio(file);
                                        setAudioPreview((prev) => {
                                          if (prev) URL.revokeObjectURL(prev);
                                          return URL.createObjectURL(file);
                                        });
                                        return false;
                                      }}
                                      disabled={submitting}
                                    >
                                      <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                                      <p className="ant-upload-text">上传音频</p>
                                      <p className="ant-upload-hint">支持 WAV / MP3 / M4A / AAC</p>
                                    </Dragger>
                                    {audio && (
                                      <div style={{ marginTop: 8 }}>
                                        <Text type="secondary">{audio.name} · {formatFileSize(audio.size)}</Text>
                                        {audioPreview && <audio controls src={audioPreview} style={{ width: '100%', marginTop: 6 }} />}
                                      </div>
                                    )}
                                  </>
                                )}
                              </Card>
                            </Col>
                          </Row>
                          <div style={{ marginTop: 16, textAlign: 'center' }}>
                            <Button type="primary" loading={submitting} disabled={!canSubmitDuix} onClick={() => void handleGenerateDuix()}>
                              {narrationSource === 'tts'
                                ? `生成配音并出绿幕 · ${driveMode === 'video' ? '参考视频' : '静照'}`
                                : `用 Duix · ${driveMode === 'video' ? '参考视频' : '静照'} 生成绿幕`}
                            </Button>
                            {submitting && submitPhase && (
                              <div style={{ marginTop: 8 }}>
                                <Text type="secondary">{submitPhase}</Text>
                              </div>
                            )}
                          </div>
                          {job && (
                            <Card size="small" style={{ marginTop: 12 }} title={`Duix · ${driveLabel}`}>
                              <Paragraph style={{ marginBottom: 8 }}>
                                {formatQueueHint(job.status, job.queuePosition, job.message || job.stage)}
                              </Paragraph>
                              <Progress
                                percent={Math.min(100, Math.round(job.progress || 0))}
                                status={job.status === 'failed' ? 'exception' : job.status === 'completed' ? 'success' : 'active'}
                              />
                              {job.status === 'failed' && (
                                <Alert type="error" showIcon style={{ marginTop: 8 }} message={job.error || '生成失败'} />
                              )}
                              {resultVideoUrl && (
                                <div style={{ marginTop: 12 }}>
                                  <video src={resultVideoUrl} controls style={{ width: '100%', maxHeight: 240, background: '#000' }} />
                                  <Button
                                    type="primary"
                                    style={{ marginTop: 8 }}
                                    loading={gsLocalizing}
                                    onClick={async () => {
                                      try {
                                        const blobUrl = await localizeJobGreenscreen(job.id);
                                        setGreenscreen({ kind: 'job', jobId: job.id, previewUrl: blobUrl });
                                        message.success('绿幕已缓存到本地，可进入摆位');
                                      } catch (e: any) {
                                        message.error(e?.message || '缓存绿幕失败');
                                      }
                                    }}
                                  >
                                    用作绿幕继续合成
                                  </Button>
                                </div>
                              )}
                            </Card>
                          )}
                        </div>
                      ),
                    },
                  ]}
                />
                {greenscreen && (
                  <Alert
                    style={{ marginTop: 12 }}
                    type="success"
                    showIcon
                    message={`已选定绿幕（${greenscreen.kind === 'job' ? 'Duix 生成' : greenscreen.kind === 'ref' ? '素材库' : '上传'}）`}
                  />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={10}>
              <Card title="底视频（现成视频）">
                <Dragger
                  accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                  maxCount={1}
                  showUploadList={false}
                  beforeUpload={(file) => {
                    if (!/\.(mp4|mov|webm)$/i.test(file.name)) {
                      message.error('仅支持 MP4 / MOV / WEBM');
                      return false;
                    }
                    if (file.size > 200 * 1024 * 1024) {
                      message.error('底视频不超过 200MB');
                      return false;
                    }
                    setBackground(file);
                    setBackgroundPreview((p) => {
                      if (p) URL.revokeObjectURL(p);
                      return URL.createObjectURL(file);
                    });
                    return false;
                  }}
                >
                  <p className="ant-upload-drag-icon"><VideoCameraOutlined /></p>
                  <p className="ant-upload-text">上传要叠数字人的底视频</p>
                  <p className="ant-upload-hint">例如课程录屏、讲解片等</p>
                </Dragger>
                {background && backgroundPreview && (
                  <div style={{ marginTop: 12 }}>
                    <video src={backgroundPreview} controls style={{ width: '100%', maxHeight: 240, background: '#000' }} />
                    <Text type="secondary">{background.name} · {formatFileSize(background.size)}</Text>
                  </div>
                )}
              </Card>
            </Col>
          </Row>

          <div style={{ marginTop: 24, textAlign: 'right' }}>
            <Button
              type="primary"
              size="large"
              icon={<ArrowRightOutlined />}
              disabled={!canGoStep2 || gsLocalizing}
              loading={gsLocalizing}
              onClick={async () => {
                if (greenscreen?.kind === 'job' && greenscreen.previewUrl && !greenscreen.previewUrl.startsWith('blob:')) {
                  try {
                    const blobUrl = await localizeJobGreenscreen(greenscreen.jobId);
                    setGreenscreen({ kind: 'job', jobId: greenscreen.jobId, previewUrl: blobUrl });
                  } catch (e: any) {
                    message.error(e?.message || '缓存绿幕失败，无法进入摆位');
                    return;
                  }
                }
                setStep(1);
              }}
            >
              下一步：摆位
            </Button>
          </div>
        </>
      )}

      <Modal
        open={gsLocalizing}
        footer={null}
        closable={false}
        title="正在缓存绿幕到本地…"
        destroyOnClose
      >
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          摆位需要本地解码；大文件首次缓存会稍慢，完成后即可实时抠绿。
        </Paragraph>
        <Progress
          percent={
            gsLocalProgress?.total
              ? Math.min(99, Math.round((gsLocalProgress.loaded / gsLocalProgress.total) * 100))
              : undefined
          }
          status="active"
          format={() => {
            if (!gsLocalProgress) return '';
            const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
            return gsLocalProgress.total
              ? `${mb(gsLocalProgress.loaded)} / ${mb(gsLocalProgress.total)}`
              : mb(gsLocalProgress.loaded);
          }}
        />
      </Modal>

      {step === 1 && greenscreenPreviewUrl && backgroundPreview && (
        <Card
          title="摆位与抠绿强度"
          extra={
            <Space>
              <Button onClick={() => setStep(0)}>上一步</Button>
              <Button type="primary" loading={composeSubmitting} onClick={() => void submitCompose('preview')}>
                确认并生成预览
              </Button>
            </Space>
          }
        >
          <GreenscreenComposeEditor
            backgroundUrl={backgroundPreview}
            greenscreenUrl={greenscreenPreviewUrl}
            layout={layout}
            onLayoutChange={setLayout}
            chromaSimilarity={chromaSimilarity}
            onChromaSimilarityChange={setChromaSimilarity}
            disabled={composeSubmitting}
          />
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <Button onClick={() => setLayout({ ...DEFAULT_AVATAR_LAYOUT })} disabled={composeSubmitting}>
              重置位置
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card
          title="预览实际效果（服务端 ffmpeg 抠绿）"
          extra={
            <Space>
              <Button onClick={() => setStep(1)} disabled={composeSubmitting}>返回调整</Button>
              <Button
                type="primary"
                loading={composeSubmitting && composeJob?.mode === 'export'}
                disabled={composeJob?.mode === 'preview' && composeJob.status !== 'completed'}
                onClick={() => void submitCompose('export')}
              >
                效果确认，开始导出
              </Button>
            </Space>
          }
        >
          {composeJob && (
            <>
              <Paragraph>
                {formatQueueHint(composeJob.status, composeJob.queuePosition, composeJob.message || composeJob.stage)}
              </Paragraph>
              <Progress
                percent={Math.min(100, Math.round(composeJob.progress || 0))}
                status={
                  composeJob.status === 'failed' ? 'exception'
                    : composeJob.status === 'completed' ? 'success' : 'active'
                }
              />
              {composeJob.status === 'failed' && (
                <Alert type="error" showIcon style={{ marginTop: 12 }} message={composeJob.error || '预览失败'} />
              )}
            </>
          )}
          {composeVideoUrl && composeJob?.mode === 'preview' && composeJob.status === 'completed' && (
            <video
              key={composeVideoUrl}
              src={composeVideoUrl}
              controls
              autoPlay
              style={{ width: '100%', marginTop: 16, maxHeight: 480, background: '#000' }}
            />
          )}
          {!composeJob && !composeSubmitting && (
            <Alert type="info" showIcon message="请从摆位页点击「确认并生成预览」" />
          )}
          {!composeJob && composeSubmitting && (
            <Alert type="info" showIcon message="正在提交导出…" />
          )}
        </Card>
      )}

      {step === 3 && (
        <Card
          title="导出成片"
          extra={
            <Button onClick={() => setStep(2)} disabled={composeSubmitting}>返回预览</Button>
          }
        >
          {(!composeJob || composeJob.mode !== 'export') && (
            <Button type="primary" loading={composeSubmitting} onClick={() => void submitCompose('export')}>
              开始导出全片
            </Button>
          )}
          {composeJob?.mode === 'export' && (
            <>
              <Paragraph>
                {formatQueueHint(composeJob.status, composeJob.queuePosition, composeJob.message || composeJob.stage)}
              </Paragraph>
              <Progress
                percent={Math.min(100, Math.round(composeJob.progress || 0))}
                status={
                  composeJob.status === 'failed' ? 'exception'
                    : composeJob.status === 'completed' ? 'success' : 'active'
                }
              />
              {composeJob.status === 'failed' && (
                <Alert type="error" showIcon style={{ marginTop: 12 }} message={composeJob.error || '导出失败'} />
              )}
              {composeVideoUrl && composeJob.status === 'completed' && (
                <div style={{ marginTop: 16 }}>
                  <video
                    key={composeVideoUrl}
                    src={composeVideoUrl}
                    controls
                    style={{ width: '100%', maxHeight: 480, background: '#000' }}
                  />
                  <div style={{ marginTop: 12, textAlign: 'center' }}>
                    <Button
                      type="primary"
                      icon={<DownloadOutlined />}
                      href={composeVideoUrl}
                      download={`compose-${composeJob.id}.mp4`}
                    >
                      下载成片
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
};

export default AvatarPage;

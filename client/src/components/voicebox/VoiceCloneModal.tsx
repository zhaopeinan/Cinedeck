import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, Checkbox, Form, Input, Modal, Progress, Radio, Select, Space, Tag, Typography, Upload, message,
} from 'antd';
import { PlayCircleOutlined, SoundOutlined } from '@ant-design/icons';
import { voiceboxApi } from '../../api';

const { Text } = Typography;

export type VoiceCloneMode = 'upload' | 'record';

export interface VoiceCloneModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (voice: { id: string }) => void;
  modes?: VoiceCloneMode[];
  defaultMode?: VoiceCloneMode;
  title?: string;
}

export const VoiceCloneModal: React.FC<VoiceCloneModalProps> = ({
  open,
  onClose,
  onSuccess,
  modes = ['upload', 'record'],
  defaultMode,
  title = '克隆音色',
}) => {
  const allowed = modes.length ? modes : (['upload', 'record'] as VoiceCloneMode[]);
  const [form] = Form.useForm();
  const [cloneMode, setCloneMode] = useState<VoiceCloneMode>(
    defaultMode && allowed.includes(defaultMode) ? defaultMode : allowed[0],
  );
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [authConfirmed, setAuthConfirmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [qualityCheck, setQualityCheck] = useState<{ passed: boolean; reason?: string } | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const durationTimerRef = useRef<number | null>(null);
  const volumeTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingStartRef = useRef<number | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const avgVolumeRef = useRef(0);
  const volumeSampleCountRef = useRef(0);

  const cleanupRecording = useCallback(() => {
    if (durationTimerRef.current) { clearInterval(durationTimerRef.current); durationTimerRef.current = null; }
    if (volumeTimerRef.current) { clearInterval(volumeTimerRef.current); volumeTimerRef.current = null; }
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  const reset = useCallback(() => {
    cleanupRecording();
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    setIsRecording(false);
    setRecordedBlob(null);
    setCloneFile(null);
    setQualityCheck(null);
    setAuthConfirmed(false);
    setRecordingDuration(0);
    setVolumeLevel(0);
    setIsPreviewPlaying(false);
    form.resetFields();
    setCloneMode(defaultMode && allowed.includes(defaultMode) ? defaultMode : allowed[0]);
  }, [allowed, cleanupRecording, defaultMode, form]);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      avgVolumeRef.current = 0;
      volumeSampleCountRef.current = 0;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setRecordedBlob(blob);
        const elapsed = recordingStartRef.current ? Math.floor((Date.now() - recordingStartRef.current) / 1000) : 0;
        const avg = volumeSampleCountRef.current
          ? avgVolumeRef.current / volumeSampleCountRef.current
          : 0;
        cleanupRecording();
        setIsRecording(false);
        if (elapsed < 5) setQualityCheck({ passed: false, reason: '录音时长不足 5 秒' });
        else if (avg < 5) setQualityCheck({ passed: false, reason: '音量过低，请靠近麦克风重录' });
        else setQualityCheck({ passed: true });
      };
      recorder.start(100);
      setRecordingDuration(0);
      recordingStartRef.current = Date.now();
      durationTimerRef.current = window.setInterval(() => {
        if (recordingStartRef.current) {
          setRecordingDuration(Math.floor((Date.now() - recordingStartRef.current) / 1000));
        }
      }, 1000);
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      volumeTimerRef.current = window.setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        const v = Math.round(dataArray.reduce((a, b) => a + b, 0) / dataArray.length);
        setVolumeLevel(v);
        avgVolumeRef.current += v;
        volumeSampleCountRef.current += 1;
      }, 100);
      setIsRecording(true);
      setRecordedBlob(null);
      setQualityCheck(null);
    } catch (err: any) {
      message.error(err.name === 'NotAllowedError' ? '麦克风权限被拒绝' : `录音失败：${err.message}`);
    }
  };

  const handlePreviewRecording = () => {
    if (!recordedBlob) return;
    if (isPreviewPlaying && previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
      setIsPreviewPlaying(false);
      return;
    }
    const url = URL.createObjectURL(recordedBlob);
    const audio = new Audio(url);
    previewAudioRef.current = audio;
    setIsPreviewPlaying(true);
    audio.onended = () => {
      setIsPreviewPlaying(false);
      URL.revokeObjectURL(url);
      previewAudioRef.current = null;
    };
    void audio.play();
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const audioBlob = cloneMode === 'upload' ? cloneFile : recordedBlob;
      if (!audioBlob) {
        message.warning(cloneMode === 'upload' ? '请先上传参考音频' : '请先完成录音');
        return;
      }
      if (cloneMode === 'record' && !qualityCheck?.passed) {
        message.warning('录音质量未通过');
        return;
      }
      setIsSaving(true);
      const formData = new FormData();
      if (cloneMode === 'upload' && cloneFile) {
        formData.append('audio', cloneFile, cloneFile.name);
      } else {
        formData.append('audio', audioBlob as Blob, 'recording.webm');
      }
      formData.append('name', values.name);
      formData.append('language', values.language || 'zh-CN');
      formData.append('description', values.description || '');
      const created = await voiceboxApi.createVoice(formData);
      const newId = created.data.data?.id as string | undefined;
      message.success('音色克隆成功');
      onSuccess?.(newId ? { id: newId } : { id: '' });
      reset();
      onClose();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error(err.response?.data?.error?.message || err.message || '克隆失败');
    } finally {
      setIsSaving(false);
    }
  };

  const showModeSwitch = allowed.length > 1;

  return (
    <Modal
      title={title}
      open={open}
      onCancel={() => { reset(); onClose(); }}
      onOk={() => void handleSave()}
      okText="保存音色"
      confirmLoading={isSaving}
      destroyOnClose
      okButtonProps={{
        disabled: cloneMode === 'record' && (!recordedBlob || !qualityCheck?.passed),
      }}
    >
      <Form form={form} layout="vertical" initialValues={{ language: 'zh-CN' }}>
        <Form.Item name="name" label="音色名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder="例如：老师旁白" />
        </Form.Item>
        <Form.Item name="language" label="语言" rules={[{ required: true }]}>
          <Select options={[{ value: 'zh-CN', label: '中文' }, { value: 'en-US', label: 'English' }]} />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={2} placeholder="可选" />
        </Form.Item>
      </Form>

      {showModeSwitch && (
        <Radio.Group
          value={cloneMode}
          onChange={(e) => {
            setCloneMode(e.target.value);
            setCloneFile(null);
            setRecordedBlob(null);
            setQualityCheck(null);
          }}
          style={{ marginBottom: 12 }}
        >
          {allowed.includes('upload') && <Radio.Button value="upload">上传音频</Radio.Button>}
          {allowed.includes('record') && <Radio.Button value="record">录音</Radio.Button>}
        </Radio.Group>
      )}

      {cloneMode === 'upload' ? (
        <Upload.Dragger
          maxCount={1}
          accept=".wav,.mp3,.m4a,.ogg,.flac,.webm,.aac"
          beforeUpload={(file) => {
            setCloneFile(file);
            return false;
          }}
          onRemove={() => setCloneFile(null)}
          fileList={cloneFile ? [{ uid: '1', name: cloneFile.name, status: 'done' as const }] : []}
        >
          <p className="ant-upload-drag-icon"><SoundOutlined /></p>
          <p>拖入或点击上传参考音频（建议 5 秒以上清晰人声）</p>
        </Upload.Dragger>
      ) : (
        <div>
          {!authConfirmed && (
            <div style={{ background: '#f6f6f6', padding: 12, borderRadius: 8, marginBottom: 12 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                录音将用于本地音色克隆，仅保存在本机服务器，不用于第三方分享。
              </Text>
              <Checkbox checked={authConfirmed} onChange={(e) => setAuthConfirmed(e.target.checked)}>
                我同意将录音用于本地音色克隆
              </Checkbox>
            </div>
          )}
          <div style={{ textAlign: 'center' }}>
            {!isRecording && !recordedBlob && (
              <Button type="primary" icon={<SoundOutlined />} disabled={!authConfirmed} onClick={() => void startRecording()}>
                开始录音
              </Button>
            )}
            {isRecording && (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Text type="danger">录音中… {recordingDuration}s</Text>
                <Progress percent={Math.min(volumeLevel, 100)} showInfo={false} strokeColor={volumeLevel > 10 ? '#52c41a' : '#ff4d4f'} />
                <Button danger onClick={() => mediaRecorderRef.current?.stop()}>停止</Button>
              </Space>
            )}
            {recordedBlob && qualityCheck && (
              qualityCheck.passed ? (
                <Space direction="vertical">
                  <Tag color="success">录音可用</Tag>
                  <Space>
                    <Button
                      icon={<PlayCircleOutlined />}
                      onClick={handlePreviewRecording}
                    >
                      {isPreviewPlaying ? '停止试听' : '试听录音'}
                    </Button>
                    <Button onClick={() => {
                      setRecordedBlob(null);
                      setQualityCheck(null);
                      setAuthConfirmed(true);
                    }}>
                      重新录音
                    </Button>
                  </Space>
                </Space>
              ) : (
                <Space direction="vertical">
                  <Tag color="error">未通过</Tag>
                  <Text type="danger">{qualityCheck.reason}</Text>
                  <Button type="primary" onClick={() => {
                    setRecordedBlob(null);
                    setQualityCheck(null);
                  }}>
                    重新录音
                  </Button>
                </Space>
              )
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};

export default VoiceCloneModal;

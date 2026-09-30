import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Card, Col, Progress, Row, Space, Typography, Upload, message, Alert, Checkbox,
} from 'antd';
import {
  ArrowLeftOutlined, InboxOutlined, SoundOutlined, PictureOutlined,
  DownloadOutlined, VideoCameraOutlined,
} from '@ant-design/icons';
import {
  avatarApi, withToken, type AvatarDriveMode,
} from '../../api';
import {
  AvatarDriveModePicker,
  AvatarPhotoUpload,
  AvatarRefLibraryPanel,
  GreenscreenAlert,
  useAvatarRefs,
} from '../../components/avatar';

const { Title, Text, Paragraph } = Typography;
const { Dragger } = Upload;

type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

interface JobState {
  id: string;
  driveMode?: AvatarDriveMode;
  refVideoId?: string | null;
  status: JobStatus;
  stage: string;
  message: string;
  progress: number;
  error?: string | null;
}

const AvatarPage: React.FC = () => {
  const navigate = useNavigate();
  const [driveMode, setDriveMode] = useState<AvatarDriveMode>('video');
  const [photo, setPhoto] = useState<File | null>(null);
  const [template, setTemplate] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [templatePreview, setTemplatePreview] = useState<string | null>(null);
  const [audioPreview, setAudioPreview] = useState<string | null>(null);
  const [selectedRefId, setSelectedRefId] = useState<string | null>(null);
  const [saveToLibrary, setSaveToLibrary] = useState(true);
  /** 临时上传并保存到库时是否绿幕 */
  const [tempAsGreenscreen, setTempAsGreenscreen] = useState(false);
  const { refs, setRefs, loading: refsLoading, loadRefs } = useAvatarRefs();
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    document.title = 'Cinedeck · 数字人解说';
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      if (templatePreview) URL.revokeObjectURL(templatePreview);
      if (audioPreview) URL.revokeObjectURL(audioPreview);
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
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
          if (data.status === 'completed') message.success('视频生成完成');
          else message.error(data.error || data.message || '生成失败');
        }
      } catch (err: any) {
        stopPolling();
        setSubmitting(false);
        message.error(err.response?.data?.error?.message || err.message || '查询进度失败');
      }
    }, 2000);
  };

  const handleDriveModeChange = (mode: AvatarDriveMode) => {
    setDriveMode(mode);
    if (mode === 'photo') {
      setTemplate(null);
      setTemplatePreview((p) => { if (p) URL.revokeObjectURL(p); return null; });
      setSelectedRefId(null);
    } else {
      setPhoto(null);
      setPhotoPreview((p) => { if (p) URL.revokeObjectURL(p); return null; });
    }
  };

  const canSubmit = (() => {
    if (!audio || submitting) return false;
    if (driveMode === 'photo') return !!photo;
    return !!selectedRefId || !!template;
  })();

  const handleGenerate = async () => {
    if (!canSubmit || !audio) {
      message.warning(driveMode === 'video' ? '请选择/上传参考视频并上传音频' : '请上传照片和音频');
      return;
    }
    setSubmitting(true);
    setJob(null);
    try {
      const res = await avatarApi.createJob({
        driveMode,
        audio,
        photo,
        template: selectedRefId ? null : template,
        refVideoId: selectedRefId,
        saveToLibrary: !selectedRefId && !!template && saveToLibrary,
        refName: template?.name,
        isGreenscreen: !selectedRefId && !!template ? tempAsGreenscreen : undefined,
      });
      const data = res.data.data as JobState;
      setJob(data);
      startPolling(data.id);
      if (data.refVideoId && saveToLibrary && !selectedRefId) {
        void loadRefs();
      }
    } catch (err: any) {
      setSubmitting(false);
      message.error(err.response?.data?.error?.message || err.message || '提交失败');
    }
  };

  const resultVideoUrl = job?.status === 'completed' && job.id
    ? withToken(`/api/v1/avatar/jobs/${job.id}/video`)
    : null;

  const driveLabel = (job?.driveMode || driveMode) === 'video' ? '参考视频' : '静照口型';

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '40px 24px' }}>
      <Space style={{ marginBottom: 24 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>工作台</Button>
      </Space>

      <div style={{ marginBottom: 28 }}>
        <Title level={2} style={{ marginBottom: 4 }}>数字人解说</Title>
        <Text type="secondary">基于 Duix：静照口型或参考视频驱动，生成口型同步解说视频</Text>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
        message="生成期间会独占 GPU（与 PPT 配音互斥），建议单段音频不超过 2 分钟。参考视频仅本人可见。"
      />

      <Card title="驱动方式" style={{ marginBottom: 16 }}>
        <AvatarDriveModePicker
          value={driveMode}
          onChange={handleDriveModeChange}
          disabled={submitting}
        />
      </Card>

      {driveMode === 'video' && (
        <AvatarRefLibraryPanel
          mode="manage"
          refs={refs}
          loading={refsLoading}
          selectedId={selectedRefId}
          disabled={submitting}
          showTempHint
          style={{ marginBottom: 16 }}
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

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          {driveMode === 'photo' ? (
            <Card title={<Space><PictureOutlined /> 本人照片</Space>}>
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
            <Card title={<Space><VideoCameraOutlined /> 临时参考视频（可选）</Space>}>
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
                    message.error('参考视频不超过 100MB');
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
                <p className="ant-upload-text">本次临时上传</p>
                <p className="ant-upload-hint">若已从素材库选择，可跳过此项</p>
              </Dragger>
              {template && (
                <div style={{ marginTop: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={saveToLibrary}
                      disabled={submitting}
                      onChange={(e) => setSaveToLibrary(e.target.checked)}
                    />
                    <Text>同时保存到我的参考视频库</Text>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={tempAsGreenscreen}
                      disabled={submitting}
                      onChange={(e) => setTempAsGreenscreen(e.target.checked)}
                    />
                    <Text>绿幕模板（叠 PPT 时抠绿透明）</Text>
                  </label>
                  {tempAsGreenscreen && (
                    <GreenscreenAlert
                      style={{ marginTop: 8 }}
                      message="绿幕模板：合成到 PPT 时会抠掉绿色背景"
                      description={null}
                    />
                  )}
                  {templatePreview && (
                    <video src={templatePreview} controls style={{ width: '100%', marginTop: 12, maxHeight: 220, background: '#000' }} />
                  )}
                  <div><Text type="secondary">{template.name}</Text></div>
                </div>
              )}
              {selectedRefId && !template && (
                <Alert style={{ marginTop: 12 }} type="success" showIcon message="已使用素材库中的参考视频" />
              )}
            </Card>
          )}
        </Col>
        <Col xs={24} md={12}>
          <Card title={<Space><SoundOutlined /> 解说音频</Space>}>
            <Dragger
              accept="audio/wav,audio/mpeg,audio/mp3,.wav,.mp3"
              maxCount={1}
              showUploadList={false}
              beforeUpload={(file) => {
                if (!/\.(wav|mp3)$/i.test(file.name)) {
                  message.error('仅支持 WAV / MP3');
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
              <p className="ant-upload-text">点击或拖拽音频</p>
              <p className="ant-upload-hint">可从配音页下载后再上传</p>
            </Dragger>
            {audio && (
              <div style={{ marginTop: 16 }}>
                <Text strong>{audio.name}</Text>
                <br />
                <Text type="secondary">{formatSize(audio.size)}</Text>
                {audioPreview && (
                  <audio controls src={audioPreview} style={{ width: '100%', marginTop: 8 }} />
                )}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <div style={{ marginTop: 24, textAlign: 'center' }}>
        <Button
          type="primary"
          size="large"
          loading={submitting}
          disabled={!canSubmit}
          onClick={handleGenerate}
        >
          用 Duix · {driveMode === 'video' ? '参考视频' : '静照'} 生成
        </Button>
      </div>

      {job && (
        <Card style={{ marginTop: 24 }} title={`生成进度 · Duix · ${driveLabel}`}>
          <Paragraph>{job.message || job.stage}</Paragraph>
          <Progress
            percent={Math.min(100, Math.round(job.progress || 0))}
            status={job.status === 'failed' ? 'exception' : job.status === 'completed' ? 'success' : 'active'}
          />
          {job.status === 'failed' && (
            <Alert type="error" showIcon style={{ marginTop: 12 }} message={job.error || '生成失败'} />
          )}
          {resultVideoUrl && (
            <div style={{ marginTop: 16 }}>
              <video src={resultVideoUrl} controls style={{ width: '100%', maxHeight: 480, background: '#000' }} />
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <Button type="primary" icon={<DownloadOutlined />} href={resultVideoUrl} download={`avatar-${job.id}.mp4`}>
                  下载视频
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

export default AvatarPage;

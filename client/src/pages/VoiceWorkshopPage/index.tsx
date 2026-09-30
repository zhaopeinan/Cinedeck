import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Steps, Row, Col, Button, Tag, Space, Typography, Modal, message, Spin, Tooltip, Alert } from 'antd';
import { PlusOutlined, WarningOutlined } from '@ant-design/icons';
import { useVoiceStore } from '../../stores/voiceStore';
import { useProjectStore } from '../../stores/projectStore';
import { analytics, AnalyticsEvents } from '../../utils/analytics';
import { voiceboxApi, projectApi } from '../../api';
import { VoiceCloneModal, VoiceListPanel, ModelListPanel, ModelDetailModal, fetchVoiceSampleObjectUrl } from '../../components/voicebox';
import { useAutoSave } from '../../hooks/useAutoSave';

const { Text } = Typography;

// 简单估算可用磁盘空间（浏览器无法直接获取，这里用一个启发式方法）
// 实际项目中可能需要后端接口返回磁盘信息，这里仅做前端估算
const estimateAvailableSpace = (): number => {
  // 默认假设 10GB 可用，实际项目中应通过后端接口获取
  return 10 * 1024 * 1024 * 1024;
};

const VoiceWorkshopPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentProject, updateProject } = useProjectStore();
  const {
    voices, selectedVoiceId, models, selectedModelId,
    isLoadingVoices, isLoadingModels,
    loadVoices, selectVoice, deleteVoice,
    loadModels, selectModel, downloadModel, cancelModelDownload,
    pauseModelDownload, resumeModelDownload,
    setSelectedVoiceId, setSelectedModelId,
  } = useVoiceStore();

  const [recorderModalOpen, setRecorderModalOpen] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);

  const saveState = useAutoSave(id, {
    selectedVoiceId,
    selectedModelId,
  });

  // 模型详情弹窗状态
  const [modelDetailModalOpen, setModelDetailModalOpen] = useState(false);
  const [detailModel, setDetailModel] = useState<any>(null);

  // 磁盘空间不足警告
  const [diskWarningModelId, setDiskWarningModelId] = useState<string | null>(null);
  const [voiceboxAvailable, setVoiceboxAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    // 先检查Voicebox服务状态
    voiceboxApi.healthCheck().then(res => {
      setVoiceboxAvailable(res.data?.data?.available ?? false);
    }).catch(() => {
      setVoiceboxAvailable(false);
    });
    loadVoices();
    loadModels();
    analytics.track(AnalyticsEvents.VOICE_LIST_SHOW);
    analytics.track(AnalyticsEvents.MODEL_LIST_SHOW);
  }, []);

  useEffect(() => {
    if (currentProject?.selectedVoiceId) {
      setSelectedVoiceId(currentProject.selectedVoiceId);
    }
    if (currentProject?.selectedModelId) {
      setSelectedModelId(currentProject.selectedModelId);
    }
  }, [currentProject]);

  useEffect(() => {
    return () => {
      if (sampleAudioRef.current) {
        sampleAudioRef.current.pause();
        sampleAudioRef.current = null;
      }
    };
  }, []);

  const handleSelectVoice = async (voiceId: string) => {
    selectVoice(voiceId);
    analytics.track(AnalyticsEvents.VOICE_SELECT, { voiceId });
    if (id) {
      if (selectedVoiceId && selectedVoiceId !== voiceId) {
        Modal.confirm({
          title: '更换音色',
          content: '更换音色后需要重新生成全部配音，是否确认？',
          onOk: async () => {
            await updateProject(id, { selectedVoiceId: voiceId });
            await projectApi.markDubbingRegenerate(id);
          },
        });
      } else {
        await updateProject(id, { selectedVoiceId: voiceId });
      }
    }
  };

  const handleSelectModel = async (modelId: string) => {
    selectModel(modelId);
    if (id) {
      await updateProject(id, { selectedModelId: modelId });
    }
  };

  const stopSampleAudio = useCallback(() => {
    if (sampleAudioRef.current) {
      sampleAudioRef.current.pause();
      sampleAudioRef.current.src = '';
      sampleAudioRef.current = null;
    }
    setPlayingVoiceId(null);
  }, []);

  const handlePlaySample = async (voiceId: string) => {
    if (playingVoiceId === voiceId) {
      stopSampleAudio();
      return;
    }
    stopSampleAudio();
    setPlayingVoiceId(voiceId);
    analytics.track(AnalyticsEvents.VOICE_SAMPLE_PLAY, { voiceId });
    try {
      const objectUrl = await fetchVoiceSampleObjectUrl(voiceId);
      const audio = new Audio(objectUrl);
      sampleAudioRef.current = audio;
      audio.onended = () => {
        stopSampleAudio();
        URL.revokeObjectURL(objectUrl);
      };
      await audio.play();
    } catch (err: any) {
      message.error(err.message || '试听失败');
      stopSampleAudio();
    }
  };

  const handleDownloadModel = async (modelId: string) => {
    const model = models.find((m: any) => m.id === modelId);
    if (model) {
      const availableSpace = estimateAvailableSpace();
      if (model.downloadSize > availableSpace) {
        setDiskWarningModelId(modelId);
        return;
      }
    }
    try {
      message.loading('开始下载模型...');
      analytics.track(AnalyticsEvents.MODEL_DOWNLOAD_START, { modelId });
      await downloadModel(modelId);
      analytics.track(AnalyticsEvents.MODEL_DOWNLOAD_SUCCESS, { modelId });
      message.success('模型下载成功');
    } catch {
      analytics.track(AnalyticsEvents.MODEL_DOWNLOAD_FAIL, { modelId });
      message.error('模型下载失败');
    }
  };

  const handleConfirmDownloadAnyway = async (modelId: string) => {
    setDiskWarningModelId(null);
    try {
      message.loading('开始下载模型（空间不足，可能失败）...');
      await downloadModel(modelId);
      message.success('模型下载成功');
    } catch {
      message.error('模型下载失败');
    }
  };

  const handleShowModelDetail = (model: any) => {
    setDetailModel(model);
    setModelDetailModalOpen(true);
  };

  // 语言兼容性检查
  const selectedVoice = voices.find((v: any) => v.id === selectedVoiceId);
  const selectedModel = models.find((m: any) => m.id === selectedModelId);
  const languageMismatch = selectedVoice && selectedModel &&
    selectedModel.language !== 'multi' && selectedVoice.language !== 'multi' &&
    selectedVoice.language !== selectedModel.language;

  const selectedModelData = models.find((m: any) => m.id === selectedModelId);
  const canProceed = selectedVoiceId && selectedModelId &&
    (selectedModelData?.status === 'available' || selectedModelData?.status === 'downloaded') &&
    !languageMismatch;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px' }}>
      <Steps
        current={2}
        items={[
          { title: '导入PPT' },
          { title: '读取备注' },
          { title: '选择音色' },
          { title: '生成配音' },
          { title: '生成数字人' },
          { title: '视频预览' },
          { title: '编辑导出' },
        ]}
        style={{ marginBottom: 24 }}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="音色库全局共享。上传克隆、预置音色试听、多人对话请在造声工厂完成；此处选择并绑定到当前项目。"
        action={
          <Space>
            <Button size="small" type="link" onClick={() => navigate('/voice-factory')}>造声工厂</Button>
            <Button size="small" type="link" onClick={() => { void loadVoices(); void loadModels(); }}>刷新列表</Button>
          </Space>
        }
      />

      <Row gutter={24}>
        {/* 音色选择 */}
        <Col span={14}>
          <Card title="配音音色" extra={
            <Space>
              <Button onClick={() => navigate('/voice-factory')}>去工厂克隆</Button>
              <Button icon={<PlusOutlined />} onClick={() => setRecorderModalOpen(true)} disabled={voiceboxAvailable === false}>
                快速录音
              </Button>
            </Space>
          }>
            {voiceboxAvailable === false && (
              <Alert
                type="warning"
                showIcon
                message="Voicebox 服务启动中"
                description={
                  <div>
                    <p>音色服务正在自动启动，首次启动可能需要下载模型，请稍候…</p>
                    <Button size="small" type="primary" onClick={() => {
                      voiceboxApi.healthCheck().then(res => {
                        const available = res.data?.data?.available ?? false;
                        setVoiceboxAvailable(available);
                        if (available) { loadVoices(); loadModels(); message.success('Voicebox 已连接'); }
                        else { message.info('Voicebox 仍在启动中，请稍后再试'); }
                      }).catch(() => message.info('Voicebox 仍在启动中，请稍后再试'));
                    }}>
                      重新检测
                    </Button>
                  </div>
                }
                style={{ marginBottom: 16 }}
              />
            )}
            <VoiceListPanel
              voices={voices}
              loading={isLoadingVoices}
              selectedVoiceId={selectedVoiceId}
              onSelectVoice={(vid) => void handleSelectVoice(vid)}
              playingVoiceId={playingVoiceId}
              onPlaySample={handlePlaySample}
              onDeleteVoice={async (vid) => { await deleteVoice(vid); }}
              emptyText={voiceboxAvailable === false ? 'Voicebox 正在启动，请稍候…' : '暂无可用音色'}
            />
          </Card>
        </Col>

        {/* 模型管理 */}
        <Col span={10}>
          <Card title="配音模型">
            <ModelListPanel
              variant="full"
              models={models}
              loading={isLoadingModels}
              selectedModelId={selectedModelId}
              onSelectModel={(mid) => void handleSelectModel(mid)}
              onDownloadModel={(mid) => void handleDownloadModel(mid)}
              onPauseDownload={(mid) => void pauseModelDownload(mid)}
              onCancelDownload={(mid) => void cancelModelDownload(mid)}
              onShowDetail={handleShowModelDetail}
              diskWarningModelId={diskWarningModelId}
              onConfirmDownloadAnyway={(mid) => void handleConfirmDownloadAnyway(mid)}
              onDismissDiskWarning={() => setDiskWarningModelId(null)}
            />
          </Card>
        </Col>
      </Row>

      {/* 语言兼容性警告 */}
      {languageMismatch && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="语言不匹配"
          description={`所选音色语言为 ${selectedVoice.language}，模型语言为 ${selectedModel.language}，可能导致配音效果不佳。建议选择语言匹配的音色和模型。`}
          style={{ marginTop: 16 }}
        />
      )}

      <div style={{ marginTop: 24, textAlign: 'center' }}>
        <Space>
          {saveState.status === 'saving' && <Tag color="processing">正在保存...</Tag>}
          {saveState.status === 'saved' && <Tag color="success">已自动保存</Tag>}
          {saveState.status === 'failed' && <Tag color="error">保存失败，请检查网络</Tag>}
          <Button onClick={() => navigate(`/project/${id}/notes`)}>上一步</Button>
          <Tooltip title={languageMismatch ? '音色与模型语言不匹配，请调整选择' : ''}>
            <Button
              type="primary"
              size="large"
              disabled={!canProceed}
              onClick={() => navigate(`/project/${id}/dubbing`)}
            >
              下一步：生成配音
            </Button>
          </Tooltip>
        </Space>
      </div>

      <ModelDetailModal
        open={modelDetailModalOpen}
        model={detailModel}
        onClose={() => { setModelDetailModalOpen(false); setDetailModel(null); }}
      />

      <VoiceCloneModal
        open={recorderModalOpen}
        title="快速录音克隆"
        modes={['record']}
        defaultMode="record"
        onClose={() => setRecorderModalOpen(false)}
        onSuccess={async (voice) => {
          await loadVoices();
          if (voice.id) {
            setSelectedVoiceId(voice.id);
            if (id) {
              try { await updateProject(id, { selectedVoiceId: voice.id }); } catch { /* ignore */ }
            }
          }
        }}
      />

    </div>
  );
};

export default VoiceWorkshopPage;

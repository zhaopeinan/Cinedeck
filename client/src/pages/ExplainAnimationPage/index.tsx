import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Col, Input, List, Progress, Radio, Row, Space, Tag, Typography, Upload, message, Popconfirm,
} from 'antd';
import {
  ArrowLeftOutlined, CheckOutlined, DeleteOutlined, ReloadOutlined, RocketOutlined, SettingOutlined,
} from '@ant-design/icons';
import { explainApi } from '../../api';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;
const { Dragger } = Upload;

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  queued: { color: 'default', text: '排队中' },
  running: { color: 'processing', text: '进行中' },
  await_style: { color: 'warning', text: '选风格' },
  await_sample: { color: 'warning', text: '确认样片' },
  completed: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
  cancelled: { color: 'default', text: '已取消' },
};

const ExplainAnimationPage: React.FC = () => {
  const navigate = useNavigate();
  const [topic, setTopic] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [llmOk, setLlmOk] = useState<{
    configured: boolean;
    name?: string | null;
    modelName?: string | null;
    genSettings?: {
      maxTokensRecommend: number;
      maxTokensScript: number;
      maxTokensSample: number;
      maxTokensFinal: number;
      reasoningEffort: string;
    };
  } | null>(null);
  const [voiceover, setVoiceover] = useState<'none' | 'zh' | 'en'>('none');
  const [pickingStyleId, setPickingStyleId] = useState<number | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const res = await explainApi.listJobs();
      if (res.data?.success) setJobs(res.data.data?.jobs || []);
    } catch { /* ignore */ }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await explainApi.getJob(id);
      if (res.data?.success) setDetail(res.data.data);
    } catch { /* ignore */ }
  }, []);

  const loadLlm = useCallback(async () => {
    try {
      const res = await explainApi.llmStatus();
      if (res.data?.success) setLlmOk(res.data.data || null);
    } catch {
      setLlmOk({ configured: false });
    }
  }, []);

  useEffect(() => {
    document.title = 'Cinedeck · 讲解动画';
    void loadJobs();
    void loadLlm();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [loadJobs, loadLlm]);

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    void loadDetail(activeId);
  }, [activeId, loadDetail]);

  useEffect(() => {
    const busy = jobs.some((j) =>
      ['queued', 'running', 'await_style', 'await_sample'].includes(j.status),
    ) || (detail && ['queued', 'running'].includes(detail.status));
    if (!busy) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => {
      void loadJobs();
      if (activeId) void loadDetail(activeId);
    }, 2500);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobs, detail?.status, activeId, loadJobs, loadDetail]);

  const handleCreate = async () => {
    if (!llmOk?.configured) {
      message.warning('请先配置 LLM API');
      navigate('/settings');
      return;
    }
    if (!topic.trim() && !file) {
      message.warning('请输入选题或上传文件');
      return;
    }
    setSubmitting(true);
    try {
      const res = await explainApi.createJob({ topic: topic.trim() || undefined, file });
      if (!res.data?.success) throw new Error(res.data?.error?.message || '提交失败');
      message.success('已提交，正在推荐风格…');
      setTopic('');
      setFile(null);
      await loadJobs();
      setActiveId(res.data.data.id);
    } catch (e: any) {
      message.error(e?.response?.data?.error?.message || e?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectStyle = async (styleId: number) => {
    if (!detail?.id) return;
    setPickingStyleId(styleId);
    try {
      const res = await explainApi.selectStyle(detail.id, { styleId, voiceover });
      if (!res.data?.success) throw new Error(res.data?.error?.message || '选择失败');
      message.success('已选定风格，开始生成样片…');
      setDetail(res.data.data);
      await loadJobs();
    } catch (e: any) {
      message.error(e?.response?.data?.error?.message || e?.message || '选择失败');
    } finally {
      setPickingStyleId(null);
    }
  };

  const recommendations = Array.isArray(detail?.recommendations?.recommendations)
    ? detail.recommendations.recommendations
    : (Array.isArray(detail?.recommendations) ? detail.recommendations : []);
  const coreQuestion = detail?.recommendations?.coreQuestion;

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: 24 }}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
        <Title level={4} style={{ margin: 0 }}>讲解动画</Title>
      </Space>

      <Paragraph type="secondary">
        上传文稿或直接输入选题 → LLM 推荐 3 种风格（含示例图）→ 确认约 20 秒样片 → 扩展全片 HTML。
        流程来自 Opus 讲解动画技能，需配置可用的大模型 API。
      </Paragraph>

      {!llmOk?.configured ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="尚未配置 LLM API"
          description="讲解动画依赖大模型生成风格推荐与 HTML 动效。请先到设置中添加 OpenAI 兼容接口并设为默认。"
          action={
            <Button type="primary" icon={<SettingOutlined />} onClick={() => navigate('/settings')}>
              去设置
            </Button>
          }
        />
      ) : (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          message={`当前 LLM：${llmOk.name || '未命名'} · ${llmOk.modelName || ''}`}
          description={llmOk.genSettings
            ? `Token：推荐 ${llmOk.genSettings.maxTokensRecommend.toLocaleString()} · 分镜 ${llmOk.genSettings.maxTokensScript.toLocaleString()} · 样片 ${llmOk.genSettings.maxTokensSample.toLocaleString()} · 全片 ${llmOk.genSettings.maxTokensFinal.toLocaleString()} · reasoning=${llmOk.genSettings.reasoningEffort}`
            : undefined}
          action={
            <Button size="small" onClick={() => navigate('/settings')}>调整 Token</Button>
          }
        />
      )}

      <Row gutter={20}>
        <Col xs={24} lg={10}>
          <Card title="1. 选题 / 上传">
            <TextArea
              rows={8}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：用动画讲清楚「奥卡姆剃刀」是什么，以及它如何帮人做决策。"
            />
            <div style={{ marginTop: 12 }}>
              <Dragger
                multiple={false}
                maxCount={1}
                beforeUpload={(f) => {
                  setFile(f);
                  return false;
                }}
                onRemove={() => setFile(null)}
                fileList={file ? [{ uid: '1', name: file.name, status: 'done' as const }] : []}
              >
                <p className="ant-upload-text">也可上传 .pptx / .txt / .md</p>
                <p className="ant-upload-hint">PPT 会自动抽取每页正文与备注作为选题</p>
              </Dragger>
            </div>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              block
              style={{ marginTop: 16 }}
              loading={submitting}
              disabled={!llmOk?.configured}
              onClick={() => void handleCreate()}
            >
              开始制作
            </Button>
          </Card>

          <Card title="任务列表" style={{ marginTop: 16 }}>
            {jobs.length === 0 ? (
              <Text type="secondary">暂无任务</Text>
            ) : (
              <List
                dataSource={jobs}
                renderItem={(item) => {
                  const st = STATUS_TAG[item.status] || { color: 'default', text: item.status };
                  return (
                    <List.Item
                      onClick={() => setActiveId(item.id)}
                      style={{
                        cursor: 'pointer',
                        background: activeId === item.id ? 'rgba(22,119,255,0.06)' : undefined,
                        padding: '8px 10px',
                        borderRadius: 8,
                      }}
                      actions={[
                        item.status !== 'running' && (
                          <Popconfirm
                            key="del"
                            title="删除此任务？"
                            onConfirm={async (e) => {
                              e?.stopPropagation?.();
                              await explainApi.deleteJob(item.id);
                              if (activeId === item.id) setActiveId(null);
                              await loadJobs();
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
                            <Text>{item.name}</Text>
                            <Tag color={st.color}>{st.text}</Tag>
                          </Space>
                        }
                        description={
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {item.stageLabel || item.stage} · {item.message || ''}
                          </Text>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card
            title="2. 制作进度"
            extra={detail ? (
              <Button size="small" icon={<ReloadOutlined />} onClick={() => detail.id && loadDetail(detail.id)}>刷新</Button>
            ) : null}
          >
            {!detail ? (
              <Paragraph type="secondary">从左侧选择任务，或提交新选题。</Paragraph>
            ) : (
              <>
                <Space wrap style={{ marginBottom: 12 }}>
                  <Text strong>{detail.name}</Text>
                  <Tag color={STATUS_TAG[detail.status]?.color}>{STATUS_TAG[detail.status]?.text || detail.status}</Tag>
                  <Text type="secondary">{detail.stageLabel}</Text>
                </Space>
                {(detail.status === 'queued' || detail.status === 'running') && (
                  <Progress percent={detail.progress || 0} status="active" />
                )}
                {detail.message && <Paragraph type="secondary">{detail.message}</Paragraph>}
                {detail.error && <Alert type="error" showIcon message={detail.error} style={{ marginBottom: 12 }} />}
                {(detail.status === 'failed' || detail.status === 'cancelled') && (
                  <Button
                    style={{ marginBottom: 12 }}
                    icon={<ReloadOutlined />}
                    onClick={async () => {
                      await explainApi.retryJob(detail.id);
                      message.success('已重新排队');
                      await loadDetail(detail.id);
                      await loadJobs();
                    }}
                  >
                    重试此任务
                  </Button>
                )}
                {coreQuestion && (
                  <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`核心问题：${coreQuestion}`} />
                )}

                {detail.status === 'await_style' && (
                  <>
                    <Paragraph>请选择一种风格，并确认是否加旁白（与技能确认点一一致）：</Paragraph>
                    <Radio.Group
                      value={voiceover}
                      onChange={(e) => setVoiceover(e.target.value)}
                      style={{ marginBottom: 12 }}
                      optionType="button"
                      options={[
                        { label: '不加配音', value: 'none' },
                        { label: '中文配音', value: 'zh' },
                        { label: '英文配音', value: 'en' },
                      ]}
                    />
                    <Row gutter={[12, 12]}>
                      {(Array.isArray(recommendations) ? recommendations : []).map((r: any) => (
                        <Col xs={24} sm={8} key={r.id}>
                          <Card
                            size="small"
                            cover={
                              <img
                                alt={r.nameZh}
                                src={explainApi.posterUrl(r.id)}
                                style={{ height: 120, objectFit: 'cover' }}
                              />
                            }
                            actions={[
                              <Button
                                key="pick"
                                type={r.recommended ? 'primary' : 'default'}
                                size="small"
                                loading={pickingStyleId === r.id}
                                onClick={() => void handleSelectStyle(r.id)}
                              >
                                {r.recommended ? '选用（推荐）' : '选用'}
                              </Button>,
                            ]}
                          >
                            <Card.Meta
                              title={<Text style={{ fontSize: 13 }}>#{r.id} {r.nameZh}</Text>}
                              description={<Text type="secondary" style={{ fontSize: 12 }}>{r.reason}</Text>}
                            />
                          </Card>
                        </Col>
                      ))}
                    </Row>
                  </>
                )}

                {(detail.hasSample || detail.status === 'await_sample' || detail.status === 'completed') && (
                  <div style={{ marginTop: 16 }}>
                    <Title level={5}>样片预览</Title>
                    {detail.hasSample && (
                      <iframe
                        title="sample"
                        src={explainApi.sampleUrl(detail.id)}
                        style={{ width: '100%', height: 360, border: '1px solid #f0f0f0', borderRadius: 8, background: '#000' }}
                      />
                    )}
                    {detail.status === 'await_sample' && (
                      <Space style={{ marginTop: 12 }}>
                        <Button
                          type="primary"
                          icon={<CheckOutlined />}
                          onClick={async () => {
                            await explainApi.approveSample(detail.id);
                            message.success('已确认样片，开始生成全片…');
                            await loadDetail(detail.id);
                            await loadJobs();
                          }}
                        >
                          确认样片，生成全片
                        </Button>
                        <Button
                          onClick={async () => {
                            await explainApi.rejectSample(detail.id);
                            message.info('正在重做样片…');
                            await loadDetail(detail.id);
                            await loadJobs();
                          }}
                        >
                          重做样片
                        </Button>
                      </Space>
                    )}
                  </div>
                )}

                {detail.hasFinal && (
                  <div style={{ marginTop: 16 }}>
                    <Title level={5}>完整动画</Title>
                    <iframe
                      title="final"
                      src={explainApi.finalUrl(detail.id)}
                      style={{ width: '100%', height: 420, border: '1px solid #f0f0f0', borderRadius: 8, background: '#000' }}
                    />
                    <Button
                      style={{ marginTop: 8 }}
                      href={explainApi.finalUrl(detail.id)}
                      target="_blank"
                    >
                      新窗口打开
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default ExplainAnimationPage;

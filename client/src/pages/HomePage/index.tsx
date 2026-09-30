import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Upload, Button, message, Typography, Steps, Space, Tag, List, Empty, Popconfirm, Alert, Row, Col } from 'antd';
import { InboxOutlined, FilePptOutlined, RightOutlined, ClockCircleOutlined, DeleteOutlined, RocketOutlined } from '@ant-design/icons';
import { useProjectStore } from '../../stores/projectStore';
import { projectApi } from '../../api';
import { analytics, AnalyticsEvents } from '../../utils/analytics';

const { Title, Text } = Typography;
const { Dragger } = Upload;

const PARSE_STATUS_MAP: Record<string, { text: string; color: string }> = {
  pending: { text: '待解析', color: 'default' },
  parsing: { text: '解析中', color: 'processing' },
  success: { text: '解析成功', color: 'green' },
  partial: { text: '部分成功', color: 'orange' },
  failed: { text: '解析失败', color: 'red' },
};

const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { createProject, parseProject, isParsing, listProjects, projects } = useProjectStore();
  const [file, setFile] = useState<File | null>(null);
  const [projectCreated, setProjectCreated] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    listProjects();
    analytics.track(AnalyticsEvents.PAGE_ENTRY_SHOW);
    document.title = 'Cinedeck · PPT 讲解视频 · 分步向导';
  }, []);

  const handleFileSelect = (selectedFile: File) => {
    if (!selectedFile.name.toLowerCase().endsWith('.pptx')) {
      message.error('仅支持PPTX文件，请重新选择');
      return false;
    }
    setFile(selectedFile);
    analytics.track(AnalyticsEvents.FILE_SELECT, { fileName: selectedFile.name, fileSize: selectedFile.size });
    return false; // Prevent auto upload
  };

  const handleCreateProject = async () => {
    if (!file) return;
    try {
      const project = await createProject(file);
      setProjectId(project.id);
      setProjectCreated(true);
      message.success('文件上传成功');
    } catch (error: any) {
      message.error('文件上传失败：' + (error.response?.data?.error?.message || error.message));
    }
  };

  const handleParse = async () => {
    if (!projectId) return;
    try {
      analytics.track(AnalyticsEvents.PARSE_START, { projectId });
      await parseProject(projectId);
      analytics.track(AnalyticsEvents.PARSE_SUCCESS, { projectId });
      message.success('PPT解析成功');
      navigate(`/project/${projectId}/notes`);
    } catch (error: any) {
      analytics.track(AnalyticsEvents.PARSE_FAIL, { projectId, error: error.message });
      message.error('PPT解析失败：' + (error.response?.data?.error?.message || error.message));
    }
  };

  const handleContinueProject = (project: any) => {
    const status = project.parse_status || project.parseStatus;
    if (status === 'pending' || status === 'parsing' || status === 'failed') {
      navigate(`/project/${project.id}/notes`);
    } else if (status === 'success' || status === 'partial') {
      // 根据配音和视频状态决定跳转
      const videoStatus = project.video_status || project.videoStatus;
      if (videoStatus === 'success') {
        navigate(`/project/${project.id}/preview`);
      } else {
        navigate(`/project/${project.id}/voice`);
      }
    } else {
      navigate(`/project/${project.id}/notes`);
    }
  };

  const handleDeleteProject = async (project: any) => {
    try {
      await projectApi.delete(project.id);
      message.success('项目已删除');
      listProjects();
    } catch (err: any) {
      message.error('删除失败：' + (err.response?.data?.error?.message || err.message));
    }
  };

  const formatTime = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}天前`;
    return d.toLocaleDateString('zh-CN');
  };

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 24px' }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ marginBottom: 4 }}>PPT 讲解视频 · 分步向导</Title>
        <Text type="secondary">导入 PPT，按七步精细打磨配音与成片。需要无人值守请用一键全自动。</Text>
      </div>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12}>
          <Card size="small" style={{ borderColor: '#d4380d', background: '#fff7e6' }}>
            <Space>
              <FilePptOutlined style={{ fontSize: 22, color: '#d4380d' }} />
              <div>
                <Text strong>当前：分步向导</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>可控每一步，适合打磨</Text>
              </div>
            </Space>
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card
            size="small"
            hoverable
            onClick={() => navigate('/mooc')}
            style={{ cursor: 'pointer' }}
          >
            <Space>
              <RocketOutlined style={{ fontSize: 22, color: '#08979c' }} />
              <div>
                <Text strong>切换：一键全自动</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>一次配置，后台串行成片</Text>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
        message="音色与克隆请在「造声工厂」统一管理；本向导第三步只做选择并绑定到项目。"
        action={<Button size="small" type="link" onClick={() => navigate('/voice-factory')}>打开造声工厂</Button>}
      />

      <Steps
        current={0}
        items={[
          { title: '导入PPT' },
          { title: '读取备注' },
          { title: '选择音色' },
          { title: '生成配音' },
          { title: '生成数字人' },
          { title: '视频预览' },
          { title: '编辑导出' },
        ]}
        style={{ marginBottom: 40 }}
      />

      <Card>
        <Dragger
          accept=".pptx"
          maxCount={1}
          beforeUpload={handleFileSelect}
          showUploadList={false}
          disabled={projectCreated}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽PPTX文件到此区域</p>
          <p className="ant-upload-hint">仅支持.pptx格式</p>
        </Dragger>

        {file && (
          <Card
            size="small"
            style={{ marginTop: 16 }}
          >
            <Space>
              <FilePptOutlined style={{ fontSize: 24, color: '#d4380d' }} />
              <div>
                <Text strong>{file.name}</Text>
                <br />
                <Text type="secondary">{(file.size / 1024).toFixed(2)} KB</Text>
                {' '}
                <Tag color="green">可解析</Tag>
              </div>
            </Space>
          </Card>
        )}

        <div style={{ marginTop: 24, textAlign: 'center' }}>
          {!projectCreated ? (
            <Button
              type="primary"
              size="large"
              disabled={!file}
              onClick={handleCreateProject}
            >
              上传文件
            </Button>
          ) : (
            <Button
              type="primary"
              size="large"
              loading={isParsing}
              onClick={handleParse}
            >
              读取PPT备注
            </Button>
          )}
        </div>
      </Card>

      {/* 最近项目列表 */}
      {projects.length > 0 && (
        <Card title="最近项目" style={{ marginTop: 24 }}>
          <List
            dataSource={projects.slice(0, 10)}
            renderItem={(project: any) => {
              const statusInfo = PARSE_STATUS_MAP[project.parse_status || project.parseStatus] || { text: '未知', color: 'default' };
              return (
                <List.Item
                  actions={[
                    <Button
                      key="continue"
                      type="link"
                      icon={<RightOutlined />}
                      onClick={() => handleContinueProject(project)}
                    >
                      继续
                    </Button>,
                    <Popconfirm
                      key="delete"
                      title="确认删除该项目？"
                      description="删除后无法恢复，包括所有幻灯片、配音和视频文件。"
                      onConfirm={() => handleDeleteProject(project)}
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />} size="small" />
                    </Popconfirm>,
                  ]}
                  style={{ padding: '8px 0' }}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <FilePptOutlined style={{ color: '#d4380d' }} />
                        <span>{project.name || project.file_name}</span>
                        <Tag color={statusInfo.color}>{statusInfo.text}</Tag>
                      </Space>
                    }
                    description={
                      <Space size={16}>
                        <Text type="secondary">{project.file_name}</Text>
                        <Text type="secondary">
                          <ClockCircleOutlined /> {formatTime(project.updated_at || project.updatedAt)}
                        </Text>
                      </Space>
                    }
                  />
                </List.Item>
              );
            }}
          />
        </Card>
      )}
    </div>
  );
};

export default HomePage;

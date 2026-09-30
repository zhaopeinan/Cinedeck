import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Col, Row, Typography, Space, Divider } from 'antd';
import {
  FilePptOutlined, RocketOutlined, UserOutlined, AudioOutlined,
  FileTextOutlined, ExperimentOutlined, FormOutlined,
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

type HubCard = {
  key: string;
  title: string;
  desc: string;
  path: string;
  icon: React.ReactNode;
  accent?: string;
};

const Section: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({
  title, subtitle, children,
}) => (
  <div style={{ marginBottom: 36 }}>
    <div style={{ marginBottom: 16 }}>
      <Title level={4} style={{ margin: 0 }}>{title}</Title>
      {subtitle && <Text type="secondary">{subtitle}</Text>}
    </div>
    <Row gutter={[20, 20]}>{children}</Row>
  </div>
);

const HubCardView: React.FC<{ item: HubCard }> = ({ item }) => {
  const navigate = useNavigate();
  return (
    <Col xs={24} sm={12} lg={8}>
      <Card
        hoverable
        onClick={() => navigate(item.path)}
        style={{ minHeight: 200, height: '100%' }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ fontSize: 32, color: item.accent || '#1677ff', lineHeight: 1 }}>{item.icon}</div>
          <Title level={4} style={{ margin: 0 }}>{item.title}</Title>
          <Paragraph type="secondary" style={{ marginBottom: 0, minHeight: 44 }}>
            {item.desc}
          </Paragraph>
          <Button type="primary">进入</Button>
        </Space>
      </Card>
    </Col>
  );
};

const HubPage: React.FC = () => {
  const navigate = useNavigate();
  useEffect(() => {
    document.title = 'Cinedeck · 工作台';
  }, []);

  const pptCards: HubCard[] = [
    {
      key: 'ppt-step',
      title: '分步向导',
      desc: '导入 PPTX，按七步完成备注、配音、数字人与成片，适合精细打磨。',
      path: '/ppt',
      icon: <FilePptOutlined />,
      accent: '#d4380d',
    },
    {
      key: 'ppt-mooc',
      title: '一键全自动',
      desc: '一次选好音色与选项，后台串行跑完解析、解说词、配音与成片（含批量）。',
      path: '/mooc',
      icon: <RocketOutlined />,
      accent: '#08979c',
    },
  ];

  const scriptCards: HubCard[] = [
    {
      key: 'hyperframe',
      title: 'HyperFrame 讲授动画',
      desc: '多模态分析 PPT 生成讲义，配音后输出 HyperFrames 动画工程。',
      path: '/hyperframe',
      icon: <ExperimentOutlined />,
      accent: '#c41d7f',
    },
  ];

  const toolCards: HubCard[] = [
    {
      key: 'voice',
      title: '造声工厂',
      desc: '克隆/预置音色、单人试听、多人对话长音频；项目配音也从此处取音色。',
      path: '/voice-factory',
      icon: <AudioOutlined />,
      accent: '#531dab',
    },
    {
      key: 'avatar',
      title: '数字人（独立）',
      desc: '自备照片/参考视频 + 整段音频，生成口型视频；与 PPT 项目内数字人共用素材库。',
      path: '/avatar',
      icon: <UserOutlined />,
      accent: '#1677ff',
    },
    {
      key: 'transcribe',
      title: '视频转写',
      desc: '上传音视频，Whisper 识别为文本，可复制下载。',
      path: '/transcribe',
      icon: <FileTextOutlined />,
      accent: '#d46b08',
    },
  ];

  return (
    <div style={{
      maxWidth: 1280,
      width: '100%',
      margin: '0 auto',
      padding: '48px clamp(16px, 3vw, 40px)',
      boxSizing: 'border-box',
    }}
    >
      <div style={{ marginBottom: 32 }}>
        <Title level={2} style={{ marginBottom: 4 }}>Cinedeck</Title>
        <Text type="secondary">按交付物选择工作流：讲解视频、智能讲稿，或独立工具。</Text>
      </div>

      <Section
        title="PPT 讲解视频"
        subtitle="同一套项目流水线：分步打磨，或一键全自动。"
      >
        {pptCards.map((c) => <HubCardView key={c.key} item={c} />)}
      </Section>

      <Divider style={{ margin: '8px 0 28px' }} />

      <Section
        title="PPT 智能讲稿"
        subtitle="先产出讲义/讲稿；传统讲解片请走上方「PPT 讲解视频」。"
      >
        {scriptCards.map((c) => <HubCardView key={c.key} item={c} />)}
        <Col xs={24} sm={12} lg={8}>
          <Card style={{ minHeight: 200, height: '100%', background: '#fafafa' }}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <FormOutlined style={{ fontSize: 32, color: '#8c8c8c' }} />
              <Title level={4} style={{ margin: 0 }}>分步备注优化</Title>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                在「分步向导」的备注检查页，用 LLM 生成/优化/调长解说词。
              </Paragraph>
              <Button onClick={() => navigate('/ppt')}>去分步向导</Button>
            </Space>
          </Card>
        </Col>
      </Section>

      <Divider style={{ margin: '8px 0 28px' }} />

      <Section title="工具台" subtitle="与成片流水线解耦的能力；音色库为全局共享。">
        {toolCards.map((c) => <HubCardView key={c.key} item={c} />)}
      </Section>
    </div>
  );
};

export default HubPage;

import React from 'react';
import { Button, List, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import { CheckCircleFilled, DeleteOutlined, PauseOutlined, PlayCircleOutlined } from '@ant-design/icons';

const { Paragraph, Text } = Typography;

export interface VoiceListPanelProps {
  voices: any[];
  selectedVoiceId?: string | null;
  onSelectVoice?: (id: string) => void;
  loading?: boolean;
  maxHeight?: number;
  playingVoiceId?: string | null;
  previewLoadingVoiceId?: string | null;
  onPlaySample: (voiceId: string) => void | Promise<void>;
  onDeleteVoice?: (voiceId: string) => void | Promise<void>;
  emptyText?: React.ReactNode;
  selectionHighlight?: boolean;
}

export const VoiceListPanel: React.FC<VoiceListPanelProps> = ({
  voices,
  selectedVoiceId,
  onSelectVoice,
  loading,
  maxHeight = 360,
  playingVoiceId,
  previewLoadingVoiceId,
  onPlaySample,
  onDeleteVoice,
  emptyText = '暂无音色。可先克隆一段参考音频。',
  selectionHighlight = true,
}) => (
  <Spin spinning={!!loading}>
    {voices.length === 0 ? (
      <Paragraph type="secondary" style={{ margin: 0 }}>{emptyText}</Paragraph>
    ) : (
      <List
        dataSource={voices}
        style={{ maxHeight, overflow: 'auto' }}
        renderItem={(voice: any) => {
          const selected = selectionHighlight && selectedVoiceId === voice.id;
          const selectable = !!onSelectVoice;
          return (
            <List.Item
              onClick={() => selectable && onSelectVoice?.(voice.id)}
              style={{
                cursor: selectable ? 'pointer' : 'default',
                background: selected ? '#e6f4ff' : undefined,
                borderRadius: 8,
                padding: '8px 12px',
              }}
              actions={[
                <Button
                  key="play"
                  type="text"
                  loading={previewLoadingVoiceId === voice.id}
                  icon={playingVoiceId === voice.id ? <PauseOutlined /> : <PlayCircleOutlined />}
                  onClick={(e) => { e.stopPropagation(); void onPlaySample(voice.id); }}
                >
                  {playingVoiceId === voice.id ? '停止' : previewLoadingVoiceId === voice.id ? '合成中' : '试听'}
                </Button>,
                onDeleteVoice && voice.source === 'personal' ? (
                  <Popconfirm
                    key="del"
                    title="确认删除此音色？"
                    onConfirm={async (e) => {
                      e?.stopPropagation();
                      await onDeleteVoice(voice.id);
                    }}
                  >
                    <Button type="text" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                  </Popconfirm>
                ) : null,
              ].filter(Boolean)}
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    {voice.name}
                    {selected && <CheckCircleFilled style={{ color: '#1677ff' }} />}
                    <Tag>{voice.language}</Tag>
                    <Tag color={voice.source === 'personal' ? 'purple' : voice.source === 'preset' ? 'cyan' : 'blue'}>
                      {voice.source === 'personal' ? '克隆' : voice.source === 'preset' ? '预置' : '预置'}
                    </Tag>
                  </Space>
                }
                description={voice.description ? <Text type="secondary">{voice.description}</Text> : null}
              />
            </List.Item>
          );
        }}
      />
    )}
  </Spin>
);

export default VoiceListPanel;

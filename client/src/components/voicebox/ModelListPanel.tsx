import React from 'react';
import { Alert, Button, List, Progress, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { MODEL_STATUS_LABELS } from '../../constants';
import { isTtsModel } from '../../utils/voiceboxModels';

const { Text } = Typography;

export interface ModelListPanelProps {
  models: any[];
  selectedModelId?: string | null;
  onSelectModel: (id: string) => void;
  loading?: boolean;
  /** simple: 工厂页；full: 项目页（下载进度/暂停/取消/磁盘警告） */
  variant?: 'simple' | 'full';
  filterModels?: (m: any) => boolean;
  onDownloadModel?: (id: string) => void | Promise<void>;
  onPauseDownload?: (id: string) => void | Promise<void>;
  onCancelDownload?: (id: string) => void | Promise<void>;
  onShowDetail?: (model: any) => void;
  diskWarningModelId?: string | null;
  onConfirmDownloadAnyway?: (id: string) => void;
  onDismissDiskWarning?: () => void;
}

export const ModelListPanel: React.FC<ModelListPanelProps> = ({
  models,
  selectedModelId,
  onSelectModel,
  loading,
  variant = 'simple',
  filterModels = isTtsModel,
  onDownloadModel,
  onPauseDownload,
  onCancelDownload,
  onShowDetail,
  diskWarningModelId,
  onConfirmDownloadAnyway,
  onDismissDiskWarning,
}) => {
  const list = models.filter(filterModels);

  return (
    <Spin spinning={!!loading}>
      <List
        dataSource={list}
        locale={{ emptyText: '暂无配音模型' }}
        renderItem={(model: any) => {
          const statusLabel = MODEL_STATUS_LABELS[model.status] || { text: model.status, color: 'default' };
          const selected = selectedModelId === model.id;
          const ready = model.status === 'available' || model.status === 'downloaded';
          const sizeMb = model.downloadSize ? (model.downloadSize / 1024 / 1024).toFixed(variant === 'full' ? 1 : 0) : null;

          const actions: React.ReactNode[] = [];
          if (model.status === 'not_downloaded' && onDownloadModel) {
            actions.push(
              <Button key="dl" size="small" onClick={() => void onDownloadModel(model.id)}>
                下载
              </Button>,
            );
          }
          if (variant === 'full' && model.status === 'downloading') {
            actions.push(
              <Space key="dl-ctrl">
                {onPauseDownload && (
                  <Button size="small" onClick={() => void onPauseDownload(model.id)}>暂停</Button>
                )}
                {onCancelDownload && (
                  <Button size="small" danger onClick={() => void onCancelDownload(model.id)}>取消</Button>
                )}
              </Space>,
            );
          }
          if (variant === 'full' && model.status === 'downloaded' && onDownloadModel) {
            actions.push(
              <Button key="install" size="small" type="primary" onClick={() => void onDownloadModel(model.id)}>
                安装
              </Button>,
            );
          }
          if (ready) {
            actions.push(
              <Button
                key="sel"
                size="small"
                type={selected ? 'primary' : 'default'}
                onClick={() => onSelectModel(model.id)}
              >
                {selected ? '已选择' : '选择'}
              </Button>,
            );
          }

          return (
            <List.Item
              style={{
                background: selected ? '#e6f4ff' : undefined,
                borderRadius: 8,
                padding: '8px 12px',
                marginBottom: variant === 'full' ? 8 : undefined,
              }}
              actions={actions.filter(Boolean)}
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    <span
                      style={{ cursor: onShowDetail ? 'pointer' : 'default' }}
                      onClick={() => onShowDetail?.(model)}
                    >
                      {model.name}
                    </span>
                    <Tag color={statusLabel.color}>{statusLabel.text}</Tag>
                    {model.isRecommended && (
                      <Tooltip title={model.recommendReason || '推荐'}>
                        <Tag color="gold">推荐</Tag>
                      </Tooltip>
                    )}
                  </Space>
                }
                description={
                  <Space direction="vertical" size={0} style={{ width: '100%' }}>
                    {variant === 'simple' ? (
                      <Text type="secondary">
                        {model.version}
                        {sizeMb ? ` · ${sizeMb}MB` : ''}
                      </Text>
                    ) : (
                      <>
                        <Text type="secondary">版本: {model.version} | 语言: {model.language}</Text>
                        <Text type="secondary">大小: {sizeMb ? `${sizeMb}MB` : '-'}</Text>
                      </>
                    )}
                    {variant === 'full' && model.status === 'downloading' && (
                      <Progress percent={Number(model.downloadProgress || 0)} size="small" />
                    )}
                    {variant === 'full' && diskWarningModelId === model.id && (
                      <Alert
                        type="warning"
                        showIcon
                        icon={<WarningOutlined />}
                        message="磁盘空间可能不足"
                        description={`模型需要 ${sizeMb}MB，请确认磁盘空间充足`}
                        action={
                          <Space direction="vertical">
                            <Button size="small" type="primary" danger onClick={() => onConfirmDownloadAnyway?.(model.id)}>
                              仍然下载
                            </Button>
                            <Button size="small" onClick={() => onDismissDiskWarning?.()}>取消</Button>
                          </Space>
                        }
                        style={{ marginTop: 4 }}
                      />
                    )}
                  </Space>
                }
              />
            </List.Item>
          );
        }}
      />
    </Spin>
  );
};

export default ModelListPanel;

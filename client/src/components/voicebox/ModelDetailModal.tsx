import React from 'react';
import { Descriptions, Modal, Space, Tag } from 'antd';
import { MODEL_STATUS_LABELS } from '../../constants';

export interface ModelDetailModalProps {
  open: boolean;
  model: any | null;
  onClose: () => void;
}

export const ModelDetailModal: React.FC<ModelDetailModalProps> = ({ open, model, onClose }) => (
  <Modal title="模型详情" open={open} onCancel={onClose} footer={null} width={560} destroyOnClose>
    {model && (
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="模型名称">{model.name}</Descriptions.Item>
        <Descriptions.Item label="版本">{model.version}</Descriptions.Item>
        <Descriptions.Item label="语言">{model.language}</Descriptions.Item>
        <Descriptions.Item label="能力">
          <Space wrap>
            {model.capabilities?.map((c: string) => <Tag key={c}>{c}</Tag>)}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="下载大小">
          {model.downloadSize ? `${(model.downloadSize / 1024 / 1024).toFixed(1)} MB` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="安装大小">
          {model.installedSize ? `${(model.installedSize / 1024 / 1024).toFixed(1)} MB` : '未知'}
        </Descriptions.Item>
        <Descriptions.Item label="运行设备">{model.runDevice}</Descriptions.Item>
        <Descriptions.Item label="推荐理由">{model.recommendReason || '无'}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={MODEL_STATUS_LABELS[model.status]?.color || 'default'}>
            {MODEL_STATUS_LABELS[model.status]?.text || model.status}
          </Tag>
        </Descriptions.Item>
      </Descriptions>
    )}
  </Modal>
);

export default ModelDetailModal;

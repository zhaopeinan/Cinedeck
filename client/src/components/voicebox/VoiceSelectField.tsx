import React from 'react';
import { Button, Select, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

export interface VoiceSelectFieldProps {
  value?: string;
  onChange?: (id: string) => void;
  voices: Array<{ id: string; name?: string; language?: string; source?: string }>;
  loading?: boolean;
  placeholder?: string;
  onReload?: () => void;
  style?: React.CSSProperties;
  disabled?: boolean;
}

export const VoiceSelectField: React.FC<VoiceSelectFieldProps> = ({
  value,
  onChange,
  voices,
  loading,
  placeholder = '选择音色',
  onReload,
  style,
  disabled,
}) => (
  <Space.Compact style={{ width: '100%', ...style }}>
    <Select
      value={value}
      onChange={onChange}
      loading={loading}
      disabled={disabled}
      placeholder={voices.length ? placeholder : '暂无音色'}
      style={{ width: '100%' }}
      showSearch
      optionFilterProp="label"
      options={voices.map((v) => ({
        value: v.id,
        label: `${v.name || v.id}${v.language ? ` · ${v.language}` : ''}${v.source === 'preset' ? ' · 预置' : v.source === 'personal' ? ' · 克隆' : ''}`,
      }))}
      notFoundContent="暂无音色"
    />
    {onReload && (
      <Button icon={<ReloadOutlined />} onClick={onReload} loading={loading} title="刷新音色列表" />
    )}
  </Space.Compact>
);

export interface ModelSelectFieldProps {
  value?: string;
  onChange?: (id: string) => void;
  models: Array<{ id: string; name?: string; status?: string }>;
  loading?: boolean;
  placeholder?: string;
  onReload?: () => void;
  readyOnly?: boolean;
  style?: React.CSSProperties;
  disabled?: boolean;
}

export const ModelSelectField: React.FC<ModelSelectFieldProps> = ({
  value,
  onChange,
  models,
  loading,
  placeholder = '选择配音模型',
  onReload,
  readyOnly = true,
  style,
  disabled,
}) => {
  const list = readyOnly
    ? models.filter((m) => m.status === 'available' || m.status === 'downloaded')
    : models;
  const optionsSource = list.length ? list : models;

  return (
    <Space.Compact style={{ width: '100%', ...style }}>
      <Select
        value={value}
        onChange={onChange}
        loading={loading}
        disabled={disabled}
        placeholder={optionsSource.length ? placeholder : '暂无可用模型'}
        style={{ width: '100%' }}
        showSearch
        optionFilterProp="label"
        options={optionsSource.map((m) => ({
          value: m.id,
          label: m.name || m.id,
        }))}
        notFoundContent="暂无模型"
      />
      {onReload && (
        <Button icon={<ReloadOutlined />} onClick={onReload} loading={loading} title="刷新模型列表" />
      )}
    </Space.Compact>
  );
};

export default VoiceSelectField;

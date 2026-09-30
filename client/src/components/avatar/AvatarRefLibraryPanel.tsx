import React, { useState } from 'react';
import {
  Button, Card, Checkbox, Empty, Input, List, Popconfirm, Radio, Select, Space, Tag, Typography, Upload, message,
} from 'antd';
import {
  DeleteOutlined, EditOutlined, PlusOutlined, VideoCameraOutlined,
} from '@ant-design/icons';
import { avatarApi, type AvatarRefVideo } from '../../api';
import { formatFileSize } from '../../utils/formatFileSize';
import { GreenscreenAlert } from './GreenscreenAlert';
import { notifyGreenscreenRef } from './notifyGreenscreenRef';

const { Paragraph, Text } = Typography;

export type AvatarRefLibraryMode = 'manage' | 'pick' | 'select';

export interface AvatarRefLibraryPanelProps {
  mode: AvatarRefLibraryMode;
  refs: AvatarRefVideo[];
  loading?: boolean;
  selectedId: string | null;
  disabled?: boolean;
  onSelect: (id: string, item: AvatarRefVideo) => void;
  /** Called after local list mutates (upload / rename / delete / greenscreen). */
  onRefsChange?: (refs: AvatarRefVideo[]) => void;
  /** pick: open standalone library manager */
  onManageLibrary?: () => void;
  /** manage: show footer hint about temp upload */
  showTempHint?: boolean;
  cardSize?: 'default' | 'small';
  title?: React.ReactNode;
  style?: React.CSSProperties;
  /** select mode: Form.Item compatible (optional; falls back to selectedId/onSelect) */
  value?: string | null;
  onChange?: (id: string) => void;
  selectPlaceholder?: string;
}

function validateVideo(file: File): boolean {
  if (!/\.(mp4|mov|webm)$/i.test(file.name)) {
    message.error('仅支持 MP4 / MOV / WEBM');
    return false;
  }
  if (file.size > 100 * 1024 * 1024) {
    message.error('参考视频不超过 100MB');
    return false;
  }
  return true;
}

export const AvatarRefLibraryPanel: React.FC<AvatarRefLibraryPanelProps> = ({
  mode,
  refs,
  loading,
  selectedId,
  disabled,
  onSelect,
  onRefsChange,
  onManageLibrary,
  showTempHint = false,
  cardSize = 'default',
  title,
  style,
  value,
  onChange,
  selectPlaceholder,
}) => {
  const [uploading, setUploading] = useState(false);
  const [uploadAsGreenscreen, setUploadAsGreenscreen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const effectiveSelected = mode === 'select' ? (value ?? selectedId) : selectedId;
  const selectedRef = refs.find((r) => r.id === effectiveSelected) || null;

  const emitSelect = (item: AvatarRefVideo) => {
    onSelect(item.id, item);
    onChange?.(item.id);
    notifyGreenscreenRef(item);
  };

  const patchRefs = (next: AvatarRefVideo[]) => {
    onRefsChange?.(next);
  };

  const handleUpload = async (file: File, opts?: { autoSelect?: boolean; withGreenscreen?: boolean }) => {
    if (!validateVideo(file)) return;
    setUploading(true);
    try {
      const displayName = file.name.replace(/\.[^.]+$/, '').trim() || file.name;
      const isGs = opts?.withGreenscreen ?? (mode === 'manage' ? uploadAsGreenscreen : false);
      const res = await avatarApi.uploadRef(file, displayName, { isGreenscreen: isGs });
      const row = res.data.data as AvatarRefVideo;
      const next = [row, ...refs.filter((r) => r.id !== row.id)];
      patchRefs(next);
      message.success(
        isGs
          ? '参考视频已保存（绿幕：叠 PPT 时会抠绿透明）'
          : mode === 'manage'
            ? '参考视频已保存（仅自己可见）'
            : '参考视频已上传并选用',
      );
      if (opts?.autoSelect !== false) emitSelect(row);
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await avatarApi.deleteRef(id);
      patchRefs(refs.filter((r) => r.id !== id));
      message.success('已删除');
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '删除失败');
    }
  };

  const handleRename = async (id: string) => {
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await avatarApi.renameRef(id, renameValue.trim());
      patchRefs(refs.map((r) => (r.id === id ? { ...r, name: renameValue.trim() } : r)));
      setRenamingId(null);
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '重命名失败');
    }
  };

  const handleToggleGreenscreen = async (item: AvatarRefVideo, checked: boolean) => {
    try {
      const res = await avatarApi.updateRef(item.id, { isGreenscreen: checked });
      const row = res.data.data as AvatarRefVideo;
      patchRefs(refs.map((r) => (r.id === item.id ? { ...r, ...row } : r)));
      if (checked) message.info('已标记为绿幕：叠到 PPT 时会抠绿做成透明');
    } catch (err: any) {
      message.error(err.response?.data?.error?.message || '更新失败');
    }
  };

  const previewPlayer = selectedRef ? (
    <div style={{ marginTop: 12 }}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        预览：{selectedRef.name}
      </Text>
      <video
        key={selectedRef.id}
        src={avatarApi.getRefPreviewUrl(selectedRef.id)}
        controls
        playsInline
        preload="metadata"
        style={{
          width: '100%',
          maxWidth: mode === 'select' ? 360 : 420,
          maxHeight: 240,
          background: '#000',
          borderRadius: 8,
          display: 'block',
        }}
      />
    </div>
  ) : null;

  if (mode === 'select') {
    return (
      <div style={style}>
        <Select
          style={{ width: '100%' }}
          disabled={disabled}
          loading={loading}
          placeholder={selectPlaceholder || (refs.length ? '选择参考视频' : '暂无参考视频，请先到「数字人解说」上传')}
          value={effectiveSelected || undefined}
          options={refs.map((r) => ({
            value: r.id,
            label: r.isGreenscreen ? `${r.name}（绿幕）` : r.name,
          }))}
          onChange={(id) => {
            const hit = refs.find((r) => r.id === id);
            if (hit) emitSelect(hit);
          }}
        />
        {previewPlayer}
        <GreenscreenAlert visible={!!selectedRef?.isGreenscreen} style={{ marginTop: 12, marginBottom: 0 }} />
      </div>
    );
  }

  const cardTitle = title ?? (
    <Space>
      <VideoCameraOutlined />
      {mode === 'manage' ? '我的参考视频（私有）' : '参考视频（整份共用）'}
    </Space>
  );

  const manageExtra = mode === 'manage' ? (
    <Space wrap>
      <Checkbox
        checked={uploadAsGreenscreen}
        disabled={uploading || disabled}
        onChange={(e) => setUploadAsGreenscreen(e.target.checked)}
      >
        绿幕模板
      </Checkbox>
      <Upload
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
        showUploadList={false}
        disabled={uploading || disabled}
        beforeUpload={(file) => {
          void handleUpload(file);
          return false;
        }}
      >
        <Button icon={<PlusOutlined />} loading={uploading} size="small">
          上传到素材库
        </Button>
      </Upload>
    </Space>
  ) : undefined;

  return (
    <Card
      size={cardSize}
      title={cardTitle}
      style={style}
      extra={manageExtra}
    >
      {mode === 'pick' && refs.length === 0 && !loading ? (
        <Text type="secondary">素材库为空，请先到独立「数字人解说」页上传参考视频，或在此上传并选用。</Text>
      ) : mode === 'manage' && refs.length === 0 && !loading ? (
        <Empty description="还没有参考视频，请上传一段 5–30 秒半身说话片段" />
      ) : mode === 'pick' ? (
        <>
          <Radio.Group
            value={effectiveSelected || undefined}
            disabled={disabled}
            onChange={(e) => {
              const hit = refs.find((r) => r.id === e.target.value);
              if (hit) emitSelect(hit);
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}
          >
            {refs.map((r) => (
              <Radio
                key={r.id}
                value={r.id}
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: effectiveSelected === r.id ? 'rgba(22,119,255,0.06)' : undefined,
                }}
              >
                <Space>
                  {r.name}
                  {r.isGreenscreen && <Tag color="green">绿幕</Tag>}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {formatFileSize(r.fileSize)}
                  </Text>
                </Space>
              </Radio>
            ))}
          </Radio.Group>
          {previewPlayer}
        </>
      ) : (
        <List
          loading={loading}
          dataSource={refs}
          renderItem={(item) => (
            <List.Item
              style={{
                cursor: 'pointer',
                background: effectiveSelected === item.id ? 'rgba(22,119,255,0.06)' : undefined,
                borderRadius: 8,
                padding: '8px 12px',
              }}
              onClick={() => emitSelect(item)}
              actions={[
                <Checkbox
                  key="gs"
                  checked={!!item.isGreenscreen}
                  disabled={disabled}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => void handleToggleGreenscreen(item, e.target.checked)}
                >
                  绿幕
                </Checkbox>,
                <Button
                  key="edit"
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(item.id);
                    setRenameValue(item.name);
                  }}
                />,
                <Popconfirm
                  key="del"
                  title="删除这段参考视频？"
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    void handleDelete(item.id);
                  }}
                  onCancel={(e) => e?.stopPropagation()}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  renamingId === item.id ? (
                    <Input
                      size="small"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onPressEnter={() => void handleRename(item.id)}
                      onBlur={() => void handleRename(item.id)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      style={{ maxWidth: 280 }}
                    />
                  ) : (
                    <Space>
                      {item.name}
                      {effectiveSelected === item.id && <Tag color="blue">已选</Tag>}
                      {item.isGreenscreen && <Tag color="green">绿幕</Tag>}
                    </Space>
                  )
                }
                description={`${formatFileSize(item.fileSize)} · ${new Date(item.createdAt).toLocaleString()}`}
              />
              {effectiveSelected === item.id && (
                <video
                  src={avatarApi.getRefPreviewUrl(item.id)}
                  controls
                  style={{ width: 180, maxHeight: 120, background: '#000', borderRadius: 6 }}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
            </List.Item>
          )}
        />
      )}

      <GreenscreenAlert
        visible={!!selectedRef?.isGreenscreen}
        style={{ marginTop: 12 }}
        message={mode === 'manage' ? '已选绿幕模板' : undefined}
      />

      {mode === 'pick' && (
        <div style={{ marginTop: 12 }}>
          <Space wrap>
            <Upload
              accept="video/mp4,video/webm,.mp4,.webm"
              showUploadList={false}
              disabled={disabled || uploading}
              beforeUpload={(file) => {
                void handleUpload(file as File, { autoSelect: true });
                return false;
              }}
            >
              <Button size="small" icon={<VideoCameraOutlined />} loading={uploading}>
                上传并选用
              </Button>
            </Upload>
            {onManageLibrary && (
              <Button size="small" onClick={onManageLibrary}>管理参考视频库</Button>
            )}
          </Space>
        </div>
      )}

      {mode === 'manage' && showTempHint && (
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          也可在下方临时上传一段仅用于本次生成的视频（可选同时保存到素材库）。绿幕请勾选「绿幕」标记，系统不做自动检测。
        </Paragraph>
      )}
    </Card>
  );
};

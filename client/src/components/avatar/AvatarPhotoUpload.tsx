import React from 'react';
import { Button, Space, Typography, Upload, message } from 'antd';
import { InboxOutlined, PictureOutlined, PlusOutlined } from '@ant-design/icons';

const { Text } = Typography;
const { Dragger } = Upload;

export interface AvatarPhotoUploadProps {
  variant?: 'dragger' | 'button';
  disabled?: boolean;
  fileName?: string | null;
  previewUrl?: string | null;
  /** When true, show success tag that a photo already exists (project flow). */
  hasExisting?: boolean;
  onFile: (file: File) => void;
}

function validatePhoto(file: File): boolean {
  if (!/\.(jpe?g|png)$/i.test(file.name)) {
    message.error('仅支持 JPG / PNG');
    return false;
  }
  return true;
}

export const AvatarPhotoUpload: React.FC<AvatarPhotoUploadProps> = ({
  variant = 'dragger',
  disabled,
  fileName,
  previewUrl,
  hasExisting,
  onFile,
}) => {
  if (variant === 'button') {
    return (
      <Space wrap>
        <Upload
          accept=".jpg,.jpeg,.png,image/jpeg,image/png"
          showUploadList={false}
          disabled={disabled}
          beforeUpload={(file) => {
            if (!validatePhoto(file)) return false;
            onFile(file);
            return false;
          }}
        >
          <Button icon={<PlusOutlined />} disabled={disabled}>
            {fileName || (hasExisting ? '重新上传静照' : '上传照片')}
          </Button>
        </Upload>
        {fileName && <Text type="secondary">{fileName}</Text>}
      </Space>
    );
  }

  return (
    <>
      <Dragger
        accept="image/jpeg,image/png,image/jpg,.jpg,.jpeg,.png"
        maxCount={1}
        showUploadList={false}
        disabled={disabled}
        beforeUpload={(file) => {
          if (!validatePhoto(file)) return false;
          onFile(file);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽照片</p>
        <p className="ant-upload-hint">建议正面、人脸清晰</p>
      </Dragger>
      {previewUrl && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <img src={previewUrl} alt="preview" style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 8 }} />
          {fileName && <div><Text type="secondary">{fileName}</Text></div>}
        </div>
      )}
      {!previewUrl && hasExisting && (
        <div style={{ marginTop: 12 }}>
          <Space>
            <PictureOutlined />
            <Text type="success">已有静照</Text>
          </Space>
        </div>
      )}
    </>
  );
};

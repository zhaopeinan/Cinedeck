import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Table, Button, Space, Typography, Modal, Form, Input, InputNumber, message, Tag, Popconfirm, Spin, Divider, Select } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined, ApiOutlined, ArrowLeftOutlined, SettingOutlined } from '@ant-design/icons';
import { llmApi, systemSettingsApi, explainApi, type ExplainGenSettings } from '../../api';
import { useAuthStore } from '../../stores/authStore';

const { Title, Text, Paragraph } = Typography;

interface TestImage {
  id: string;
  name: string;
  description: string;
  url: string;
}

const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const [configs, setConfigs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<any>(null);
  const [form] = Form.useForm();

  // 多模态测试相关状态
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testConfigId, setTestConfigId] = useState<string | null>(null);
  const [testImages, setTestImages] = useState<TestImage[]>([]);
  const [selectedTestImage, setSelectedTestImage] = useState<string>('city');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // 系统配置相关状态（管理员可见）
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';
  const [systemSettings, setSystemSettings] = useState<any[]>([]);
  const [systemSettingsLoading, setSystemSettingsLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const [modules, setModules] = useState<Array<{ id: string; label: string; description: string }>>([]);
  const [bindings, setBindings] = useState<Record<string, string | null>>({});
  const [defaultConfigId, setDefaultConfigId] = useState<string | null>(null);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [savingBindings, setSavingBindings] = useState(false);

  const [explainGen, setExplainGen] = useState<ExplainGenSettings | null>(null);
  const [explainGenDefaults, setExplainGenDefaults] = useState<ExplainGenSettings | null>(null);
  const [explainGenFields, setExplainGenFields] = useState<any[]>([]);
  const [explainGenLoading, setExplainGenLoading] = useState(false);
  const [savingExplainGen, setSavingExplainGen] = useState(false);

  const loadConfigs = async () => {
    setLoading(true);
    try {
      const res = await llmApi.listConfigs();
      setConfigs(res.data.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const loadBindings = async () => {
    setBindingsLoading(true);
    try {
      const res = await llmApi.getModuleBindings();
      if (res.data?.success && res.data.data) {
        setModules(res.data.data.modules || []);
        setBindings(res.data.data.bindings || {});
        setDefaultConfigId(res.data.data.defaultConfigId || null);
      }
    } catch {
      // ignore
    } finally {
      setBindingsLoading(false);
    }
  };

  const loadTestImages = async () => {
    try {
      const res = await llmApi.getTestImages();
      setTestImages(res.data.data || []);
    } catch {
      // ignore
    }
  };

  const loadSystemSettings = async () => {
    if (!isAdmin) return;
    setSystemSettingsLoading(true);
    try {
      const res = await systemSettingsApi.list();
      setSystemSettings(res.data.data || []);
    } catch {
      // ignore
    } finally {
      setSystemSettingsLoading(false);
    }
  };

  const loadExplainGen = async () => {
    setExplainGenLoading(true);
    try {
      const res = await explainApi.getGenSettings();
      if (res.data?.success && res.data.data) {
        setExplainGen(res.data.data.settings);
        setExplainGenDefaults(res.data.data.defaults);
        setExplainGenFields(res.data.data.fields || []);
      }
    } catch {
      // ignore
    } finally {
      setExplainGenLoading(false);
    }
  };

  const handleSaveExplainGen = async () => {
    if (!explainGen) return;
    setSavingExplainGen(true);
    try {
      const res = await explainApi.setGenSettings(explainGen);
      if (!res.data?.success) throw new Error(res.data?.error?.message || '保存失败');
      setExplainGen(res.data.data.settings);
      setExplainGenDefaults(res.data.data.defaults);
      message.success('讲解动画 Token 配置已保存');
    } catch (err: any) {
      message.error('保存失败：' + (err.response?.data?.error?.message || err.message));
    } finally {
      setSavingExplainGen(false);
    }
  };

  const handleResetExplainGen = () => {
    if (!explainGenDefaults) return;
    setExplainGen({ ...explainGenDefaults });
  };

  const handleSaveSetting = async (key: string, value: string) => {
    setSavingKey(key);
    try {
      await systemSettingsApi.update(key, value);
      message.success('配置已保存');
      await loadSystemSettings();
    } catch (error: any) {
      message.error('保存失败：' + (error.response?.data?.error?.message || error.message));
    } finally {
      setSavingKey(null);
    }
  };

  useEffect(() => {
    document.title = 'Cinedeck · 设置';
    loadConfigs();
    loadBindings();
    loadExplainGen();
    loadSystemSettings();
  }, []);

  const handleSaveBindings = async () => {
    setSavingBindings(true);
    try {
      const res = await llmApi.setModuleBindings(bindings);
      if (!res.data?.success) throw new Error(res.data?.error?.message || '保存失败');
      setBindings(res.data.data?.bindings || bindings);
      message.success('模块模型绑定已保存');
      await loadBindings();
    } catch (e: any) {
      message.error(e?.response?.data?.error?.message || e?.message || '保存失败');
    } finally {
      setSavingBindings(false);
    }
  };

  const handleAdd = () => {
    setEditingConfig(null);
    form.resetFields();
    form.setFieldsValue({ temperature: 0.7, maxRetryCycles: 3, toleranceRate: 0.1 });
    setModalOpen(true);
  };

  const handleEdit = (record: any) => {
    setEditingConfig(record);
    form.setFieldsValue({
      name: record.name,
      baseUrl: record.baseUrl,
      modelName: record.modelName,
      apiKey: '',
      temperature: record.temperature,
      maxRetryCycles: record.maxRetryCycles ?? 3,
      toleranceRate: record.toleranceRate ?? 0.1,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editingConfig) {
        await llmApi.updateConfig(editingConfig.id, values);
        message.success('更新成功');
      } else {
        await llmApi.createConfig(values);
        message.success('创建成功');
      }
      setModalOpen(false);
      loadConfigs();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('操作失败：' + (err.response?.data?.error?.message || err.message));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await llmApi.deleteConfig(id);
      message.success('删除成功');
      loadConfigs();
    } catch (err: any) {
      message.error('删除失败：' + (err.response?.data?.error?.message || err.message));
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await llmApi.activateConfig(id);
      await loadBindings();
      message.success('已设为默认');
      loadConfigs();
    } catch (err: any) {
      message.error('设置失败：' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 打开测试弹窗
  const handleOpenTest = async (id: string) => {
    setTestConfigId(id);
    setTestResult(null);
    setSelectedTestImage('city');
    setTestModalOpen(true);
    if (testImages.length === 0) {
      await loadTestImages();
    }
  };

  // 执行多模态测试
  const handleRunTest = async () => {
    if (!testConfigId) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await llmApi.testConfig(testConfigId, selectedTestImage);
      setTestResult(res.data.data.reply);
      message.success('多模态测试成功');
    } catch (err: any) {
      setTestResult(null);
      message.error('测试失败：' + (err.response?.data?.error?.message || err.message));
    } finally {
      setTestLoading(false);
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: any) => (
        <Space>
          <Text strong>{name}</Text>
          {record.isActive === 1 && <Tag color="green" icon={<CheckCircleOutlined />}>默认</Tag>}
        </Space>
      ),
    },
    { title: 'Base URL', dataIndex: 'baseUrl', key: 'baseUrl', ellipsis: true },
    { title: '模型', dataIndex: 'modelName', key: 'modelName' },
    {
      title: '温度',
      dataIndex: 'temperature',
      key: 'temperature',
      width: 80,
      render: (t: number) => t?.toFixed(1),
    },
    {
      title: '重试次数',
      dataIndex: 'maxRetryCycles',
      key: 'maxRetryCycles',
      width: 90,
      render: (v: number) => v ?? 3,
    },
    {
      title: '容差率',
      dataIndex: 'toleranceRate',
      key: 'toleranceRate',
      width: 90,
      render: (v: number) => `${Math.round((v ?? 0.1) * 100)}%`,
    },
    {
      title: '操作',
      key: 'action',
      width: 280,
      render: (_: any, record: any) => (
        <Space size="small">
          <Button size="small" icon={<ApiOutlined />} onClick={() => handleOpenTest(record.id)}>
            测试
          </Button>
          {record.isActive !== 1 && (
            <Button size="small" type="link" onClick={() => handleActivate(record.id)}>设为默认</Button>
          )}
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // 当前选中的测试图片
  const currentTestImage = testImages.find(t => t.id === selectedTestImage);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px' }}>
      <div style={{ marginBottom: 16 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
          <Title level={4} style={{ margin: 0 }}>设置</Title>
        </Space>
      </div>

      <Card title="大模型（LLM）" style={{ marginBottom: isAdmin ? 0 : undefined }}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <Text type="secondary">
            OpenAI 兼容接口，用于解说词、HyperFrame 讲义、讲解动画（风格推荐与 HTML 动效生成）等。配置按用户隔离；未配置个人项时可用全局激活配置。
          </Text>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加配置</Button>
        </div>

        <Table
          dataSource={configs}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={false}
          size="middle"
        />
      </Card>

      <Card
        title="讲解动画 · Token 预算"
        style={{ marginTop: 16 }}
        extra={
          <Space>
            <Button onClick={handleResetExplainGen} disabled={!explainGenDefaults || savingExplainGen}>恢复默认</Button>
            <Button type="primary" loading={savingExplainGen} onClick={() => void handleSaveExplainGen()} disabled={!explainGen}>
              保存
            </Button>
          </Space>
        }
      >
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          各阶段发给大模型的 <Text code>max_tokens</Text> 与 Reasoning 强度（按当前登录用户保存）。
          HTML 阶段若出骨架会自动用 <Text code>reasoning=none</Text> 重试一次。
        </Paragraph>
        <Spin spinning={explainGenLoading}>
          {explainGen && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
              {explainGenFields.filter((f) => f.type === 'int').map((f) => (
                <div key={f.key}>
                  <Text strong style={{ display: 'block', marginBottom: 4 }}>{f.label}</Text>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>{f.description}</Text>
                  <InputNumber
                    style={{ width: '100%' }}
                    min={f.min}
                    max={f.max}
                    step={500}
                    value={(explainGen as any)[f.key]}
                    onChange={(v) => setExplainGen((prev) => prev ? { ...prev, [f.key]: Number(v) || f.min || 0 } : prev)}
                  />
                  {explainGenDefaults && (
                    <Text type="secondary" style={{ fontSize: 11 }}>默认 {((explainGenDefaults as any)[f.key])?.toLocaleString?.()}</Text>
                  )}
                </div>
              ))}
              {explainGenFields.filter((f) => f.type === 'enum').map((f) => (
                <div key={f.key}>
                  <Text strong style={{ display: 'block', marginBottom: 4 }}>{f.label}</Text>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>{f.description}</Text>
                  <Select
                    style={{ width: '100%' }}
                    value={(explainGen as any)[f.key]}
                    options={(f.options || []).map((o: any) => ({ value: o.value, label: o.label }))}
                    onChange={(v) => setExplainGen((prev) => prev ? { ...prev, [f.key]: v } : prev)}
                  />
                </div>
              ))}
            </div>
          )}
        </Spin>
      </Card>

      <Card
        title="模块使用的模型"
        style={{ marginTop: 16, marginBottom: isAdmin ? 0 : undefined }}
        extra={
          <Button type="primary" loading={savingBindings} onClick={() => void handleSaveBindings()} disabled={configs.length === 0}>
            保存绑定
          </Button>
        }
      >
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          可为不同功能指定模型；选「使用默认」则走上方标记为默认的配置。例如讲解动画可用更强的多模态模型，解说词用更便宜的文本模型。
        </Paragraph>
        <Spin spinning={bindingsLoading}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {modules.map((m) => (
              <div key={m.id} style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ minWidth: 160 }}>
                  <Text strong>{m.label}</Text>
                  <div><Text type="secondary" style={{ fontSize: 12 }}>{m.description}</Text></div>
                </div>
                <Select
                  style={{ minWidth: 280, flex: 1 }}
                  value={bindings[m.id] || ''}
                  onChange={(v) => setBindings((prev) => ({ ...prev, [m.id]: v || null }))}
                  options={[
                    {
                      value: '',
                      label: defaultConfigId
                        ? `使用默认（${configs.find((c) => c.id === defaultConfigId)?.name || '当前默认'}）`
                        : '使用默认',
                    },
                    ...configs.map((c) => ({
                      value: c.id,
                      label: `${c.name}${c.isActive === 1 || c.is_active === 1 ? ' · 默认' : ''}`,
                    })),
                  ]}
                />
              </div>
            ))}
            {modules.length === 0 && (
              <Text type="secondary">加载模块列表中…</Text>
            )}
          </Space>
        </Spin>
      </Card>

      {/* 系统配置（仅管理员可见） */}
      {isAdmin && (
        <>
          <Divider />
          <Card>
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <SettingOutlined />
              <Title level={5} style={{ margin: 0 }}>系统配置</Title>
              <Tag color="red" style={{ marginLeft: 8 }}>管理员</Tag>
            </div>
            <Text type="secondary">系统级超参数配置，影响所有用户的全局行为。</Text>

            <Spin spinning={systemSettingsLoading}>
              <div style={{ marginTop: 16 }}>
                {systemSettings.map((s: any) => (
                  <SystemSettingRow
                    key={s.key}
                    setting={s}
                    saving={savingKey === s.key}
                    onSave={(v) => handleSaveSetting(s.key, v)}
                  />
                ))}
              </div>
            </Spin>
          </Card>
        </>
      )}

      {/* 添加/编辑配置弹窗 */}
      <Modal
        title={editingConfig ? '编辑配置' : '添加配置'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={520}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="配置名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：GPT-4o / Qwen-VL" />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请输入 Base URL' }]}>
            <Input placeholder="如：https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item name="modelName" label="模型名称" rules={[{ required: true, message: '请输入模型名称' }]}>
            <Input placeholder="如：gpt-4o / qwen-vl-max" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key">
            <Input.Password
              placeholder={editingConfig ? '******（留空不修改）' : 'sk-...'}
              autoComplete="new-password"
            />
          </Form.Item>
          <Form.Item name="temperature" label="Temperature（温度）" rules={[{ required: true }]}>
            <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12, marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>以下参数用于解说词生成的字数达标循环检查</Text>
          </div>
          <Form.Item name="maxRetryCycles" label="循环重试次数" tooltip="字数不达标时重试的最大次数" rules={[{ required: true }]}>
            <InputNumber min={0} max={10} step={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="toleranceRate" label="容差率" tooltip="实际字数与目标字数的允许偏差比例，超过此比例则重试" rules={[{ required: true }]}>
            <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} formatter={(v) => `${Math.round((Number(v) || 0) * 100)}%`} parser={(v: string) => parseFloat((v || '').replace('%', '')) / 100 as any} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 多模态测试弹窗 */}
      <Modal
        title="多模态测试"
        open={testModalOpen}
        onCancel={() => { setTestModalOpen(false); setTestResult(null); }}
        footer={[
          <Button key="cancel" onClick={() => { setTestModalOpen(false); setTestResult(null); }}>关闭</Button>,
          <Button key="test" type="primary" loading={testLoading} onClick={handleRunTest} icon={<ApiOutlined />}>
            发送测试
          </Button>,
        ]}
        width={640}
      >
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            选择一张测试图片，发送给大模型。模型将识别图片内容并返回描述，验证多模态能力。
          </Text>
        </div>

        {/* 测试图片选择 */}
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>选择测试图片：</Text>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {testImages.map((img) => (
              <div
                key={img.id}
                onClick={() => setSelectedTestImage(img.id)}
                style={{
                  cursor: 'pointer',
                  border: selectedTestImage === img.id ? '2px solid #1677ff' : '2px solid #e8e8e8',
                  borderRadius: 8,
                  padding: 4,
                  width: 110,
                  textAlign: 'center',
                  transition: 'border-color 0.2s',
                }}
              >
                <img
                  src={img.url}
                  alt={img.name}
                  style={{ width: '100%', height: 80, objectFit: 'cover', borderRadius: 4 }}
                />
                <div style={{ fontSize: 12, marginTop: 4 }}>{img.name}</div>
              </div>
            ))}
            {testImages.length === 0 && <Spin />}
          </div>
        </div>

        {/* 当前选中的大图预览 */}
        {currentTestImage && (
          <div style={{ marginBottom: 16, textAlign: 'center' }}>
            <img
              src={currentTestImage.url}
              alt={currentTestImage.name}
              style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, border: '1px solid #e8e8e8' }}
            />
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{currentTestImage.description}</Text>
            </div>
          </div>
        )}

        {/* 测试结果 */}
        {testLoading && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin tip="正在调用大模型识别图片..." />
          </div>
        )}
        {testResult && !testLoading && (
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>大模型返回的图片描述：</Text>
            <div
              style={{
                background: '#f6f8fa',
                borderRadius: 8,
                padding: 16,
                border: '1px solid #e8e8e8',
                maxHeight: 200,
                overflowY: 'auto',
              }}
            >
              <Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{testResult}</Paragraph>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

/** 单行系统配置：可编辑数值并保存。 */
const SystemSettingRow: React.FC<{ setting: any; saving: boolean; onSave: (value: string) => void }> = ({ setting, saving, onSave }) => {
  const [value, setValue] = useState(String(setting.value ?? ''));

  // 当后端值变化时（如保存后刷新），同步本地输入框
  useEffect(() => {
    setValue(String(setting.value ?? ''));
  }, [setting.value]);

  const isDubbingTimeout = setting.key === 'dubbing_timeout_seconds';

  const labelMap: Record<string, string> = {
    dubbing_timeout_seconds: '配音生成超时（秒）',
  };
  const label = labelMap[setting.key] || setting.key;

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>{label}</div>
        <Text type="secondary" style={{ fontSize: 12 }}>{setting.description || ''}</Text>
        {setting.updatedAt && (
          <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>
            最近更新：{new Date(setting.updatedAt).toLocaleString()}{setting.updatedBy ? ` · ${setting.updatedBy}` : ''}
          </div>
        )}
      </div>
      <Space>
        {isDubbingTimeout ? (
          <InputNumber
            value={Number(value) || 0}
            min={10}
            max={7200}
            step={60}
            style={{ width: 140 }}
            onChange={(v) => setValue(String(v ?? 0))}
            disabled={saving}
          />
        ) : (
          <Input
            value={value}
            style={{ width: 200 }}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
          />
        )}
        <Button
          type="primary"
          size="small"
          loading={saving}
          disabled={value === String(setting.value ?? '')}
          onClick={() => onSave(value)}
        >
          保存
        </Button>
      </Space>
    </div>
  );
};

export default SettingsPage;

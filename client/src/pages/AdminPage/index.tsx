import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Tabs, Table, Button, Card, Row, Col, Statistic, Spin, Tag, Space,
  Typography, Modal, Form, Input, Select, Switch, Popconfirm, message, Checkbox, Drawer,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  PlusOutlined, LogoutOutlined, HomeOutlined, UserOutlined,
  TeamOutlined, FileTextOutlined, CheckCircleOutlined, ClockCircleOutlined,
  DeleteOutlined, KeyOutlined, CopyOutlined, ShareAltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { authApi, projectApi, openPlatformApi, accessGrantApi, type AccessGrant } from '../../api';
import { useAuthStore } from '../../stores/authStore';

const { Title, Text } = Typography;
const { Search } = Input;

interface UserRecord {
  id: string;
  username: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LogRecord {
  id: string;
  userId: string | null;
  username: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  userAgent: string | null;
  details: string | null;
  status: string;
  createdAt: string;
}

interface StatsData {
  userCount: number;
  activeUserCount: number;
  logCount: number;
  todayLogCount: number;
  projectCount: number;
}

const ROLE_OPTIONS = [
  { label: '管理员', value: 'admin' },
  { label: '普通用户', value: 'user' },
];

const LOG_STATUS_OPTIONS = [
  { label: '全部', value: '' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' },
];

const formatTime = (time: string | null): string => {
  if (!time) return '-';
  return dayjs(time).format('YYYY-MM-DD HH:mm:ss');
};

const getErrMsg = (err: any): string =>
  err?.response?.data?.error?.message || err?.message || '操作失败';

export const AdminPage: React.FC = () => {
  const navigate = useNavigate();
  const { user, token, logout, fetchMe } = useAuthStore();

  const [activeTab, setActiveTab] = useState('overview');

  // Stats
  const [stats, setStats] = useState<StatsData | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Users
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [createUserSubmitting, setCreateUserSubmitting] = useState(false);
  const [createUserForm] = Form.useForm();
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<UserRecord | null>(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordForm] = Form.useForm();

  const [grantDrawerOpen, setGrantDrawerOpen] = useState(false);
  const [grantTarget, setGrantTarget] = useState<UserRecord | null>(null);
  const [grantRows, setGrantRows] = useState<AccessGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantUsername, setGrantUsername] = useState('');
  const [grantNote, setGrantNote] = useState('');
  const [grantSubmitting, setGrantSubmitting] = useState(false);

  // Logs
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsPage, setLogsPage] = useState(1);
  const [logsPageSize, setLogsPageSize] = useState(20);
  const [logsAction, setLogsAction] = useState('');
  const [logsStatus, setLogsStatus] = useState('');

  // Projects
  const [projects, setProjects] = useState<any[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Open platform API keys
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [createKeySubmitting, setCreateKeySubmitting] = useState(false);
  const [createKeyForm] = Form.useForm();

  // Auth: ensure user is loaded; redirect to login if no token
  useEffect(() => {
    if (!token) {
      navigate('/login');
      return;
    }
    if (!user) {
      fetchMe();
    }
  }, [token, user, fetchMe, navigate]);

  // Auth: non-admins are not allowed
  useEffect(() => {
    if (user && user.role !== 'admin') {
      message.error('无权限访问');
      navigate('/');
    }
  }, [user, navigate]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await authApi.getStats();
      setStats(res.data.data);
    } catch {
      // handled by interceptor
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const res = await authApi.getUsers();
      setUsers(res.data.data || []);
    } catch {
      // ignore
    } finally {
      setUsersLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await authApi.getLogs({
        page: logsPage,
        pageSize: logsPageSize,
        action: logsAction || undefined,
        status: logsStatus || undefined,
      });
      const data = res.data.data;
      setLogs(data?.logs || []);
      setLogsTotal(data?.total || 0);
    } catch {
      // ignore
    } finally {
      setLogsLoading(false);
    }
  }, [logsPage, logsPageSize, logsAction, logsStatus]);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const res = await projectApi.listAll();
      setProjects(res.data.data || []);
    } catch {
      // ignore
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const loadApiKeys = useCallback(async () => {
    setApiKeysLoading(true);
    try {
      const res = await openPlatformApi.listKeys();
      setApiKeys(res.data.data || []);
    } catch {
      // ignore
    } finally {
      setApiKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'overview' && user?.role === 'admin') loadStats();
  }, [activeTab, loadStats, user]);

  useEffect(() => {
    if (activeTab === 'users' && user?.role === 'admin') loadUsers();
  }, [activeTab, loadUsers, user]);

  useEffect(() => {
    if (activeTab === 'logs' && user?.role === 'admin') loadLogs();
  }, [activeTab, loadLogs, user]);

  useEffect(() => {
    if (activeTab === 'projects' && user?.role === 'admin') loadProjects();
  }, [activeTab, loadProjects, user]);

  useEffect(() => {
    if (activeTab === 'open-platform' && user?.role === 'admin') loadApiKeys();
  }, [activeTab, loadApiKeys, user]);

  const handleCreateApiKey = async () => {
    try {
      const values = await createKeyForm.validateFields();
      setCreateKeySubmitting(true);
      await openPlatformApi.createKey({
        name: values.name,
        scopes: values.scopes || [],
      });
      setCreateKeyOpen(false);
      createKeyForm.resetFields();
      message.success('密钥已创建');
      await loadApiKeys();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(getErrMsg(err));
    } finally {
      setCreateKeySubmitting(false);
    }
  };

  const handleCopyApiKey = async (apiKey: string) => {
    try {
      await navigator.clipboard.writeText(apiKey);
      message.success('已复制到剪贴板');
    } catch {
      message.error('复制失败，请手动选中复制');
    }
  };

  const handleToggleApiKey = async (record: any, enabled: boolean) => {
    try {
      await openPlatformApi.updateKey(record.id, { status: enabled ? 'active' : 'disabled' });
      message.success(enabled ? '已启用' : '已禁用');
      await loadApiKeys();
    } catch (err: any) {
      message.error(getErrMsg(err));
    }
  };

  const handleDeleteApiKey = async (id: string) => {
    try {
      await openPlatformApi.deleteKey(id);
      message.success('已删除');
      await loadApiKeys();
    } catch (err: any) {
      message.error(getErrMsg(err));
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // ===== User management handlers =====
  const handleCreateUser = async () => {
    try {
      const values = await createUserForm.validateFields();
      setCreateUserSubmitting(true);
      await authApi.createUser(values);
      message.success('用户创建成功');
      setCreateUserOpen(false);
      createUserForm.resetFields();
      loadUsers();
    } catch (err: any) {
      if (err?.errorFields) return; // form validation error
      message.error('创建失败：' + getErrMsg(err));
    } finally {
      setCreateUserSubmitting(false);
    }
  };

  const handleRoleChange = async (record: UserRecord, role: string) => {
    try {
      await authApi.updateUser(record.id, { role });
      message.success('角色已更新');
      setUsers((prev) => prev.map((u) => (u.id === record.id ? { ...u, role } : u)));
    } catch (err: any) {
      message.error('更新失败：' + getErrMsg(err));
      loadUsers();
    }
  };

  const handleStatusChange = async (record: UserRecord, checked: boolean) => {
    const status = checked ? 'active' : 'disabled';
    try {
      await authApi.updateUser(record.id, { status });
      message.success(checked ? '已启用' : '已禁用');
      setUsers((prev) => prev.map((u) => (u.id === record.id ? { ...u, status } : u)));
    } catch (err: any) {
      message.error('更新失败：' + getErrMsg(err));
      loadUsers();
    }
  };

  const openPasswordModal = (record: UserRecord) => {
    setPasswordTarget(record);
    passwordForm.resetFields();
    setPasswordModalOpen(true);
  };

  const handlePasswordSubmit = async () => {
    if (!passwordTarget) return;
    try {
      const values = await passwordForm.validateFields();
      setPasswordSubmitting(true);
      if (passwordTarget.id === user?.id) {
        await authApi.changePassword(values.oldPassword, values.newPassword);
        message.success('密码修改成功');
      } else {
        await authApi.resetPassword(passwordTarget.id, values.newPassword);
        message.success('密码重置成功');
      }
      setPasswordModalOpen(false);
      passwordForm.resetFields();
      setPasswordTarget(null);
    } catch (err: any) {
      if (err?.errorFields) return; // form validation error
      message.error('操作失败：' + getErrMsg(err));
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const openGrantDrawer = async (record: UserRecord) => {
    setGrantTarget(record);
    setGrantDrawerOpen(true);
    setGrantUsername('');
    setGrantNote('');
    setGrantsLoading(true);
    try {
      const res = await accessGrantApi.adminList({ grantorUserId: record.id, status: 'active' });
      setGrantRows(res.data.data || []);
    } catch (err: any) {
      message.error('加载授权失败：' + getErrMsg(err));
      setGrantRows([]);
    } finally {
      setGrantsLoading(false);
    }
  };

  const handleAdminCreateGrant = async () => {
    if (!grantTarget) return;
    const name = grantUsername.trim();
    if (!name) {
      message.warning('请输入被授权用户名');
      return;
    }
    setGrantSubmitting(true);
    try {
      await accessGrantApi.adminCreate(grantTarget.id, name, grantNote.trim() || undefined);
      message.success(`已代 ${grantTarget.username} 授权给 ${name}`);
      setGrantUsername('');
      setGrantNote('');
      const res = await accessGrantApi.adminList({ grantorUserId: grantTarget.id, status: 'active' });
      setGrantRows(res.data.data || []);
    } catch (err: any) {
      message.error(getErrMsg(err));
    } finally {
      setGrantSubmitting(false);
    }
  };

  const handleAdminRevokeGrant = async (id: string) => {
    try {
      await accessGrantApi.revoke(id);
      message.success('已撤销授权');
      if (grantTarget) {
        const res = await accessGrantApi.adminList({ grantorUserId: grantTarget.id, status: 'active' });
        setGrantRows(res.data.data || []);
      }
    } catch (err: any) {
      message.error(getErrMsg(err));
    }
  };

  const handleDeleteUser = async (id: string) => {
    try {
      await authApi.deleteUser(id);
      message.success('用户已删除');
      loadUsers();
    } catch (err: any) {
      message.error('删除失败：' + getErrMsg(err));
    }
  };

  // ===== Logs handlers =====
  const handleLogsSearch = (value: string) => {
    setLogsAction(value.trim());
    setLogsPage(1);
  };

  const handleLogsStatusChange = (value: string) => {
    setLogsStatus(value);
    setLogsPage(1);
  };

  // ===== Projects handlers =====
  const handleDeleteProject = async (id: string) => {
    try {
      await projectApi.delete(id);
      message.success('项目已删除');
      loadProjects();
    } catch (err: any) {
      message.error('删除失败：' + getErrMsg(err));
    }
  };

  const userColumns: TableColumnsType<UserRecord> = [
    { title: '用户名', dataIndex: 'username', key: 'username', width: 140 },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 100,
      render: (role: string) => (
        <Tag color={role === 'admin' ? 'purple' : 'blue'}>
          {role === 'admin' ? '管理员' : '普通用户'}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: string) => {
        const isActive = status === 'active';
        return (
          <Tag color={isActive ? 'green' : 'default'}>
            {isActive ? '正常' : '已禁用'}
          </Tag>
        );
      },
    },
    {
      title: '最后登录',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      width: 170,
      render: formatTime,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: formatTime,
    },
    {
      title: '操作',
      key: 'action',
      width: 420,
      render: (_: any, record: UserRecord) => {
        const isSelf = record.id === user?.id;
        const isAdmin = record.role === 'admin';
        return (
          <Space size="small" wrap>
            <Select
              size="small"
              value={record.role}
              options={ROLE_OPTIONS}
              onChange={(role) => handleRoleChange(record, role)}
              style={{ width: 110 }}
            />
            <Switch
              size="small"
              checked={record.status === 'active'}
              onChange={(checked) => handleStatusChange(record, checked)}
              disabled={isSelf}
            />
            <Button size="small" icon={<ShareAltOutlined />} onClick={() => void openGrantDrawer(record)}>
              授权
            </Button>
            <Button size="small" onClick={() => openPasswordModal(record)}>
              重置密码
            </Button>
            {isAdmin ? (
              <Button size="small" danger disabled>
                删除
              </Button>
            ) : (
              <Popconfirm
                title="确认删除该用户？"
                onConfirm={() => handleDeleteUser(record.id)}
              >
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  const logColumns: TableColumnsType<LogRecord> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: formatTime,
    },
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      width: 120,
      render: (v: string | null) => v || '-',
    },
    { title: '操作类型', dataIndex: 'action', key: 'action', width: 150 },
    {
      title: '详情',
      dataIndex: 'details',
      key: 'details',
      ellipsis: true,
      render: (v: string | null) => v || '-',
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      key: 'ip',
      width: 140,
      render: (v: string | null) => v || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: string) => (
        <Tag color={status === 'success' ? 'green' : 'red'}>
          {status === 'success' ? '成功' : '失败'}
        </Tag>
      ),
    },
  ];

  const tabItems = [
    {
      key: 'overview',
      label: '系统概览',
      children: (
        <Spin spinning={statsLoading}>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} md={8} lg={6}>
              <Card>
                <Statistic title="用户总数" value={stats?.userCount ?? 0} prefix={<UserOutlined />} />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <Card>
                <Statistic title="活跃用户数" value={stats?.activeUserCount ?? 0} prefix={<TeamOutlined />} valueStyle={{ color: '#52c41a' }} />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <Card>
                <Statistic title="项目总数" value={stats?.projectCount ?? 0} prefix={<FileTextOutlined />} />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <Card>
                <Statistic title="操作日志总数" value={stats?.logCount ?? 0} prefix={<CheckCircleOutlined />} />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={8} lg={6}>
              <Card>
                <Statistic title="今日操作数" value={stats?.todayLogCount ?? 0} prefix={<ClockCircleOutlined />} valueStyle={{ color: '#1890ff' }} />
              </Card>
            </Col>
          </Row>
        </Spin>
      ),
    },
    {
      key: 'users',
      label: '用户管理',
      children: (
        <Card>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text type="secondary">共 {users.length} 个用户</Text>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { createUserForm.resetFields(); setCreateUserOpen(true); }}>
              创建用户
            </Button>
          </div>
          <Table
            dataSource={users}
            columns={userColumns}
            rowKey="id"
            loading={usersLoading}
            pagination={false}
            size="middle"
            scroll={{ x: 1000 }}
          />
        </Card>
      ),
    },
    {
      key: 'logs',
      label: '操作日志',
      children: (
        <Card>
          <Space style={{ marginBottom: 16 }}>
            <Search
              placeholder="搜索操作类型"
              onSearch={handleLogsSearch}
              allowClear
              style={{ width: 250 }}
            />
            <Select
              value={logsStatus}
              onChange={handleLogsStatusChange}
              style={{ width: 120 }}
              options={LOG_STATUS_OPTIONS}
            />
          </Space>
          <Table
            dataSource={logs}
            columns={logColumns}
            rowKey="id"
            loading={logsLoading}
            size="middle"
            scroll={{ x: 900 }}
            pagination={{
              current: logsPage,
              pageSize: logsPageSize,
              total: logsTotal,
              showSizeChanger: true,
              showQuickJumper: true,
              showTotal: (total) => `共 ${total} 条`,
              onChange: (page, pageSize) => {
                setLogsPage(page);
                setLogsPageSize(pageSize);
              },
            }}
          />
        </Card>
      ),
    },
    {
      key: 'projects',
      label: '项目管理',
      children: (
        <Card>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text type="secondary">查看和删除所有用户的项目</Text>
            <Button onClick={loadProjects} loading={projectsLoading}>刷新</Button>
          </div>
          <Table
            dataSource={projects}
            rowKey="id"
            loading={projectsLoading}
            size="middle"
            scroll={{ x: 900 }}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 个项目` }}
            columns={[
              { title: '项目名称', dataIndex: 'name', key: 'name', ellipsis: true },
              { title: '所属用户', dataIndex: 'owner_username', key: 'owner_username', width: 120, render: (v: string) => v || '-' },
              {
                title: '解析状态',
                dataIndex: 'parse_status',
                key: 'parse_status',
                width: 100,
                render: (s: string) => {
                  const map: Record<string, { text: string; color: string }> = {
                    pending: { text: '待解析', color: 'default' },
                    parsing: { text: '解析中', color: 'processing' },
                    success: { text: '成功', color: 'green' },
                    partial: { text: '部分成功', color: 'orange' },
                    failed: { text: '失败', color: 'red' },
                  };
                  const info = map[s] || { text: s || '未知', color: 'default' };
                  return <Tag color={info.color}>{info.text}</Tag>;
                },
              },
              {
                title: '视频状态',
                dataIndex: 'video_status',
                key: 'video_status',
                width: 100,
                render: (s: string) => {
                  const map: Record<string, { text: string; color: string }> = {
                    none: { text: '未生成', color: 'default' },
                    processing: { text: '生成中', color: 'processing' },
                    success: { text: '已生成', color: 'green' },
                    failed: { text: '失败', color: 'red' },
                  };
                  const info = map[s] || { text: s || '未知', color: 'default' };
                  return <Tag color={info.color}>{info.text}</Tag>;
                },
              },
              {
                title: '更新时间',
                dataIndex: 'updated_at',
                key: 'updated_at',
                width: 170,
                render: (t: string) => formatTime(t),
              },
              {
                title: '创建时间',
                dataIndex: 'created_at',
                key: 'created_at',
                width: 170,
                render: (t: string) => formatTime(t),
              },
              {
                title: '操作',
                key: 'action',
                width: 80,
                render: (_: any, record: any) => (
                  <Popconfirm
                    title="确认删除该项目？"
                    description="将删除该项目及其所有文件。"
                    onConfirm={() => handleDeleteProject(record.id)}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                  >
                    <Button type="text" danger icon={<DeleteOutlined />} size="small" />
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      ),
    },
    {
      key: 'open-platform',
      label: '开放平台',
      children: (
        <Card
          title="API Key 管理"
          extra={
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                createKeyForm.resetFields();
                createKeyForm.setFieldsValue({ scopes: ['tts', 'avatar'] });
                setCreateKeyOpen(true);
              }}
            >
              创建密钥
            </Button>
          }
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            外部系统通过 <Text code>Authorization: Bearer sk_...</Text> 调用{' '}
            <Text code>/api/open/v1/tts</Text>、<Text code>/api/open/v1/avatar</Text>
            （含 Duix 生成与绿幕叠底 <Text code>/compose</Text>）。密钥可随时查看与复制。详见{' '}
            <Text code>docs/open-platform.md</Text>。
          </Text>
          <Table
            rowKey="id"
            loading={apiKeysLoading}
            dataSource={apiKeys}
            pagination={false}
            scroll={{ x: 1100 }}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                key: 'name',
                width: 140,
              },
              {
                title: 'API Key',
                dataIndex: 'apiKey',
                key: 'apiKey',
                width: 360,
                render: (key: string | null) =>
                  key ? (
                    <Space size={4}>
                      <Text code copyable={false} style={{ wordBreak: 'break-all' }}>{key}</Text>
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={() => handleCopyApiKey(key)}
                      />
                    </Space>
                  ) : (
                    <Text type="secondary">（旧密钥无明文，请删除后重建）</Text>
                  ),
              },
              {
                title: '权限',
                dataIndex: 'scopes',
                key: 'scopes',
                width: 160,
                render: (scopes: string[]) => (
                  <Space size={4}>
                    {(scopes || []).map((s) => (
                      <Tag key={s} color={s === 'tts' ? 'blue' : 'purple'}>{s}</Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: '状态',
                dataIndex: 'status',
                key: 'status',
                width: 100,
                render: (status: string, record: any) => (
                  <Switch
                    checked={status === 'active'}
                    checkedChildren="启用"
                    unCheckedChildren="禁用"
                    onChange={(checked) => handleToggleApiKey(record, checked)}
                  />
                ),
              },
              {
                title: '最近使用',
                dataIndex: 'lastUsedAt',
                key: 'lastUsedAt',
                width: 170,
                render: (t: string | null) => formatTime(t),
              },
              {
                title: '创建时间',
                dataIndex: 'createdAt',
                key: 'createdAt',
                width: 170,
                render: (t: string) => formatTime(t),
              },
              {
                title: '操作',
                key: 'action',
                width: 80,
                fixed: 'right',
                render: (_: any, record: any) => (
                  <Popconfirm
                    title="确认删除该密钥？"
                    description="删除后使用此 Key 的外部调用将立即失效。"
                    onConfirm={() => handleDeleteApiKey(record.id)}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                  >
                    <Button type="text" danger icon={<DeleteOutlined />} size="small" />
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      ),
    },
  ];

  if (!user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  const isSelfPassword = passwordTarget?.id === user?.id;

  return (
    <div style={{ minHeight: '100vh', background: '#f0f2f5' }}>
      <div
        style={{
          background: '#fff',
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        }}
      >
        <div>
          <Title level={4} style={{ margin: 0 }}>系统后台管理</Title>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Text type="secondary">当前用户：{user?.username} ({user?.role})</Text>
          <Button icon={<HomeOutlined />} onClick={() => navigate('/')}>返回首页</Button>
          <Button danger icon={<LogoutOutlined />} onClick={handleLogout}>退出登录</Button>
        </div>
      </div>
      <div style={{ padding: 24 }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      </div>

      <Modal
        title="创建用户"
        open={createUserOpen}
        onOk={handleCreateUser}
        onCancel={() => { setCreateUserOpen(false); createUserForm.resetFields(); }}
        confirmLoading={createUserSubmitting}
        okText="创建"
        cancelText="取消"
      >
        <Form form={createUserForm} layout="vertical" style={{ marginTop: 16 }} initialValues={{ role: 'user' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="请输入用户名" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 6, message: '密码至少 6 位' },
            ]}
          >
            <Input.Password placeholder="至少 6 位" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={isSelfPassword ? '修改密码' : `重置 ${passwordTarget?.username ?? ''} 的密码`}
        open={passwordModalOpen}
        onOk={handlePasswordSubmit}
        onCancel={() => { setPasswordModalOpen(false); passwordForm.resetFields(); setPasswordTarget(null); }}
        confirmLoading={passwordSubmitting}
        okText={isSelfPassword ? '修改' : '重置'}
        cancelText="取消"
      >
        <Form form={passwordForm} layout="vertical" style={{ marginTop: 16 }}>
          {isSelfPassword && (
            <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true, message: '请输入旧密码' }]}>
              <Input.Password autoComplete="current-password" />
            </Form.Item>
          )}
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '密码至少 6 位' },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          {isSelfPassword && (
            <Form.Item
              name="confirmPassword"
              label="确认新密码"
              rules={[
                { required: true, message: '请确认新密码' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('newPassword') === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('两次输入的密码不一致'));
                  },
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title="创建开放平台密钥"
        open={createKeyOpen}
        onOk={handleCreateApiKey}
        onCancel={() => { setCreateKeyOpen(false); createKeyForm.resetFields(); }}
        confirmLoading={createKeySubmitting}
        okText="创建"
        cancelText="取消"
      >
        <Form
          form={createKeyForm}
          layout="vertical"
          style={{ marginTop: 16 }}
          initialValues={{ scopes: ['tts', 'avatar'] }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：外部系统 A" prefix={<KeyOutlined />} />
          </Form.Item>
          <Form.Item
            name="scopes"
            label="权限范围"
            rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个权限' }]}
          >
            <Checkbox.Group
              options={[
                { label: 'TTS（Voicebox）', value: 'tts' },
                { label: 'Avatar（Duix）', value: 'avatar' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={grantTarget ? `数据授权 · ${grantTarget.username}` : '数据授权'}
        open={grantDrawerOpen}
        onClose={() => { setGrantDrawerOpen(false); setGrantTarget(null); setGrantRows([]); }}
        width={480}
      >
        <Text type="secondary">
          代该用户授权他人查看并操作其全部已有任务与项目；对方不能以该用户身份新建资源。
        </Text>
        <Space wrap style={{ margin: '16px 0', width: '100%' }}>
          <Input
            placeholder="被授权用户名"
            value={grantUsername}
            onChange={(e) => setGrantUsername(e.target.value)}
            style={{ width: 160 }}
            onPressEnter={() => void handleAdminCreateGrant()}
          />
          <Input
            placeholder="备注（可选）"
            value={grantNote}
            onChange={(e) => setGrantNote(e.target.value)}
            style={{ width: 180 }}
          />
          <Button type="primary" loading={grantSubmitting} onClick={() => void handleAdminCreateGrant()}>
            代为授权
          </Button>
        </Space>
        <Spin spinning={grantsLoading}>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={grantRows}
            locale={{ emptyText: '暂无有效授权' }}
            columns={[
              { title: '被授权人', dataIndex: 'granteeUsername', key: 'grantee' },
              { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '-' },
              {
                title: '时间',
                dataIndex: 'createdAt',
                key: 'createdAt',
                render: (v: string) => formatTime(v),
              },
              {
                title: '操作',
                key: 'action',
                render: (_: any, row: AccessGrant) => (
                  <Popconfirm title="确认撤销？" onConfirm={() => void handleAdminRevokeGrant(row.id)}>
                    <Button size="small" danger>撤销</Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Spin>
      </Drawer>

    </div>
  );
};

export default AdminPage;
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Tabs, Table, Button, Card, Row, Col, Statistic, Spin, Tag, Space,
  Typography, Modal, Form, Input, Select, Switch, Popconfirm, message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  PlusOutlined, LogoutOutlined, HomeOutlined, UserOutlined,
  TeamOutlined, FileTextOutlined, CheckCircleOutlined, ClockCircleOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { authApi, projectApi } from '../../api';
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
      width: 360,
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
    </div>
  );
};

export default AdminPage;
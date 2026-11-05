import React, { useCallback, useEffect, useState } from 'react';
import { Button, Drawer, Empty, Progress, Space, Tag, Typography, message } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ClockCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { jobsApi, type JobsSummary, type UnifiedJob, type UnifiedJobStatus } from '../../api';

const KIND_LABEL: Record<string, string> = {
  tts_dubbing: '配音',
  transcribe: '转写',
  dialogue: '对话',
  avatar: '数字人',
  compose: '绿幕叠底',
  project_avatar: '项目数字人',
  video_compose: '视频合成',
  mooc: '慕课',
  hyperframe: 'HyperFrame',
  explain: '讲解动画',
  explain_export: '讲解导出',
};

const STATUS_META: Record<
  UnifiedJobStatus,
  { color: string; label: string; icon: React.ReactNode }
> = {
  queued: { color: 'gold', label: '排队中', icon: <ClockCircleOutlined /> },
  running: { color: 'processing', label: '进行中', icon: <LoadingOutlined /> },
  completed: { color: 'success', label: '已完成', icon: <CheckCircleOutlined /> },
  failed: { color: 'error', label: '失败', icon: <CloseCircleOutlined /> },
  cancelled: { color: 'default', label: '已取消', icon: <StopOutlined /> },
};

function statusHint(job: UnifiedJob): string {
  if (job.status === 'queued' && job.queuePosition != null) {
    if (job.queuePosition <= 1) return '排队中 · 即将开始';
    return `排队中 · 前面还有 ${job.queuePosition - 1} 个`;
  }
  if (job.message) return job.message;
  return STATUS_META[job.status]?.label || job.status;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function formatClock(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDuration(ms?: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function timingLine(job: UnifiedJob): string | null {
  const active = job.status === 'queued' || job.status === 'running';
  const start = formatClock(job.startedAt || job.createdAt);
  const end = formatClock(job.finishedAt);
  const dur = formatDuration(job.durationMs);
  const parts: string[] = [];
  if (active) {
    if (job.status === 'queued' && start) parts.push(`入队 ${start}`);
    if (job.status === 'running' && start) parts.push(`开始 ${start}`);
    if (job.status === 'running' && dur) parts.push(`已用时 ${dur}`);
  } else {
    if (start && end) parts.push(`${start} → ${end}`);
    else if (start) parts.push(`开始 ${start}`);
    else if (end) parts.push(`完成 ${end}`);
    if (dur) parts.push(`耗时 ${dur}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export const TaskCenterDrawer: React.FC<Props> = ({ open, onClose }) => {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<UnifiedJob[]>([]);
  const [summary, setSummary] = useState<JobsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [listRes, sumRes] = await Promise.all([
        jobsApi.list(),
        jobsApi.summary(),
      ]);
      if (listRes.data?.success) setJobs(listRes.data.data?.jobs || []);
      if (sumRes.data?.success) setSummary(sumRes.data.data || null);
    } catch {
      /* ignore poll errors */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    refresh().finally(() => setLoading(false));
    const t = window.setInterval(refresh, 3000);
    return () => window.clearInterval(t);
  }, [open, refresh]);

  const onCancel = async (job: UnifiedJob) => {
    setCancelling(job.id);
    try {
      const res = await jobsApi.cancel(job.id, job.kind);
      if (!res.data?.success) {
        message.error(res.data?.error?.message || '取消失败');
      } else {
        message.success('已请求取消');
        await refresh();
      }
    } catch (e: any) {
      message.error(e?.message || '取消失败');
    } finally {
      setCancelling(null);
    }
  };

  const gpuLine = summary
    ? [
        summary.gpu.duixBusy ? 'Duix 占用中' : null,
        summary.gpu.voicebox.active
          ? `Voicebox: ${summary.gpu.voicebox.active}`
          : summary.gpu.voicebox.waitingCount > 0
            ? `Voicebox 排队 ${summary.gpu.voicebox.waitingCount}`
            : 'GPU 空闲',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <Drawer
      title="任务中心"
      placement="right"
      width={420}
      open={open}
      onClose={onClose}
      extra={
        summary ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            进行中 {summary.activeCount} · 排队 {summary.queuedCount}
          </Typography.Text>
        ) : null
      }
    >
      {gpuLine && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
          {gpuLine}
        </Typography.Paragraph>
      )}

      {!loading && jobs.length === 0 && (
        <Empty description="暂无任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {jobs.map((job) => {
          const meta = STATUS_META[job.status] || STATUS_META.failed;
          const active = job.status === 'queued' || job.status === 'running';
          const timing = timingLine(job);
          return (
            <div
              key={`${job.kind}:${job.id}`}
              style={{
                border: '1px solid #f0f0f0',
                borderRadius: 8,
                padding: '10px 12px',
                background: active ? '#fafafa' : '#fff',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Space size={6} wrap>
                    <Tag>{KIND_LABEL[job.kind] || job.kind}</Tag>
                    <Tag color={meta.color} icon={meta.icon}>
                      {meta.label}
                    </Tag>
                  </Space>
                  <div style={{ fontWeight: 500, marginTop: 4 }}>{job.title}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                    {statusHint(job)}
                  </Typography.Text>
                  {timing && (
                    <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
                      {timing}
                    </Typography.Text>
                  )}
                </div>
              </div>
              {active && (
                <Progress
                  percent={Math.min(100, Math.max(0, Number(job.progress) || 0))}
                  size="small"
                  status={job.status === 'queued' ? 'normal' : 'active'}
                  style={{ marginTop: 8, marginBottom: 0 }}
                />
              )}
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                {job.href && (
                  <Button
                    size="small"
                    type="link"
                    style={{ padding: 0 }}
                    onClick={() => {
                      onClose();
                      navigate(job.href!);
                    }}
                  >
                    打开
                  </Button>
                )}
                {job.cancellable && active && (
                  <Button
                    size="small"
                    type="link"
                    danger
                    style={{ padding: 0 }}
                    loading={cancelling === job.id}
                    onClick={() => onCancel(job)}
                  >
                    取消
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </Space>
    </Drawer>
  );
};

/** Badge count helper for top bar */
export function useJobsBadge(pollMs = 4000): { count: number; refresh: () => void } {
  const [count, setCount] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const res = await jobsApi.summary();
      if (res.data?.success && res.data.data) {
        setCount(res.data.data.activeCount || 0);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(t);
  }, [refresh, pollMs]);

  return { count, refresh };
}

export default TaskCenterDrawer;

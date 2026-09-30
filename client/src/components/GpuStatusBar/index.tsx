import React, { useEffect, useRef, useState } from 'react';
import { Tooltip } from 'antd';
import {
  systemApi,
  type GpuDeviceStatus,
  type GpuStatusSnapshot,
  type ServiceStatusItem,
  type ServiceStatusSnapshot,
} from '../../api';

function fmtMem(used: number | null, total: number | null) {
  if (used == null || total == null) return '-';
  const u = used >= 1024 ? `${(used / 1024).toFixed(1)}G` : `${Math.round(used)}M`;
  const t = total >= 1024 ? `${(total / 1024).toFixed(0)}G` : `${Math.round(total)}M`;
  return `${u}/${t}`;
}

function utilColor(u: number | null) {
  if (u == null) return '#8c8c8c';
  if (u >= 85) return '#cf1322';
  if (u >= 50) return '#d48806';
  return '#389e0d';
}

function memRatio(g: GpuDeviceStatus) {
  if (g.memoryUsedMb == null || g.memoryTotalMb == null || g.memoryTotalMb <= 0) return 0;
  return Math.min(100, (g.memoryUsedMb / g.memoryTotalMb) * 100);
}

function serviceDotColor(s: ServiceStatusItem) {
  if (s.state === 'running') {
    if (s.healthy === false) return '#d48806';
    return '#52c41a';
  }
  if (s.state === 'stopped') return '#8c8c8c';
  if (s.state === 'missing') return '#ff4d4f';
  return '#faad14';
}

function serviceStateText(s: ServiceStatusItem) {
  if (s.state === 'running') {
    if (s.healthy === false) return '异常';
    return s.kind === 'image' ? '就绪' : '运行';
  }
  if (s.state === 'stopped') return '停止';
  if (s.state === 'missing') return '缺失';
  return '未知';
}

const chipBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 10px',
  borderRadius: 8,
  background: 'rgba(0,0,0,0.72)',
  color: '#fff',
  fontSize: 12,
  lineHeight: 1.2,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
  cursor: 'default',
  whiteSpace: 'nowrap',
};

const GpuChip: React.FC<{ gpu: GpuDeviceStatus }> = ({ gpu }) => {
  const util = gpu.utilizationGpu;
  const tip = [
    gpu.name,
    `利用率 ${util != null ? `${Math.round(util)}%` : '-'}`,
    `显存 ${fmtMem(gpu.memoryUsedMb, gpu.memoryTotalMb)}`,
    `温度 ${gpu.temperatureC != null ? `${Math.round(gpu.temperatureC)}°C` : '-'}`,
    gpu.powerDrawW != null
      ? `功耗 ${Math.round(gpu.powerDrawW)}${gpu.powerLimitW != null ? `/${Math.round(gpu.powerLimitW)}` : ''}W`
      : null,
  ].filter(Boolean).join('\n');

  return (
    <Tooltip title={<pre style={{ margin: 0, fontSize: 12 }}>{tip}</pre>}>
      <div style={chipBase}>
        <span style={{ opacity: 0.75 }}>GPU{gpu.index}</span>
        <span style={{ color: utilColor(util), fontWeight: 700 }}>
          {util != null ? `${Math.round(util)}%` : '--'}
        </span>
        <span style={{ opacity: 0.9 }}>{fmtMem(gpu.memoryUsedMb, gpu.memoryTotalMb)}</span>
        {gpu.temperatureC != null && (
          <span style={{ opacity: 0.85 }}>{Math.round(gpu.temperatureC)}°</span>
        )}
        <span style={{
          width: 36,
          height: 4,
          borderRadius: 2,
          background: 'rgba(255,255,255,0.18)',
          overflow: 'hidden',
          display: 'inline-block',
        }}
        >
          <span style={{
            display: 'block',
            height: '100%',
            width: `${memRatio(gpu)}%`,
            background: utilColor(util),
          }}
          />
        </span>
      </div>
    </Tooltip>
  );
};

const ServiceChip: React.FC<{ item: ServiceStatusItem }> = ({ item }) => {
  const tip = [
    `${item.label} (${item.target})`,
    `状态: ${serviceStateText(item)}`,
    item.detail ? `详情: ${item.detail}` : null,
    item.healthy != null ? `健康检查: ${item.healthy ? '通过' : '失败'}` : null,
    item.note,
  ].filter(Boolean).join('\n');

  return (
    <Tooltip title={<pre style={{ margin: 0, fontSize: 12 }}>{tip}</pre>}>
      <div style={{ ...chipBase, gap: 6, padding: '3px 8px' }}>
        <span style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: serviceDotColor(item),
          boxShadow: item.state === 'running' ? `0 0 6px ${serviceDotColor(item)}` : 'none',
          flexShrink: 0,
        }}
        />
        <span style={{ opacity: 0.85 }}>{item.label}</span>
        <span style={{ color: serviceDotColor(item), fontWeight: 600 }}>
          {serviceStateText(item)}
        </span>
      </div>
    </Tooltip>
  );
};

/**
 * Fixed bottom-right status strip: GPU + Voicebox/Duix/… on one row.
 * Keep clear of top-right page actions (退出登录 / 返回首页).
 */
const GpuStatusBar: React.FC = () => {
  const [snap, setSnap] = useState<GpuStatusSnapshot | null>(null);
  const [services, setServices] = useState<ServiceStatusSnapshot | null>(null);
  const gpuTimer = useRef<number | null>(null);
  const svcTimer = useRef<number | null>(null);
  const gpuInFlight = useRef(false);
  const svcInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const tickGpu = async () => {
      if (gpuInFlight.current) return;
      gpuInFlight.current = true;
      try {
        const res = await systemApi.getGpu();
        if (!cancelled) setSnap(res.data.data);
      } catch {
        if (!cancelled) {
          setSnap({
            available: false,
            gpus: [],
            error: '查询失败',
            queriedAt: new Date().toISOString(),
          });
        }
      } finally {
        gpuInFlight.current = false;
      }
    };

    const tickServices = async () => {
      if (svcInFlight.current) return;
      svcInFlight.current = true;
      try {
        const res = await systemApi.getServices();
        if (!cancelled) setServices(res.data.data);
      } catch {
        if (!cancelled) {
          setServices({
            services: [],
            queriedAt: new Date().toISOString(),
          });
        }
      } finally {
        svcInFlight.current = false;
      }
    };

    void tickGpu();
    void tickServices();
    gpuTimer.current = window.setInterval(() => { void tickGpu(); }, 1000);
    svcTimer.current = window.setInterval(() => { void tickServices(); }, 5000);
    return () => {
      cancelled = true;
      if (gpuTimer.current) window.clearInterval(gpuTimer.current);
      if (svcTimer.current) window.clearInterval(svcTimer.current);
    };
  }, []);

  const primaryServices = (services?.services || []).filter((s) => (
    s.id === 'voicebox' || s.id === 'duix' || s.id === 'ollama' || s.id === 'hyperframes'
  ));
  // OpenTalking 仅在运行时显示，避免常驻一条停止项
  const extra = (services?.services || []).filter((s) => s.id === 'opentalking' && s.state === 'running');

  return (
    <div style={{
      position: 'fixed',
      bottom: 12,
      right: 16,
      zIndex: 1200,
      display: 'flex',
      flexWrap: 'nowrap',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 6,
      pointerEvents: 'auto',
      maxWidth: 'min(96vw, 980px)',
      overflowX: 'auto',
    }}
    >
      {!services && (
        <div style={{ ...chipBase, opacity: 0.7 }}>服务 …</div>
      )}
      {primaryServices.map((s) => (
        <ServiceChip key={s.id} item={s} />
      ))}
      {extra.map((s) => (
        <ServiceChip key={s.id} item={s} />
      ))}

      {!snap && (
        <div style={{
          padding: '4px 10px',
          borderRadius: 8,
          background: 'rgba(0,0,0,0.55)',
          color: '#fff',
          fontSize: 12,
          whiteSpace: 'nowrap',
        }}
        >
          GPU …
        </div>
      )}
      {snap && !snap.available && (
        <Tooltip title={snap.error || 'GPU 不可用'}>
          <div style={{
            padding: '4px 10px',
            borderRadius: 8,
            background: 'rgba(0,0,0,0.55)',
            color: '#ffa39e',
            fontSize: 12,
            whiteSpace: 'nowrap',
          }}
          >
            GPU 不可用
          </div>
        </Tooltip>
      )}
      {snap?.available && snap.gpus.map((g) => (
        <GpuChip key={g.index} gpu={g} />
      ))}
    </div>
  );
};

export default GpuStatusBar;

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Checkbox, Col, Divider, Drawer, Form, InputNumber, Modal, Progress, Radio, Row,
  Select, Slider, Space, Spin, Steps, Switch, Table, Tag, Tooltip, Typography, Upload, message,
} from 'antd';
import {
  CloudUploadOutlined, DeleteOutlined, DownloadOutlined, ExclamationCircleOutlined, ExpandOutlined,
  EyeOutlined, PlayCircleOutlined, PlusOutlined, ThunderboltOutlined, UserOutlined,
  ProfileOutlined, ReloadOutlined, RocketOutlined, StopOutlined,
} from '@ant-design/icons';
import { explainApi, moocApi, projectApi, videoApi, voiceboxApi } from '../../api';
import AvatarPipEditor from '../../components/AvatarPipEditor';
import { ModelSelectField, VoiceSelectField } from '../../components/voicebox';
import { AvatarRefLibraryPanel, useAvatarRefs } from '../../components/avatar';
import { DEFAULT_AVATAR_LAYOUT } from '../../constants/avatarDefaults';
import { countPptxSlides } from '../../utils/pptxSlideCount';
import { isTtsModel } from '../../utils/voiceboxModels';
import type { AvatarLayout } from '../../types';
import { estimateQueuePosition, formatQueueHint } from '../../utils/queueHint';

const { Title, Text, Paragraph } = Typography;

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  creating: '创建项目',
  parsing: '解析 PPT',
  script: '生成解说词',
  dubbing: '生成配音',
  avatar: '生成数字人',
  explain_points: '分析知识点',
  explain_gen: '生成讲解动画',
  explain: '修复讲解插片',
  compose: '合成视频',
  done: '已完成',
  failed: '失败',
};

const STATUS_COLOR: Record<string, string> = {
  queued: 'default',
  running: 'processing',
  success: 'success',
  failed: 'error',
  cancelled: 'warning',
};

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};

function truncateText(s: string, max = 28) {
  if (!s) return '-';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

type SubmitMode = 'single' | 'batch';

function buildMoocFormData(
  pptFile: File,
  values: Record<string, any>,
  opts: {
    photo: File | null;
    avatarPages: number[];
    layout: AvatarLayout;
    avatarFirstPageOnly?: boolean;
  },
): FormData {
  const fd = new FormData();
  fd.append('file', pptFile);
  fd.append('target_duration', String(values.targetDuration ?? 0));
  fd.append('use_existing_note', values.useExistingNote ? '1' : '0');
  fd.append('selected_voice_id', values.selectedVoiceId);
  fd.append('selected_model_id', values.selectedModelId);
  fd.append('enable_avatar', values.enableAvatar ? '1' : '0');
  fd.append('avatar_drive_mode', values.avatarDriveMode || 'video');
  if (values.avatarRefVideoId) fd.append('avatar_ref_video_id', values.avatarRefVideoId);
  if (opts.photo) fd.append('photo', opts.photo);
  if (values.enableAvatar) {
    if (opts.avatarFirstPageOnly) {
      fd.append('avatar_first_page_only', '1');
      fd.append('avatar_page_indexes', JSON.stringify([1]));
    } else {
      fd.append('avatar_page_indexes', JSON.stringify(opts.avatarPages));
    }
    fd.append('avatar_layout', JSON.stringify(opts.layout));
  }
  fd.append('allow_silent_pages', values.allowSilentPages ? '1' : '0');
  fd.append('default_silent_page_duration', String(values.defaultSilentPageDuration ?? 5));
  const pauseSec = values.pauseEnabled === false ? 0 : Number(values.pauseDuration ?? 2);
  fd.append('pause_duration', String(Number.isFinite(pauseSec) ? pauseSec : 2));
  const maxRetries = Number(values.maxRetries);
  fd.append('max_retries', String(Number.isFinite(maxRetries) ? Math.max(0, Math.min(20, Math.round(maxRetries))) : 5));
  fd.append('enable_explain_insert', values.enableExplainInsert ? '1' : '0');
  if (values.enableExplainInsert) {
    fd.append('explain_export_quality', String(values.explainExportQuality || '1080p'));
  }
  if (values.enableAvatar) {
    const chroma = Number(values.chromaSimilarity);
    fd.append(
      'chroma_similarity',
      String(Number.isFinite(chroma) ? Math.min(0.6, Math.max(0.05, chroma)) : 0.28),
    );
  }
  return fd;
}

const MoocPage: React.FC = () => {
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [submitMode, setSubmitMode] = useState<SubmitMode>('single');
  const [photo, setPhoto] = useState<File | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const [avatarPages, setAvatarPages] = useState<number[]>([]);
  const [layout, setLayout] = useState<AvatarLayout>(DEFAULT_AVATAR_LAYOUT);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [layoutPage, setLayoutPage] = useState(1);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [voices, setVoices] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const { refs, loadRefs } = useAvatarRefs({ autoLoad: false });
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<any[]>([]);
  const [queueInfo, setQueueInfo] = useState<{ hasRunning?: boolean; queuedCount?: number }>({});
  const [errorModal, setErrorModal] = useState<{ open: boolean; title: string; content: string }>({
    open: false, title: '', content: '',
  });
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailJob, setDetailJob] = useState<any | null>(null);
  const detailIdRef = useRef<string | null>(null);
  const [explainPreview, setExplainPreview] = useState<{
    open: boolean;
    id: string;
    title: string;
    kind: 'final' | 'sample';
    fullscreen?: boolean;
  } | null>(null);
  const [stageMediaPreview, setStageMediaPreview] = useState<{
    open: boolean;
    kind: 'dubbing' | 'avatar';
    projectId: string;
    moocJobId?: string | null;
    loading?: boolean;
    pages: Array<{ pageIndex: number; duration?: number | null }>;
    pageIndex: number;
    avatarView?: 'raw' | 'compose';
    chromaSimilarity?: number;
    composeUrl?: string | null;
    composing?: boolean;
  } | null>(null);
  const pollRef = useRef<number | null>(null);
  const previewReqRef = useRef(0);

  const [form] = Form.useForm();
  const enableAvatar = Form.useWatch('enableAvatar', form);
  const enableExplainInsert = Form.useWatch('enableExplainInsert', form);
  const driveMode = Form.useWatch('avatarDriveMode', form);
  const selectedAvatarRefId = Form.useWatch('avatarRefVideoId', form);

  const activePreviewFile = submitMode === 'batch' ? (batchFiles[0] || null) : file;
  const isBatchMode = submitMode === 'batch';
  const avatarFirstPageOnly = isBatchMode && enableAvatar;

  const pageOptions = useMemo(
    () => Array.from({ length: slideCount }, (_, i) => i + 1),
    [slideCount],
  );

  const layoutImageUrl = previewId
    ? moocApi.getPreviewPageUrl(previewId, avatarFirstPageOnly ? 1 : layoutPage)
    : '';

  const resetPreview = () => {
    setPreviewId(null);
    setLayoutPage(1);
    setPreviewError(null);
    setPreviewLoading(false);
  };

  const loadSlidePreview = useCallback(async (f: File) => {
    const reqId = ++previewReqRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await moocApi.previewSlides(f);
      if (reqId !== previewReqRef.current) return;
      const data = res.data.data;
      setPreviewId(data.previewId);
      setSlideCount(data.pageCount);
      setLayoutPage(1);
      const pages = data.pages?.length
        ? data.pages
        : Array.from({ length: data.pageCount }, (_, i) => i + 1);
      setAvatarPages(pages);
      message.success(`已渲染 ${data.pageCount} 页真实幻灯片，可选择一页调整布局`);
    } catch (err: any) {
      if (reqId !== previewReqRef.current) return;
      setPreviewId(null);
      setPreviewError(err.response?.data?.error?.message || err.message || '幻灯片预览失败');
    } finally {
      if (reqId === previewReqRef.current) setPreviewLoading(false);
    }
  }, []);

  const handlePickFile = async (f: File) => {
    if (!f.name.toLowerCase().endsWith('.pptx')) {
      message.error('仅支持 PPTX');
      return;
    }
    setFile(f);
    setBatchFiles([]);
    resetPreview();
    try {
      const n = await countPptxSlides(f);
      setSlideCount(n);
      const pages = Array.from({ length: n }, (_, i) => i + 1);
      setAvatarPages(pages);
      if (!n) message.warning('未能识别页数，开启数字人后将尝试服务端渲染');
    } catch {
      setSlideCount(0);
      setAvatarPages([]);
    }
    if (form.getFieldValue('enableAvatar')) {
      void loadSlidePreview(f);
    }
  };

  const handlePickBatchFiles = async (incoming: File[]) => {
    const valid = incoming.filter((f) => f.name.toLowerCase().endsWith('.pptx'));
    if (!valid.length) {
      message.error('仅支持 PPTX');
      return;
    }
    setFile(null);
    setBatchFiles(valid);
    resetPreview();
    setSlideCount(0);
    setAvatarPages([1]);
    setLayoutPage(1);
    if (form.getFieldValue('enableAvatar') && valid[0]) {
      void loadSlidePreview(valid[0]);
    }
  };

  const handleSubmitModeChange = (mode: SubmitMode) => {
    setSubmitMode(mode);
    resetPreview();
    if (mode === 'batch') {
      setFile(null);
      setSlideCount(0);
      if (form.getFieldValue('enableAvatar')) {
        setAvatarPages([1]);
        setLayoutPage(1);
        if (batchFiles[0]) void loadSlidePreview(batchFiles[0]);
      }
    } else {
      setBatchFiles([]);
    }
  };

  // 开启数字人且已有文件时，自动渲染真实幻灯片（失败后需手动重试，避免死循环）
  useEffect(() => {
    if (!enableAvatar || !activePreviewFile) return;
    if (previewId || previewLoading || previewError) return;
    void loadSlidePreview(activePreviewFile);
  }, [enableAvatar, activePreviewFile, previewId, previewLoading, previewError, loadSlidePreview]);

  useEffect(() => {
    if (avatarFirstPageOnly) {
      setAvatarPages([1]);
      setLayoutPage(1);
    }
  }, [avatarFirstPageOnly]);

  const loadJobDetail = useCallback(async (id: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setDetailLoading(true);
    try {
      const res = await moocApi.getJob(id);
      const data = res.data.data;
      if (detailIdRef.current === id) setDetailJob(data);
      return data;
    } catch (e: any) {
      if (!opts?.silent) {
        message.error(e.response?.data?.error?.message || '加载进度详情失败');
      }
      return null;
    } finally {
      if (!opts?.silent) setDetailLoading(false);
    }
  }, []);

  const openJobDetail = useCallback(async (id: string) => {
    detailIdRef.current = id;
    setDetailOpen(true);
    setDetailJob(null);
    await loadJobDetail(id);
  }, [loadJobDetail]);

  const closeJobDetail = useCallback(() => {
    detailIdRef.current = null;
    setDetailOpen(false);
    setDetailJob(null);
  }, []);

  useEffect(() => {
    if (!explainPreview?.fullscreen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExplainPreview((prev) => (prev ? { ...prev, fullscreen: false } : prev));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [explainPreview?.fullscreen]);

  const openStageMediaPreview = useCallback(async (
    kind: 'dubbing' | 'avatar',
    projectId: string,
    moocJobId?: string | null,
    chromaSimilarity?: number,
  ) => {
    if (!projectId) {
      message.warning('项目尚未创建，暂无可预览内容');
      return;
    }
    setStageMediaPreview({
      open: true,
      kind,
      projectId,
      moocJobId: moocJobId || null,
      loading: true,
      pages: [],
      pageIndex: 1,
      avatarView: kind === 'avatar' ? 'compose' : 'raw',
      chromaSimilarity: Number.isFinite(Number(chromaSimilarity)) ? Number(chromaSimilarity) : 0.28,
      composeUrl: null,
      composing: false,
    });
    try {
      const res = await projectApi.getSlides(projectId);
      const slides = res.data.data || [];
      const pages = slides
        .filter((s: any) => {
          if (kind === 'dubbing') {
            return (s.dubbingStatus || s.dubbing_status) === 'generated'
              && !!(s.dubbingAudioPath || s.dubbing_audio_path);
          }
          return (s.avatarStatus || s.avatar_status) === 'generated'
            && !!(s.avatarVideoPath || s.avatar_video_path);
        })
        .map((s: any) => ({
          pageIndex: Number(s.pageIndex ?? s.page_index),
          duration: s.dubbingDuration ?? s.dubbing_duration ?? null,
        }))
        .filter((p: any) => Number.isFinite(p.pageIndex) && p.pageIndex > 0);
      if (!pages.length) {
        message.info(kind === 'dubbing' ? '还没有可预览的配音' : '还没有可预览的数字人视频');
        setStageMediaPreview(null);
        return;
      }
      setStageMediaPreview((prev) => prev ? {
        ...prev,
        loading: false,
        pages,
        pageIndex: pages[0].pageIndex,
      } : null);
    } catch (e: any) {
      message.error(e.response?.data?.error?.message || '加载预览失败');
      setStageMediaPreview(null);
    }
  }, []);

  const generateAvatarComposePreview = useCallback(async () => {
    if (!stageMediaPreview || stageMediaPreview.kind !== 'avatar') return;
    const { projectId, pageIndex, chromaSimilarity = 0.28 } = stageMediaPreview;
    setStageMediaPreview({ ...stageMediaPreview, composing: true, avatarView: 'compose' });
    try {
      const res = await projectApi.composeAvatarPagePreview(projectId, pageIndex, chromaSimilarity);
      const data = res.data.data;
      const url = projectApi.getAvatarComposePreviewUrl(
        projectId,
        pageIndex,
        data.chromaSimilarity ?? chromaSimilarity,
      );
      setStageMediaPreview((prev) => prev ? {
        ...prev,
        composing: false,
        composeUrl: `${url}&t=${Date.now()}`,
        chromaSimilarity: data.chromaSimilarity ?? chromaSimilarity,
        avatarView: 'compose',
      } : null);
      if (data.cached) message.success('已加载缓存的合成预览');
      else message.success('合成预览已生成（约前 8 秒）');
    } catch (e: any) {
      message.error(e.response?.data?.error?.message || '合成预览失败');
      setStageMediaPreview((prev) => prev ? { ...prev, composing: false } : null);
    }
  }, [stageMediaPreview]);

  const applyChromaToMoocJob = useCallback(async () => {
    if (!stageMediaPreview?.moocJobId) {
      message.warning('无法关联到当前一键任务');
      return;
    }
    try {
      await moocApi.updateJobConfig(stageMediaPreview.moocJobId, {
        chromaSimilarity: stageMediaPreview.chromaSimilarity ?? 0.28,
      });
      message.success(`已应用到任务：绿幕强度 ${Math.round((stageMediaPreview.chromaSimilarity ?? 0.28) * 100)}`);
      if (detailIdRef.current) void loadJobDetail(detailIdRef.current, { silent: true });
    } catch (e: any) {
      message.error(e.response?.data?.error?.message || '保存失败');
    }
  }, [stageMediaPreview, loadJobDetail]);

  const [retryingExplainId, setRetryingExplainId] = useState<string | null>(null);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await moocApi.listJobs();
      const data = res.data.data;
      setJobs(data.jobs || []);
      setQueueInfo(data.queue || {});
      const openId = detailIdRef.current;
      if (openId && detailOpen) {
        void loadJobDetail(openId, { silent: true });
      }
    } catch {
      // ignore polling errors
    }
  }, [detailOpen, loadJobDetail]);

  const repairExplainChild = useCallback(async (
    child: any,
    mode: 'reexport' | 'regenerate',
  ) => {
    const moocId = detailIdRef.current;
    if (!moocId) return;
    setRetryingExplainId(child.id);
    try {
      const res = await moocApi.repairExplainChild(moocId, child.id, mode);
      message.success(res.data.data?.message || `已开始修复：${child.title || '知识点'}`);
      await loadJobDetail(moocId, { silent: true });
      await refreshJobs();
    } catch (e: any) {
      message.error(e.response?.data?.error?.message || '修复失败');
    } finally {
      setRetryingExplainId(null);
    }
  }, [loadJobDetail, refreshJobs]);

  const retryExplainChild = useCallback(async (childId: string, title?: string) => {
    const child = (detailJob?.explain?.children || []).find((c: any) => c.id === childId);
    if (child?.canRepair || child?.qcStatus === 'failed') {
      const mode = (child.status === 'completed' && child.hasFinal) ? 'reexport' : 'regenerate';
      await repairExplainChild(child, mode);
      return;
    }
    setRetryingExplainId(childId);
    try {
      await explainApi.retryJob(childId);
      message.success(`已重新排队：${title || '知识点'}`);
      const openId = detailIdRef.current;
      if (openId) await loadJobDetail(openId, { silent: true });
      await refreshJobs();
    } catch (e: any) {
      message.error(e.response?.data?.error?.message || '重试失败');
    } finally {
      setRetryingExplainId(null);
    }
  }, [detailJob, loadJobDetail, refreshJobs, repairExplainChild]);

  const retryAllFailedExplain = useCallback(async () => {
    const failed = (detailJob?.explain?.children || []).filter(
      (c: any) => c.status === 'failed' || c.status === 'cancelled' || c.canRepair || c.qcStatus === 'failed',
    );
    if (!failed.length) {
      message.info('没有失败或质检未通过的知识点');
      return;
    }
    setRetryingExplainId('__all__');
    try {
      let ok = 0;
      for (const c of failed) {
        try {
          const mode = (c.status === 'completed' && c.hasFinal) ? 'reexport' : 'regenerate';
          await moocApi.repairExplainChild(detailIdRef.current!, c.id, mode);
          ok += 1;
        } catch {
          // continue others
        }
      }
      message.success(`已开始修复 ${ok}/${failed.length} 个知识点（通过后自动补进成片）`);
      const openId = detailIdRef.current;
      if (openId) await loadJobDetail(openId, { silent: true });
      await refreshJobs();
    } finally {
      setRetryingExplainId(null);
    }
  }, [detailJob, loadJobDetail, refreshJobs]);

  const loadVoiceOptions = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      const [vRes, mRes] = await Promise.all([
        voiceboxApi.listVoices(),
        voiceboxApi.listModels(),
      ]);
      if (vRes.data?.error || mRes.data?.error) {
        throw new Error(vRes.data?.error?.message || mRes.data?.error?.message || 'Voicebox 不可用');
      }
      const vs = vRes.data.data || [];
      const rawModels = (mRes.data.data || []).filter(isTtsModel);
      const ms = rawModels.filter((m: any) => (
        m.downloaded || m.loaded || m.status === 'ready' || m.status === 'available' || m.status === 'downloaded'
      ));
      setVoices(vs);
      setModels(ms.length ? ms : rawModels);
      if (vs[0] && !form.getFieldValue('selectedVoiceId')) {
        form.setFieldValue('selectedVoiceId', vs[0].id);
      }
      const preferred = (ms.length ? ms : rawModels).find((m: any) => m.isRecommended)
        || ms[0]
        || rawModels[0];
      if (preferred && !form.getFieldValue('selectedModelId')) {
        form.setFieldValue('selectedModelId', preferred.id);
      }
      if (!vs.length && !opts?.silent) {
        message.warning('暂无音色，请先在造声工厂克隆，或确认 Voicebox 已启动');
      }
      return vs.length > 0;
    } catch (err: any) {
      if (!opts?.silent) {
        message.warning(err.response?.data?.error?.message || '音色/模型列表加载失败，请确认 Voicebox 已启动');
      }
      return false;
    }
  }, [form]);

  useEffect(() => {
    document.title = 'Cinedeck · PPT 讲解视频 · 一键全自动';
    form.setFieldsValue({
      targetDuration: 0,
      useExistingNote: true,
      enableAvatar: false,
      avatarDriveMode: 'video',
      allowSilentPages: true,
      defaultSilentPageDuration: 5,
      pauseDuration: 2,
      pauseEnabled: true,
      maxRetries: 5,
      enableExplainInsert: false,
      explainExportQuality: '1080p',
      chromaSimilarity: 0.28,
    });

    void (async () => {
      // 数字人互斥可能刚停掉 Voicebox：失败时短暂重试
      for (let i = 0; i < 3; i++) {
        const ok = await loadVoiceOptions({ silent: i < 2 });
        if (ok) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      try {
        await loadRefs();
      } catch {
        // ignore
      }
    })();

    void refreshJobs();
    pollRef.current = window.setInterval(() => { void refreshJobs(); }, 3000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const handleSubmit = async () => {
    const filesToSubmit = isBatchMode ? batchFiles : (file ? [file] : []);
    if (!filesToSubmit.length) {
      message.error(isBatchMode ? '请先选择至少一个 PPTX 文件' : '请先选择 PPTX 文件');
      return;
    }
    try {
      const values = await form.validateFields();
      if (values.enableAvatar && values.avatarDriveMode === 'photo' && !photo) {
        message.error('请上传数字人静照');
        return;
      }
      if (values.enableAvatar && !avatarFirstPageOnly && !avatarPages.length) {
        message.error('请至少勾选一页生成数字人');
        return;
      }
      setSubmitting(true);
      let ok = 0;
      for (const pptFile of filesToSubmit) {
        const fd = buildMoocFormData(pptFile, values, {
          photo,
          avatarPages: avatarFirstPageOnly ? [1] : avatarPages,
          layout,
          avatarFirstPageOnly,
        });
        await moocApi.createJob(fd);
        ok += 1;
      }
      message.success(
        ok > 1
          ? `已加入 ${ok} 个任务，将按相同配置串行处理`
          : '任务已加入队列，后台将串行处理',
      );
      setFile(null);
      setBatchFiles([]);
      setPhoto(null);
      setSlideCount(0);
      setAvatarPages([]);
      setLayout(DEFAULT_AVATAR_LAYOUT);
      resetPreview();
      await refreshJobs();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err.response?.data?.error?.message || err.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResume = async (id: string) => {
    try {
      await moocApi.retryJob(id, { resume: true });
      message.success('已从断点继续排队');
      await refreshJobs();
    } catch (e: any) {
      message.error(e.response?.data?.error?.message || '继续失败');
    }
  };

  const handleRestart = async (id: string) => {
    Modal.confirm({
      title: '全部重跑？',
      content: '将丢弃当前进度，从头重新生成（解析→解说词→配音…）',
      okText: '全部重跑',
      okType: 'danger',
      onOk: async () => {
        try {
          await moocApi.retryJob(id, { resume: false });
          message.success('已重新排队（全部重跑）');
          await refreshJobs();
        } catch (e: any) {
          message.error(e.response?.data?.error?.message || '重跑失败');
        }
      },
    });
  };

  const [optimizeJob, setOptimizeJob] = useState<any | null>(null);
  const [optimizeSubmitting, setOptimizeSubmitting] = useState(false);
  const [optimizePhoto, setOptimizePhoto] = useState<File | null>(null);
  const [optimizeForm] = Form.useForm();
  const optimizeChangeAvatar = Form.useWatch('changeAvatar', optimizeForm);
  const optimizeAddExplain = Form.useWatch('addExplain', optimizeForm);
  const optimizeDriveMode = Form.useWatch('avatarDriveMode', optimizeForm);

  const openOptimize = (job: any, preset?: { changeAvatar?: boolean; addExplain?: boolean }) => {
    setOptimizeJob(job);
    setOptimizePhoto(null);
    void loadRefs();
    const cfg = job.config || {};
    const hasExplain = !!job.hasExplainInsert;
    optimizeForm.setFieldsValue({
      changeAvatar: preset?.changeAvatar ?? false,
      addExplain: preset?.addExplain ?? !hasExplain,
      explainExportQuality: cfg.explainExportQuality || '1080p',
      avatarDriveMode: cfg.avatarDriveMode || 'video',
      avatarRefVideoId: cfg.avatarRefVideoId || undefined,
      chromaSimilarity: Number(cfg.chromaSimilarity ?? 0.28),
      avatarFirstPageOnly: !!cfg.avatarFirstPageOnly,
    });
  };

  const submitOptimize = async () => {
    if (!optimizeJob) return;
    try {
      const values = await optimizeForm.validateFields();
      const changeAvatar = !!values.changeAvatar;
      const addExplain = !!values.addExplain;
      if (!changeAvatar && !addExplain) {
        message.warning('请至少勾选一项优化内容');
        return;
      }
      if (changeAvatar) {
        if (values.avatarDriveMode === 'photo' && !optimizePhoto && !optimizeJob.config?.hasAvatarPhoto) {
          message.warning('请上传数字人静照');
          return;
        }
        if (values.avatarDriveMode === 'video' && !values.avatarRefVideoId) {
          message.warning('请选择参考视频');
          return;
        }
      }
      setOptimizeSubmitting(true);
      const fd = new FormData();
      fd.append('change_avatar', changeAvatar ? '1' : '0');
      fd.append('add_explain', addExplain ? '1' : '0');
      if (addExplain) {
        fd.append('explain_export_quality', values.explainExportQuality || '1080p');
      }
      if (changeAvatar) {
        fd.append('avatar_drive_mode', values.avatarDriveMode || 'video');
        if (values.avatarRefVideoId) fd.append('avatar_ref_video_id', values.avatarRefVideoId);
        if (optimizePhoto) fd.append('photo', optimizePhoto);
        const chroma = Number(values.chromaSimilarity);
        fd.append(
          'chroma_similarity',
          String(Number.isFinite(chroma) ? Math.min(0.6, Math.max(0.05, chroma)) : 0.28),
        );
        if (values.avatarFirstPageOnly) fd.append('avatar_first_page_only', '1');
        const layout = optimizeJob.config?.avatarLayout || DEFAULT_AVATAR_LAYOUT;
        fd.append('avatar_layout', JSON.stringify(layout));
      }
      await moocApi.optimize(optimizeJob.id, fd);
      const parts = [
        changeAvatar ? '更换数字人' : null,
        addExplain ? (optimizeJob.hasExplainInsert ? '重做讲解' : '加讲解') : null,
      ].filter(Boolean);
      message.success(`已排队：${parts.join(' + ')}并重合成`);
      setOptimizeJob(null);
      await refreshJobs();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.response?.data?.error?.message || '成片优化失败');
    } finally {
      setOptimizeSubmitting(false);
    }
  };

  const handleOptimizeExplainBatch = () => {
    const candidates = jobs.filter((j) => j.canOptimizeExplain || (
      j.projectId && (j.status === 'success' || j.status === 'failed' || j.status === 'cancelled')
    ));
    const fresh = candidates.filter((j) => !j.hasExplainInsert);
    const list = fresh.length ? fresh : candidates;
    if (!list.length) {
      message.info('没有可优化的已完成任务');
      return;
    }
    Modal.confirm({
      title: `批量一键优化（${list.length} 个）？`,
      content: fresh.length
        ? `将为 ${fresh.length} 个尚未加讲解的任务补知识点动画并重合成；保留原有配音/数字人。`
        : `将重新为 ${list.length} 个任务生成知识点讲解并重合成。`,
      okText: '批量优化',
      onOk: async () => {
        try {
          const res = await moocApi.optimizeExplainBatch(list.map((j) => j.id));
          const data = res.data.data;
          message.success(`已排队优化 ${data?.ok || 0}/${data?.total || list.length} 个任务`);
          await refreshJobs();
        } catch (e: any) {
          message.error(e.response?.data?.error?.message || '批量优化失败');
        }
      },
    });
  };

  const columns = [
    {
      title: '任务',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      ellipsis: true,
      render: (_: any, r: any) => (
        <Tooltip title={`${r.name || ''}\n${r.fileName || ''}`}>
          <div style={{ maxWidth: 190, overflow: 'hidden' }}>
            <div style={{
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            >
              {truncateText(r.name, 24)}
            </div>
            <div style={{
              fontSize: 11,
              color: 'rgba(0,0,0,0.45)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            >
              {truncateText(r.fileName, 28)}
            </div>
          </div>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 78,
      render: (s: string, r: any) => {
        const repairing = !!(r.repairInProgress || r.config?.repairInProgress)
          || (s === 'running' && (r.stage === 'explain_gen' || r.stage === 'explain'))
          || (s === 'running' && /重导|修复|叠数字人|知识点插片/.test(String(r.message || '')));
        if (repairing) {
          return <Tag color="processing" style={{ margin: 0 }}>修复中</Tag>;
        }
        return (
          <Tag color={STATUS_COLOR[s] || 'default'} style={{ margin: 0 }}>
            {STATUS_LABEL[s] || s}
          </Tag>
        );
      },
    },
    {
      title: '进度',
      key: 'progress',
      width: 160,
      render: (_: any, r: any) => {
        const repairing = !!(r.repairInProgress || r.config?.repairInProgress)
          || (r.status === 'running' && /重导|修复|叠数字人|知识点插片/.test(String(r.message || '')));
        const stageText = r.status === 'failed'
          ? (r.failedStageLabel || STAGE_LABEL[r.failedStage] || STAGE_LABEL[r.stage] || r.stage)
          : repairing
            ? (STAGE_LABEL.explain || '修复讲解插片')
            : (r.stageLabel || STAGE_LABEL[r.stage] || r.stage);
        const summary = repairing
          ? (r.message || r.progressSummary || '正在修复知识点插片…')
          : (r.progressSummary || '');
        return (
          <Tooltip title="点击查看流水线与知识点详情">
            <div
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                void openJobDetail(r.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void openJobDetail(r.id);
                }
              }}
              style={{ width: 148, cursor: 'pointer' }}
            >
              <div style={{ fontSize: 12, marginBottom: 2, color: '#1677ff' }}>{stageText}</div>
              {summary && summary !== stageText && (
                <div style={{
                  fontSize: 11,
                  color: 'rgba(0,0,0,0.45)',
                  marginBottom: 2,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                >
                  {truncateText(summary, 22)}
                </div>
              )}
              {(r.retryCount > 0 || (r.maxRetries != null && r.status !== 'success')) && (
                <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)', marginBottom: 2 }}>
                  重试 {r.retryCount || 0}/{r.maxRetries ?? 5}
                </div>
              )}
              {(r.status === 'running' || r.status === 'queued') ? (
                <Progress
                  percent={r.progress || 0}
                  size="small"
                  status={r.status === 'queued' ? 'normal' : 'active'}
                  showInfo={false}
                />
              ) : r.status === 'success' ? (
                <Progress percent={100} size="small" status="success" showInfo={false} />
              ) : r.status === 'failed' ? (
                <Progress percent={r.progress || 0} size="small" status="exception" showInfo={false} />
              ) : null}
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: '说明',
      dataIndex: 'message',
      ellipsis: true,
      render: (msg: string, r: any) => {
        const hint = formatQueueHint(
          r.status,
          estimateQueuePosition(jobs, r.id),
          msg,
        );
        const explainHint = r.explainStats
          ? `讲解 ${r.explainStats.completed || 0}/${r.explainStats.total || 0}`
            + (r.explainEtaLabel ? ` · 预计剩余 ${r.explainEtaLabel}` : '')
          : '';
        const text = r.error || r.progressSummary || explainHint || hint || msg || '-';
        const short = truncateText(text.replace(/\n/g, ' '), 56);
        const isFail = r.status === 'failed';
        return (
          <Space size={4}>
            <Tooltip title={`${text}（点击查看详情）`}>
              <Text
                type={isFail ? 'danger' : 'secondary'}
                style={{ fontSize: 12, maxWidth: 360, display: 'inline-block', cursor: 'pointer' }}
                ellipsis
                onClick={() => void openJobDetail(r.id)}
              >
                {short}
              </Text>
            </Tooltip>
            {isFail && r.error && (
              <Button
                type="link"
                size="small"
                icon={<ExclamationCircleOutlined />}
                style={{ padding: 0, height: 'auto' }}
                onClick={() => setErrorModal({
                  open: true,
                  title: `失败详情 · ${r.failedStageLabel || STAGE_LABEL[r.stage] || ''}`,
                  content: r.error,
                })}
              >
                错误
              </Button>
            )}
          </Space>
        );
      },
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 90,
      render: (t: string) => {
        if (!t) return '-';
        const d = new Date(t);
        return (
          <Tooltip title={d.toLocaleString('zh-CN')}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {`${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 360,
      fixed: 'right' as const,
      render: (_: any, r: any) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="link"
            icon={<ProfileOutlined />}
            onClick={() => void openJobDetail(r.id)}
          >
            详情
          </Button>
          {(r.pptAvailable || r.fileName) && (
            <Button
              size="small"
              type="link"
              icon={<DownloadOutlined />}
              onClick={async () => {
                try {
                  message.loading({ content: '正在下载 PPT…', key: `ppt-${r.id}`, duration: 0 });
                  await moocApi.downloadPpt(r.id, r.fileName || r.name);
                  message.success({ content: 'PPT 已开始下载', key: `ppt-${r.id}` });
                } catch (e: any) {
                  message.error({ content: e.message || 'PPT 下载失败', key: `ppt-${r.id}` });
                }
              }}
            >
              PPT
            </Button>
          )}
          {r.status === 'success' && r.projectId && (
            <>
              <Button
                size="small"
                type="link"
                icon={<PlayCircleOutlined />}
                onClick={() => window.open(videoApi.getPlayUrl(r.projectId), '_blank')}
              >
                播放
              </Button>
              <Button
                size="small"
                type="link"
                icon={<DownloadOutlined />}
                onClick={() => {
                  try {
                    videoApi.download(r.projectId, r.name);
                    message.success({ content: '已开始下载', key: `dl-${r.id}` });
                  } catch (e: any) {
                    message.error({ content: e.message || '下载失败', key: `dl-${r.id}` });
                  }
                }}
              >
                下载
              </Button>
              <Button size="small" type="link" onClick={() => navigate(`/project/${r.projectId}/preview`)}>
                项目
              </Button>
            </>
          )}
          {(r.canOptimizeExplain || r.canOptimizeAvatar) && (
            <Button
              size="small"
              type="link"
              icon={<ThunderboltOutlined />}
              onClick={() => openOptimize(r)}
            >
              优化成片
            </Button>
          )}
          {(r.status === 'queued' || r.status === 'running') && (
            <Button
              size="small"
              type="link"
              danger
              icon={<StopOutlined />}
              onClick={async () => {
                await moocApi.cancelJob(r.id);
                message.info('已请求取消');
                await refreshJobs();
              }}
            >
              取消
            </Button>
          )}
          {(r.status === 'failed' || r.status === 'cancelled') && (
            <>
              <Button
                size="small"
                type="link"
                icon={<ReloadOutlined />}
                onClick={() => void handleResume(r.id)}
              >
                {r.canResume ? '继续' : '重试'}
              </Button>
              {r.canResume && (
                <Button size="small" type="link" onClick={() => void handleRestart(r.id)}>
                  重跑
                </Button>
              )}
            </>
          )}
          {r.status !== 'running' && (
            <Button
              size="small"
              type="link"
              danger
              icon={<DeleteOutlined />}
              onClick={async () => {
                try {
                  await moocApi.deleteJob(r.id);
                  message.success('已删除');
                  await refreshJobs();
                } catch (e: any) {
                  message.error(e.response?.data?.error?.message || '删除失败');
                }
              }}
            />
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{
      maxWidth: 1680,
      width: '100%',
      margin: '0 auto',
      padding: '32px clamp(16px, 2.5vw, 40px)',
      boxSizing: 'border-box',
    }}
    >
      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ marginBottom: 4 }}>PPT 讲解视频 · 一键全自动</Title>
        <Text type="secondary">与分步向导共用同一套流水线；一次配置全部选项，支持单个或批量 PPT。</Text>
        <div style={{ marginTop: 12 }}>
          <Button size="small" onClick={() => navigate('/ppt')}>切换到分步向导</Button>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message="流水线：解析 PPT → 生成解说词 → 配音 →（可选）数字人 →（可选）知识点讲解动画 → 合成视频。全局一次只跑一个任务，跑完自动接下一个。"
      />

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={9} xl={7} xxl={6}>
          <Card
            title="新建任务"
            extra={<RocketOutlined />}
          >
            <div style={{ marginBottom: 16 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>提交方式</Text>
              <Radio.Group
                value={submitMode}
                onChange={(e) => handleSubmitModeChange(e.target.value)}
                optionType="button"
                buttonStyle="solid"
              >
                <Radio.Button value="single">单个 PPT</Radio.Button>
                <Radio.Button value="batch">批量 PPT</Radio.Button>
              </Radio.Group>
            </div>

            {isBatchMode ? (
              <>
                <Upload.Dragger
                  accept=".pptx"
                  multiple
                  showUploadList={false}
                  beforeUpload={(_f, list) => {
                    void handlePickBatchFiles(list as File[]);
                    return false;
                  }}
                >
                  <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
                  <p className="ant-upload-text">点击或拖拽上传多个 PPTX</p>
                  <p className="ant-upload-hint">
                    最大 200MB/个 · 已选 {batchFiles.length} 个文件
                  </p>
                </Upload.Dragger>
                {batchFiles.length > 0 && (
                  <div style={{ marginTop: 12, maxHeight: 160, overflow: 'auto' }}>
                    {batchFiles.map((f, idx) => (
                      <div
                        key={`${f.name}-${idx}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '4px 0',
                          borderBottom: '1px solid rgba(0,0,0,0.06)',
                        }}
                      >
                        <Text ellipsis style={{ flex: 1, marginRight: 8 }}>{f.name}</Text>
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => {
                            setBatchFiles((prev) => {
                              const next = prev.filter((_, i) => i !== idx);
                              if (!next.length) resetPreview();
                              else if (idx === 0 && form.getFieldValue('enableAvatar')) {
                                void loadSlidePreview(next[0]);
                              }
                              return next;
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <Upload.Dragger
                accept=".pptx"
                maxCount={1}
                showUploadList={false}
                beforeUpload={(f) => {
                  void handlePickFile(f);
                  return false;
                }}
              >
                <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
                <p className="ant-upload-text">{file ? file.name : '点击或拖拽上传 PPTX'}</p>
                <p className="ant-upload-hint">
                  最大 200MB
                  {slideCount > 0 ? ` · 识别到 ${slideCount} 页` : ''}
                </p>
              </Upload.Dragger>
            )}

            <Divider />

            <Form form={form} layout="vertical" requiredMark={false}>
              <Form.Item label="目标总时长（分钟）" name="targetDuration" tooltip="0 表示按内容自动估算">
                <InputNumber min={0} max={180} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="useExistingNote" valuePropName="checked">
                <Checkbox>参考 PPT 已有备注生成解说词</Checkbox>
              </Form.Item>

              <Form.Item
                label="配音音色"
                name="selectedVoiceId"
                rules={[{ required: true, message: '请选择音色' }]}
                extra={
                  <Space size={0}>
                    <Button type="link" size="small" onClick={() => navigate('/voice-factory')}>去造声工厂克隆</Button>
                    <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => void loadVoiceOptions()}>
                      刷新
                    </Button>
                  </Space>
                }
              >
                <VoiceSelectField voices={voices} />
              </Form.Item>
              <Form.Item
                label="配音模型"
                name="selectedModelId"
                rules={[{ required: true, message: '请选择模型' }]}
                extra={
                  <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => void loadVoiceOptions()}>
                    刷新模型列表
                  </Button>
                }
              >
                <ModelSelectField models={models} readyOnly={false} />
              </Form.Item>

              <Form.Item label="生成数字人" name="enableAvatar" valuePropName="checked">
                <Switch checkedChildren="开启" unCheckedChildren="跳过" />
              </Form.Item>

              <Form.Item
                label="插入知识点讲解动画"
                name="enableExplainInsert"
                valuePropName="checked"
                extra="全自动拆知识点并生成动画，按页插入最终成片；若同时开启数字人，插片也会叠同款数字人（复用下方布局与绿幕强度）"
              >
                <Switch checkedChildren="开启" unCheckedChildren="关闭" />
              </Form.Item>
              {enableExplainInsert && (
                <Form.Item label="讲解动画清晰度" name="explainExportQuality">
                  <Select
                    options={[
                      { value: '720p', label: '720p' },
                      { value: '1080p', label: '1080p' },
                      { value: '1440p', label: '1440p' },
                    ]}
                  />
                </Form.Item>
              )}

              {enableAvatar && (
                <>
                  <Form.Item label="驱动方式" name="avatarDriveMode">
                    <Radio.Group>
                      <Radio.Button value="video">参考视频</Radio.Button>
                      <Radio.Button value="photo">静照</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                  {driveMode === 'video' ? (
                    <>
                      <Form.Item
                        label="参考视频"
                        name="avatarRefVideoId"
                        rules={[{ required: true, message: '请选择参考视频' }]}
                      >
                        <AvatarRefLibraryPanel
                          mode="select"
                          refs={refs}
                          selectedId={selectedAvatarRefId || null}
                          onSelect={() => undefined}
                        />
                      </Form.Item>
                    </>
                  ) : (
                    <Form.Item label="静照" required>
                      <Upload
                        accept="image/*"
                        maxCount={1}
                        showUploadList={false}
                        beforeUpload={(f) => { setPhoto(f); return false; }}
                      >
                        <Button icon={<PlusOutlined />}>{photo ? photo.name : '上传照片'}</Button>
                      </Upload>
                    </Form.Item>
                  )}

                  <Form.Item
                    label={
                      avatarFirstPageOnly ? '数字人页码（批量）' : (
                        <Space>
                          <span>生成数字人的页码</span>
                          {pageOptions.length > 0 && (
                            <>
                              <Button
                                type="link"
                                size="small"
                                onClick={() => setAvatarPages([...pageOptions])}
                              >
                                全选
                              </Button>
                              <Button type="link" size="small" onClick={() => setAvatarPages([])}>
                                清空
                              </Button>
                            </>
                          )}
                        </Space>
                      )
                    }
                    required
                  >
                    {avatarFirstPageOnly ? (
                      <>
                        <Alert
                          type="info"
                          showIcon
                          message="批量模式：每个 PPT 仅第 1 页生成数字人"
                          description="各文件页数不同，无法统一勾选多页；布局在下方按第 1 页预览调整后，将全部 PPT 共用。"
                          style={{ marginBottom: 12 }}
                        />
                        <Tag color="blue">第 1 页</Tag>
                      </>
                    ) : pageOptions.length > 0 ? (
                      <Checkbox.Group
                        value={avatarPages}
                        onChange={(vals) => setAvatarPages(vals as number[])}
                        style={{ width: '100%' }}
                      >
                        <Row gutter={[4, 4]}>
                          {pageOptions.map((p) => (
                            <Col span={4} key={p}>
                              <Checkbox value={p}>{p}</Checkbox>
                            </Col>
                          ))}
                        </Row>
                      </Checkbox.Group>
                    ) : (
                      <Select
                        mode="tags"
                        placeholder="输入页码后回车，如 1、3、5"
                        tokenSeparators={[',', ' ', '，']}
                        value={avatarPages.map(String)}
                        onChange={(vals) => {
                          const pages = vals
                            .map((v) => Number(v))
                            .filter((n) => Number.isFinite(n) && n >= 1);
                          setAvatarPages([...new Set(pages)].sort((a, b) => a - b));
                        }}
                        style={{ width: '100%' }}
                      />
                    )}
                    {!avatarFirstPageOnly && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        已选 {avatarPages.length} 页
                        {slideCount > 0 ? ` / 共 ${slideCount} 页` : ''}
                      </Text>
                    )}
                  </Form.Item>

                  <Form.Item
                    label="数字人布局（位置与大小）"
                    tooltip={avatarFirstPageOnly
                      ? '用第一个 PPT 的第 1 页预览布局，批量任务共用'
                      : '请选择 PPT 中的真实页面作为底图再调整，布局会更准确'}
                  >
                    {!activePreviewFile ? (
                      <Alert type="warning" showIcon message="请先上传 PPTX，再渲染真实页面做布局" />
                    ) : previewLoading ? (
                      <div style={{ textAlign: 'center', padding: 32 }}>
                        <Spin tip="正在渲染真实幻灯片，请稍候…" />
                      </div>
                    ) : previewError ? (
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Alert type="error" showIcon message={previewError} />
                        <Button icon={<ReloadOutlined />} onClick={() => void loadSlidePreview(activePreviewFile)}>
                          重新渲染
                        </Button>
                      </Space>
                    ) : previewId ? (
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        {!avatarFirstPageOnly && (
                          <div>
                            <Text style={{ marginRight: 8 }}>布局参考页</Text>
                            <Select
                              value={layoutPage}
                              onChange={setLayoutPage}
                              style={{ width: 160 }}
                              options={pageOptions.map((p) => ({
                                value: p,
                                label: `第 ${p} 页`,
                              }))}
                            />
                            <Button
                              type="link"
                              size="small"
                              icon={<ReloadOutlined />}
                              onClick={() => void loadSlidePreview(activePreviewFile)}
                            >
                              重新渲染
                            </Button>
                          </div>
                        )}
                        {avatarFirstPageOnly && activePreviewFile && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            预览文件：{activePreviewFile.name}（第 1 页）
                          </Text>
                        )}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {avatarFirstPageOnly
                            ? '在真实幻灯片上拖拽蓝框调整位置与大小；所有批量 PPT 共用此布局。'
                            : '在真实幻灯片上拖拽蓝框调整位置与大小；参考页仅用于预览，不影响勾选生成的页码。'}
                        </Text>
                        <AvatarPipEditor
                          key={`${previewId}-${layoutPage}`}
                          imageUrl={layoutImageUrl}
                          layout={layout}
                          onChange={setLayout}
                          aspectRatio={1}
                        />
                      </Space>
                    ) : (
                      <Button type="primary" ghost onClick={() => void loadSlidePreview(activePreviewFile)}>
                        渲染真实幻灯片以配置布局
                      </Button>
                    )}
                  </Form.Item>

                  <Form.Item
                    label="绿幕抠图强度"
                    name="chromaSimilarity"
                    tooltip="仅绿幕参考视频生效；数值越大抠得越狠。页讲解与知识点插片共用。"
                    extra="默认 28。非绿幕素材可忽略此项。"
                    getValueProps={(v) => ({
                      value: Math.round((Number(v) || 0.28) * 100),
                    })}
                    normalize={(v) => Math.min(0.6, Math.max(0.05, (Number(v) || 28) / 100))}
                  >
                    <Slider
                      min={10}
                      max={50}
                      tooltip={{ formatter: (v) => `${v}` }}
                      marks={{ 10: '弱', 28: '默认', 50: '强' }}
                    />
                  </Form.Item>
                </>
              )}

              <Divider style={{ margin: '12px 0' }}>播放设置</Divider>
              <Form.Item name="pauseEnabled" valuePropName="checked">
                <Checkbox>页间停顿</Checkbox>
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prev, cur) => prev.pauseEnabled !== cur.pauseEnabled}
              >
                {({ getFieldValue }) =>
                  getFieldValue('pauseEnabled') !== false ? (
                    <Form.Item label="停顿时长（秒）" name="pauseDuration" tooltip="默认 2 秒，与编辑导出页一致">
                      <InputNumber min={0.5} max={10} step={0.5} style={{ width: '100%' }} />
                    </Form.Item>
                  ) : null
                }
              </Form.Item>

              <Form.Item name="allowSilentPages" valuePropName="checked">
                <Checkbox>允许无配音页以静默时长占位</Checkbox>
              </Form.Item>
              <Form.Item label="静默页默认时长（秒）" name="defaultSilentPageDuration">
                <InputNumber min={1} max={30} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="出错自动重试次数"
                name="maxRetries"
                tooltip="单次任务失败后自动从断点重试的次数，默认 5；设为 0 则不自动重试，失败后直接进入下一任务"
              >
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>

              <Button
                type="primary"
                block
                size="large"
                icon={<PlusOutlined />}
                loading={submitting}
                onClick={handleSubmit}
              >
                {isBatchMode
                  ? (batchFiles.length > 1 ? `批量加入队列（${batchFiles.length} 个）` : '加入队列')
                  : '加入队列'}
              </Button>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={15} xl={17} xxl={18}>
          <Card
            title="任务队列"
            extra={
              <Space>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {queueInfo.hasRunning ? '有任务运行中' : '空闲'}
                  {typeof queueInfo.queuedCount === 'number' ? ` · 排队 ${queueInfo.queuedCount}` : ''}
                </Text>
                <Button
                  size="small"
                  icon={<ThunderboltOutlined />}
                  onClick={() => handleOptimizeExplainBatch()}
                >
                  批量加讲解
                </Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => refreshJobs()}>刷新</Button>
              </Space>
            }
          >
            <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 12, fontSize: 12 }}>
              串行执行。出错会按配置自动从断点重试；次数用尽后失败并进入下一任务。也可手动点「继续 / 重跑」。
            </Paragraph>
            <Table
              rowKey="id"
              size="small"
              columns={columns as any}
              dataSource={jobs}
              pagination={{ pageSize: 8, size: 'small' }}
              scroll={{ x: 1180 }}
              locale={{ emptyText: '暂无任务，左侧配置后加入队列' }}
              onRow={(r) => ({
                onDoubleClick: () => { void openJobDetail(r.id); },
              })}
            />
          </Card>
        </Col>
      </Row>

      <Modal
        open={errorModal.open}
        title={errorModal.title || '失败详情'}
        onCancel={() => setErrorModal({ open: false, title: '', content: '' })}
        footer={[
          <Button key="close" type="primary" onClick={() => setErrorModal({ open: false, title: '', content: '' })}>
            关闭
          </Button>,
        ]}
        width={640}
      >
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="失败阶段与原因如下，可点「继续」仅重试未完成步骤"
        />
        <pre style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 360,
          overflow: 'auto',
          margin: 0,
          fontSize: 12,
          background: '#fafafa',
          padding: 12,
          borderRadius: 6,
        }}
        >
          {errorModal.content}
        </pre>
      </Modal>

      <Modal
        open={!!optimizeJob}
        title={optimizeJob
          ? `优化成片 · ${truncateText(optimizeJob.name || optimizeJob.fileName || '', 24)}`
          : '优化成片'}
        onCancel={() => {
          if (optimizeSubmitting) return;
          setOptimizeJob(null);
          setOptimizePhoto(null);
        }}
        onOk={() => void submitOptimize()}
        okText="开始优化"
        confirmLoading={optimizeSubmitting}
        width={680}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="保留配音等已有产物。可只换数字人、只加讲解，或两项一起做。"
          description={
            optimizeJob?.hasExplainInsert
              ? '若同时勾选两项：会用新数字人重新生成知识点讲解（不沿用旧插片）。仅换数字人时，会保留讲解 HTML 并重叠新数字人。'
              : '勾选「加讲解」后会分析知识点、生成讲解动画并重合成。'
          }
        />
        <Form form={optimizeForm} layout="vertical">
          <Form.Item name="changeAvatar" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>
              <Space size={6}>
                <UserOutlined />
                更换数字人
              </Space>
            </Checkbox>
          </Form.Item>
          <Form.Item name="addExplain" valuePropName="checked" style={{ marginBottom: 16 }}>
            <Checkbox>
              <Space size={6}>
                <ThunderboltOutlined />
                {optimizeJob?.hasExplainInsert ? '重做知识点讲解' : '加知识点讲解'}
              </Space>
            </Checkbox>
          </Form.Item>

          {optimizeAddExplain ? (
            <Form.Item label="讲解导出清晰度" name="explainExportQuality" style={{ marginBottom: 16 }}>
              <Radio.Group optionType="button" buttonStyle="solid">
                <Radio.Button value="720p">720p</Radio.Button>
                <Radio.Button value="1080p">1080p</Radio.Button>
                <Radio.Button value="1440p">1440p</Radio.Button>
              </Radio.Group>
            </Form.Item>
          ) : null}

          {optimizeChangeAvatar ? (
            <>
              <Divider style={{ margin: '8px 0 16px' }}>数字人设置</Divider>
              <Form.Item label="驱动方式" name="avatarDriveMode" rules={[{ required: true }]}>
                <Radio.Group optionType="button" buttonStyle="solid">
                  <Radio.Button value="video">参考视频</Radio.Button>
                  <Radio.Button value="photo">静照</Radio.Button>
                </Radio.Group>
              </Form.Item>
              {optimizeDriveMode === 'photo' ? (
                <Form.Item label="静照" required>
                  <Upload
                    accept="image/*"
                    maxCount={1}
                    showUploadList={false}
                    beforeUpload={(f) => { setOptimizePhoto(f); return false; }}
                  >
                    <Button icon={<PlusOutlined />}>
                      {optimizePhoto
                        ? optimizePhoto.name
                        : (optimizeJob?.config?.hasAvatarPhoto ? '重新上传（可沿用原静照）' : '上传照片')}
                    </Button>
                  </Upload>
                </Form.Item>
              ) : (
                <Form.Item
                  label="参考视频"
                  name="avatarRefVideoId"
                  rules={[{ required: true, message: '请选择参考视频' }]}
                >
                  <AvatarRefLibraryPanel
                    mode="select"
                    refs={refs}
                    selectedId={optimizeForm.getFieldValue('avatarRefVideoId') || null}
                    onSelect={(id) => { optimizeForm.setFieldValue('avatarRefVideoId', id); }}
                  />
                </Form.Item>
              )}
              <Form.Item
                label="绿幕抠图强度"
                name="chromaSimilarity"
                tooltip="仅绿幕参考视频生效"
              >
                <Slider
                  min={0.05}
                  max={0.6}
                  step={0.01}
                  marks={{ 0.05: '弱', 0.28: '默认', 0.6: '强' }}
                />
              </Form.Item>
              <Form.Item name="avatarFirstPageOnly" valuePropName="checked">
                <Checkbox>仅第 1 页生成数字人</Checkbox>
              </Form.Item>
            </>
          ) : null}
        </Form>
      </Modal>

      <Drawer
        title={detailJob ? `进度详情 · ${truncateText(detailJob.name || detailJob.fileName || '', 28)}` : '进度详情'}
        open={detailOpen}
        onClose={closeJobDetail}
        width={560}
        destroyOnClose
        extra={
          detailJob?.id ? (
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadJobDetail(detailJob.id)}>
              刷新
            </Button>
          ) : null
        }
      >
        {detailLoading && !detailJob ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
        ) : !detailJob ? (
          <Text type="secondary">暂无数据</Text>
        ) : (
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            <div>
              <Space wrap size={[8, 8]}>
                {(() => {
                  const repairing = !!(detailJob.repairInProgress || detailJob.config?.repairInProgress)
                    || (detailJob.status === 'running' && (detailJob.stage === 'explain_gen' || detailJob.stage === 'explain'))
                    || (detailJob.status === 'running' && /重导|修复|叠数字人|知识点插片/.test(String(detailJob.message || '')));
                  return (
                    <>
                      <Tag color={repairing ? 'processing' : (STATUS_COLOR[detailJob.status] || 'default')}>
                        {repairing ? '修复中' : (STATUS_LABEL[detailJob.status] || detailJob.status)}
                      </Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {repairing
                          ? (STAGE_LABEL.explain || '修复讲解插片')
                          : (detailJob.stageLabel || STAGE_LABEL[detailJob.stage] || detailJob.stage)}
                      </Text>
                    </>
                  );
                })()}
                {detailJob.elapsedLabel && (
                  <Text type="secondary" style={{ fontSize: 12 }}>已用 {detailJob.elapsedLabel}</Text>
                )}
                {(detailJob.status === 'running' || detailJob.status === 'queued') && (
                  <Progress
                    percent={detailJob.progress || 0}
                    size="small"
                    style={{ width: 120, margin: 0 }}
                    status={detailJob.status === 'queued' ? 'normal' : 'active'}
                  />
                )}
              </Space>
              {(detailJob.message || detailJob.progressSummary) && (
                <div style={{ marginTop: 8 }}>
                  <Text>
                    {(detailJob.repairInProgress || detailJob.config?.repairInProgress)
                      ? (detailJob.message || detailJob.progressSummary)
                      : (detailJob.progressSummary || detailJob.message)}
                  </Text>
                </div>
              )}
            </div>

            <div>
              <Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>流水线</Title>
              <Steps
                direction="vertical"
                size="small"
                current={(detailJob.pipeline || []).findIndex((s: any) => s.status === 'running')}
                items={(detailJob.pipeline || []).map((s: any) => {
                  const statusMap: Record<string, 'wait' | 'process' | 'finish' | 'error'> = {
                    pending: 'wait',
                    running: 'process',
                    done: 'finish',
                    failed: 'error',
                    skipped: 'finish',
                  };
                  const bits = [
                    s.status === 'skipped' ? '已跳过' : null,
                    s.durationLabel || null,
                    s.summary || null,
                  ].filter(Boolean);
                  const canPreviewDubbing = s.id === 'dubbing'
                    && (s.status === 'done' || s.status === 'running')
                    && !!detailJob.projectId;
                  const canPreviewAvatar = s.id === 'avatar'
                    && (s.status === 'done' || s.status === 'running')
                    && !!detailJob.projectId;
                  return {
                    title: s.label,
                    status: statusMap[s.status] || 'wait',
                    description: (
                      <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                        {bits.length ? <div>{bits.join(' · ')}</div> : null}
                        {(canPreviewDubbing || canPreviewAvatar) && (
                          <Button
                            type="link"
                            size="small"
                            icon={<EyeOutlined />}
                            style={{ padding: 0, height: 'auto', marginTop: bits.length ? 2 : 0 }}
                            onClick={() => void openStageMediaPreview(
                              canPreviewDubbing ? 'dubbing' : 'avatar',
                              detailJob.projectId,
                              detailJob.id,
                              detailJob.config?.chromaSimilarity,
                            )}
                          >
                            {canPreviewDubbing ? '预览配音' : '预览数字人'}
                          </Button>
                        )}
                      </div>
                    ),
                  };
                })}
              />
            </div>

            {detailJob.explain && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                  <Title level={5} style={{ margin: 0 }}>知识点讲解</Title>
                  {!!((detailJob.explain.stats?.failed || 0) + (detailJob.explain.stats?.qcFailed || 0)) && (
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={retryingExplainId === '__all__'}
                      onClick={() => void retryAllFailedExplain()}
                    >
                      修复全部未通过
                    </Button>
                  )}
                </div>
                <Space wrap size={[8, 8]} style={{ marginBottom: 12 }}>
                  <Tag>
                    完成 {detailJob.explain.stats?.completed || 0}/{detailJob.explain.stats?.total || 0}
                  </Tag>
                  {!!detailJob.explain.stats?.running && (
                    <Tag color="processing">进行中 {detailJob.explain.stats.running}</Tag>
                  )}
                  {!!detailJob.explain.stats?.queued && (
                    <Tag>排队 {detailJob.explain.stats.queued}</Tag>
                  )}
                  {!!detailJob.explain.stats?.failed && (
                    <Tag color="error">失败 {detailJob.explain.stats.failed}</Tag>
                  )}
                  {!!detailJob.explain.stats?.qcFailed && (
                    <Tag color="warning">未通过 {detailJob.explain.stats.qcFailed}</Tag>
                  )}
                  {!!detailJob.explain.stats?.repairing && (
                    <Tag color="processing">修复中 {detailJob.explain.stats.repairing}</Tag>
                  )}
                  {!!detailJob.explain.stats?.retrying && (
                    <Tag color="warning">重试 {detailJob.explain.stats.retrying}</Tag>
                  )}
                  {detailJob.explain.concurrency != null && (
                    <Tag>并发 {detailJob.explain.concurrency}</Tag>
                  )}
                  {detailJob.explain.avgDoneLabel && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      均时 {detailJob.explain.avgDoneLabel}
                    </Text>
                  )}
                  {detailJob.explain.etaLabel && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      预计剩余 {detailJob.explain.etaLabel}
                    </Text>
                  )}
                </Space>
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={detailJob.explain.children || []}
                  locale={{ emptyText: '暂无子任务' }}
                  columns={[
                    {
                      title: '知识点',
                      dataIndex: 'title',
                      ellipsis: true,
                      render: (t: string, row: any) => (
                        <Tooltip title={row.qcReason || row.error || row.message || row.name || t}>
                          <span>{t || '-'}</span>
                        </Tooltip>
                      ),
                    },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      width: 100,
                      render: (s: string, row: any) => {
                        const tip = row.qcReason || row.error || row.message || undefined;
                        if (row.qcStatus === 'repairing') {
                          return <Tooltip title={tip}><Tag color="processing" style={{ margin: 0 }}>修复中</Tag></Tooltip>;
                        }
                        if (row.qcStatus === 'failed') {
                          return <Tooltip title={tip}><Tag color="warning" style={{ margin: 0 }}>未通过</Tag></Tooltip>;
                        }
                        return (
                          <Tooltip title={tip}>
                            <Tag
                              color={
                                s === 'completed' ? 'success'
                                  : s === 'running' ? 'processing'
                                    : s === 'failed' || s === 'cancelled' ? 'error'
                                      : 'default'
                              }
                              style={{ margin: 0 }}
                            >
                              {s === 'completed' ? (row.inInserts ? '已入片' : '完成')
                                : s === 'running' ? '进行中'
                                  : s === 'queued' ? (row.message?.includes('自动重试') || row.message?.includes('手动重新') || row.message?.includes('重新生成') ? '重试中' : '排队')
                                    : s === 'failed' ? '失败'
                                      : s === 'cancelled' ? '取消'
                                        : s}
                            </Tag>
                          </Tooltip>
                        );
                      },
                    },
                    {
                      title: '进度',
                      width: 72,
                      render: (_: any, row: any) => (
                        row.status === 'running' || row.status === 'queued' || row.qcStatus === 'repairing'
                          ? `${row.progress || 0}%`
                          : (row.durationLabel || '-')
                      ),
                    },
                    {
                      title: '阶段',
                      dataIndex: 'stageLabel',
                      width: 88,
                      ellipsis: true,
                      render: (t: string, row: any) => t || row.stage || '-',
                    },
                    {
                      title: '',
                      key: 'actions',
                      width: 148,
                      render: (_: any, row: any) => (
                        <Space size={0} wrap>
                          {(row.hasFinal || row.hasSample) && (
                            <Button
                              type="link"
                              size="small"
                              icon={<EyeOutlined />}
                              style={{ padding: '0 4px' }}
                              onClick={() => setExplainPreview({
                                open: true,
                                id: row.id,
                                title: row.title || row.name || '知识点预览',
                                kind: row.hasFinal ? 'final' : 'sample',
                              })}
                            >
                              预览
                            </Button>
                          )}
                          {row.canRepair && row.qcStatus !== 'repairing' && (
                            <>
                              {row.status === 'completed' && row.hasFinal && (
                                <Button
                                  type="link"
                                  size="small"
                                  icon={<ReloadOutlined />}
                                  style={{ padding: '0 4px' }}
                                  loading={retryingExplainId === row.id}
                                  disabled={retryingExplainId === '__all__'}
                                  onClick={() => void repairExplainChild(row, 'reexport')}
                                >
                                  重导
                                </Button>
                              )}
                              <Button
                                type="link"
                                size="small"
                                danger={row.qcStatus === 'failed' || row.status === 'failed'}
                                icon={<ReloadOutlined />}
                                style={{ padding: '0 4px' }}
                                loading={retryingExplainId === row.id}
                                disabled={retryingExplainId === '__all__'}
                                onClick={() => void repairExplainChild(row, 'regenerate')}
                              >
                                {row.status === 'completed' ? '重生' : '重试'}
                              </Button>
                            </>
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </Space>
        )}
      </Drawer>

      <Modal
        open={!!explainPreview?.open && !explainPreview?.fullscreen}
        title={explainPreview
          ? `${explainPreview.kind === 'final' ? '全片预览' : '样片预览'} · ${truncateText(explainPreview.title, 24)}`
          : '预览'}
        onCancel={() => setExplainPreview(null)}
        footer={[
          <Button
            key="blank"
            href={explainPreview
              ? (explainPreview.kind === 'final'
                ? explainApi.finalUrl(explainPreview.id)
                : explainApi.sampleUrl(explainPreview.id))
              : undefined}
            target="_blank"
            disabled={!explainPreview}
          >
            新窗口打开
          </Button>,
          <Button
            key="fs"
            icon={<ExpandOutlined />}
            onClick={() => {
              if (!explainPreview) return;
              // Ant Design Modal 使用 transform，浏览器原生 Fullscreen API 会失败，改用页面级遮罩
              setExplainPreview({ ...explainPreview, fullscreen: true });
            }}
          >
            全屏
          </Button>,
          <Button key="close" type="primary" onClick={() => setExplainPreview(null)}>
            关闭
          </Button>,
        ]}
        width={880}
        destroyOnClose
        styles={{ body: { paddingTop: 12 } }}
      >
        {explainPreview && !explainPreview.fullscreen && (
          <div style={{ background: '#000', borderRadius: 8, overflow: 'hidden' }}>
            <iframe
              title={explainPreview.kind === 'final' ? 'explain-final' : 'explain-sample'}
              src={explainPreview.kind === 'final'
                ? explainApi.finalUrl(explainPreview.id)
                : explainApi.sampleUrl(explainPreview.id)}
              style={{
                width: '100%',
                height: 480,
                border: 'none',
                display: 'block',
                background: '#000',
              }}
              allow="fullscreen; autoplay"
            />
          </div>
        )}
      </Modal>

      {explainPreview?.fullscreen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 3000,
            background: '#000',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            gap: 12,
          }}
          >
            <Text style={{ color: '#fff' }} ellipsis>
              {explainPreview.kind === 'final' ? '全片' : '样片'} · {explainPreview.title}
            </Text>
            <Space>
              <Button
                size="small"
                onClick={() => setExplainPreview({ ...explainPreview, fullscreen: false })}
              >
                退出全屏
              </Button>
              <Button size="small" type="primary" onClick={() => setExplainPreview(null)}>
                关闭
              </Button>
            </Space>
          </div>
          <iframe
            title={explainPreview.kind === 'final' ? 'explain-final-fs' : 'explain-sample-fs'}
            src={explainPreview.kind === 'final'
              ? explainApi.finalUrl(explainPreview.id)
              : explainApi.sampleUrl(explainPreview.id)}
            style={{
              flex: 1,
              width: '100%',
              border: 'none',
              background: '#000',
            }}
            allow="fullscreen; autoplay"
          />
        </div>
      )}

      <Modal
        open={!!stageMediaPreview?.open}
        title={stageMediaPreview
          ? `${stageMediaPreview.kind === 'dubbing' ? '配音预览' : '数字人预览'} · 第 ${stageMediaPreview.pageIndex} 页`
          : '预览'}
        onCancel={() => setStageMediaPreview(null)}
        footer={stageMediaPreview ? [
          <Button
            key="prev"
            disabled={stageMediaPreview.pages.findIndex((p) => p.pageIndex === stageMediaPreview.pageIndex) <= 0}
            onClick={() => {
              const idx = stageMediaPreview.pages.findIndex((p) => p.pageIndex === stageMediaPreview.pageIndex);
              if (idx > 0) {
                setStageMediaPreview({
                  ...stageMediaPreview,
                  pageIndex: stageMediaPreview.pages[idx - 1].pageIndex,
                  composeUrl: null,
                });
              }
            }}
          >
            上一页
          </Button>,
          <Button
            key="next"
            disabled={
              stageMediaPreview.pages.findIndex((p) => p.pageIndex === stageMediaPreview.pageIndex)
              >= stageMediaPreview.pages.length - 1
            }
            onClick={() => {
              const idx = stageMediaPreview.pages.findIndex((p) => p.pageIndex === stageMediaPreview.pageIndex);
              if (idx >= 0 && idx < stageMediaPreview.pages.length - 1) {
                setStageMediaPreview({
                  ...stageMediaPreview,
                  pageIndex: stageMediaPreview.pages[idx + 1].pageIndex,
                  composeUrl: null,
                });
              }
            }}
          >
            下一页
          </Button>,
          <Button key="close" type="primary" onClick={() => setStageMediaPreview(null)}>
            关闭
          </Button>,
        ] : null}
        width={760}
        destroyOnClose
      >
        {stageMediaPreview?.loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
        ) : stageMediaPreview ? (
          <div>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                共 {stageMediaPreview.pages.length} 页可预览
                {stageMediaPreview.kind === 'dubbing' ? '（配音）' : '（数字人）'}
              </Text>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {stageMediaPreview.pages.map((p) => (
                  <Button
                    key={p.pageIndex}
                    size="small"
                    type={p.pageIndex === stageMediaPreview.pageIndex ? 'primary' : 'default'}
                    onClick={() => setStageMediaPreview({
                      ...stageMediaPreview,
                      pageIndex: p.pageIndex,
                      composeUrl: null,
                    })}
                  >
                    {p.pageIndex}
                  </Button>
                ))}
              </div>
            </div>

            {stageMediaPreview.kind === 'dubbing' ? (
              <>
                <div style={{
                  background: '#111',
                  borderRadius: 8,
                  overflow: 'hidden',
                  marginBottom: 12,
                  textAlign: 'center',
                }}
                >
                  <img
                    key={`img-${stageMediaPreview.projectId}-${stageMediaPreview.pageIndex}`}
                    src={projectApi.getSlideImageUrl(stageMediaPreview.projectId, stageMediaPreview.pageIndex)}
                    alt={`第 ${stageMediaPreview.pageIndex} 页`}
                    style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain', display: 'block', margin: '0 auto' }}
                  />
                </div>
                <audio
                  key={`audio-${stageMediaPreview.projectId}-${stageMediaPreview.pageIndex}`}
                  controls
                  autoPlay
                  src={projectApi.getSlideAudioUrl(stageMediaPreview.projectId, stageMediaPreview.pageIndex)}
                  style={{ width: '100%' }}
                />
              </>
            ) : (
              <>
                <Radio.Group
                  value={stageMediaPreview.avatarView || 'compose'}
                  optionType="button"
                  buttonStyle="solid"
                  style={{ marginBottom: 12 }}
                  onChange={(e) => setStageMediaPreview({
                    ...stageMediaPreview,
                    avatarView: e.target.value,
                  })}
                  options={[
                    { label: '合成效果', value: 'compose' },
                    { label: '绿幕原片', value: 'raw' },
                  ]}
                />

                {(stageMediaPreview.avatarView || 'compose') === 'compose' ? (
                  <div>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="可调绿幕抠图强度并生成短预览（约前 8 秒），满意后点「应用到任务」供最终成片使用。"
                    />
                    <div style={{ marginBottom: 12 }}>
                      <Text style={{ display: 'block', marginBottom: 4 }}>
                        绿幕抠图强度：{Math.round((stageMediaPreview.chromaSimilarity ?? 0.28) * 100)}
                      </Text>
                      <Slider
                        min={5}
                        max={60}
                        value={Math.round((stageMediaPreview.chromaSimilarity ?? 0.28) * 100)}
                        onChange={(v) => setStageMediaPreview({
                          ...stageMediaPreview,
                          chromaSimilarity: Number(v) / 100,
                          composeUrl: null,
                        })}
                        marks={{ 5: '弱', 28: '默认', 60: '强' }}
                      />
                      <Space wrap style={{ marginTop: 8 }}>
                        <Button
                          type="primary"
                          loading={!!stageMediaPreview.composing}
                          onClick={() => void generateAvatarComposePreview()}
                        >
                          生成合成预览
                        </Button>
                        {stageMediaPreview.moocJobId && (
                          <Button onClick={() => void applyChromaToMoocJob()}>
                            应用到任务
                          </Button>
                        )}
                      </Space>
                    </div>
                    {stageMediaPreview.composing ? (
                      <div style={{ textAlign: 'center', padding: 48 }}><Spin tip="正在合成预览…" /></div>
                    ) : stageMediaPreview.composeUrl ? (
                      <video
                        key={stageMediaPreview.composeUrl}
                        controls
                        autoPlay
                        src={stageMediaPreview.composeUrl}
                        style={{ width: '100%', maxHeight: 420, background: '#000', borderRadius: 8 }}
                      />
                    ) : (
                      <div style={{
                        background: '#111',
                        borderRadius: 8,
                        padding: 48,
                        textAlign: 'center',
                        color: 'rgba(255,255,255,0.65)',
                      }}
                      >
                        调整强度后点击「生成合成预览」
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div style={{
                      background: '#111',
                      borderRadius: 8,
                      overflow: 'hidden',
                      marginBottom: 12,
                      textAlign: 'center',
                    }}
                    >
                      <img
                        key={`img-raw-${stageMediaPreview.projectId}-${stageMediaPreview.pageIndex}`}
                        src={projectApi.getSlideImageUrl(stageMediaPreview.projectId, stageMediaPreview.pageIndex)}
                        alt={`第 ${stageMediaPreview.pageIndex} 页`}
                        style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain', display: 'block', margin: '0 auto' }}
                      />
                    </div>
                    <video
                      key={`video-raw-${stageMediaPreview.projectId}-${stageMediaPreview.pageIndex}`}
                      controls
                      autoPlay
                      src={projectApi.getAvatarPageVideoUrl(stageMediaPreview.projectId, stageMediaPreview.pageIndex)}
                      style={{ width: '100%', maxHeight: 360, background: '#000', borderRadius: 8 }}
                    />
                  </>
                )}
              </>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
};

export default MoocPage;

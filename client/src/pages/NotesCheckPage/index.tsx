import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Table, Tag, Button, Steps, Modal, Typography, Space, Image, Empty, message, Upload, InputNumber, Switch, Progress, Alert, Input } from 'antd';
import { WarningOutlined, ReloadOutlined, UploadOutlined, RobotOutlined, SettingOutlined, EditOutlined, ThunderboltOutlined, ColumnHeightOutlined } from '@ant-design/icons';
import { useProjectStore } from '../../stores/projectStore';
import { NoteStatus } from '../../types';
import { NOTE_STATUS_LABELS } from '../../constants';
import { projectApi, llmApi, withToken } from '../../api';

const { Title, Text, Paragraph } = Typography;

const STAGE_LABELS: Record<string, string> = {
  allocating: '分析页面复杂度，分配时长...',
  drafting: '生成解说词初稿...',
  refining: '统一优化完善...',
  checking: '字数达标检查与重试...',
  optimizing: '优化解说词（英文转中文）...',
  optimizing_notes: '优化备注（英文转中文）...',
  adjusting: '调整解说词长度...',
  done: '生成完成',
  failed: '生成失败',
  idle: '等待中',
};

const NotesCheckPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { slides, loadProject, loadSlides, reparseSlide, reimportProject, parseProject } = useProjectStore();
  const [selectedSlide, setSelectedSlide] = useState<any>(null);
  const [filter, setFilter] = useState<string>('all');
  const [isReimporting, setIsReimporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 解说词生成
  const [genModalOpen, setGenModalOpen] = useState(false);
  const [genProgress, setGenProgress] = useState<any>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [targetDuration, setTargetDuration] = useState<number>(0); // 0 = 自动
  const [useExistingNote, setUseExistingNote] = useState(true);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 单页重新生成
  const [singleGenModalOpen, setSingleGenModalOpen] = useState(false);
  const [singleGenPageIndex, setSingleGenPageIndex] = useState<number>(-1);
  const [singleGenDuration, setSingleGenDuration] = useState<number>(30); // 秒
  const [singleGenLoading, setSingleGenLoading] = useState(false);

  // 单页操作类型：generate / optimize / adjust
  const [singleActionType, setSingleActionType] = useState<'generate' | 'optimize' | 'adjust'>('generate');
  const [singleOptLoading, setSingleOptLoading] = useState(false);
  const [singleAdjLoading, setSingleAdjLoading] = useState(false);

  // 手动编辑备注
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const { TextArea } = Input;

  // 调整解说词长度
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [adjustTargetDuration, setAdjustTargetDuration] = useState<number>(10); // 分钟
  const currentTotalDuration = slides.reduce((sum: number, s: any) => sum + (s.estimatedDuration || 0), 0);

  useEffect(() => {
    if (id) {
      loadProject(id);
      loadSlides(id);
    }
  }, [id]);

  const filteredSlides = filter === 'all'
    ? slides
    : slides.filter((s: any) => s.noteStatus === filter);

  const hasFailedNotes = slides.some((s: any) =>
    s.noteStatus === NoteStatus.READ_FAILED ||
    s.noteStatus === NoteStatus.PAGE_FAILED ||
    s.noteStatus === NoteStatus.TOO_LONG
  );

  const hasNoNotes = slides.every((s: any) => s.noteStatus === NoteStatus.EMPTY);
  const hasGeneratedScripts = slides.some((s: any) => s.scriptStatus === 'generated');
  // 有备注或有生成的解说词即可继续
  const canProceed = (!hasFailedNotes && !hasNoNotes) || hasGeneratedScripts;

  // ===== 解说词生成 =====
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(async () => {
      if (!id) return;
      try {
        const res = await llmApi.getScriptProgress(id);
        const prog = res.data.data;
        setGenProgress(prog);
        // 每次轮询都刷新 slides，实时显示每页的生成/重试结果
        loadSlides(id);
        if (prog?.stage === 'done') {
          stopPolling();
          setIsGenerating(false);
          message.success('解说词生成完成');
          loadSlides(id);
        } else if (prog?.stage === 'failed') {
          stopPolling();
          setIsGenerating(false);
          message.error('解说词生成失败：' + (prog.error || '未知错误'));
        }
      } catch {
        // ignore
      }
    }, 2000);
  }, [id, stopPolling, loadSlides]);

  const handleGenerateScripts = async () => {
    if (!id) return;
    setGenModalOpen(false);
    setIsGenerating(true);
    setGenProgress({ stage: 'allocating', currentPage: 0, totalPages: slides.length });
    try {
      await llmApi.generateScripts(id, {
        targetDuration,
        useExistingNote,
      });
      startPolling();
    } catch (err: any) {
      setIsGenerating(false);
      message.error('启动生成失败：' + (err.response?.data?.error?.message || err.message));
    }
  };

  const handleSingleGenerate = async () => {
    // 兼容旧调用，转发到统一处理
    await handleSingleAction();
  };

  const openSingleGenModal = (pageIndex: number) => {
    setSingleGenPageIndex(pageIndex);
    setSingleActionType('generate');
    // 默认时长：用现有预计时长，没有则 30 秒
    const slide = slides.find((s: any) => s.pageIndex === pageIndex);
    setSingleGenDuration(slide?.estimatedDuration ? Math.round(slide.estimatedDuration) : 30);
    setSingleGenModalOpen(true);
  };

  const openSingleOptimizeModal = (pageIndex: number) => {
    setSingleGenPageIndex(pageIndex);
    setSingleActionType('optimize');
    setSingleGenModalOpen(true);
  };

  const openSingleAdjustModal = (pageIndex: number) => {
    setSingleGenPageIndex(pageIndex);
    setSingleActionType('adjust');
    // 默认时长：用现有预计时长，没有则 30 秒
    const slide = slides.find((s: any) => s.pageIndex === pageIndex);
    setSingleGenDuration(slide?.estimatedDuration ? Math.round(slide.estimatedDuration) : 30);
    setSingleGenModalOpen(true);
  };

  const handleSingleAction = async () => {
    if (!id || singleGenPageIndex < 0) return;

    if (singleActionType === 'optimize') {
      setSingleOptLoading(true);
      try {
        const res = await llmApi.optimizeSingleScript(id, singleGenPageIndex);
        message.success(`第${singleGenPageIndex + 1}页解说词已优化（${res.data.data.charCount} 字）`);
        setSingleGenModalOpen(false);
        loadSlides(id);
      } catch (err: any) {
        message.error('优化失败：' + (err.response?.data?.error?.message || err.message));
      } finally {
        setSingleOptLoading(false);
      }
      return;
    }

    if (singleActionType === 'adjust') {
      setSingleAdjLoading(true);
      try {
        const res = await llmApi.adjustSingleScriptLength(id, singleGenPageIndex, singleGenDuration);
        message.success(`第${singleGenPageIndex + 1}页解说词已调整（${res.data.data.charCount} 字）`);
        setSingleGenModalOpen(false);
        loadSlides(id);
      } catch (err: any) {
        message.error('调整失败：' + (err.response?.data?.error?.message || err.message));
      } finally {
        setSingleAdjLoading(false);
      }
      return;
    }

    // generate
    setSingleGenLoading(true);
    try {
      const res = await llmApi.generateSingleScript(id, singleGenPageIndex, singleGenDuration);
      message.success(`第${singleGenPageIndex + 1}页解说词已重新生成（${res.data.data.charCount} 字）`);
      setSingleGenModalOpen(false);
      loadSlides(id);
    } catch (err: any) {
      message.error('重新生成失败：' + (err.response?.data?.error?.message || err.message));
    } finally {
      setSingleGenLoading(false);
    }
  };

  const handleStartEdit = () => {
    if (!selectedSlide) return;
    setEditContent(selectedSlide.noteContent || '');
    setEditMode(true);
  };

  const handleCancelEdit = () => {
    setEditMode(false);
    setEditContent('');
  };

  const handleSaveEdit = async () => {
    if (!id || !selectedSlide) return;
    setEditSaving(true);
    try {
      await projectApi.updateNote(id, selectedSlide.pageIndex, editContent);
      message.success('备注已保存');
      setEditMode(false);
      // 更新弹窗内显示的内容
      setSelectedSlide({ ...selectedSlide, noteContent: editContent, noteCharCount: editContent.length, estimatedDuration: editContent.length / 5.5 });
      // 刷新表格
      loadSlides(id);
    } catch (err: any) {
      message.error('保存失败：' + (err.response?.data?.error?.message || err.message));
    } finally {
      setEditSaving(false);
    }
  };

  const handleOptimizeScripts = async () => {
    if (!id) return;
    Modal.confirm({
      title: '优化解说词',
      content: '将保留所有原内容，仅把英文术语替换为中文。优化后需要重新配音。是否继续？',
      okText: '开始优化',
      cancelText: '取消',
      onOk: async () => {
        setIsGenerating(true);
        setGenProgress({ stage: 'optimizing', currentPage: 0, totalPages: slides.length });
        try {
          await llmApi.optimizeScripts(id);
          startPolling();
        } catch (err: any) {
          setIsGenerating(false);
          message.error('启动优化失败：' + (err.response?.data?.error?.message || err.message));
        }
      },
    });
  };

  const handleOptimizeNotes = async () => {
    if (!id) return;
    Modal.confirm({
      title: '优化备注',
      content: '将保留所有原内容，仅把英文术语替换为中文。仅优化备注，不影响已生成的解说词。是否继续？',
      okText: '开始优化',
      cancelText: '取消',
      onOk: async () => {
        setIsGenerating(true);
        setGenProgress({ stage: 'optimizing_notes', currentPage: 0, totalPages: slides.length });
        try {
          await llmApi.optimizeNotes(id);
          startPolling();
        } catch (err: any) {
          setIsGenerating(false);
          message.error('启动优化失败：' + (err.response?.data?.error?.message || err.message));
        }
      },
    });
  };

  const handleAdjustLength = async () => {
    if (!id) return;
    setAdjustModalOpen(false);
    setIsGenerating(true);
    setGenProgress({ stage: 'adjusting', currentPage: 0, totalPages: slides.length });
    try {
      await llmApi.adjustScriptsLength(id, adjustTargetDuration);
      startPolling();
    } catch (err: any) {
      setIsGenerating(false);
      message.error('启动调整失败：' + (err.response?.data?.error?.message || err.message));
    }
  };

  const handleCancelGeneration = async () => {
    if (!id) return;
    try {
      await llmApi.cancelScriptGeneration(id);
      message.info('已取消重试，使用当前结果');
      // 不立即停止轮询，等后端返回 done
    } catch (err: any) {
      message.error('取消失败：' + (err.response?.data?.error?.message || err.message));
    }
  };

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const handleReparse = async (pageIndex: number) => {
    if (!id) return;
    try {
      await reparseSlide(id, pageIndex);
      message.success('重新读取成功');
    } catch {
      message.error('重新读取失败');
    }
  };

  const handleReimportClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleReimportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !id) return;

    if (!file.name.toLowerCase().endsWith('.pptx')) {
      message.error('仅支持PPTX文件');
      return;
    }

    Modal.confirm({
      title: '重新导入PPT',
      content: '重新导入将清除当前备注和配音状态，是否确认？',
      okText: '确认重新导入',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setIsReimporting(true);
        try {
          await reimportProject(id, file);
          message.success('文件已替换，正在重新解析...');
          await parseProject(id);
          message.success('重新解析成功');
        } catch (error: any) {
          message.error('重新导入失败：' + (error.response?.data?.error?.message || error.message));
        } finally {
          setIsReimporting(false);
          // Reset file input
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }
      },
      onCancel: () => {
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      },
    });
  };

  const columns = [
    {
      title: '页码',
      dataIndex: 'pageIndex',
      key: 'pageIndex',
      width: 80,
    },
    {
      title: '缩略图',
      dataIndex: 'pageIndex',
      key: 'thumbnail',
      width: 120,
      render: (pageIndex: number) => (
        <Image
          src={id ? withToken(`/api/v1/projects/${id}/slides/${pageIndex}/thumbnail`) : ''}
          width={100}
          height={56}
          style={{ objectFit: 'cover', borderRadius: 4, cursor: 'pointer' }}
          preview={false}
          fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88P/BfwAJhAPk2iMa1AAAAABJRU5ErkJggg=="
          onClick={() => {
            const slide = slides.find((s: any) => s.pageIndex === pageIndex);
            if (slide) setSelectedSlide(slide);
          }}
        />
      ),
    },
    {
      title: '备注状态',
      dataIndex: 'noteStatus',
      key: 'noteStatus',
      width: 120,
      render: (status: string) => {
        const label = NOTE_STATUS_LABELS[status] || { text: status, color: 'default' };
        return <Tag color={label.color}>{label.text}</Tag>;
      },
    },
    {
      title: '备注内容',
      dataIndex: 'noteContent',
      key: 'noteContent',
      ellipsis: true,
      render: (text: string | null) => text || <Text type="secondary">-</Text>,
    },
    {
      title: '字数',
      dataIndex: 'noteCharCount',
      key: 'noteCharCount',
      width: 80,
    },
    {
      title: '预计时长',
      dataIndex: 'estimatedDuration',
      key: 'estimatedDuration',
      width: 100,
      render: (duration: number) => duration > 0 ? `${duration.toFixed(1)}s` : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 280,
      render: (_: any, record: any) => (
        <Space size="small" wrap>
          {record.noteStatus === NoteStatus.READ_FAILED || record.noteStatus === NoteStatus.PAGE_FAILED
            ? <Button size="small" icon={<ReloadOutlined />} onClick={() => handleReparse(record.pageIndex)}>重试</Button>
            : null}
          <Button
            size="small"
            type="link"
            icon={<RobotOutlined />}
            onClick={() => openSingleGenModal(record.pageIndex)}
            disabled={isGenerating || singleGenLoading || singleOptLoading || singleAdjLoading}
          >
            重新生成
          </Button>
          {record.noteStatus === NoteStatus.LOADED && (
            <>
              <Button
                size="small"
                type="link"
                icon={<ThunderboltOutlined />}
                onClick={() => openSingleOptimizeModal(record.pageIndex)}
                disabled={isGenerating || singleGenLoading || singleOptLoading || singleAdjLoading}
              >
                优化
              </Button>
              <Button
                size="small"
                type="link"
                icon={<ColumnHeightOutlined />}
                onClick={() => openSingleAdjustModal(record.pageIndex)}
                disabled={isGenerating || singleGenLoading || singleOptLoading || singleAdjLoading}
              >
                调整长度
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px' }}>
      <Steps
        current={1}
        items={[
          { title: '导入PPT' },
          { title: '读取备注' },
          { title: '选择音色' },
          { title: '生成配音' },
          { title: '生成数字人' },
          { title: '视频预览' },
          { title: '编辑导出' },
        ]}
        style={{ marginBottom: 24 }}
      />

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Title level={4} style={{ margin: 0 }}>备注检查</Title>
          <Space>
            <Button
              icon={<RobotOutlined />}
              onClick={() => setGenModalOpen(true)}
              disabled={isGenerating}
              loading={isGenerating}
            >
              {hasGeneratedScripts ? '重新生成解说词' : '生成解说词'}
            </Button>
            {!hasNoNotes && (
              <Button
                icon={<ThunderboltOutlined />}
                onClick={handleOptimizeNotes}
                disabled={isGenerating}
              >
                优化备注
              </Button>
            )}
            {hasGeneratedScripts && (
              <Button
                icon={<ThunderboltOutlined />}
                onClick={handleOptimizeScripts}
                disabled={isGenerating}
              >
                优化解说词
              </Button>
            )}
            {hasGeneratedScripts && (
              <Button
                icon={<ColumnHeightOutlined />}
                onClick={() => setAdjustModalOpen(true)}
                disabled={isGenerating}
              >
                调整长度
              </Button>
            )}
            <Button
              icon={<UploadOutlined />}
              onClick={handleReimportClick}
              loading={isReimporting}
            >
              重新导入PPT
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pptx"
              style={{ display: 'none' }}
              onChange={handleReimportFile}
            />
            {['all', 'loaded', 'empty', 'read_failed'].map(f => (
              <Button
                key={f}
                size="small"
                type={filter === f ? 'primary' : 'default'}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? '全部' : f === 'loaded' ? '已读取' : f === 'empty' ? '无备注' : '读取失败'}
              </Button>
            ))}
          </Space>
        </div>

        {/* 生成进度 */}
        {isGenerating && genProgress && (
          <Alert
            type="info"
            style={{ marginBottom: 16 }}
            message={
              <div>
                <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <Text strong>{STAGE_LABELS[genProgress.stage] || '处理中...'}</Text>
                    {genProgress.totalPages > 0 && (
                      <Text type="secondary" style={{ marginLeft: 12 }}>
                        {Math.min(genProgress.currentPage + 1, genProgress.totalPages)} / {genProgress.totalPages} 页
                      </Text>
                    )}
                  </div>
                  {genProgress.stage === 'checking' && (
                    <Button size="small" onClick={handleCancelGeneration}>
                      跳过重试，使用当前结果
                    </Button>
                  )}
                </div>
                {genProgress.totalPages > 0 && (
                  <Progress
                    percent={Math.round(((genProgress.currentPage + 1) / genProgress.totalPages) * 100)}
                    status="active"
                    size="small"
                  />
                )}
              </div>
            }
          />
        )}

        {hasNoNotes && !hasGeneratedScripts ? (
          <Empty description="未读取到PPT备注">
            <Space direction="vertical">
              <Button type="primary" icon={<RobotOutlined />} onClick={() => setGenModalOpen(true)} disabled={isGenerating}>
                用大模型生成解说词
              </Button>
              <Button onClick={() => navigate('/ppt')}>重新导入PPT</Button>
            </Space>
          </Empty>
        ) : (
          <Table
            dataSource={filteredSlides}
            columns={columns}
            rowKey="pageIndex"
            pagination={false}
            size="middle"
            summary={(data) => {
              const totalDuration = data.reduce((sum, r: any) => sum + (r.estimatedDuration || 0), 0);
              const totalChars = data.reduce((sum, r: any) => sum + (r.noteCharCount || 0), 0);
              if (totalDuration === 0) return null;
              const mins = Math.floor(totalDuration / 60);
              const secs = Math.round(totalDuration % 60);
              return (
                <Table.Summary fixed>
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                    <Table.Summary.Cell index={1} />
                    <Table.Summary.Cell index={2}>{totalChars} 字</Table.Summary.Cell>
                    <Table.Summary.Cell index={3}>
                      <Text strong style={{ color: '#1677ff' }}>
                        {totalDuration.toFixed(1)}s
                      </Text>
                      <Text type="secondary" style={{ marginLeft: 8 }}>
                        （约 {mins}:{secs.toString().padStart(2, '0')}）
                      </Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={4} />
                  </Table.Summary.Row>
                </Table.Summary>
              );
            }}
          />
        )}

        <div style={{ marginTop: 24, textAlign: 'center' }}>
          {hasFailedNotes && (
            <Text type="warning" style={{ display: 'block', marginBottom: 8 }}>
              <WarningOutlined /> 存在备注读取失败的页面，请处理后再继续
            </Text>
          )}
          <Space>
            <Button size="large" onClick={() => navigate('/ppt')}>上一步</Button>
            <Button
              type="primary"
              size="large"
              disabled={!canProceed}
              onClick={() => navigate(`/project/${id}/voice`)}
            >
              下一步：选择音色
            </Button>
          </Space>
        </div>
      </Card>

      <Modal
        title={`第 ${selectedSlide?.pageIndex + 1} 页`}
        open={!!selectedSlide}
        onCancel={() => { setSelectedSlide(null); setEditMode(false); }}
        footer={
          editMode ? (
            <Space>
              <Button onClick={handleCancelEdit}>取消</Button>
              <Button type="primary" onClick={handleSaveEdit} loading={editSaving}>保存</Button>
            </Space>
          ) : (
            <Space>
              <Button onClick={() => { setSelectedSlide(null); setEditMode(false); }}>关闭</Button>
              <Button type="primary" icon={<EditOutlined />} onClick={handleStartEdit}>编辑备注</Button>
            </Space>
          )
        }
        width={700}
      >
        {selectedSlide && (
          <div>
            <Image
              src={id ? withToken(`/api/v1/projects/${id}/slides/${selectedSlide.pageIndex}/image`) : ''}
              style={{ width: '100%', marginBottom: 16 }}
              fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88P/BfwAJhAPk2iMa1AAAAABJRU5ErkJggg=="
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Title level={5} style={{ margin: 0 }}>备注内容</Title>
              {!editMode && (
                <Space size="large">
                  <Text type="secondary">字数：{selectedSlide.noteCharCount || 0}</Text>
                  <Text type="secondary">预计时长：{selectedSlide.estimatedDuration ? selectedSlide.estimatedDuration.toFixed(1) : '0.0'}s</Text>
                </Space>
              )}
            </div>
            {editMode ? (
              <div>
                <TextArea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={10}
                  placeholder="请输入备注内容..."
                  style={{ marginBottom: 8 }}
                />
                <Space>
                  <Text type="secondary">字数：{editContent.length}</Text>
                  <Text type="secondary">预计时长：{(editContent.length / 5.5).toFixed(1)}s</Text>
                </Space>
              </div>
            ) : (
              <Paragraph>{selectedSlide.noteContent || '（无备注）'}</Paragraph>
            )}
          </div>
        )}
      </Modal>

      {/* 生成解说词设置弹窗 */}
      <Modal
        title="生成解说词"
        open={genModalOpen}
        onOk={handleGenerateScripts}
        onCancel={() => setGenModalOpen(false)}
        okText="开始生成"
        cancelText="取消"
        width={480}
      >
        <div style={{ marginTop: 16 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="系统将使用多模态大模型识别 PPT 图片内容，生成口语化解说词。"
            description="第一阶段：逐页识别图片生成初稿；第二阶段：统一优化完善。"
          />
          <div style={{ marginBottom: 16 }}>
            <Text strong>目标总时长（分钟）</Text>
            <div style={{ marginTop: 8 }}>
              <Space>
                <InputNumber
                  min={0}
                  max={120}
                  step={1}
                  value={targetDuration}
                  onChange={(v) => setTargetDuration(v || 0)}
                  style={{ width: 120 }}
                  addonAfter="分钟"
                />
                <Text type="secondary">设为 0 则根据备注长度自动估算</Text>
              </Space>
            </div>
            {targetDuration > 0 && (
              <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                将根据每页复杂度动态分配时长（非平均分配），总计约 {targetDuration} 分钟
              </Text>
            )}
          </div>
          <div style={{ marginBottom: 16 }}>
            <Text strong>参考已有备注</Text>
            <div style={{ marginTop: 8 }}>
              <Space>
                <Switch checked={useExistingNote} onChange={setUseExistingNote} />
                <Text type="secondary">{useExistingNote ? '将备注作为生成参考' : '仅根据图片内容生成'}</Text>
              </Space>
            </div>
          </div>
          <Alert
            type="warning"
            showIcon
            message="生成后将覆盖现有备注内容，并需要重新配音。"
          />
        </div>
      </Modal>

      {/* 单页操作弹窗（生成/优化/调整长度） */}
      <Modal
        title={
          singleActionType === 'generate' ? `重新生成第 ${singleGenPageIndex + 1} 页解说词`
          : singleActionType === 'optimize' ? `优化第 ${singleGenPageIndex + 1} 页解说词`
          : `调整第 ${singleGenPageIndex + 1} 页解说词长度`
        }
        open={singleGenModalOpen}
        onOk={handleSingleAction}
        onCancel={() => setSingleGenModalOpen(false)}
        okText={
          singleActionType === 'generate' ? '生成'
          : singleActionType === 'optimize' ? '优化'
          : '调整'
        }
        cancelText="取消"
        confirmLoading={singleGenLoading || singleOptLoading || singleAdjLoading}
        width={420}
      >
        <div style={{ marginTop: 16 }}>
          {singleActionType === 'optimize' ? (
            <Alert
              type="info"
              showIcon
              message="将保留原内容，仅把英文术语替换为中文。"
            />
          ) : (
            <>
              <Text strong>目标讲解时长</Text>
              <div style={{ marginTop: 8 }}>
                <Space>
                  <InputNumber
                    min={5}
                    max={600}
                    step={5}
                    value={singleGenDuration}
                    onChange={(v) => setSingleGenDuration(v || 30)}
                    style={{ width: 120 }}
                    addonAfter="秒"
                  />
                  <Text type="secondary">
                    约 {Math.round(singleGenDuration * 5.5)} 字
                  </Text>
                </Space>
              </div>
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 16 }}
                message={
                  singleActionType === 'generate'
                    ? '将使用多模态大模型根据 PPT 图片重新生成此页解说词。'
                    : '将根据目标时长对现有解说词进行扩写或缩写，保留核心信息。'
                }
              />
            </>
          )}
        </div>
      </Modal>

      {/* 调整长度弹窗 */}
      <Modal
        title="调整解说词长度"
        open={adjustModalOpen}
        onOk={handleAdjustLength}
        onCancel={() => setAdjustModalOpen(false)}
        okText="开始调整"
        cancelText="取消"
        width={460}
      >
        <div style={{ marginTop: 16 }}>
          <Text strong>目标总时长</Text>
          <div style={{ marginTop: 8 }}>
            <Space>
              <InputNumber
                min={1}
                max={120}
                step={1}
                value={adjustTargetDuration}
                onChange={(v) => setAdjustTargetDuration(v || 10)}
                style={{ width: 140 }}
                addonAfter="分钟"
              />
              <Text type="secondary">
                约 {Math.round(adjustTargetDuration * 60 * 5.5)} 字
              </Text>
            </Space>
          </div>
          <div style={{ marginTop: 16, padding: 12, background: '#fafafa', borderRadius: 6 }}>
            <Space direction="vertical" size={4}>
              <Text type="secondary">当前总时长：{(currentTotalDuration / 60).toFixed(1)} 分钟（{Math.round(currentTotalDuration * 5.5)} 字）</Text>
              <Text type="secondary">目标总时长：{adjustTargetDuration} 分钟（{Math.round(adjustTargetDuration * 60 * 5.5)} 字）</Text>
              <Text type={adjustTargetDuration * 60 > currentTotalDuration ? 'success' : 'warning'}>
                {adjustTargetDuration * 60 > currentTotalDuration
                  ? `将扩写约 ${Math.round((adjustTargetDuration * 60 - currentTotalDuration) * 5.5)} 字`
                  : `将缩写约 ${Math.round((currentTotalDuration - adjustTargetDuration * 60) * 5.5)} 字`}
              </Text>
            </Space>
          </div>
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 16 }}
            message="将根据各页现有内容比例分配目标字数，扩写或缩写后需要重新配音。"
          />
        </div>
      </Modal>
    </div>
  );
};

export default NotesCheckPage;

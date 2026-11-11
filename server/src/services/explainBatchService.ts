/**
 * 讲解专题：一份 PPT 拆多个知识点，各自自动生成讲解动画。
 */
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { EXPLAIN_UPLOAD_DIR, EXPLAIN_WORK_DIR, type ExplainJobRow } from './explainJobService';
import { AccessOpts, ownerInClause, ownsOrGranted } from './accessControl';

fs.mkdirSync(EXPLAIN_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(EXPLAIN_WORK_DIR, { recursive: true });

export type ExplainBatchStatus =
  | 'queued'
  | 'analyzing'
  | 'await_points'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ExplainKnowledgePoint {
  id: string;
  title: string;
  coreQuestion: string;
  summary: string;
  /** Human-readable range, e.g. "第 2–4 页" */
  sourcePages?: string;
  /** Inclusive page cluster covered by this animation */
  pageStart?: number;
  pageEnd?: number;
  /**
   * Suggested insertion: play this animation after finishing this PPT page
   * (typically = pageEnd). 0 means before the first slide.
   */
  insertAfterPage?: number;
  priority?: number;
  selected?: boolean;
  jobId?: string | null;
}

export interface ExplainBatchRow {
  id: string;
  user_id: string;
  name: string;
  source_file_name: string | null;
  source_file_path: string | null;
  topic_text: string;
  status: ExplainBatchStatus;
  stage: string;
  progress: number;
  message: string | null;
  error: string | null;
  knowledge_points_json: string | null;
  voiceover: 'none' | 'zh' | 'en';
  selected_voice_id: string | null;
  selected_model_id: string | null;
  subtitles: number;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const BATCH_STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  analyzing: '分析课件',
  await_points: '确认知识点',
  generating: '生成动画',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export class ExplainBatchService {
  constructor(private db: Database.Database) {}

  create(input: {
    userId: string;
    name: string;
    sourceFileName?: string | null;
    sourceFilePath?: string | null;
    voiceover: 'none' | 'zh' | 'en';
    voiceId?: string | null;
    modelId?: string | null;
    subtitles?: boolean;
  }): ExplainBatchRow {
    const id = uuidv4();
    const now = new Date().toISOString();
    const row: ExplainBatchRow = {
      id,
      user_id: input.userId,
      name: (input.name || '讲解专题').slice(0, 120),
      source_file_name: input.sourceFileName || null,
      source_file_path: input.sourceFilePath || null,
      topic_text: '',
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: '已入队，等待分析课件',
      error: null,
      knowledge_points_json: null,
      voiceover: input.voiceover,
      selected_voice_id: input.voiceId || null,
      selected_model_id: input.modelId || null,
      subtitles: input.subtitles ? 1 : 0,
      cancel_requested: 0,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    };
    this.db.prepare(`
      INSERT INTO explain_batches (
        id, user_id, name, source_file_name, source_file_path, topic_text,
        status, stage, progress, message, error, knowledge_points_json,
        voiceover, selected_voice_id, selected_model_id, subtitles, cancel_requested,
        created_at, updated_at, started_at, finished_at
      ) VALUES (
        @id, @user_id, @name, @source_file_name, @source_file_path, @topic_text,
        @status, @stage, @progress, @message, @error, @knowledge_points_json,
        @voiceover, @selected_voice_id, @selected_model_id, @subtitles, @cancel_requested,
        @created_at, @updated_at, @started_at, @finished_at
      )
    `).run(row);
    return row;
  }

  get(id: string): ExplainBatchRow | null {
    return (this.db.prepare('SELECT * FROM explain_batches WHERE id = ?').get(id) as ExplainBatchRow | undefined) || null;
  }

  getOwned(id: string, userId: string, opts?: AccessOpts): ExplainBatchRow | null {
    const row = this.get(id);
    if (!row || !ownsOrGranted(row.user_id, userId, opts)) return null;
    return row;
  }

  listForUser(ownerIds: string | string[], limit = 40): ExplainBatchRow[] {
    const ids = Array.isArray(ownerIds) ? ownerIds : [ownerIds];
    const { sql, params } = ownerInClause(ids);
    return this.db.prepare(
      `SELECT * FROM explain_batches WHERE user_id IN (${sql}) ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, Math.min(100, Math.max(1, limit))) as ExplainBatchRow[];
  }

  listActive(): ExplainBatchRow[] {
    return this.db.prepare(
      `SELECT * FROM explain_batches WHERE status IN ('queued','analyzing','generating') ORDER BY created_at ASC`,
    ).all() as ExplainBatchRow[];
  }

  update(id: string, patch: Partial<ExplainBatchRow>): ExplainBatchRow | null {
    const allowed = [
      'name', 'topic_text', 'status', 'stage', 'progress', 'message', 'error',
      'knowledge_points_json', 'voiceover', 'selected_voice_id', 'selected_model_id',
      'subtitles', 'cancel_requested', 'started_at', 'finished_at',
    ] as const;
    const sets: string[] = [];
    const values: any[] = [];
    for (const key of allowed) {
      if ((patch as any)[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push((patch as any)[key]);
      }
    }
    if (!sets.length) return this.get(id);
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE explain_batches SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  claimNextQueued(): ExplainBatchRow | null {
    const row = this.db.prepare(
      `SELECT * FROM explain_batches WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    ).get() as ExplainBatchRow | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    const r = this.db.prepare(`
      UPDATE explain_batches
      SET status = 'analyzing', stage = 'analyzing', progress = 5, message = '开始分析课件…',
          started_at = COALESCE(started_at, ?), updated_at = ?, error = NULL
      WHERE id = ? AND status = 'queued'
    `).run(now, now, row.id);
    if (r.changes === 0) return null;
    return this.get(row.id);
  }

  hasAnalyzing(): boolean {
    return !!this.db.prepare(
      `SELECT id FROM explain_batches WHERE status = 'analyzing' LIMIT 1`,
    ).get();
  }

  isCancelRequested(id: string): boolean {
    const row = this.db.prepare('SELECT cancel_requested FROM explain_batches WHERE id = ?').get(id) as
      | { cancel_requested: number } | undefined;
    return !!(row && Number(row.cancel_requested));
  }

  requestCancel(id: string, userId: string, opts?: AccessOpts): ExplainBatchRow | null {
    const batch = this.getOwned(id, userId, opts);
    if (!batch) return null;
    if (batch.status === 'queued' || batch.status === 'await_points') {
      return this.update(id, {
        status: 'cancelled',
        stage: 'cancelled',
        message: '已取消',
        cancel_requested: 1,
        progress: 100,
        finished_at: new Date().toISOString(),
      });
    }
    if (batch.status === 'analyzing' || batch.status === 'generating') {
      return this.update(id, { cancel_requested: 1, message: '正在请求取消…' });
    }
    return batch;
  }

  parsePoints(batch: ExplainBatchRow): ExplainKnowledgePoint[] {
    try {
      const raw = JSON.parse(batch.knowledge_points_json || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  setPoints(id: string, points: ExplainKnowledgePoint[]): ExplainBatchRow | null {
    return this.update(id, { knowledge_points_json: JSON.stringify(points) });
  }

  listChildJobs(batchId: string): ExplainJobRow[] {
    return this.db.prepare(
      `SELECT * FROM explain_jobs WHERE batch_id = ? ORDER BY created_at ASC`,
    ).all(batchId) as ExplainJobRow[];
  }

  recoverStaleAnalyzing(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE explain_batches
      SET status = 'failed', stage = 'failed',
          message = '服务重启，分析中断',
          error = '进程重启导致专题分析中断，请重新提交',
          finished_at = ?, updated_at = ?
      WHERE status = 'analyzing'
    `).run(now, now);
  }

  /** Recompute batch progress from child explain jobs. */
  refreshFromChildren(batchId: string): ExplainBatchRow | null {
    const batch = this.get(batchId);
    if (!batch || batch.status === 'cancelled') return batch;
    const children = this.listChildJobs(batchId);
    if (!children.length) return batch;

    const total = children.length;
    const completed = children.filter((j) => j.status === 'completed').length;
    const failed = children.filter((j) => j.status === 'failed' || j.status === 'cancelled').length;
    const active = children.filter((j) =>
      j.status === 'queued' || j.status === 'running' || j.status === 'await_style' || j.status === 'await_sample',
    ).length;
    const avgProgress = Math.round(children.reduce((s, j) => s + (Number(j.progress) || 0), 0) / total);
    const progress = Math.min(99, Math.max(40, avgProgress));

    if (active === 0 && completed + failed === total) {
      const allOk = failed === 0;
      return this.update(batchId, {
        status: allOk ? 'completed' : (completed > 0 ? 'completed' : 'failed'),
        stage: allOk ? 'done' : 'failed',
        progress: 100,
        message: allOk
          ? `全部 ${total} 个动画已完成`
          : `完成 ${completed}/${total}，失败 ${failed}`,
        error: failed ? `${failed} 个子任务失败` : null,
        finished_at: new Date().toISOString(),
      });
    }

    if (batch.status === 'generating' || batch.status === 'await_points') {
      const retrying = children.filter((j) =>
        j.status === 'queued' && /自动重试/.test(String(j.message || '')),
      ).length;
      return this.update(batchId, {
        status: 'generating',
        stage: 'generating',
        progress,
        message: `生成中 ${completed}/${total} 完成`
          + (failed ? `，${failed} 失败` : '')
          + (retrying ? `，${retrying} 重试中` : '')
          + (active ? `，进行中 ${active}` : ''),
      });
    }
    return batch;
  }

  publicRow(batch: ExplainBatchRow, childJobs?: ExplainJobRow[]) {
    const points = this.parsePoints(batch);
    const children = childJobs || this.listChildJobs(batch.id);
    const childMap = new Map(children.map((j) => [j.id, j]));
    return {
      id: batch.id,
      name: batch.name,
      sourceFileName: batch.source_file_name,
      topicText: batch.topic_text,
      status: batch.status,
      stage: batch.stage,
      stageLabel: BATCH_STAGE_LABEL[batch.stage] || batch.stage,
      progress: batch.progress,
      message: batch.message,
      error: batch.error,
      voiceover: batch.voiceover,
      selectedVoiceId: batch.selected_voice_id,
      selectedModelId: batch.selected_model_id,
      subtitles: !!batch.subtitles,
      knowledgePoints: points.map((p) => {
        const pageStart = Number(p.pageStart) || undefined;
        const pageEnd = Number(p.pageEnd) || pageStart;
        const insertAfterPage = Number.isFinite(Number(p.insertAfterPage))
          ? Number(p.insertAfterPage)
          : (pageEnd || undefined);
        const sourcePages = p.sourcePages
          || (pageStart && pageEnd
            ? (pageStart === pageEnd ? `第 ${pageStart} 页` : `第 ${pageStart}–${pageEnd} 页`)
            : undefined);
        return {
          ...p,
          pageStart,
          pageEnd,
          insertAfterPage,
          sourcePages,
          insertHint: insertAfterPage != null
            ? (insertAfterPage <= 0
              ? '建议插入：课件开头（第 1 页之前）'
              : `建议插入：讲完第 ${insertAfterPage} 页之后`)
            : null,
          jobId: p.jobId || null,
          jobStatus: p.jobId ? childMap.get(p.jobId)?.status || null : null,
          jobProgress: p.jobId ? childMap.get(p.jobId)?.progress ?? null : null,
          jobMessage: p.jobId ? childMap.get(p.jobId)?.message || null : null,
          hasFinal: !!(p.jobId && childMap.get(p.jobId)?.final_path),
        };
      }),
      childCount: children.length,
      completedCount: children.filter((j) => j.status === 'completed').length,
      failedCount: children.filter((j) => j.status === 'failed' || j.status === 'cancelled').length,
      createdAt: batch.created_at,
      updatedAt: batch.updated_at,
      startedAt: batch.started_at,
      finishedAt: batch.finished_at,
    };
  }

  /** Work dir helper for uploads already under explain-uploads. */
  static uploadDir() {
    return EXPLAIN_UPLOAD_DIR;
  }
}

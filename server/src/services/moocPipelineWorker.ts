import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { ProjectService } from './projectService';
import { PptParserService } from './pptParser';
import { ScriptGeneratorService } from './scriptGenerator';
import { VoiceboxAdapter } from './voiceboxAdapter';
import { VideoComposerService } from './videoComposer';
import { SystemSettingsService } from './systemSettingsService';
import { generateAllInBackground } from './dubbingGenerator';
import {
  startDubbingProgress,
  getDubbingProgress,
  markDubbingCancelled,
} from './dubbingProgress';
import { generateProjectAvatars, isProjectAvatarRunning } from './projectAvatarWorker';
import { getProjectAvatarProgress } from './projectAvatarProgress';
import { requestCancel } from './jobCancel';
import { ensureVoiceboxRunningForAudio } from './avatarWorker';
import {
  MoocJobService,
  STAGE_LABEL_CN,
  type MoocCheckpoint,
  type MoocJobRow,
  type MoocJobStage,
} from './moocJobService';
import type { ExplainBatchService } from './explainBatchService';
import type { ExplainJobService } from './explainJobService';
import { runMoocExplainInsert, type ExplainInsertClip } from './moocExplainBridge';
import { attachAvatarsToExplainInserts } from './moocExplainAvatar';
import { recordMoocStageEvent } from './moocProgressDetail';

export interface MoocPipelineDeps {
  db: Database.Database;
  moocJobs: MoocJobService;
  projectService: ProjectService;
  pptParser: PptParserService;
  scriptGenerator: ScriptGeneratorService;
  voicebox: VoiceboxAdapter;
  videoComposer: VideoComposerService;
  systemSettings: SystemSettingsService;
  explainBatches?: ExplainBatchService;
  explainJobs?: ExplainJobService;
}

const CHECKPOINT_ORDER: MoocCheckpoint[] = [
  'none', 'created', 'parsed', 'scripted', 'dubbed', 'avatar',
  'explain_points', 'explain_ready', 'composed',
];

function checkpointAtLeast(current: MoocCheckpoint | string | null | undefined, target: MoocCheckpoint): boolean {
  const a = CHECKPOINT_ORDER.indexOf((current as MoocCheckpoint) || 'none');
  const b = CHECKPOINT_ORDER.indexOf(target);
  return a >= b;
}

let deps: MoocPipelineDeps | null = null;
let pumping = false;

export function initMoocPipeline(d: MoocPipelineDeps) {
  deps = d;
  d.moocJobs.recoverStaleRunning();
  setTimeout(() => pumpMoocQueue(), 1500);
}

export function pumpMoocQueue() {
  if (!deps) return;
  if (pumping) return;
  if (deps.moocJobs.hasRunning()) {
    deps.moocJobs.annotateQueuedWaiting();
    return;
  }

  const job = deps.moocJobs.claimNextQueued();
  if (!job) return;

  pumping = true;
  runMoocJob(job)
    .catch((err) => {
      console.error('[MOOC] Unhandled job error:', err?.message || err);
      deps?.moocJobs.handleFailureWithRetry(
        job.id,
        (job.stage as MoocJobStage) || 'creating',
        String(err?.message || err),
      );
    })
    .finally(() => {
      pumping = false;
      // Slightly longer gap after a job ends so auto-retry / next job breathe
      setTimeout(() => pumpMoocQueue(), 1500);
    });
}

function throwIfCancel(jobId: string) {
  if (deps!.moocJobs.isCancelRequested(jobId)) {
    const err = new Error('CANCELLED');
    (err as any).code = 'CANCELLED';
    throw err;
  }
}

/** Infer checkpoint from project state when DB checkpoint is missing (legacy jobs). */
function inferCheckpoint(projectId: string, projectService: ProjectService, enableAvatar: boolean): MoocCheckpoint {
  const project = projectService.getProject(projectId) as any;
  if (!project) return 'none';
  if (project.video_status === 'success' && project.video_file_path) return 'composed';

  const slides = projectService.getSlides(projectId) as any[];
  if (!slides.length) {
    if (project.parse_status === 'success' || project.parse_status === 'partial') return 'parsed';
    return 'created';
  }

  const noteSlides = slides.filter((s) => s.note_status === 'loaded' && s.note_content);
  const allDubbed = noteSlides.length > 0 && noteSlides.every((s) => s.dubbing_status === 'generated');

  if (enableAvatar && allDubbed) {
    const wanted = slides.filter((s) => s.avatar_enabled !== 0 && s.avatar_status !== 'skipped');
    const avatarDone = wanted.length === 0 || wanted.every(
      (s) => s.avatar_status === 'generated' || s.avatar_status === 'skipped',
    );
    if (avatarDone) return 'avatar';
  }

  if (allDubbed) return enableAvatar ? 'dubbed' : 'avatar'; // skip avatar checkpoint gate
  if (noteSlides.length > 0) return 'scripted';
  if (project.parse_status === 'success' || project.parse_status === 'partial') return 'parsed';
  return 'created';
}

async function runMoocJob(job: MoocJobRow) {
  const d = deps!;
  const config = d.moocJobs.parseConfig(job);
  let projectId: string | null = job.project_id;
  let checkpoint: MoocCheckpoint = (job.checkpoint as MoocCheckpoint) || 'none';
  let currentStage: MoocJobStage = 'creating';

  // Legacy / interrupted jobs: recover checkpoint from project artifacts
  if (projectId && (checkpoint === 'none' || !job.checkpoint)) {
    const inferred = inferCheckpoint(projectId, d.projectService, !!config.enableAvatar);
    if (inferred !== 'none') {
      checkpoint = inferred;
      d.moocJobs.updateJob(job.id, { checkpoint: inferred });
      console.log(`[MOOC] Job ${job.id} inferred checkpoint=${inferred} from project ${projectId}`);
    }
  }

  const CHECKPOINT_STAGE: Partial<Record<MoocCheckpoint, string>> = {
    created: 'creating',
    parsed: 'parsing',
    scripted: 'script',
    dubbed: 'dubbing',
    avatar: 'avatar',
    explain_points: 'explain_points',
    explain_ready: 'explain_gen',
    composed: 'compose',
  };

  const beginStage = (stageId: string) => {
    recordMoocStageEvent(d.moocJobs, job.id, stageId, 'start');
  };

  const setProgress = (stage: MoocJobStage, progress: number, message: string) => {
    currentStage = stage;
    d.moocJobs.updateJob(job.id, { stage, progress, message });
  };

  const markCheckpoint = (
    cp: MoocCheckpoint,
    progress: number,
    message: string,
    opts?: { skip?: boolean },
  ) => {
    checkpoint = cp;
    d.moocJobs.updateJob(job.id, { checkpoint: cp, progress, message });
    const stageId = CHECKPOINT_STAGE[cp];
    if (stageId) {
      const skip = opts?.skip ?? /跳过|未启用|未就绪/.test(message);
      recordMoocStageEvent(d.moocJobs, job.id, stageId, skip ? 'skip' : 'end', message);
    }
  };

  const fail = (stage: MoocJobStage, detailed: string) => {
    d.moocJobs.handleFailureWithRetry(job.id, stage, detailed);
  };

  try {
    throwIfCancel(job.id);

    // ── 1) Create project ──────────────────────────────────────────
    if (!checkpointAtLeast(checkpoint, 'created')) {
      beginStage('creating');
      setProgress('creating', 5, '创建项目…');
      if (!fs.existsSync(job.file_path)) {
        throw Object.assign(new Error('上传的 PPTX 文件不存在，请重新提交任务'), { stage: 'creating' });
      }
      const project = d.projectService.createProject(
        job.file_name,
        fs.statSync(job.file_path).size,
        job.file_path,
        job.user_id,
      );
      projectId = project.id;
      d.moocJobs.updateJob(job.id, { project_id: projectId });
      markCheckpoint('created', 8, '项目已创建');
    } else {
      projectId = job.project_id;
      if (!projectId || !d.projectService.getProject(projectId)) {
        // Lost project — force recreate
        checkpoint = 'none';
        beginStage('creating');
        setProgress('creating', 5, '原项目丢失，重新创建…');
        const project = d.projectService.createProject(
          job.file_name,
          fs.statSync(job.file_path).size,
          job.file_path,
          job.user_id,
        );
        projectId = project.id;
        d.moocJobs.updateJob(job.id, { project_id: projectId, checkpoint: 'created' });
        checkpoint = 'created';
        recordMoocStageEvent(d.moocJobs, job.id, 'creating', 'end', '项目已重建');
      } else {
        setProgress('creating', 8, '断点续跑：跳过创建项目');
      }
    }

    const layout = config.avatarLayout || { x: 0.72, y: 0.52, w: 0.25, h: 0.444 };
    d.projectService.updateProject(projectId!, {
      selected_voice_id: config.selectedVoiceId,
      selected_model_id: config.selectedModelId,
      allow_silent_pages: config.allowSilentPages ? 1 : 0,
      default_silent_page_duration: config.defaultSilentPageDuration,
      avatar_drive_mode: config.avatarDriveMode,
      avatar_ref_video_id: config.enableAvatar && config.avatarDriveMode === 'video'
        ? (config.avatarRefVideoId || null)
        : null,
      avatar_photo_path: config.enableAvatar && config.avatarDriveMode === 'photo'
        ? (config.avatarPhotoPath || null)
        : null,
      avatar_layout_json: JSON.stringify(layout),
    });

    if (config.enableAvatar && config.avatarDriveMode === 'photo' && config.avatarPhotoPath) {
      const projectDir = path.resolve(process.cwd(), '..', 'data', 'projects', projectId!);
      fs.mkdirSync(projectDir, { recursive: true });
      const dest = path.join(projectDir, `avatar_photo${path.extname(config.avatarPhotoPath) || '.jpg'}`);
      const p = d.projectService.getProject(projectId!) as any;
      if ((!p?.avatar_photo_path || !fs.existsSync(p.avatar_photo_path)) && fs.existsSync(config.avatarPhotoPath)) {
        fs.copyFileSync(config.avatarPhotoPath, dest);
        d.projectService.updateProject(projectId!, { avatar_photo_path: dest, avatar_drive_mode: 'photo' });
      }
    }

    throwIfCancel(job.id);

    // ── 2) Parse ───────────────────────────────────────────────────
    if (!checkpointAtLeast(checkpoint, 'parsed')) {
      beginStage('parsing');
      setProgress('parsing', 12, '解析 PPT…');
      await d.pptParser.parsePpt(projectId!);
      markCheckpoint('parsed', 20, 'PPT 解析完成');
    } else {
      setProgress('parsing', 20, '断点续跑：跳过解析');
    }
    throwIfCancel(job.id);

    // ── 3) Scripts ─────────────────────────────────────────────────
    if (!checkpointAtLeast(checkpoint, 'scripted')) {
      beginStage('script');
      setProgress('script', 25, '生成解说词…');
      const targetSec = config.targetDurationMin > 0 ? config.targetDurationMin * 60 : 0;
      await d.scriptGenerator.generateScripts(
        projectId!,
        targetSec,
        config.useExistingNote !== false,
        job.user_id,
      );
      const slidesAfterScript = d.projectService.getSlides(projectId!) as any[];
      for (const s of slidesAfterScript) {
        if (s.note_content && s.note_status !== 'loaded') {
          d.projectService.updateSlide(projectId!, s.page_index, {
            note_status: 'loaded',
            note_char_count: s.note_content.length,
          });
        }
      }
      markCheckpoint('scripted', 40, '解说词生成完成');
    } else {
      setProgress('script', 40, '断点续跑：跳过解说词');
    }
    throwIfCancel(job.id);

    // ── 4) Dubbing ─────────────────────────────────────────────────
    if (!checkpointAtLeast(checkpoint, 'dubbed')) {
      beginStage('dubbing');
      setProgress('dubbing', 45, '生成配音…');
      try {
        await ensureVoiceboxRunningForAudio();
      } catch (err: any) {
        throw Object.assign(
          new Error(`Voicebox 未就绪，无法配音：${err?.message || err}`),
          { stage: 'dubbing' },
        );
      }
      const projectFresh = d.projectService.getProject(projectId!) as any;
      const slides = d.projectService.getSlides(projectId!) as any[];
      const noteSlides = slides.filter((s) => s.note_status === 'loaded' && s.note_content);
      if (!noteSlides.length) {
        throw Object.assign(new Error('没有可配音的页面（解说词为空）'), { stage: 'dubbing' });
      }
      if (!config.selectedVoiceId || !config.selectedModelId) {
        throw Object.assign(new Error('未选择音色或配音模型'), { stage: 'dubbing' });
      }

      // Only regenerate pages that are not yet generated (resume-friendly)
      const toGenerate = noteSlides.filter((s) => s.dubbing_status !== 'generated');
      for (const slide of toGenerate) {
        if (slide.dubbing_status === 'failed' || slide.dubbing_status === 'generating') {
          d.projectService.updateSlide(projectId!, slide.page_index, {
            dubbing_status: 'pending',
            dubbing_error: null,
          });
        }
      }

      if (toGenerate.length === 0) {
        markCheckpoint('dubbed', 70, '配音已全部完成（跳过）');
      } else {
        const concurrency = d.systemSettings.getDubbingConcurrency();
        startDubbingProgress(projectId!, toGenerate.length, concurrency);

        const cancelWatcher = setInterval(() => {
          if (d.moocJobs.isCancelRequested(job.id)) {
            markDubbingCancelled(projectId!);
          }
          const prog = getDubbingProgress(projectId!);
          if (prog && prog.totalToGenerate > 0) {
            const done = (prog.completedCount || 0) + (prog.failedCount || 0);
            const ratio = Math.min(1, done / prog.totalToGenerate);
            const pct = 45 + Math.round(ratio * 25);
            d.moocJobs.updateJob(job.id, {
              progress: pct,
              message: prog.message || `配音中 ${prog.completedCount || 0}/${prog.totalToGenerate}`,
            });
          }
        }, 2000);

        try {
          // Pass only pending slides so generated ones are kept
          const pending = (d.projectService.getSlides(projectId!) as any[])
            .filter((s) => s.note_status === 'loaded' && s.note_content && s.dubbing_status !== 'generated');
          await generateAllInBackground(
            projectId!,
            pending,
            config.selectedVoiceId,
            config.selectedModelId,
            d.voicebox,
            d.projectService,
            d.videoComposer,
            projectFresh,
            d.systemSettings,
            concurrency,
          );
        } finally {
          clearInterval(cancelWatcher);
        }

        throwIfCancel(job.id);

        const afterDub = d.projectService.getSlides(projectId!) as any[];
        const dubbedNeeded = afterDub.filter((s) => s.note_status === 'loaded' && s.note_content);
        const failedDub = dubbedNeeded.filter((s) => s.dubbing_status !== 'generated');
        if (failedDub.length) {
          const details = failedDub.slice(0, 8).map((s) => {
            const err = (s.dubbing_error || '未知错误').replace(/\s+/g, ' ').slice(0, 120);
            return `第${s.page_index}页：${err}`;
          }).join('\n');
          const more = failedDub.length > 8 ? `\n…另有 ${failedDub.length - 8} 页失败` : '';
          throw Object.assign(
            new Error(`配音失败 ${failedDub.length}/${dubbedNeeded.length} 页\n${details}${more}`),
            { stage: 'dubbing' },
          );
        }
        markCheckpoint('dubbed', 70, '配音全部完成');
      }
    } else {
      setProgress('dubbing', 70, '断点续跑：跳过配音');
    }
    throwIfCancel(job.id);

    const afterDubAll = d.projectService.getSlides(projectId!) as any[];
    const dubbed = afterDubAll.filter((s) => s.note_status === 'loaded' && s.dubbing_status === 'generated');

    // ── 5) Avatar ──────────────────────────────────────────────────
    if (config.enableAvatar) {
      if (!checkpointAtLeast(checkpoint, 'avatar')) {
        beginStage('avatar');
        setProgress('avatar', 75, '生成数字人…');
        if (config.avatarDriveMode === 'video' && !config.avatarRefVideoId) {
          throw Object.assign(new Error('已启用数字人但未选择参考视频'), { stage: 'avatar' });
        }
        if (config.avatarDriveMode === 'photo') {
          const p = d.projectService.getProject(projectId!) as any;
          if (!p?.avatar_photo_path || !fs.existsSync(p.avatar_photo_path)) {
            throw Object.assign(new Error('已启用数字人但未上传静照'), { stage: 'avatar' });
          }
        }

        const allDubbedIndexes = dubbed.map((s) => s.page_index);
        const wanted = config.avatarFirstPageOnly
          ? new Set([1])
          : Array.isArray(config.avatarPageIndexes) && config.avatarPageIndexes.length
            ? new Set(config.avatarPageIndexes.map(Number))
            : null;

        // Resume: only pages that still need avatar
        let pageIndexes = wanted
          ? allDubbedIndexes.filter((p) => wanted.has(p))
          : allDubbedIndexes;

        const slidesNow = d.projectService.getSlides(projectId!) as any[];
        pageIndexes = pageIndexes.filter((p) => {
          const s = slidesNow.find((x) => x.page_index === p);
          return !s || s.avatar_status !== 'generated';
        });

        if (wanted) {
          for (const s of dubbed) {
            if (!wanted.has(s.page_index)) {
              d.projectService.updateSlide(projectId!, s.page_index, {
                avatar_enabled: 0,
                avatar_status: 'skipped',
                avatar_visible: 0,
              });
            }
          }
        }

        if (!pageIndexes.length) {
          markCheckpoint('avatar', 88, '数字人已完成（跳过）');
        } else {
          const avatarPoll = setInterval(() => {
            if (d.moocJobs.isCancelRequested(job.id)) {
              requestCancel('avatar', projectId!);
            }
            const ap = getProjectAvatarProgress(projectId!);
            if (ap.status === 'running') {
              d.moocJobs.updateJob(job.id, {
                progress: 75 + Math.round((ap.percent || 0) * 0.1),
                message: ap.message || `数字人 ${ap.completed}/${ap.total}`,
              });
            }
          }, 2000);

          try {
            while (isProjectAvatarRunning(projectId!)) {
              await sleep(1000);
              throwIfCancel(job.id);
            }
            await generateProjectAvatars({
              projectId: projectId!,
              userId: job.user_id,
              pageIndexes,
              projectService: d.projectService,
              db: d.db,
            });
          } finally {
            clearInterval(avatarPoll);
          }

          throwIfCancel(job.id);
          const apFinal = getProjectAvatarProgress(projectId!);
          if (apFinal.status === 'cancelled') {
            throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
          }
          if (apFinal.failed > 0 && apFinal.completed === 0) {
            const pageErrs = (apFinal.pages || [])
              .filter((p: any) => p.status === 'failed')
              .slice(0, 6)
              .map((p: any) => `第${p.pageIndex}页：${(p.error || p.message || '').slice(0, 80)}`)
              .join('\n');
            throw Object.assign(
              new Error(`数字人生成失败\n${pageErrs || apFinal.message || ''}`),
              { stage: 'avatar' },
            );
          }
          markCheckpoint('avatar', 88, '数字人生成完成');
        }
      } else {
        setProgress('avatar', 88, '断点续跑：跳过数字人');
      }
    } else if (!checkpointAtLeast(checkpoint, 'avatar')) {
      // Skip avatar stage in checkpoint so compose can resume cleanly
      markCheckpoint('avatar', 88, '未启用数字人，跳过');
    }

    throwIfCancel(job.id);

    // ── 6) Optional: knowledge-point explain inserts ────────────────
    let insertClips: ExplainInsertClip[] = [];
    let explainSummary = '';
    if (config.enableExplainInsert) {
      if (!d.explainBatches || !d.explainJobs) {
        console.warn('[MOOC] enableExplainInsert but explain services missing — skipping inserts');
        markCheckpoint('explain_ready', 88, '讲解动画服务未就绪，跳过插入');
      } else if (!checkpointAtLeast(checkpoint, 'explain_ready')) {
        const project = d.projectService.getProject(projectId!) as any;
        const projectDir = path.dirname(project.file_path);
        const pptxPath = project.file_path && fs.existsSync(project.file_path)
          ? project.file_path
          : job.file_path;
        const quality = (['720p', '1080p', '1440p'].includes(String(config.explainExportQuality))
          ? config.explainExportQuality
          : '1080p') as '720p' | '1080p' | '1440p';

        if (!checkpointAtLeast(checkpoint, 'explain_points')) {
          beginStage('explain_points');
          setProgress('explain_points', 72, '分析课件知识点…');
        } else {
          beginStage('explain_gen');
          setProgress('explain_gen', 80, '生成知识点讲解动画…');
        }

        let explainGenStarted = checkpointAtLeast(checkpoint, 'explain_points');
        try {
          const result = await runMoocExplainInsert({
            deps: {
              moocJobs: d.moocJobs,
              batches: d.explainBatches,
              explainJobs: d.explainJobs,
            },
            moocJobId: job.id,
            userId: job.user_id,
            projectId: projectId!,
            projectDir,
            pptxPath,
            pptxName: job.file_name,
            voiceId: config.selectedVoiceId,
            modelId: config.selectedModelId,
            quality,
            isCancelled: () => d.moocJobs.isCancelRequested(job.id),
            onProgress: (stage, progress, message) => {
              if (stage === 'explain_gen' && !explainGenStarted) {
                recordMoocStageEvent(d.moocJobs, job.id, 'explain_points', 'end', '知识点分析完成');
                beginStage('explain_gen');
                explainGenStarted = true;
              }
              setProgress(stage === 'explain_points' ? 'explain_points' : 'explain_gen', progress, message);
            },
          });
          insertClips = result.inserts;
          explainSummary = result.summary;

          // Reuse MOOC avatar config on knowledge-point inserts
          if (config.enableAvatar && insertClips.length) {
            setProgress('explain_gen', 86, '为知识点插片生成数字人…');
            try {
              const av = await attachAvatarsToExplainInserts({
                projectId: projectId!,
                userId: job.user_id,
                projectDir,
                inserts: insertClips,
                projectService: d.projectService,
                videoComposer: d.videoComposer,
                db: d.db,
                chromaSimilarity: config.chromaSimilarity ?? 0.28,
                isCancelled: () => d.moocJobs.isCancelRequested(job.id),
                onProgress: (message, progress) => setProgress('explain_gen', progress, message),
              });
              insertClips = av.inserts;
              // Rewrite inserts.json with avatar-composited paths
              const insertsPath = path.join(projectDir, 'explain_inserts.json');
              const summaryExtra = av.avatarApplied
                ? `（其中 ${av.avatarApplied} 段已叠数字人`
                  + (av.avatarFailed ? `，${av.avatarFailed} 段数字人失败仍用原片` : '')
                  + '）'
                : (av.avatarFailed ? `（知识点数字人失败 ${av.avatarFailed}，用原片）` : '');
              explainSummary = `${result.summary}${summaryExtra}`;
              fs.writeFileSync(insertsPath, JSON.stringify({
                summary: explainSummary,
                inserts: insertClips,
                updatedAt: new Date().toISOString(),
              }, null, 2), 'utf8');
            } catch (err: any) {
              if (err?.code === 'CANCELLED' || /CANCELLED|取消/.test(String(err?.message || ''))) {
                throw err;
              }
              console.warn(`[MOOC] Explain avatar soft-fail:`, err?.message || err);
              explainSummary = `${result.summary}（知识点数字人跳过：${String(err?.message || err).slice(0, 80)}）`;
            }
          }

          markCheckpoint('explain_points', 78, `知识点分析完成（${insertClips.length} 段待插入）`);
          markCheckpoint('explain_ready', 88, explainSummary);
        } catch (err: any) {
          if (err?.code === 'CANCELLED' || /CANCELLED|取消/.test(String(err?.message || ''))) {
            throw err;
          }
          // Soft-fail: continue compose without inserts
          explainSummary = `知识点插入跳过：${String(err?.message || err).slice(0, 160)}`;
          console.warn(`[MOOC] Explain insert soft-fail job=${job.id}:`, explainSummary);
          if (!checkpointAtLeast(checkpoint, 'explain_points')) {
            markCheckpoint('explain_points', 78, explainSummary, { skip: true });
          }
          markCheckpoint('explain_ready', 88, explainSummary, { skip: true });
        }
      } else {
        // Resume: load inserts from disk
        const project = d.projectService.getProject(projectId!) as any;
        const insertsPath = path.join(path.dirname(project.file_path), 'explain_inserts.json');
        if (fs.existsSync(insertsPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(insertsPath, 'utf8'));
            explainSummary = String(raw.summary || '');
            insertClips = (Array.isArray(raw.inserts) ? raw.inserts : [])
              .filter((c: any) => c?.videoPath && fs.existsSync(c.videoPath))
              .map((c: any) => ({
                afterPage: Number(c.afterPage) || 0,
                videoPath: String(c.videoPath),
                title: String(c.title || ''),
                explainJobId: String(c.explainJobId || ''),
              }));
          } catch { /* ignore */ }
        }
        setProgress('explain_gen', 88, explainSummary || '断点续跑：跳过讲解动画');
      }
    } else if (!checkpointAtLeast(checkpoint, 'explain_ready')) {
      // Keep checkpoint order consistent when feature is off
      markCheckpoint('explain_points', 88, '未启用知识点插入');
      markCheckpoint('explain_ready', 88, '未启用知识点插入');
    }

    throwIfCancel(job.id);

    // ── 7) Compose ─────────────────────────────────────────────────
    if (!checkpointAtLeast(checkpoint, 'composed')) {
      beginStage('compose');
      setProgress('compose', 90, insertClips.length
        ? `合成讲解视频（含 ${insertClips.length} 段知识点动画）…`
        : '合成讲解视频…');
      const slidesForCompose = d.projectService.getSlides(projectId!) as any[];
      d.projectService.updateProject(projectId!, { video_status: 'generating' });
      d.videoComposer.clearProgress(projectId!);
      d.videoComposer.writeInitialProgress(projectId!, slidesForCompose.length);

      const composePoll = setInterval(() => {
        if (d.moocJobs.isCancelRequested(job.id)) {
          d.videoComposer.forceCancelCompose(projectId!);
        }
        const vp = d.videoComposer.getProgress(projectId!);
        if (vp) {
          const ratio = vp.totalPages > 0 ? (vp.currentPage || 0) / vp.totalPages : 0;
          d.moocJobs.updateJob(job.id, {
            progress: 90 + Math.round(Math.min(9, ratio * 9)),
            message: `视频合成中（${vp.stage || ''} ${vp.currentPage || 0}/${vp.totalPages || 0}）`,
          });
        }
      }, 2000);

      try {
        await d.videoComposer.composeVideo({
          projectId: projectId!,
          slides: slidesForCompose,
          allowSilentPages: !!config.allowSilentPages,
          defaultSilentPageDuration: config.defaultSilentPageDuration || 5,
          pauseDuration: config.pauseDuration ?? 2,
          chromaSimilarity: config.chromaSimilarity ?? 0.28,
          insertClips: insertClips.map((c) => ({
            afterPage: c.afterPage,
            videoPath: c.videoPath,
            title: c.title,
          })),
        });
      } finally {
        clearInterval(composePoll);
      }

      throwIfCancel(job.id);

      const finalProject = d.projectService.getProject(projectId!) as any;
      if (finalProject?.video_status !== 'success') {
        throw Object.assign(new Error('视频合成未成功，请查看合成日志后重试'), { stage: 'compose' });
      }
      markCheckpoint('composed', 99, '视频合成完成');
    }

    const doneMessage = explainSummary
      ? `MOOC 视频已生成（${explainSummary}）`
      : 'MOOC 视频已生成';
    d.moocJobs.updateJob(job.id, {
      status: 'success',
      stage: 'done',
      checkpoint: 'composed',
      progress: 100,
      message: doneMessage,
      error: null,
      failed_stage: null,
      finished_at: new Date().toISOString(),
    });
    console.log(`[MOOC] Job ${job.id} success → project ${projectId}`);
  } catch (err: any) {
    if (err?.code === 'CANCELLED' || err?.message === 'CANCELLED') {
      if (projectId) {
        markDubbingCancelled(projectId);
        requestCancel('avatar', projectId);
        try { d.videoComposer.forceCancelCompose(projectId); } catch { /* ignore */ }
      }
      d.moocJobs.markCancelled(job.id, `已取消（断点：${checkpoint}，可继续）`);
      console.log(`[MOOC] Job ${job.id} cancelled at checkpoint=${checkpoint}`);
      return;
    }
    const stage: MoocJobStage = (err?.stage as MoocJobStage) || currentStage || 'creating';
    const msg = err?.message || String(err);
    console.error(`[MOOC] Job ${job.id} failed at ${stage}:`, msg);
    fail(stage, msg);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function requestMoocJobCancel(jobId: string) {
  if (!deps) return;
  const job = deps.moocJobs.getJob(jobId);
  if (!job) return;
  deps.moocJobs.updateJob(jobId, { message: '正在请求取消…' });
  try {
    const cfg = deps.moocJobs.parseConfig(job);
    if (cfg.explainBatchId && deps.explainBatches) {
      deps.explainBatches.requestCancel(cfg.explainBatchId, job.user_id);
      for (const child of deps.explainBatches.listChildJobs(cfg.explainBatchId)) {
        if (deps.explainJobs && ['queued', 'running', 'await_style', 'await_sample'].includes(child.status)) {
          deps.explainJobs.requestCancel(child.id, job.user_id);
        }
      }
    }
  } catch { /* ignore */ }
  if (job.project_id) {
    markDubbingCancelled(job.project_id);
    requestCancel('avatar', job.project_id);
    try { deps.videoComposer.forceCancelCompose(job.project_id); } catch { /* ignore */ }
  }
}

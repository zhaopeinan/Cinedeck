/**
 * 知识点插片叠数字人：复用 MOOC/项目数字人配置（布局、参考、绿幕强度）。
 */
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import type { ProjectService } from './projectService';
import type { VideoComposerService } from './videoComposer';
import type { ExplainInsertClip } from './moocExplainBridge';
import { AvatarRefVideoService } from './avatarRefVideoService';
import { synthesizeDuixClip, withDuixGpuExclusive } from './avatarWorker';
import { clampChromaSimilarity } from './avatarComposeService';

export async function attachAvatarsToExplainInserts(opts: {
  projectId: string;
  userId: string;
  projectDir: string;
  inserts: ExplainInsertClip[];
  projectService: ProjectService;
  videoComposer: VideoComposerService;
  db: Database.Database;
  chromaSimilarity: number;
  isCancelled: () => boolean;
  onProgress?: (message: string, progress: number) => void;
  /** Rebuild even if insert_*.mp4 already exists (needed after re-export repair). */
  force?: boolean;
}): Promise<{ inserts: ExplainInsertClip[]; avatarApplied: number; avatarFailed: number }> {
  const inserts = opts.inserts.slice();
  if (!inserts.length) return { inserts, avatarApplied: 0, avatarFailed: 0 };

  const project = opts.projectService.getProject(opts.projectId) as any;
  if (!project) return { inserts, avatarApplied: 0, avatarFailed: 0 };

  const driveMode = (project.avatar_drive_mode || 'video') as 'photo' | 'video';
  let templateSource: string | null = null;
  if (driveMode === 'video') {
    const refId = project.avatar_ref_video_id;
    if (!refId) throw new Error('已启用数字人但未选择参考视频');
    const refService = new AvatarRefVideoService(opts.db);
    const owned = refService.getOwned(refId, opts.userId);
    if (!owned || !fs.existsSync(owned.file_path)) {
      throw new Error('参考视频不存在或无权访问');
    }
    try {
      const { ensureDuixTemplate } = await import('./duixTemplatePrep');
      const prepared = await ensureDuixTemplate(owned.file_path, 'video');
      if (prepared !== owned.prepared_path) {
        refService.setPreparedPath(refId, opts.userId, prepared);
      }
      templateSource = prepared;
    } catch {
      templateSource = refService.resolveTemplatePath(owned);
    }
  } else {
    if (!project.avatar_photo_path || !fs.existsSync(project.avatar_photo_path)) {
      throw new Error('已启用数字人但未上传静照');
    }
    try {
      const { ensureDuixTemplate } = await import('./duixTemplatePrep');
      templateSource = await ensureDuixTemplate(project.avatar_photo_path, 'photo');
    } catch {
      templateSource = project.avatar_photo_path;
    }
  }

  const chromaKey = opts.projectService.isAvatarRefGreenscreen(project.avatar_ref_video_id);
  const chromaSimilarity = clampChromaSimilarity(opts.chromaSimilarity);
  const layoutJson = project.avatar_layout_json || null;
  const outDir = path.join(opts.projectDir, 'explain_avatars');
  fs.mkdirSync(outDir, { recursive: true });

  let avatarApplied = 0;
  let avatarFailed = 0;

  await withDuixGpuExclusive(async () => {
    for (let i = 0; i < inserts.length; i++) {
      if (opts.isCancelled()) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
      const clip = inserts[i];
      const tag = `${clip.explainJobId || i}_gs${Math.round(chromaSimilarity * 100)}`;
      const avatarOut = path.join(outDir, `avatar_${tag}.mp4`);
      const composited = path.join(outDir, `insert_${tag}.mp4`);

      // Resume: already composited (unless force rebuild after re-export)
      if (!opts.force && fs.existsSync(composited)) {
        inserts[i] = { ...clip, videoPath: composited };
        avatarApplied += 1;
        continue;
      }
      if (opts.force) {
        for (const stale of [composited, avatarOut]) {
          try { if (fs.existsSync(stale)) fs.unlinkSync(stale); } catch { /* ignore */ }
        }
      }

      const audioPath = (clip.audioPath && fs.existsSync(clip.audioPath))
        ? clip.audioPath
        : (() => {
          const beside = path.join(path.dirname(clip.videoPath), 'narration.wav');
          return fs.existsSync(beside) ? beside : null;
        })();
      if (!audioPath) {
        console.warn(`[MOOC-ExplainAvatar] no narration for ${clip.explainJobId}, skip avatar`);
        avatarFailed += 1;
        continue;
      }

      opts.onProgress?.(
        `知识点数字人 ${i + 1}/${inserts.length}：${clip.title || ''}`,
        85 + Math.round((i / Math.max(1, inserts.length)) * 4),
      );

      try {
        if (!fs.existsSync(avatarOut)) {
          const workId = `mooc-explain-${opts.projectId}-${tag}-${Date.now()}`;
          const raw = await synthesizeDuixClip({
            workId,
            audioSourcePath: audioPath,
            driveMode,
            templateSourcePath: templateSource!,
            isCancelled: opts.isCancelled,
            onProgress: (msg) => {
              opts.onProgress?.(`知识点数字人 ${i + 1}/${inserts.length}：${msg}`, 86);
            },
          });
          fs.copyFileSync(raw, avatarOut);
        }

        await opts.videoComposer.overlayAvatarOnBackgroundVideo({
          projectId: opts.projectId,
          backgroundPath: clip.videoPath,
          avatarPath: avatarOut,
          outputPath: composited,
          layoutJson,
          chromaKey,
          chromaSimilarity,
        });

        inserts[i] = { ...clip, videoPath: composited };
        avatarApplied += 1;
      } catch (err: any) {
        if (err?.code === 'CANCELLED' || /CANCELLED|取消/.test(String(err?.message || ''))) throw err;
        console.warn(`[MOOC-ExplainAvatar] failed ${clip.explainJobId}:`, err?.message || err);
        avatarFailed += 1;
      }
    }
  });

  return { inserts, avatarApplied, avatarFailed };
}

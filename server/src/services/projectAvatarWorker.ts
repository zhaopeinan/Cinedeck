import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { ProjectService } from './projectService';
import { AvatarRefVideoService } from './avatarRefVideoService';
import { ensureVoiceboxRunningForAudio, synthesizeDuixClip, withDuixGpuExclusive } from './avatarWorker';
import {
  patchProjectAvatarPage,
  setProjectAvatarProgress,
} from './projectAvatarProgress';
import { beginJob, clearCancel, isCancelled, JobCancelledError } from './jobCancel';
import { legacySlideAudioCachePath, slideAudioCachePath } from '../utils/mediaCache';
import type Database from 'better-sqlite3';

const PROJECTS_DIR = path.resolve(process.cwd(), '..', 'data', 'projects');
const VOICEBOX_BASE_URL = process.env.VOICEBOX_BASE_URL || 'http://localhost:17493';

const runningProjects = new Set<string>();

/** Rewrite docker-internal voicebox host to configured base (and try fallbacks). */
function audioUrlCandidates(audioPath: string): string[] {
  const urls = [audioPath];
  try {
    const u = new URL(audioPath);
    if (/voicebox/i.test(u.hostname) || u.hostname === 'ppt-audio-voicebox') {
      const base = new URL(VOICEBOX_BASE_URL);
      urls.push(`${base.origin}${u.pathname}${u.search}`);
      // host.docker.internal common for Mac/desktop; Linux compose uses service name
      urls.push(`http://host.docker.internal:17493${u.pathname}${u.search}`);
    }
  } catch {
    // ignore
  }
  return [...new Set(urls)];
}

async function resolveLocalAudio(audioPath: string, projectId: string, pageIndex: number): Promise<string> {
  if (!audioPath) throw new Error('无配音音频');
  if (!audioPath.startsWith('http://') && !audioPath.startsWith('https://')) {
    if (!fs.existsSync(audioPath)) throw new Error(`音频文件不存在: ${audioPath}`);
    return audioPath;
  }
  const projectDir = path.join(PROJECTS_DIR, projectId);
  const cacheDir = path.join(projectDir, 'audio_cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const local = slideAudioCachePath(projectDir, pageIndex, audioPath);
  if (fs.existsSync(local) && fs.statSync(local).size > 1000) return local;

  // Drop legacy unversioned cache so regenerated dubbing is never reused
  const legacy = legacySlideAudioCachePath(projectDir, pageIndex);
  try { if (fs.existsSync(legacy)) fs.unlinkSync(legacy); } catch { /* ignore */ }

  let lastErr: any;
  for (const url of audioUrlCandidates(audioPath)) {
    try {
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      fs.writeFileSync(local, Buffer.from(res.data));
      if (fs.statSync(local).size < 100) throw new Error('下载的音频过小');
      return local;
    } catch (err: any) {
      lastErr = err;
      console.warn(`[ProjectAvatar] audio download failed page=${pageIndex} url=${url}: ${err?.message || err}`);
    }
  }
  throw new Error(`下载配音失败: ${lastErr?.message || lastErr}`);
}

export function isProjectAvatarRunning(projectId: string) {
  return runningProjects.has(projectId);
}

export async function generateProjectAvatars(opts: {
  projectId: string;
  userId: string;
  pageIndexes: number[];
  projectService: ProjectService;
  db: Database.Database;
}): Promise<void> {
  const { projectId, userId, pageIndexes, projectService, db } = opts;
  if (runningProjects.has(projectId)) {
    throw new Error('该项目数字人正在生成中');
  }

  const project = projectService.getProject(projectId) as any;
  if (!project) throw new Error('项目不存在');

  const driveMode = (project.avatar_drive_mode || 'video') as 'photo' | 'video';
  let templateSource: string | null = null;
  if (driveMode === 'video') {
    const refId = project.avatar_ref_video_id;
    if (!refId) throw new Error('请先选择参考视频');
    const refService = new AvatarRefVideoService(db);
    const owned = refService.getOwned(refId, userId);
    if (!owned || !fs.existsSync(owned.file_path)) {
      throw new Error('参考视频不存在或无权访问');
    }
    // Prefer upload-time prepared template; lazy-prepare if missing
    try {
      const { ensureDuixTemplate } = await import('./duixTemplatePrep');
      const prepared = await ensureDuixTemplate(owned.file_path, 'video');
      if (prepared !== owned.prepared_path) {
        refService.setPreparedPath(refId, userId, prepared);
      }
      templateSource = prepared;
    } catch {
      templateSource = refService.resolveTemplatePath(owned);
    }
  } else {
    if (!project.avatar_photo_path || !fs.existsSync(project.avatar_photo_path)) {
      throw new Error('请先上传静照');
    }
    try {
      const { ensureDuixTemplate } = await import('./duixTemplatePrep');
      templateSource = await ensureDuixTemplate(project.avatar_photo_path, 'photo');
    } catch {
      templateSource = project.avatar_photo_path;
    }
  }

  const pages = pageIndexes.slice().sort((a, b) => a - b);
  runningProjects.add(projectId);
  beginJob('avatar', projectId);

  setProjectAvatarProgress(projectId, {
    status: 'running',
    message: '准备中：先缓存配音（Voicebox 仍在线）…',
    total: pages.length,
    completed: 0,
    failed: 0,
    currentPage: null,
    pages: pages.map((pageIndex) => ({
      pageIndex,
      status: 'pending',
      message: '等待处理',
      error: null,
    })),
  });

  for (const pageIndex of pages) {
    projectService.updateSlide(projectId, pageIndex, {
      avatar_status: 'queued',
      avatar_error: null,
      avatar_enabled: 1,
    });
    patchProjectAvatarPage(projectId, pageIndex, {
      status: 'queued',
      message: '已加入队列',
      error: null,
    });
  }

  // IMPORTANT: cache audio BEFORE stopping Voicebox for GPU exclusive Duix.
  const audioByPage = new Map<number, string>();
  let completed = 0;
  let failed = 0;

  const finishCancelled = () => {
    for (const pageIndex of pages) {
      const slide = projectService.getSlide(projectId, pageIndex) as any;
      const st = slide?.avatar_status;
      if (st === 'queued' || st === 'running' || st === 'caching') {
        projectService.updateSlide(projectId, pageIndex, {
          avatar_status: slide?.avatar_video_path ? 'generated' : 'pending',
          avatar_error: null,
        });
        patchProjectAvatarPage(projectId, pageIndex, {
          status: slide?.avatar_video_path ? 'generated' : 'pending',
          message: '已取消',
          error: null,
        });
      }
    }
    setProjectAvatarProgress(projectId, {
      status: 'cancelled',
      message: `已取消（成功 ${completed}，失败 ${failed}）`,
      completed,
      failed,
      currentPage: null,
    });
  };

  try {
    setProjectAvatarProgress(projectId, {
      message: '确保 Voicebox 在线，以便下载配音…',
    });
    await ensureVoiceboxRunningForAudio();
    if (isCancelled('avatar', projectId)) throw new JobCancelledError();

    for (const pageIndex of pages) {
      if (isCancelled('avatar', projectId)) throw new JobCancelledError();
      const slide = projectService.getSlide(projectId, pageIndex) as any;
      if (!slide) {
        failed += 1;
        patchProjectAvatarPage(projectId, pageIndex, {
          status: 'failed',
          message: '页面不存在',
          error: '页面不存在',
        });
        continue;
      }
      if (slide.dubbing_status !== 'generated' || !slide.dubbing_audio_path) {
        projectService.updateSlide(projectId, pageIndex, {
          avatar_status: 'failed',
          avatar_error: '该页尚未完成配音',
        });
        failed += 1;
        patchProjectAvatarPage(projectId, pageIndex, {
          status: 'failed',
          message: '无配音',
          error: '该页尚未完成配音',
        });
        setProjectAvatarProgress(projectId, {
          completed,
          failed,
          currentPage: pageIndex,
          message: `第 ${pageIndex} 页：无配音`,
        });
        continue;
      }

      patchProjectAvatarPage(projectId, pageIndex, {
        status: 'caching',
        message: '正在缓存配音音频…',
      });
      setProjectAvatarProgress(projectId, {
        currentPage: pageIndex,
        message: `缓存第 ${pageIndex} 页配音（${completed + failed + 1}/${pages.length}）…`,
        completed,
        failed,
      });

      try {
        const local = await resolveLocalAudio(slide.dubbing_audio_path, projectId, pageIndex);
        audioByPage.set(pageIndex, local);
        patchProjectAvatarPage(projectId, pageIndex, {
          status: 'queued',
          message: '配音已缓存，等待 GPU',
        });
      } catch (err: any) {
        failed += 1;
        const msg = String(err?.message || err).slice(0, 1500);
        projectService.updateSlide(projectId, pageIndex, {
          avatar_status: 'failed',
          avatar_error: msg,
        });
        patchProjectAvatarPage(projectId, pageIndex, {
          status: 'failed',
          message: '缓存配音失败',
          error: msg,
        });
        setProjectAvatarProgress(projectId, {
          completed,
          failed,
          currentPage: pageIndex,
          message: `第 ${pageIndex} 页缓存失败`,
        });
      }
    }

    const gpuPages = pages.filter((p) => audioByPage.has(p));
    if (!gpuPages.length) {
      setProjectAvatarProgress(projectId, {
        status: 'failed',
        message: `无法生成：成功 0，失败 ${failed}（配音缓存失败）`,
        completed,
        failed,
        currentPage: null,
      });
      return;
    }

    setProjectAvatarProgress(projectId, {
      message: `配音已就绪，准备独占 GPU 生成 ${gpuPages.length} 页…`,
      completed,
      failed,
      currentPage: null,
    });

    await withDuixGpuExclusive(async () => {
      for (const pageIndex of gpuPages) {
        if (isCancelled('avatar', projectId)) throw new JobCancelledError();
        const audioLocal = audioByPage.get(pageIndex)!;
        projectService.updateSlide(projectId, pageIndex, { avatar_status: 'running', avatar_error: null });
        patchProjectAvatarPage(projectId, pageIndex, {
          status: 'running',
          message: 'Duix 生成中…',
          error: null,
        });
        setProjectAvatarProgress(projectId, {
          currentPage: pageIndex,
          message: `正在生成第 ${pageIndex} 页数字人（已完成 ${completed}/${gpuPages.length}）…`,
          completed,
          failed,
        });

        try {
          const workId = `proj-${projectId}-p${pageIndex}-${Date.now()}`;
          const outPath = await synthesizeDuixClip({
            workId,
            audioSourcePath: audioLocal,
            driveMode,
            templateSourcePath: templateSource!,
            isCancelled: () => isCancelled('avatar', projectId),
            onProgress: (msg, progress) => {
              const pagePct = Math.max(0, Math.min(100, Number(progress) || 0));
              const overall = Math.round(
                ((completed + failed + pagePct / 100) / Math.max(1, pages.length)) * 100,
              );
              patchProjectAvatarPage(projectId, pageIndex, {
                status: 'running',
                message: msg,
                percent: pagePct,
              });
              setProjectAvatarProgress(projectId, {
                currentPage: pageIndex,
                message: `第 ${pageIndex} 页：${msg}`,
                completed,
                failed,
                percent: overall,
              });
            },
          });

          const destDir = path.join(PROJECTS_DIR, projectId, 'avatar');
          fs.mkdirSync(destDir, { recursive: true });
          const dest = path.join(destDir, `page_${pageIndex}.mp4`);
          fs.copyFileSync(outPath, dest);

          projectService.updateSlide(projectId, pageIndex, {
            avatar_status: 'generated',
            avatar_video_path: dest,
            avatar_error: null,
            avatar_visible: 1,
          });
          completed += 1;
          patchProjectAvatarPage(projectId, pageIndex, {
            status: 'generated',
            message: '生成成功',
            error: null,
            percent: 100,
          });
        } catch (err: any) {
          if (err instanceof JobCancelledError || err?.name === 'JobCancelledError') {
            throw err;
          }
          failed += 1;
          const msg = String(err?.message || err).slice(0, 1500);
          projectService.updateSlide(projectId, pageIndex, {
            avatar_status: 'failed',
            avatar_error: msg,
          });
          patchProjectAvatarPage(projectId, pageIndex, {
            status: 'failed',
            message: '生成失败',
            error: msg,
          });
        }

        setProjectAvatarProgress(projectId, {
          completed,
          failed,
          currentPage: pageIndex,
          percent: Math.round(((completed + failed) / Math.max(1, pages.length)) * 100),
          message: `进度 ${completed + failed}/${pages.length}（成功 ${completed}，失败 ${failed}）`,
        });
      }
    });

    setProjectAvatarProgress(projectId, {
      status: failed && !completed ? 'failed' : 'completed',
      message: failed
        ? `完成：成功 ${completed}，失败 ${failed}`
        : `全部完成（${completed} 页）`,
      completed,
      failed,
      percent: 100,
      currentPage: null,
    });
  } catch (err: any) {
    if (err instanceof JobCancelledError || err?.name === 'JobCancelledError' || isCancelled('avatar', projectId)) {
      finishCancelled();
    } else {
      setProjectAvatarProgress(projectId, {
        status: 'failed',
        message: err?.message || String(err),
        completed,
        failed,
        currentPage: null,
      });
      throw err;
    }
  } finally {
    clearCancel('avatar', projectId);
    runningProjects.delete(projectId);
  }
}

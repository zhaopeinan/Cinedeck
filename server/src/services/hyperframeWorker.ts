import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { ProjectService } from './projectService';
import { PptParserService } from './pptParser';
import { LlmService } from './llmService';
import { VoiceboxAdapter } from './voiceboxAdapter';
import { SystemSettingsService } from './systemSettingsService';
import { ensureVoiceboxRunningForAudio } from './avatarWorker';
import { withVoiceboxGpu } from './voiceboxGpuQueue';
import { writeHyperframeComposition } from './hyperframeComposer';
import { lintHyperframesProject, renderWithOfficialHyperframes } from './hyperframeRender';
import {
  HyperframeJobService,
  HYPERFRAME_COMPOSE_DIR,
  type HfCheckpoint,
  type HfPageScript,
  type HfStage,
  type HyperframeJobRow,
} from './hyperframeJobService';

export interface HyperframePipelineDeps {
  db: Database.Database;
  jobs: HyperframeJobService;
  projectService: ProjectService;
  pptParser: PptParserService;
  llm: LlmService;
  voicebox: VoiceboxAdapter;
  systemSettings: SystemSettingsService;
}

const CHECKPOINT_ORDER: HfCheckpoint[] = ['none', 'created', 'parsed', 'scripted', 'dubbed', 'composed'];

function checkpointAtLeast(current: HfCheckpoint | string | null | undefined, target: HfCheckpoint): boolean {
  return CHECKPOINT_ORDER.indexOf((current as HfCheckpoint) || 'none') >= CHECKPOINT_ORDER.indexOf(target);
}

function runCmd(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function probeDuration(filePath: string): Promise<number> {
  const r = await runCmd('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', filePath,
  ], 30000);
  const n = parseFloat(r.stdout.trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function downloadAudio(url: string, dest: string): Promise<void> {
  const axios = (await import('axios')).default;
  const base = (process.env.VOICEBOX_BASE_URL || 'http://ppt-audio-voicebox:17493').replace(/\/$/, '');
  let fetchUrl = url;
  try {
    const u = new URL(url);
    const b = new URL(base);
    // Always prefer configured Voicebox host (avoid stale container IPs)
    if (u.pathname.startsWith('/audio/') || u.port === '17493' || u.port === b.port) {
      fetchUrl = `${b.origin}${u.pathname}${u.search}`;
    }
  } catch {
    /* keep original */
  }
  let lastErr: any;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.get(fetchUrl, { responseType: 'arraybuffer', timeout: 120000 });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(res.data));
      return;
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (!/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg) || attempt === 5) break;
      await ensureVoiceboxRunningForAudio();
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

let deps: HyperframePipelineDeps | null = null;
let pumping = false;

export function initHyperframePipeline(d: HyperframePipelineDeps) {
  deps = d;
  d.jobs.recoverStaleRunning();
  setTimeout(() => pumpHyperframeQueue(), 2000);
  setInterval(() => pumpHyperframeQueue(), 3000);
}

export function pumpHyperframeQueue() {
  if (!deps) return;
  if (pumping) return;
  const hung = deps?.jobs.recoverHungRunning?.() ?? 0;
  if (hung > 0) console.warn(`[HyperFrame] recovered ${hung} hung running job(s)`);
  if (deps.jobs.hasRunning()) return;
  const job = deps.jobs.claimNextQueued();
  if (!job) return;
  pumping = true;
  runJob(job)
    .catch((err) => {
      console.error('[HyperFrame] job error', err?.message || err);
      deps?.jobs.updateJob(job.id, {
        status: 'failed',
        stage: 'failed',
        error: String(err?.message || err),
        message: '任务失败',
        finished_at: new Date().toISOString(),
      });
    })
    .finally(() => {
      pumping = false;
      setTimeout(() => pumpHyperframeQueue(), 800);
    });
}

async function runJob(job: HyperframeJobRow) {
  const d = deps!;
  const config = d.jobs.parseConfig(job);
  let checkpoint = (job.checkpoint || 'none') as HfCheckpoint;
  let projectId = job.project_id;

  const setProgress = (stage: HfStage, progress: number, message: string) => {
    d.jobs.updateJob(job.id, { stage, progress, message });
  };
  const markCp = (cp: HfCheckpoint) => {
    checkpoint = cp;
    d.jobs.updateJob(job.id, { checkpoint: cp });
  };

  // ── create project ──
  if (!checkpointAtLeast(checkpoint, 'created')) {
    setProgress('creating', 5, '创建项目…');
    if (!fs.existsSync(job.file_path)) throw new Error('上传的 PPTX 不存在');
    const project = d.projectService.createProject(
      job.file_name,
      fs.statSync(job.file_path).size,
      job.file_path,
      job.user_id,
    );
    projectId = project.id;
    d.jobs.updateJob(job.id, { project_id: projectId });
    markCp('created');
  }

  // ── parse ──
  if (!checkpointAtLeast(checkpoint, 'parsed')) {
    setProgress('parsing', 15, '解析 PPT 页面与备注…');
    await d.pptParser.parsePpt(projectId!);
    markCp('parsed');
  }

  // ── multimodal lecture scripts ──
  if (!checkpointAtLeast(checkpoint, 'scripted')) {
    setProgress('analyzing', 25, '多模态分析页面并生成讲授讲义…');
    const scripts = await generateLectureScripts({
      projectId: projectId!,
      userId: job.user_id,
      useExistingNote: config.useExistingNote !== false,
      llm: d.llm,
      projectService: d.projectService,
      onProgress: (i, n) => {
        const pct = 25 + Math.round((i / Math.max(1, n)) * 28);
        d.jobs.updateJob(job.id, {
          progress: pct,
          message: `生成讲义 ${i}/${n}…`,
        });
      },
      onPageDone: (partial) => {
        d.jobs.updateJob(job.id, {
          scripts_json: JSON.stringify(partial),
          message: `生成讲义 ${partial.length} 页…`,
        });
      },
    });
    d.jobs.markReview(job.id, scripts);
    console.log(`[HyperFrame] ${job.id} ready for review (${scripts.length} pages)`);
    return; // pause for user confirm
  }

  // From here: produce audio + composition (user confirmed)
  const allScripts = d.jobs.parseScripts(job);
  if (!allScripts.length) throw new Error('没有可生成的讲义');

  const selectedRaw = Array.isArray(config.selectedPageIndexes) ? config.selectedPageIndexes : [];
  const selectedSet = selectedRaw.length
    ? new Set(selectedRaw.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))
    : new Set(allScripts.map((s) => s.pageIndex));
  const scripts = allScripts.filter((s) => selectedSet.has(s.pageIndex));
  if (!scripts.length) {
    throw new Error('没有选中可生成的页面，请至少勾选一页后再试');
  }

  if (!checkpointAtLeast(checkpoint, 'dubbed')) {
    setProgress('dubbing', 60, `Voicebox 配音中（${scripts.length} 页）…`);
    await ensureVoiceboxRunningForAudio();
    const voiceId = config.selectedVoiceId;
    const modelId = config.selectedModelId;
    if (!voiceId || !modelId) throw new Error('未选择音色或配音模型');

    const outAudioDir = path.join(HYPERFRAME_COMPOSE_DIR, job.id, 'assets');
    fs.mkdirSync(outAudioDir, { recursive: true });
    const maxChunk = d.systemSettings.getDubbingMaxChunkChars();
    const timeoutSec = d.systemSettings.getDubbingTimeoutSeconds();

    const persistScripts = () => {
      const byPage = new Map(scripts.map((s) => [s.pageIndex, s]));
      const mergedScripts = allScripts.map((s) => byPage.get(s.pageIndex) || s);
      d.jobs.updateJob(job.id, { scripts_json: JSON.stringify(mergedScripts) });
    };

    for (let i = 0; i < scripts.length; i++) {
      const s = scripts[i];
      const text = (s.lecture || '').trim();
      const audioLocal = path.join(outAudioDir, `page_${s.pageIndex}.wav`);
      d.jobs.updateJob(job.id, {
        progress: 60 + Math.round(((i + 1) / scripts.length) * 18),
        message: `配音 ${i + 1}/${scripts.length}（第 ${s.pageIndex} 页）…`,
      });
      if (!text) {
        s.audioPath = null;
        s.durationSec = 3;
        persistScripts();
        continue;
      }
      // Resume: skip pages that already have audio on disk (after crash / restart)
      if (s.audioPath && fs.existsSync(s.audioPath) && fs.statSync(s.audioPath).size > 1000) {
        if (!s.durationSec) s.durationSec = await probeDuration(s.audioPath) || Math.max(3, Math.round(text.length / 5.5));
        continue;
      }
      if (fs.existsSync(audioLocal) && fs.statSync(audioLocal).size > 1000) {
        s.audioPath = audioLocal;
        s.durationSec = await probeDuration(audioLocal) || Math.max(3, Math.round(text.length / 5.5));
        persistScripts();
        continue;
      }
      await withVoiceboxGpu(`hyperframe:dub-p${s.pageIndex}`, async () => {
        const task = await d.voicebox.generateDubbing({
          text,
          voiceId,
          modelId,
          language: 'zh-CN',
          maxChunkChars: maxChunk,
          instruct: '语速平稳，吐字清晰，适合课堂讲授。',
        });
        const ok = await waitVoiceboxTask(d.voicebox, task.id, timeoutSec);
        if (!ok) {
          const st = await d.voicebox.getTaskStatus(task.id).catch(() => null);
          const detail = st?.error ? String(st.error) : '';
          throw new Error(`第 ${s.pageIndex} 页配音超时或失败${detail ? `：${detail}` : ''}`);
        }
        const result = await d.voicebox.getTaskResult(task.id);
        await downloadAudio(result.audioPath, audioLocal);
        const dur = await probeDuration(audioLocal);
        s.audioPath = audioLocal;
        s.durationSec = dur || Math.max(3, Math.round(text.length / 5.5));
      });
      persistScripts();
    }
    persistScripts();
    markCp('dubbed');
  }

  // ── compose HyperFrames HTML + official CLI render ──
  if (!checkpointAtLeast(checkpoint, 'composed')) {
    setProgress('composing', 82, `生成 HyperFrames 官方工程（${scripts.length} 页）…`);
    const composeDir = path.join(HYPERFRAME_COMPOSE_DIR, job.id);
    const assetsDir = path.join(composeDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });

    const slides = d.projectService.getSlides(projectId!) as any[];
    const pagesForHtml: Array<{
      pageIndex: number;
      imageRel: string;
      audioRel: string | null;
      lecture: string;
      durationSec: number;
    }> = [];

    // Prefer freshly dubbed scripts; fall back to DB for audio paths after resume
    const latestAll = d.jobs.parseScripts(d.jobs.getJob(job.id)!);
    const latest = latestAll.filter((s) => selectedSet.has(s.pageIndex));
    for (const s of latest) {
      const slide = slides.find((x) => Number(x.page_index) === Number(s.pageIndex));
      const srcImg = slide?.image_path;
      if (!srcImg || !fs.existsSync(srcImg)) {
        console.warn(`[HyperFrame] skip page ${s.pageIndex}: missing slide image`, srcImg);
        continue;
      }
      const imgName = `slide_${s.pageIndex}${path.extname(srcImg) || '.png'}`;
      const imgDest = path.join(assetsDir, imgName);
      if (!fs.existsSync(imgDest)) fs.copyFileSync(srcImg, imgDest);

      let audioRel: string | null = null;
      if (s.audioPath && fs.existsSync(s.audioPath)) {
        const audioName = path.basename(s.audioPath);
        const audioDest = path.join(assetsDir, audioName);
        if (path.resolve(s.audioPath) !== path.resolve(audioDest)) {
          fs.copyFileSync(s.audioPath, audioDest);
        }
        audioRel = `assets/${audioName}`;
      }
      pagesForHtml.push({
        pageIndex: s.pageIndex,
        imageRel: `assets/${imgName}`,
        audioRel,
        lecture: s.lecture,
        durationSec: s.durationSec || 4,
      });
    }

    if (!pagesForHtml.length) {
      throw new Error(
        `没有可写入的页面（已选 ${latest.length} 页，项目幻灯片 ${slides.length} 页）。请重试配音；若仍失败请重新上传课件。`,
      );
    }

    writeHyperframeComposition({
      outDir: composeDir,
      title: job.name,
      pages: pagesForHtml,
    });
    d.jobs.updateJob(job.id, { composition_dir: composeDir });

    setProgress('exporting', 88, '官方 HyperFrames lint…');
    await lintHyperframesProject(composeDir);

    setProgress('exporting', 90, 'npx hyperframes render 导出中…');
    const videoPath = path.join(composeDir, 'lecture.mp4');
    await renderWithOfficialHyperframes({
      compositionDir: composeDir,
      outputPath: videoPath,
      quality: 'standard',
      onLog: (line) => {
        d.jobs.updateJob(job.id, { message: `HyperFrames: ${line.slice(0, 80)}` });
      },
    });

    d.jobs.updateJob(job.id, {
      status: 'success',
      stage: 'done',
      progress: 100,
      checkpoint: 'composed',
      composition_dir: composeDir,
      video_path: videoPath,
      message: `官方 HyperFrames 渲染完成（${pagesForHtml.length} 页），可预览与导出`,
      finished_at: new Date().toISOString(),
    });
    console.log(`[HyperFrame] ${job.id} done → ${videoPath}`);
  } else {
    d.jobs.updateJob(job.id, {
      status: 'success',
      stage: 'done',
      progress: 100,
      message: '已完成',
      finished_at: new Date().toISOString(),
    });
  }
}

async function generateLectureScripts(opts: {
  projectId: string;
  userId: string;
  useExistingNote: boolean;
  llm: LlmService;
  projectService: ProjectService;
  onProgress?: (i: number, n: number) => void;
  onPageDone?: (partial: HfPageScript[]) => void;
}): Promise<HfPageScript[]> {
  const slides = opts.projectService.getSlides(opts.projectId) as any[];
  const out: HfPageScript[] = [];
  const systemPrompt = `你是资深课程讲师。根据 PPT 页面视觉内容与备注，撰写口语化、适合课堂讲授的讲义。
要求：
1. 全部使用简体中文
2. 只输出讲义正文，不要标题、编号或 Markdown
3. 语气自然流畅，可直接朗读
4. 每页约 120–280 字，信息完整但不啰嗦`;

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    opts.onProgress?.(i + 1, slides.length);
    const note = String(slide.note_content || '').trim();
    const pageNo = slide.page_index;
    let analysis = '';
    let lecture = '';

    const userPrompt = opts.useExistingNote && note
      ? `这是课件第 ${pageNo} 页。请先用 1–2 句概括页面要点，再写讲授讲义。\n页面备注（可参考，不要照抄）：\n${note}`
      : `这是课件第 ${pageNo} 页。请根据画面内容写讲授讲义（先隐含理解页面结构与重点）。`;

    try {
      if (slide.image_path && fs.existsSync(slide.image_path)) {
        const raw = await opts.llm.chatWithImage(userPrompt, slide.image_path, {
          systemPrompt,
          userId: opts.userId,
          temperature: 0.55,
          maxTokens: 1200,
        });
        lecture = cleanLecture(raw);
        analysis = note ? `备注已加载（${note.length} 字）` : '无备注，已根据页面图像生成';
      } else {
        const raw = await opts.llm.chat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: note ? `第 ${pageNo} 页备注：\n${note}\n请写讲授讲义。` : `第 ${pageNo} 页无图像与备注，请写一句过渡讲义。` },
        ], { userId: opts.userId, temperature: 0.55, maxTokens: 1200 });
        lecture = cleanLecture(raw);
        analysis = note ? '无页面图，基于备注生成' : '无页面图与备注';
      }
    } catch (err: any) {
      // Keep lecture usable for dubbing; put failure detail in analysis only
      lecture = note || '（本页暂无讲义，请手动编辑后再生成动画）';
      analysis = `生成失败：${err?.message || err}`;
    }

    // Persist into project slide for reuse
    try {
      opts.projectService.updateSlide(opts.projectId, pageNo, {
        script_content: lecture,
        script_status: 'generated',
        note_status: note ? (slide.note_status || 'loaded') : slide.note_status,
      });
    } catch { /* ignore */ }

    out.push({
      pageIndex: pageNo,
      note,
      analysis,
      lecture,
      durationSec: Math.max(3, Math.round(lecture.length / 5.5)),
      audioPath: null,
    });
    try { opts.onPageDone?.(out.slice()); } catch { /* ignore */ }
  }
  return out;
}

function cleanLecture(raw: string): string {
  return String(raw || '')
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```$/, '')
    .replace(/^["'「]|["'」]$/g, '')
    .trim();
}

async function waitVoiceboxTask(voicebox: VoiceboxAdapter, taskId: string, timeoutSec: number): Promise<boolean> {
  const maxAttempts = Math.ceil((timeoutSec * 1000) / 2000);
  for (let i = 0; i < maxAttempts; i++) {
    const st = await voicebox.getTaskStatus(taskId);
    if (st.status === 'succeeded') return true;
    if (st.status === 'failed' || st.status === 'cancelled') return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  try { await voicebox.cancelTask(taskId); } catch { /* ignore */ }
  return false;
}

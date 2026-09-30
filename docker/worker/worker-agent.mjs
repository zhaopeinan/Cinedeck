import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);
const DISPATCHER_URL = process.env.DISPATCHER_URL || 'http://localhost:3001';
const WORKER_ID = process.env.WORKER_ID || `worker-${crypto.randomUUID().slice(0, 8)}`;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '2000');
const DATA_DIR = process.env.DATA_DIR || '/data';
const CAPABILITIES = ['parse_ppt', 'generate_dubbing', 'compose_video'];

async function httpPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function httpGet(url) {
  const res = await fetch(url);
  return res.json();
}

// Register worker with dispatcher
async function register() {
  try {
    const result = await httpPost(`${DISPATCHER_URL}/api/v1/workers/register`, {
      workerId: WORKER_ID,
      capabilities: CAPABILITIES,
    });
    console.log(`[Worker ${WORKER_ID}] Registered:`, result.success ? 'OK' : result.error?.message);
    return result.success;
  } catch (err) {
    console.error(`[Worker ${WORKER_ID}] Registration failed:`, err.message);
    return false;
  }
}

// Heartbeat - tell dispatcher we're still alive
async function heartbeat() {
  try {
    await httpPost(`${DISPATCHER_URL}/api/v1/workers/heartbeat`, {
      workerId: WORKER_ID,
      status: 'idle',
    });
  } catch {}
}

// Poll for task
async function pollTask() {
  try {
    const result = await httpPost(`${DISPATCHER_URL}/api/v1/workers/poll`, {
      workerId: WORKER_ID,
      capabilities: CAPABILITIES,
    });
    if (result.success && result.data) {
      return result.data;
    }
    return null;
  } catch {
    return null;
  }
}

// Report task result
async function reportResult(taskId, result) {
  try {
    await httpPost(`${DISPATCHER_URL}/api/v1/workers/result`, {
      workerId: WORKER_ID,
      taskId,
      result,
    });
  } catch (err) {
    console.error(`[Worker ${WORKER_ID}] Failed to report result:`, err.message);
  }
}

// Execute a task
async function executeTask(task) {
  const { taskId, type, params } = task;
  console.log(`[Worker ${WORKER_ID}] Executing task ${taskId} of type ${type}`);

  try {
    let result;
    switch (type) {
      case 'parse_ppt':
        result = await executeParsePpt(params);
        break;
      case 'generate_dubbing':
        result = await executeGenerateDubbing(params);
        break;
      case 'compose_video':
        result = await executeComposeVideo(params);
        break;
      default:
        result = { success: false, error: `Unknown task type: ${type}` };
    }
    console.log(`[Worker ${WORKER_ID}] Task ${taskId} completed:`, result.success ? 'OK' : result.error);
    await reportResult(taskId, result);
  } catch (err) {
    console.error(`[Worker ${WORKER_ID}] Task ${taskId} error:`, err.message);
    await reportResult(taskId, { success: false, error: err.message });
  }
}

// Parse PPT task
async function executeParsePpt(params) {
  const { filePath, projectId } = params;
  const projectDir = path.dirname(filePath);
  const imagesDir = path.join(projectDir, 'images');
  const thumbnailsDir = path.join(projectDir, 'thumbnails');
  const pdfDir = path.join(imagesDir, '_pdf_temp');

  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(thumbnailsDir, { recursive: true });
  fs.mkdirSync(pdfDir, { recursive: true });

  // Extract notes using python-pptx
  const script = `
import json, sys
try:
    from pptx import Presentation
    prs = Presentation(r"${filePath.replace(/"/g, '\\"')}")
    result = {"totalPages": len(prs.slides), "notes": []}
    MAX_NOTE = 10000
    MAX_PAGE = 200
    if len(prs.slides) > MAX_PAGE:
        print(json.dumps({"error": f"PPT页数超过上限({MAX_PAGE}页)"}))
        sys.exit(1)
    for slide in prs.slides:
        try:
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
                text = slide.notes_slide.notes_text_frame.text
                chars = len(text)
                if chars > MAX_NOTE:
                    result["notes"].append({"status": "too_long", "content": text, "charCount": chars})
                else:
                    result["notes"].append({"status": text.strip() and "loaded" or "empty", "content": text, "charCount": chars})
            else:
                result["notes"].append({"status": "empty", "content": "", "charCount": 0})
        except Exception as e:
            result["notes"].append({"status": "read_failed", "content": None, "charCount": 0, "error": str(e)})
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;
  const { stdout } = await execFileAsync('python3', ['-c', script], { timeout: 60000 });
  const notesResult = JSON.parse(stdout.trim());
  if (notesResult.error) return { success: false, error: notesResult.error };

  // Convert to PDF then PNG
  await execFileAsync('libreoffice', ['--headless', '--convert-to', 'pdf', '--outdir', pdfDir, filePath], { timeout: 120000 });

  const pdfFiles = fs.readdirSync(pdfDir).filter(f => f.endsWith('.pdf'));
  if (pdfFiles.length === 0) return { success: false, error: 'LibreOffice转换PDF失败' };
  const pdfPath = path.join(pdfDir, pdfFiles[0]);

  // pdftoppm to convert each page to PNG
  await execFileAsync('pdftoppm', ['-png', '-r', '150', pdfPath, path.join(imagesDir, 'slide')], { timeout: 120000 });

  // Cleanup temp PDF dir
  try { fs.rmSync(pdfDir, { recursive: true, force: true }); } catch {}

  // Normalize filenames
  const files = fs.readdirSync(imagesDir).filter(f => f.endsWith('.png'));
  for (const file of files) {
    const match = file.match(/(?:slide[-_]?|)(\d+)\.png$/i);
    if (match) {
      const num = parseInt(match[1]);
      const target = `slide_${num}.png`;
      if (file !== target) {
        const src = path.join(imagesDir, file);
        const dst = path.join(imagesDir, target);
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
        else fs.unlinkSync(src);
      }
    }
  }

  // Generate thumbnails using sips (macOS) or ImageMagick (Linux)
  for (let i = 1; i <= notesResult.totalPages; i++) {
    const imgPath = path.join(imagesDir, `slide_${i}.png`);
    const thumbPath = path.join(thumbnailsDir, `slide_${i}_thumb.png`);
    if (fs.existsSync(imgPath)) {
      try {
        await execFileAsync('convert', [imgPath, '-resize', '320x', thumbPath], { timeout: 10000 });
      } catch {
        try {
          await execFileAsync('sips', ['--resampleWidth', '320', '--out', thumbPath, imgPath], { timeout: 10000 });
        } catch {
          fs.copyFileSync(imgPath, thumbPath);
        }
      }
    }
  }

  // Build slides result
  const slides = [];
  const errors = [];
  for (let i = 0; i < notesResult.totalPages; i++) {
    const pageIndex = i + 1;
    const noteData = notesResult.notes[i];
    const noteStatus = noteData.status;
    const noteContent = noteData.content || null;
    const noteCharCount = noteData.charCount || 0;
    const estimatedDuration = (noteStatus === 'loaded') ? noteCharCount / 4 : 0;
    const imagePath = path.join(imagesDir, `slide_${pageIndex}.png`);
    const thumbnailPath = path.join(thumbnailsDir, `slide_${pageIndex}_thumb.png`);

    slides.push({
      pageIndex,
      imagePath: fs.existsSync(imagePath) ? imagePath : '',
      thumbnailPath: fs.existsSync(thumbnailPath) ? thumbnailPath : '',
      noteStatus,
      noteContent,
      noteCharCount,
      estimatedDuration,
    });

    if (noteStatus === 'read_failed') {
      errors.push({ pageIndex, type: 'read_failed', message: noteData.error || '备注读取失败' });
    }
  }

  return {
    success: true,
    data: { totalPages: notesResult.totalPages, slides, errors },
  };
}

// Generate dubbing task (delegates to Voicebox)
async function executeGenerateDubbing(params) {
  const { text, voiceId, modelId, language, projectId, pageIndex } = params;
  const VOICEBOX_URL = process.env.VOICEBOX_BASE_URL || 'http://localhost:17493';

  // Call Voicebox local API
  try {
    // Map language format: zh-CN -> zh
    const lang = (language || 'zh').split('-')[0];
    // Resolve engine from modelId
    let engine = 'qwen';
    if (modelId?.includes('kokoro')) engine = 'kokoro';
    else if (modelId?.includes('chatterbox_turbo')) engine = 'chatterbox_turbo';
    else if (modelId?.includes('chatterbox')) engine = 'chatterbox';
    else if (modelId?.includes('luxtts')) engine = 'luxtts';
    else if (modelId?.includes('tada')) engine = 'tada';
    else if (modelId?.includes('qwen_custom')) engine = 'qwen_custom_voice';

    const generateRes = await fetch(`${VOICEBOX_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: voiceId,
        text,
        language: lang,
        engine,
        model_size: '1.7B',
      }),
    });
    const generateData = await generateRes.json();

    if (!generateRes.ok) {
      return { success: false, error: generateData.detail || 'Voicebox生成失败' };
    }

    const generationId = generateData.id;

    // Poll for result using /history/{id}
    let attempts = 0;
    while (attempts < 120) {
      const statusRes = await fetch(`${VOICEBOX_URL}/history/${generationId}`);
      const statusData = await statusRes.json();

      if (statusData.status === 'completed') {
        // Download audio file
        const audioDir = path.join(DATA_DIR, 'projects', projectId);
        fs.mkdirSync(audioDir, { recursive: true });
        const audioFileName = `slide_${pageIndex}_v${Date.now()}.wav`;
        const audioPath = path.join(audioDir, audioFileName);

        // Download audio from Voicebox
        const audioUrl = `${VOICEBOX_URL}/audio/${generationId}`;
        const audioRes = await fetch(audioUrl);
        const buffer = await audioRes.arrayBuffer();
        fs.writeFileSync(audioPath, Buffer.from(buffer));

        return {
          success: true,
          data: {
            audioPath,
            duration: statusData.duration || 0,
          },
        };
      } else if (statusData.status === 'failed') {
        return { success: false, error: statusData.error || '配音生成失败' };
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
    }

    return { success: false, error: '配音生成超时' };
  } catch (err) {
    return { success: false, error: `Voicebox服务错误: ${err.message}` };
  }
}

// Compose video task
async function executeComposeVideo(params) {
  const { projectId, slides, allowSilentPages, defaultSilentPageDuration } = params;
  const projectDir = path.join(DATA_DIR, 'projects', projectId);
  const segmentsDir = path.join(projectDir, 'segments');
  const outputPath = path.join(projectDir, 'output.mp4');
  const timelinePath = path.join(projectDir, 'timeline.json');

  fs.mkdirSync(segmentsDir, { recursive: true });

  const timeline = { tracks: [{ id: 'video', type: 'video', clips: [] }, { id: 'audio', type: 'audio', clips: [] }], duration: 0 };
  let currentTime = 0;
  const segmentFiles = [];

  for (const slide of slides) {
    const { pageIndex, imagePath, dubbingAudioPath, dubbingDuration, noteStatus } = slide;
    const hasAudio = dubbingAudioPath && fs.existsSync(dubbingAudioPath);
    const isSilentPage = noteStatus === 'empty';

    let duration;
    if (hasAudio) {
      duration = dubbingDuration || defaultSilentPageDuration;
    } else if (isSilentPage && allowSilentPages) {
      duration = defaultSilentPageDuration;
    } else if (isSilentPage) {
      continue;
    } else {
      duration = defaultSilentPageDuration;
    }

    const segmentPath = path.join(segmentsDir, `segment_${pageIndex}.mp4`);

    if (hasAudio) {
      await execFileAsync('ffmpeg', ['-y', '-loop', '1', '-i', imagePath, '-i', dubbingAudioPath, '-c:v', 'libx264', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', '-shortest', '-t', String(duration), segmentPath], { timeout: 120000 });
    } else {
      await execFileAsync('ffmpeg', ['-y', '-loop', '1', '-i', imagePath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(duration), '-an', segmentPath], { timeout: 120000 });
    }

    segmentFiles.push(segmentPath);

    timeline.tracks[0].clips.push({ id: `video_${pageIndex}`, slideIndex: pageIndex, startTime: currentTime, endTime: currentTime + duration, sourcePath: imagePath, duration });
    if (hasAudio) {
      timeline.tracks[1].clips.push({ id: `audio_${pageIndex}`, slideIndex: pageIndex, startTime: currentTime, endTime: currentTime + duration, sourcePath: dubbingAudioPath, duration, volume: 1 });
    }
    currentTime += duration;
  }

  timeline.duration = currentTime;

  // Concatenate segments
  const concatListPath = path.join(segmentsDir, 'concat.txt');
  fs.writeFileSync(concatListPath, segmentFiles.map(f => `file '${f}'`).join('\n'));
  await execFileAsync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', outputPath], { timeout: 120000 });

  // Save timeline
  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));

  // Cleanup segments
  try { fs.rmSync(segmentsDir, { recursive: true, force: true }); } catch {}

  return { success: true, data: { videoPath: outputPath, timeline } };
}

// Main loop
async function main() {
  console.log(`[Worker ${WORKER_ID}] Starting...`);
  console.log(`[Worker ${WORKER_ID}] Dispatcher: ${DISPATCHER_URL}`);
  console.log(`[Worker ${WORKER_ID}] Data dir: ${DATA_DIR}`);
  console.log(`[Worker ${WORKER_ID}] Capabilities: ${CAPABILITIES.join(', ')}`);

  // Wait for dispatcher to be ready
  let registered = false;
  while (!registered) {
    registered = await register();
    if (!registered) {
      console.log(`[Worker ${WORKER_ID}] Retrying registration in 5s...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Start heartbeat
  setInterval(heartbeat, 10000);

  // Poll loop
  console.log(`[Worker ${WORKER_ID}] Polling for tasks...`);
  let idleCount = 0;
  while (true) {
    try {
      const task = await pollTask();
      if (task) {
        idleCount = 0;
        await executeTask(task);
        // Brief pause after completing a task
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        idleCount++;
        // Adaptive polling: poll less frequently when idle
        const delay = idleCount > 10 ? POLL_INTERVAL * 3 : POLL_INTERVAL;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (err) {
      console.error(`[Worker ${WORKER_ID}] Poll error:`, err.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

main();

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { initDatabase } from './db/schema';
import { ProjectService } from './services/projectService';
import { PptParserService } from './services/pptParser';
import { VoiceboxAdapter } from './services/voiceboxAdapter';
import { VoiceboxProcessManager } from './services/voiceboxProcess';
import { VideoComposerService } from './services/videoComposer';
import { createProjectRouter } from './routes/project';
import { createVoiceboxRouter } from './routes/voicebox-proxy';
import { createVideoRouter } from './routes/video';
import { createDubbingRouter } from './routes/dubbing';
import { OpenCutAdapter } from './services/opencutAdapter';
import { createOpenCutRouter } from './routes/opencut';
import { LlmService } from './services/llmService';
import { ScriptGeneratorService } from './services/scriptGenerator';
import { createLlmRouter } from './routes/llm';
import { createWorkerRouter } from './routes/workers';
import { taskQueue } from './services/taskQueue';
import { AuthService } from './services/authService';
import { createAuthMiddleware } from './middleware/auth';
import { createAuthRouter } from './routes/auth';
import { SystemSettingsService } from './services/systemSettingsService';
import { createSystemSettingsRouter } from './routes/systemSettings';
import { createSystemRouter } from './routes/system';
import { createAvatarRouter } from './routes/avatar';
import { createProjectAvatarRouter } from './routes/projectAvatar';
import { createMoocRouter } from './routes/mooc';
import { MoocJobService } from './services/moocJobService';
import { initMoocPipeline } from './services/moocPipelineWorker';
import { TranscribeJobService } from './services/transcribeJobService';
import { initTranscribePipeline } from './services/transcribeWorker';
import { createTranscribeRouter } from './routes/transcribe';
import { HyperframeJobService } from './services/hyperframeJobService';
import { initHyperframePipeline } from './services/hyperframeWorker';
import { createHyperframeRouter } from './routes/hyperframe';
import { DialogueJobService } from './services/dialogueJobService';
import { initDialoguePipeline } from './services/dialogueGenerator';
import { ensureTestImages } from './utils/generateTestImages';

const PORT = process.env.PORT || 3001;

async function main() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Ensure upload directories exist
  const voiceUploadDir = path.resolve(process.cwd(), '..', 'data', 'voice-uploads');
  fs.mkdirSync(voiceUploadDir, { recursive: true });

  // Ensure test images exist
  const testImagesDir = path.resolve(process.cwd(), '..', 'data', 'test-images');
  ensureTestImages(testImagesDir);

  // Initialize database
  const db = initDatabase();

  // Initialize auth
  const authService = new AuthService(db);
  const { authRequired, adminRequired } = createAuthMiddleware(authService);

  // Initialize Voicebox process manager (auto-starts Voicebox)
  const voiceboxProcess = new VoiceboxProcessManager();

  // Initialize services
  const projectService = new ProjectService(db);
  const pptParser = new PptParserService(projectService);
  const voicebox = new VoiceboxAdapter();
  const videoComposer = new VideoComposerService(projectService);
  const openCutAdapter = new OpenCutAdapter();
  const llmService = new LlmService(db);
  const scriptGenerator = new ScriptGeneratorService(projectService, llmService);
  const systemSettings = new SystemSettingsService(db);
  const moocJobs = new MoocJobService(db);
  const transcribeJobs = new TranscribeJobService(db);
  const hyperframeJobs = new HyperframeJobService(db);
  const dialogueJobs = new DialogueJobService(db);

  // Auth routes (captcha + login are public; users/logs/stats require auth inside the router)
  const authRouter = createAuthRouter(authService, authRequired, adminRequired);
  app.use('/api/v1/auth', authRouter);

  // Health check (public)
  app.get('/api/health', async (_req, res) => {
    const voiceboxAvailable = await voiceboxProcess.healthCheck();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      voicebox: voiceboxAvailable ? 'running' : 'starting',
    });
  });

  // Static files (public - thumbnails, images, audio, video)
  // Block /data/private/* — user avatar reference videos are owner-only via authenticated API
  const dataDir = path.resolve(process.cwd(), '..', 'data');
  fs.mkdirSync(path.join(dataDir, 'private'), { recursive: true });
  app.use('/data', (req, res, next) => {
    const p = req.path || '';
    if (p === '/private' || p.startsWith('/private/')) {
      return res.status(404).end();
    }
    next();
  }, express.static(dataDir));

  // Protected routes (require login)
  app.use('/api/v1/projects', authRequired, createProjectRouter(projectService, pptParser));
  app.use('/api/v1/voicebox', authRequired, createVoiceboxRouter(voicebox, dialogueJobs));
  app.use('/api/v1/projects', authRequired, createVideoRouter(projectService, videoComposer));
  app.use('/api/v1/projects', authRequired, createDubbingRouter(projectService, voicebox, videoComposer, systemSettings));
  app.use('/api/v1/projects', authRequired, createOpenCutRouter(projectService, openCutAdapter, videoComposer));
  app.use('/api/v1/llm', authRequired, createLlmRouter(llmService, scriptGenerator));
  app.use('/api/v1/avatar', authRequired, createAvatarRouter(db));
  app.use('/api/v1/projects', authRequired, createProjectAvatarRouter(projectService, db));
  app.use('/api/v1/mooc', authRequired, createMoocRouter(moocJobs, projectService, pptParser));
  app.use('/api/v1/transcribe', authRequired, createTranscribeRouter(transcribeJobs));
  app.use('/api/v1/hyperframe', authRequired, createHyperframeRouter(hyperframeJobs, projectService));
  app.use('/api/v1/workers', createWorkerRouter()); // workers use their own auth (API key)

  initMoocPipeline({
    db,
    moocJobs,
    projectService,
    pptParser,
    scriptGenerator,
    voicebox,
    videoComposer,
    systemSettings,
  });
  initTranscribePipeline({ jobs: transcribeJobs, voicebox });
  initHyperframePipeline({
    db,
    jobs: hyperframeJobs,
    projectService,
    pptParser,
    llm: llmService,
    voicebox,
    systemSettings,
  });
  initDialoguePipeline({ jobs: dialogueJobs, voicebox });

  // System status (GPU etc.) — any logged-in user
  app.use('/api/v1/system', authRequired, createSystemRouter());

  // System settings — admin only
  app.use('/api/v1/system-settings', authRequired, adminRequired, createSystemSettingsRouter(systemSettings));

  app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // Auto-start Voicebox in the background
    console.log('[Voicebox] Ensuring Voicebox service is running...');
    const ok = await voiceboxProcess.ensureRunning();
    if (!ok) {
      console.warn('[Voicebox] Voicebox could not be started automatically. Voice features will be unavailable.');
      console.warn('[Voicebox] You can manually start it: cd voicebox && python -m backend.main --host 127.0.0.1 --port 17493');
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down...');
    voiceboxProcess.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);

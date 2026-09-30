import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');

export function initDatabase(dbPath?: string): Database.Database {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const fullPath = dbPath || path.join(DATA_DIR, 'ppt_audio.db');
  const db = new Database(fullPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      parse_status TEXT NOT NULL DEFAULT 'pending',
      selected_voice_id TEXT,
      selected_model_id TEXT,
      video_status TEXT NOT NULL DEFAULT 'none',
      video_file_path TEXT,
      allow_silent_pages INTEGER NOT NULL DEFAULT 1,
      default_silent_page_duration REAL NOT NULL DEFAULT 5.0,
      last_saved_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slides (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      page_index INTEGER NOT NULL,
      thumbnail_path TEXT,
      image_path TEXT,
      note_status TEXT NOT NULL DEFAULT 'loaded',
      note_content TEXT,
      note_char_count INTEGER DEFAULT 0,
      estimated_duration REAL DEFAULT 0,
      dubbing_status TEXT NOT NULL DEFAULT 'pending',
      dubbing_audio_path TEXT,
      dubbing_duration REAL,
      dubbing_version INTEGER DEFAULT 0,
      dubbing_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, page_index)
    );

    CREATE TABLE IF NOT EXISTS edit_projects (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_video_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'initializing',
      timeline TEXT,
      edit_version INTEGER DEFAULT 1,
      export_status TEXT NOT NULL DEFAULT 'none',
      export_file_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_config (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model_name TEXT NOT NULL,
      api_key TEXT,
      temperature REAL NOT NULL DEFAULT 0.7,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration: add retry/tolerance columns to llm_config if not exist
  const llmCols = db.prepare("PRAGMA table_info(llm_config)").all() as any[];
  if (!llmCols.find(c => c.name === 'max_retry_cycles')) {
    db.exec('ALTER TABLE llm_config ADD COLUMN max_retry_cycles INTEGER NOT NULL DEFAULT 3');
  }
  if (!llmCols.find(c => c.name === 'tolerance_rate')) {
    db.exec('ALTER TABLE llm_config ADD COLUMN tolerance_rate REAL NOT NULL DEFAULT 0.1');
  }
  if (!llmCols.find(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE llm_config ADD COLUMN user_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_llm_config_user_id ON llm_config(user_id);');
  }

  // Migration: add user_id column to projects
  const projCols = db.prepare("PRAGMA table_info(projects)").all() as any[];
  if (!projCols.find(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN user_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);');
  }

  // Migration: add script columns to slides if not exist
  const slidesCols = db.prepare("PRAGMA table_info(slides)").all() as any[];
  if (!slidesCols.find(c => c.name === 'script_content')) {
    db.exec('ALTER TABLE slides ADD COLUMN script_content TEXT');
  }
  if (!slidesCols.find(c => c.name === 'script_status')) {
    db.exec("ALTER TABLE slides ADD COLUMN script_status TEXT NOT NULL DEFAULT 'none'");
  }

  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Operation logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      action TEXT NOT NULL,
      target TEXT,
      ip TEXT,
      user_agent TEXT,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_operation_logs_user_id ON operation_logs(user_id);`);

  // System settings table (key-value, admin-managed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
  `);

  // Seed default system settings if not present
  const existingSetting = db.prepare("SELECT key FROM system_settings WHERE key = ?").get('dubbing_timeout_seconds');
  if (!existingSetting) {
    db.prepare("INSERT INTO system_settings (key, value, description, updated_at) VALUES (?, ?, ?, ?)")
      .run('dubbing_timeout_seconds', '1000', '单页配音生成超时时间（秒），默认 1000 秒。超时后该页标记为失败。', new Date().toISOString());
  }
  const existingConcurrency = db.prepare("SELECT key FROM system_settings WHERE key = ?").get('dubbing_concurrency');
  if (!existingConcurrency) {
    db.prepare("INSERT INTO system_settings (key, value, description, updated_at) VALUES (?, ?, ?, ?)")
      .run('dubbing_concurrency', '3', '配音并发生成数（同时提交到 Voicebox 的页数）。默认 3，建议 1–3；过高可能占满 GPU 显存。', new Date().toISOString());
  }
  const existingMaxChunk = db.prepare("SELECT key FROM system_settings WHERE key = ?").get('dubbing_max_chunk_chars');
  if (!existingMaxChunk) {
    db.prepare("INSERT INTO system_settings (key, value, description, updated_at) VALUES (?, ?, ?, ?)")
      .run('dubbing_max_chunk_chars', '150', '配音文本分块最大字数（传给 Voicebox）。越小语速越稳、耗时略增。建议 100–200；最小 100。', new Date().toISOString());
  }

  // Per-user private Duix reference videos (only owner can list/preview)
  db.exec(`
    CREATE TABLE IF NOT EXISTS avatar_ref_videos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      duration_sec REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_avatar_ref_videos_user_id ON avatar_ref_videos(user_id);`);
  const refCols = db.prepare('PRAGMA table_info(avatar_ref_videos)').all() as any[];
  if (!refCols.find((c) => c.name === 'prepared_path')) {
    db.exec('ALTER TABLE avatar_ref_videos ADD COLUMN prepared_path TEXT');
  }
  // User-marked greenscreen template: compose chromakeys green → transparent (no auto-detect)
  if (!refCols.find((c) => c.name === 'is_greenscreen')) {
    db.exec('ALTER TABLE avatar_ref_videos ADD COLUMN is_greenscreen INTEGER NOT NULL DEFAULT 0');
  }
  // Project-level digital human settings (Duix in PPT flow)
  const projCols2 = db.prepare("PRAGMA table_info(projects)").all() as any[];
  const addProjCol = (name: string, ddl: string) => {
    if (!projCols2.find((c) => c.name === name)) {
      db.exec(`ALTER TABLE projects ADD COLUMN ${ddl}`);
      projCols2.push({ name });
    }
  };
  addProjCol('avatar_drive_mode', "avatar_drive_mode TEXT NOT NULL DEFAULT 'video'");
  addProjCol('avatar_ref_video_id', 'avatar_ref_video_id TEXT');
  addProjCol('avatar_photo_path', 'avatar_photo_path TEXT');
  addProjCol(
    'avatar_layout_json',
    `avatar_layout_json TEXT NOT NULL DEFAULT '{"x":0.72,"y":0.52,"w":0.25,"h":0.444}'`,
  );

  // Slide-level digital human generation + per-page layout/visibility
  const slidesCols2 = db.prepare("PRAGMA table_info(slides)").all() as any[];
  const addSlideCol = (name: string, ddl: string) => {
    if (!slidesCols2.find((c) => c.name === name)) {
      db.exec(`ALTER TABLE slides ADD COLUMN ${ddl}`);
      slidesCols2.push({ name });
    }
  };
  addSlideCol('avatar_status', "avatar_status TEXT NOT NULL DEFAULT 'none'");
  addSlideCol('avatar_enabled', 'avatar_enabled INTEGER NOT NULL DEFAULT 1');
  addSlideCol('avatar_visible', 'avatar_visible INTEGER NOT NULL DEFAULT 1');
  addSlideCol('avatar_video_path', 'avatar_video_path TEXT');
  addSlideCol('avatar_error', 'avatar_error TEXT');
  addSlideCol('avatar_layout_json', 'avatar_layout_json TEXT');

  // One-click MOOC async job queue (serial background pipelines)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mooc_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      checkpoint TEXT NOT NULL DEFAULT 'none',
      failed_stage TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mooc_jobs_user_id ON mooc_jobs(user_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mooc_jobs_status ON mooc_jobs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mooc_jobs_created_at ON mooc_jobs(created_at DESC);`);

  // Checkpoint / failed-stage for resume
  const moocCols = db.prepare('PRAGMA table_info(mooc_jobs)').all() as any[];
  if (!moocCols.find((c) => c.name === 'checkpoint')) {
    db.exec("ALTER TABLE mooc_jobs ADD COLUMN checkpoint TEXT NOT NULL DEFAULT 'none'");
  }
  if (!moocCols.find((c) => c.name === 'failed_stage')) {
    db.exec('ALTER TABLE mooc_jobs ADD COLUMN failed_stage TEXT');
  }
  if (!moocCols.find((c) => c.name === 'retry_count')) {
    db.exec('ALTER TABLE mooc_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcribe_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      audio_path TEXT,
      language TEXT,
      model TEXT NOT NULL DEFAULT 'base',
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      text TEXT,
      duration_sec REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transcribe_jobs_user_id ON transcribe_jobs(user_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transcribe_jobs_created_at ON transcribe_jobs(created_at DESC);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS hyperframe_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      scripts_json TEXT,
      composition_dir TEXT,
      video_path TEXT,
      checkpoint TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hyperframe_jobs_user_id ON hyperframe_jobs(user_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hyperframe_jobs_created_at ON hyperframe_jobs(created_at DESC);`);

  // Multi-speaker dialogue jobs (造声工厂 · 多人对话)
  db.exec(`
    CREATE TABLE IF NOT EXISTS dialogue_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      script_text TEXT NOT NULL,
      cast_json TEXT NOT NULL DEFAULT '{}',
      model_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'zh-CN',
      instruct TEXT,
      gap_ms INTEGER NOT NULL DEFAULT 600,
      max_chunk_chars INTEGER NOT NULL DEFAULT 150,
      segment_count INTEGER NOT NULL DEFAULT 0,
      completed_segments INTEGER NOT NULL DEFAULT 0,
      duration_sec REAL,
      output_path TEXT,
      work_dir TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dialogue_jobs_user_id ON dialogue_jobs(user_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dialogue_jobs_status ON dialogue_jobs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dialogue_jobs_created_at ON dialogue_jobs(created_at DESC);`);

  return db;
}

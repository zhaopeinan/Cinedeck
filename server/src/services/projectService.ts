import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

/** better-sqlite3 cannot bind boolean; coerce to 0/1 for INTEGER columns. */
function toSqliteValue(value: any): any {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export class ProjectService {
  constructor(private db: Database.Database) {}

  createProject(fileName: string, fileSize: number, filePath: string, userId?: string) {
    const id = uuidv4();
    const now = new Date().toISOString();
    const name = path.basename(fileName, path.extname(fileName));

    const projectDir = path.join(PROJECTS_DIR, id);
    fs.mkdirSync(projectDir, { recursive: true });

    const destFilePath = path.join(projectDir, fileName);
    fs.copyFileSync(filePath, destFilePath);

    this.db.prepare(`
      INSERT INTO projects (id, name, file_name, file_size, file_path, parse_status, video_status, allow_silent_pages, default_silent_page_duration, last_saved_at, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 'none', 1, 5.0, ?, ?, ?, ?)
    `).run(id, name, fileName, fileSize, destFilePath, now, userId || null, now, now);

    return this.getProject(id);
  }

  getProject(id: string) {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  }

  /** Whether the project's selected avatar ref is marked as greenscreen. */
  isAvatarRefGreenscreen(refVideoId: string | null | undefined): boolean {
    if (!refVideoId) return false;
    const row = this.db
      .prepare('SELECT is_greenscreen FROM avatar_ref_videos WHERE id = ?')
      .get(refVideoId) as { is_greenscreen?: number } | undefined;
    return !!(row && Number(row.is_greenscreen));
  }

  /** 列出当前用户的项目 */
  listProjects(userId?: string) {
    if (userId) {
      return this.db.prepare('SELECT id, name, file_name, parse_status, video_status, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
    }
    return this.db.prepare('SELECT id, name, file_name, parse_status, video_status, created_at, updated_at FROM projects ORDER BY updated_at DESC').all();
  }

  /** 管理员：列出所有项目（含用户名） */
  listAllProjects() {
    return this.db.prepare(`
      SELECT p.id, p.name, p.file_name, p.parse_status, p.video_status, p.created_at, p.updated_at, p.user_id,
             u.username AS owner_username
      FROM projects p
      LEFT JOIN users u ON p.user_id = u.id
      ORDER BY p.updated_at DESC
    `).all();
  }

  updateProject(id: string, updates: Record<string, any>) {
    const allowedFields = [
      'name', 'parse_status', 'selected_voice_id', 'selected_model_id',
      'video_status', 'video_file_path', 'allow_silent_pages',
      'default_silent_page_duration', 'last_saved_at',
      'avatar_drive_mode', 'avatar_ref_video_id', 'avatar_photo_path', 'avatar_layout_json',
    ];

    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(toSqliteValue(value));
      }
    }

    if (setClauses.length === 0) return this.getProject(id);

    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE projects SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.getProject(id);
  }

  deleteProject(id: string) {
    const project = this.getProject(id);
    if (!project) return false;

    const projectDir = path.join(PROJECTS_DIR, id);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }

    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return true;
  }

  createSlide(projectId: string, pageIndex: number, data: {
    thumbnailPath?: string;
    imagePath?: string;
    noteStatus: string;
    noteContent?: string | null;
    noteCharCount?: number;
    estimatedDuration?: number;
    scriptContent?: string | null;
    scriptStatus?: string;
  }) {
    const id = uuidv4();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO slides (id, project_id, page_index, thumbnail_path, image_path, note_status, note_content, note_char_count, estimated_duration, dubbing_status, dubbing_version, script_content, script_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
    `).run(id, projectId, pageIndex, data.thumbnailPath || null, data.imagePath || null, data.noteStatus, data.noteContent || null, data.noteCharCount || 0, data.estimatedDuration || 0, data.scriptContent || null, data.scriptStatus || 'none', now, now);

    return this.db.prepare('SELECT * FROM slides WHERE id = ?').get(id);
  }

  getSlides(projectId: string) {
    return this.db.prepare('SELECT * FROM slides WHERE project_id = ? ORDER BY page_index ASC').all(projectId);
  }

  getSlide(projectId: string, pageIndex: number) {
    return this.db.prepare('SELECT * FROM slides WHERE project_id = ? AND page_index = ?').get(projectId, pageIndex);
  }

  updateSlide(projectId: string, pageIndex: number, updates: Record<string, any>) {
    const allowedFields = [
      'thumbnail_path', 'image_path', 'note_status', 'note_content',
      'note_char_count', 'estimated_duration', 'dubbing_status',
      'dubbing_audio_path', 'dubbing_duration', 'dubbing_version',
      'dubbing_error', 'script_content', 'script_status',
      'avatar_status', 'avatar_enabled', 'avatar_visible',
      'avatar_video_path', 'avatar_error', 'avatar_layout_json',
    ];

    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(toSqliteValue(value));
      }
    }

    if (setClauses.length === 0) return this.getSlide(projectId, pageIndex);

    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(projectId);
    values.push(pageIndex);

    this.db.prepare(`UPDATE slides SET ${setClauses.join(', ')} WHERE project_id = ? AND page_index = ?`).run(...values);
    return this.getSlide(projectId, pageIndex);
  }

  deleteSlides(projectId: string) {
    this.db.prepare('DELETE FROM slides WHERE project_id = ?').run(projectId);
  }

  markSlidesRegenerate(projectId: string) {
    this.db.prepare(
      "UPDATE slides SET dubbing_status = 'regenerate_pending', updated_at = ? WHERE project_id = ? AND dubbing_status = 'generated'"
    ).run(new Date().toISOString(), projectId);
  }
}

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');

/** Fix multer/latin1 mojibake for UTF-8 filenames (e.g. 视频1 → è§é¢1). */
export function decodeUploadName(raw: string): string {
  if (!raw) return '';
  if (/[\u4e00-\u9fff]/.test(raw)) return raw;
  try {
    const fixed = Buffer.from(raw, 'latin1').toString('utf8');
    if (!fixed.includes('\uFFFD') && (/[\u4e00-\u9fff]/.test(fixed) || fixed.length < raw.length * 2)) {
      return fixed;
    }
  } catch {
    // keep original
  }
  return raw;
}

function displayNameFromUpload(name: string, originalName: string): string {
  const decodedName = decodeUploadName(name).trim();
  if (decodedName) return decodedName;
  const decodedOriginal = decodeUploadName(originalName);
  const ext = path.extname(decodedOriginal);
  const base = path.basename(decodedOriginal, ext).trim();
  return base || `参考视频 ${new Date().toISOString().slice(0, 10)}`;
}

export interface AvatarRefVideo {
  id: string;
  user_id: string;
  name: string;
  file_name: string;
  file_path: string;
  file_size: number;
  duration_sec: number | null;
  prepared_path?: string | null;
  /** 1 = green-screen template; PPT overlay chromakeys green away */
  is_greenscreen?: number;
  created_at: string;
  updated_at: string;
}

function parseBoolFlag(v: unknown): boolean {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export class AvatarRefVideoService {
  constructor(private db: Database.Database) {}

  private userDir(userId: string): string {
    const dir = path.join(DATA_DIR, 'private', 'avatar-refs', userId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  listByUser(userId: string): AvatarRefVideo[] {
    return this.db
      .prepare('SELECT * FROM avatar_ref_videos WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as AvatarRefVideo[];
  }

  getOwned(id: string, userId: string): AvatarRefVideo | null {
    const row = this.db
      .prepare('SELECT * FROM avatar_ref_videos WHERE id = ? AND user_id = ?')
      .get(id, userId) as AvatarRefVideo | undefined;
    return row || null;
  }

  /** Move file across mounts safely (rename fails with EXDEV). */
  private moveFile(src: string, dest: string): void {
    try {
      fs.renameSync(src, dest);
    } catch (err: any) {
      if (err?.code !== 'EXDEV') throw err;
      fs.copyFileSync(src, dest);
      try {
        fs.unlinkSync(src);
      } catch {
        // ignore temp cleanup
      }
    }
  }

  createFromUpload(input: {
    userId: string;
    name: string;
    originalName: string;
    tempPath: string;
    fileSize: number;
    durationSec?: number | null;
    isGreenscreen?: boolean;
  }): AvatarRefVideo {
    const id = randomUUID();
    const ext = path.extname(input.originalName).toLowerCase() || '.mp4';
    const dest = path.join(this.userDir(input.userId), `${id}${ext}`);
    this.moveFile(input.tempPath, dest);

    const now = new Date().toISOString();
    const name = displayNameFromUpload(input.name, input.originalName);
    const gs = input.isGreenscreen ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO avatar_ref_videos
         (id, user_id, name, file_name, file_path, file_size, duration_sec, is_greenscreen, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.userId, name, path.basename(dest), dest, input.fileSize, input.durationSec ?? null, gs, now, now);

    return this.getOwned(id, input.userId)!;
  }

  /** Copy an already-normalized file into the library (keeps source). */
  createFromExistingFile(input: {
    userId: string;
    name: string;
    sourcePath: string;
    originalName?: string;
    durationSec?: number | null;
    isGreenscreen?: boolean;
  }): AvatarRefVideo {
    const id = randomUUID();
    const ext = path.extname(input.originalName || input.sourcePath).toLowerCase() || '.mp4';
    const dest = path.join(this.userDir(input.userId), `${id}${ext}`);
    fs.copyFileSync(input.sourcePath, dest);
    const stat = fs.statSync(dest);
    const now = new Date().toISOString();
    const name = displayNameFromUpload(input.name, input.originalName || path.basename(input.sourcePath));
    const gs = input.isGreenscreen ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO avatar_ref_videos
         (id, user_id, name, file_name, file_path, file_size, duration_sec, is_greenscreen, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.userId, name, path.basename(dest), dest, stat.size, input.durationSec ?? null, gs, now, now);
    return this.getOwned(id, input.userId)!;
  }

  rename(id: string, userId: string, name: string): AvatarRefVideo | null {
    return this.update(id, userId, { name });
  }

  update(
    id: string,
    userId: string,
    patch: { name?: string; isGreenscreen?: boolean },
  ): AvatarRefVideo | null {
    const owned = this.getOwned(id, userId);
    if (!owned) return null;
    const sets: string[] = [];
    const vals: any[] = [];
    if (typeof patch.name === 'string') {
      const next = patch.name.trim();
      if (next) {
        sets.push('name = ?');
        vals.push(next);
      }
    }
    if (typeof patch.isGreenscreen === 'boolean') {
      sets.push('is_greenscreen = ?');
      vals.push(patch.isGreenscreen ? 1 : 0);
    }
    if (sets.length === 0) return owned;
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString(), id, userId);
    this.db
      .prepare(`UPDATE avatar_ref_videos SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...vals);
    return this.getOwned(id, userId);
  }

  delete(id: string, userId: string): boolean {
    const owned = this.getOwned(id, userId);
    if (!owned) return false;
    this.db.prepare('DELETE FROM avatar_ref_videos WHERE id = ? AND user_id = ?').run(id, userId);
    try {
      if (fs.existsSync(owned.file_path)) fs.unlinkSync(owned.file_path);
    } catch {
      // ignore disk cleanup errors
    }
    try {
      if (owned.prepared_path && fs.existsSync(owned.prepared_path)) fs.unlinkSync(owned.prepared_path);
    } catch {
      // ignore
    }
    return true;
  }

  setPreparedPath(id: string, userId: string, preparedPath: string): void {
    this.db
      .prepare('UPDATE avatar_ref_videos SET prepared_path = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(preparedPath, new Date().toISOString(), id, userId);
  }

  /** Prefer Duix-preprocessed template when available. */
  resolveTemplatePath(row: AvatarRefVideo): string {
    if (row.prepared_path && fs.existsSync(row.prepared_path) && fs.statSync(row.prepared_path).size > 1000) {
      return row.prepared_path;
    }
    return row.file_path;
  }

  publicRow(row: AvatarRefVideo) {
    return {
      id: row.id,
      name: row.name,
      fileName: row.file_name,
      fileSize: row.file_size,
      durationSec: row.duration_sec,
      prepared: !!(row.prepared_path && fs.existsSync(row.prepared_path)),
      isGreenscreen: !!(row.is_greenscreen && Number(row.is_greenscreen)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  static parseBoolFlag = parseBoolFlag;
}

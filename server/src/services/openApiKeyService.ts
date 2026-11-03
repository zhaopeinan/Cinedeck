import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export type OpenApiScope = 'tts' | 'avatar';
export const OPEN_API_SCOPES: OpenApiScope[] = ['tts', 'avatar'];

export interface OpenApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string;
  status: string;
  created_by: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpenApiKeyPublic {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: OpenApiScope[];
  status: 'active' | 'disabled';
  createdBy: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpenApiKeyVerified {
  id: string;
  name: string;
  scopes: OpenApiScope[];
  status: string;
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseScopes(raw: unknown): OpenApiScope[] {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }
  }
  const out: OpenApiScope[] = [];
  for (const s of arr) {
    const v = String(s || '').trim().toLowerCase();
    if ((OPEN_API_SCOPES as string[]).includes(v) && !out.includes(v as OpenApiScope)) {
      out.push(v as OpenApiScope);
    }
  }
  return out;
}

function toPublic(row: OpenApiKeyRow): OpenApiKeyPublic {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: parseScopes(row.scopes),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OpenApiKeyService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  list(): OpenApiKeyPublic[] {
    const rows = this.db
      .prepare('SELECT * FROM open_api_keys ORDER BY created_at DESC')
      .all() as OpenApiKeyRow[];
    return rows.map(toPublic);
  }

  getById(id: string): OpenApiKeyPublic | null {
    const row = this.db.prepare('SELECT * FROM open_api_keys WHERE id = ?').get(id) as OpenApiKeyRow | undefined;
    return row ? toPublic(row) : null;
  }

  /** Create key. Plaintext returned once only. */
  create(input: {
    name: string;
    scopes: OpenApiScope[];
    createdBy?: string | null;
  }): { key: OpenApiKeyPublic; apiKey: string } {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('名称不能为空');
    const scopes = parseScopes(input.scopes);
    if (scopes.length === 0) throw new Error('至少选择一个权限范围（tts / avatar）');

    const id = uuidv4();
    const secret = randomBytes(24).toString('base64url');
    const apiKey = `sk_${secret}`;
    const keyHash = hashKey(apiKey);
    const keyPrefix = apiKey.slice(0, 11); // sk_ + 8 chars
    const now = nowIso();

    this.db
      .prepare(`
        INSERT INTO open_api_keys (
          id, name, key_prefix, key_hash, scopes, status, created_by, last_used_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)
      `)
      .run(id, name, keyPrefix, keyHash, JSON.stringify(scopes), input.createdBy || null, now, now);

    const key = this.getById(id)!;
    return { key, apiKey };
  }

  update(
    id: string,
    patch: Partial<{ name: string; scopes: OpenApiScope[]; status: 'active' | 'disabled' }>,
  ): OpenApiKeyPublic | null {
    const existing = this.db.prepare('SELECT * FROM open_api_keys WHERE id = ?').get(id) as OpenApiKeyRow | undefined;
    if (!existing) return null;

    let name = existing.name;
    let scopesJson = existing.scopes;
    let status = existing.status;

    if (patch.name != null) {
      const n = String(patch.name).trim();
      if (!n) throw new Error('名称不能为空');
      name = n;
    }
    if (patch.scopes != null) {
      const scopes = parseScopes(patch.scopes);
      if (scopes.length === 0) throw new Error('至少选择一个权限范围（tts / avatar）');
      scopesJson = JSON.stringify(scopes);
    }
    if (patch.status != null) {
      if (patch.status !== 'active' && patch.status !== 'disabled') {
        throw new Error('状态仅支持 active / disabled');
      }
      status = patch.status;
    }

    const now = nowIso();
    this.db
      .prepare(`
        UPDATE open_api_keys
        SET name = ?, scopes = ?, status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(name, scopesJson, status, now, id);

    return this.getById(id);
  }

  delete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM open_api_keys WHERE id = ?').run(id);
    return r.changes > 0;
  }

  verify(rawKey: string): OpenApiKeyVerified | null {
    const key = String(rawKey || '').trim();
    if (!key.startsWith('sk_') || key.length < 16) return null;
    const keyHash = hashKey(key);
    const row = this.db
      .prepare("SELECT * FROM open_api_keys WHERE key_hash = ? AND status = 'active'")
      .get(keyHash) as OpenApiKeyRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      scopes: parseScopes(row.scopes),
      status: row.status,
    };
  }

  touchLastUsed(id: string): void {
    try {
      this.db
        .prepare('UPDATE open_api_keys SET last_used_at = ?, updated_at = updated_at WHERE id = ?')
        .run(nowIso(), id);
    } catch {
      /* ignore */
    }
  }

  hasScope(verified: OpenApiKeyVerified, scope: OpenApiScope): boolean {
    return verified.scopes.includes(scope);
  }
}

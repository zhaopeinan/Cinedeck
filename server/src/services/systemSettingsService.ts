import Database from 'better-sqlite3';

/**
 * System-level configuration service.
 * Stores key-value pairs in the system_settings table.
 * All values are stored as strings; callers are responsible for type coercion.
 */
export class SystemSettingsService {
  constructor(private db: Database.Database) {}

  /** Default values used when a key is missing from the DB. */
  private static DEFAULTS: Record<string, { value: string; description: string }> = {
    dubbing_timeout_seconds: { value: '1000', description: '单页配音生成超时时间（秒），默认 1000 秒。超时后该页标记为失败。' },
    dubbing_concurrency: { value: '3', description: '配音并发生成数（同时提交到 Voicebox 的页数）。默认 3，建议 1–3；过高可能占满 GPU 显存。' },
    // Qwen3-TTS 长单次生成约 30s 后会越说越快；Voicebox 按句切分可稳住语速。建议 100–200。
    dubbing_max_chunk_chars: { value: '150', description: '配音文本分块最大字数（传给 Voicebox）。越小语速越稳、耗时略增。建议 100–200；最小 100。' },
  };

  /** Get a single setting value as string (returns default if missing). */
  get(key: string): string {
    const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (row) return row.value;
    return SystemSettingsService.DEFAULTS[key]?.value ?? '';
  }

  /** Get a single setting value as number (returns default if missing or invalid). */
  getNumber(key: string, fallback: number): number {
    const raw = this.get(key);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
  }

  /** Get all settings (merging DB rows with defaults). */
  list(): Array<{ key: string; value: string; description: string | null; updatedAt: string | null; updatedBy: string | null }> {
    const rows = this.db.prepare('SELECT key, value, description, updated_at AS updatedAt, updated_by AS updatedBy FROM system_settings').all() as any[];
    const byKey = new Map(rows.map(r => [r.key, r]));
    // Merge defaults (so newly-added default keys always show up even before first write)
    const allKeys = new Set<string>([...Object.keys(SystemSettingsService.DEFAULTS), ...byKey.keys()]);
    return Array.from(allKeys).map(k => {
      const row = byKey.get(k);
      const def = SystemSettingsService.DEFAULTS[k];
      return {
        key: k,
        value: row?.value ?? def?.value ?? '',
        description: row?.description ?? def?.description ?? null,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    });
  }

  /** Update a setting (upsert). Returns the updated row. */
  update(key: string, value: string, updatedBy?: string): { key: string; value: string } {
    const def = SystemSettingsService.DEFAULTS[key];
    const description = def?.description ?? null;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO system_settings (key, value, description, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, description = COALESCE(excluded.description, system_settings.description), updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(key, value, description, now, updatedBy ?? null);
    return { key, value };
  }

  /** Convenience: get the dubbing timeout in seconds. */
  getDubbingTimeoutSeconds(): number {
    return this.getNumber('dubbing_timeout_seconds', 1000);
  }

  /** Convenience: get dubbing concurrency (clamped 1–8). */
  getDubbingConcurrency(): number {
    const n = this.getNumber('dubbing_concurrency', 3);
    return Math.max(1, Math.min(8, Math.floor(n)));
  }

  /** Convenience: max chars per TTS chunk (clamped 100–5000, Voicebox bounds). */
  getDubbingMaxChunkChars(): number {
    const n = this.getNumber('dubbing_max_chunk_chars', 150);
    return Math.max(100, Math.min(5000, Math.floor(n)));
  }
}

import Database from 'better-sqlite3';

export type ExplainReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/** Per-user token budgets for explain-animation LLM stages */
export interface ExplainGenSettings {
  maxTokensRecommend: number;
  maxTokensScript: number;
  maxTokensSample: number;
  maxTokensFinal: number;
  reasoningEffort: ExplainReasoningEffort;
}

export const EXPLAIN_GEN_DEFAULTS: ExplainGenSettings = {
  maxTokensRecommend: 4000,
  maxTokensScript: 6000,
  maxTokensSample: 24000,
  maxTokensFinal: 32000,
  reasoningEffort: 'low',
};

export const EXPLAIN_GEN_FIELD_META: Array<{
  key: keyof ExplainGenSettings;
  label: string;
  description: string;
  min?: number;
  max?: number;
  type: 'int' | 'enum';
  options?: Array<{ value: ExplainReasoningEffort; label: string }>;
}> = [
  {
    key: 'maxTokensRecommend',
    label: '风格推荐 max_tokens',
    description: '选题 → 推荐 3 种风格时的补全上限',
    min: 500,
    max: 32000,
    type: 'int',
  },
  {
    key: 'maxTokensScript',
    label: '分镜脚本 max_tokens',
    description: '选定风格后撰写极简分镜 JSON',
    min: 500,
    max: 32000,
    type: 'int',
  },
  {
    key: 'maxTokensSample',
    label: 'HTML 样片 max_tokens',
    description: '约 20 秒样片单文件 HTML（含思考预算）',
    min: 2000,
    max: 128000,
    type: 'int',
  },
  {
    key: 'maxTokensFinal',
    label: 'HTML 全片 max_tokens',
    description: '确认样片后扩展完整动画',
    min: 2000,
    max: 128000,
    type: 'int',
  },
  {
    key: 'reasoningEffort',
    label: 'Reasoning 强度',
    description: 'DeepSeek 等推理模型；样片若出骨架会自动降为 none 重试一次',
    type: 'enum',
    options: [
      { value: 'none', label: '关闭（none）' },
      { value: 'low', label: '低（low，推荐）' },
      { value: 'medium', label: '中（medium）' },
      { value: 'high', label: '高（high）' },
    ],
  },
];

const PREF_KEY = 'explain_gen_settings';

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function normalize(raw: Partial<ExplainGenSettings> | null | undefined): ExplainGenSettings {
  const d = EXPLAIN_GEN_DEFAULTS;
  const effort = raw?.reasoningEffort;
  const okEffort = effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high'
    ? effort
    : d.reasoningEffort;
  return {
    maxTokensRecommend: clampInt(raw?.maxTokensRecommend, 500, 32000, d.maxTokensRecommend),
    maxTokensScript: clampInt(raw?.maxTokensScript, 500, 32000, d.maxTokensScript),
    maxTokensSample: clampInt(raw?.maxTokensSample, 2000, 128000, d.maxTokensSample),
    maxTokensFinal: clampInt(raw?.maxTokensFinal, 2000, 128000, d.maxTokensFinal),
    reasoningEffort: okEffort,
  };
}

export class ExplainGenSettingsService {
  constructor(private db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `);
  }

  getForUser(userId: string): ExplainGenSettings {
    if (!userId) return { ...EXPLAIN_GEN_DEFAULTS };
    const row = this.db.prepare(
      'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
    ).get(userId, PREF_KEY) as { value: string } | undefined;
    if (!row?.value) return { ...EXPLAIN_GEN_DEFAULTS };
    try {
      return normalize(JSON.parse(row.value));
    } catch {
      return { ...EXPLAIN_GEN_DEFAULTS };
    }
  }

  setForUser(userId: string, patch: Partial<ExplainGenSettings>): ExplainGenSettings {
    if (!userId) throw new Error('未登录');
    const next = normalize({ ...this.getForUser(userId), ...patch });
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(userId, PREF_KEY, JSON.stringify(next), now);
    return next;
  }

  /** Public payload for settings UI */
  publicPayload(userId: string) {
    const settings = this.getForUser(userId);
    return {
      settings,
      defaults: { ...EXPLAIN_GEN_DEFAULTS },
      fields: EXPLAIN_GEN_FIELD_META,
    };
  }
}

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

export interface LlmConfig {
  id: string;
  user_id: string | null;
  name: string;
  base_url: string;
  model_name: string;
  api_key: string | null;
  temperature: number;
  is_active: number;
  max_retry_cycles: number;
  tolerance_rate: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
}

/** 校园网等环境下通过 HTTPS_PROXY/HTTP_PROXY 出站；可回退到宿主机 Clash 反代 */
function getAxiosProxy(): false | { host: string; port: number; protocol: string } {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.LLM_HTTPS_PROXY ||
    '';
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return {
      protocol: (u.protocol || 'http:').replace(':', ''),
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
    };
  } catch {
    return false;
  }
}

function isTlsInterceptError(err: any): boolean {
  const msg = String(err?.message || err || '');
  const code = String(err?.code || '');
  return (
    /altnames|certificate|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED|self[- ]signed/i.test(msg) ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  );
}

/** 校园网劫持 HTTPS 时，尝试宿主机上的 Clash 反代端口 */
function campusProxyCandidates(): Array<{ host: string; port: number; protocol: string }> {
  const port = Number(process.env.LLM_PROXY_PORT || 17890);
  const hosts = String(process.env.LLM_PROXY_HOSTS || '172.17.0.1,172.18.0.1,host.docker.internal')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hosts.map((host) => ({ host, port, protocol: 'http' }));
}

export class LlmService {
  constructor(private db: Database.Database) {}

  // ===== Config CRUD =====

  listConfigs(userId?: string): LlmConfig[] {
    if (userId) {
      return this.db.prepare('SELECT * FROM llm_config WHERE user_id = ? ORDER BY created_at ASC').all(userId) as LlmConfig[];
    }
    return this.db.prepare('SELECT * FROM llm_config ORDER BY created_at ASC').all() as LlmConfig[];
  }

  getActiveConfig(userId?: string): LlmConfig | null {
    if (userId) {
      return (this.db.prepare('SELECT * FROM llm_config WHERE user_id = ? AND is_active = 1 LIMIT 1').get(userId) as LlmConfig) || null;
    }
    return (this.db.prepare('SELECT * FROM llm_config WHERE is_active = 1 LIMIT 1').get() as LlmConfig) || null;
  }

  getConfig(id: string): LlmConfig | null {
    return (this.db.prepare('SELECT * FROM llm_config WHERE id = ?').get(id) as LlmConfig) || null;
  }

  createConfig(data: { name: string; base_url: string; model_name: string; api_key?: string; temperature?: number; max_retry_cycles?: number; tolerance_rate?: number; user_id?: string }) {
    const id = uuidv4();
    const now = new Date().toISOString();
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM llm_config WHERE user_id = ?').get(data.user_id || null) as any).c;
    this.db.prepare(`
      INSERT INTO llm_config (id, user_id, name, base_url, model_name, api_key, temperature, is_active, max_retry_cycles, tolerance_rate, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, data.user_id || null, data.name, data.base_url, data.model_name, data.api_key || null,
      data.temperature ?? 0.7, count === 0 ? 1 : 0,
      data.max_retry_cycles ?? 3, data.tolerance_rate ?? 0.1,
      now, now,
    );
    return this.getConfig(id);
  }

  updateConfig(id: string, data: Partial<{ name: string; base_url: string; model_name: string; api_key: string; temperature: number; max_retry_cycles: number; tolerance_rate: number }>) {
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: any[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (fields.length === 0) return this.getConfig(id);
    fields.push('updated_at = ?');
    values.push(now, id);
    this.db.prepare(`UPDATE llm_config SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getConfig(id);
  }

  deleteConfig(id: string, userId?: string) {
    this.db.prepare('DELETE FROM llm_config WHERE id = ? AND (? IS NULL OR user_id = ?)').run(id, userId || null, userId || null);
    // 若删除的是激活配置，自动激活该用户的第一个
    const remaining = this.listConfigs(userId);
    if (remaining.length > 0 && !remaining.find(c => c.is_active)) {
      this.setActive(remaining[0].id);
    }
  }

  setActive(id: string) {
    const config = this.getConfig(id);
    if (!config) return;
    // 只在同一个 user_id 范围内切换激活
    this.db.prepare('UPDATE llm_config SET is_active = 0 WHERE user_id IS ?').run(config.user_id || null);
    this.db.prepare('UPDATE llm_config SET is_active = 1 WHERE id = ?').run(id);
  }

  // ===== API 调用 =====

  /**
   * 调用 OpenAI 兼容的 chat completions API
   * options.userId 用于按用户筛选激活配置
   */
  async chat(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number; userId?: string; configId?: string }): Promise<string> {
    const config = options?.configId ? this.getConfig(options.configId) : this.getActiveConfig(options?.userId);
    if (!config) throw new Error('未配置大模型，请先在设置中添加 LLM 配置');

    const baseUrl = config.base_url.replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;

    const body: any = {
      model: config.model_name,
      messages,
      temperature: options?.temperature ?? config.temperature,
    };
    if (options?.maxTokens) {
      body.max_tokens = options.maxTokens;
    }

    const headers: any = { 'Content-Type': 'application/json' };
    if (config.api_key) {
      headers['Authorization'] = `Bearer ${config.api_key}`;
    }

    try {
      const res = await axios.post(url, body, {
        headers,
        timeout: 120000,
        proxy: getAxiosProxy(),
      });
      const content = res.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('模型返回内容为空');
      return content;
    } catch (err: any) {
      // 校园网 HTTPS 劫持：直连拿不到正确证书，自动改走宿主机 Clash 反代
      if (isTlsInterceptError(err) && !getAxiosProxy()) {
        let last = err;
        for (const proxy of campusProxyCandidates()) {
          try {
            const res = await axios.post(url, body, {
              headers,
              timeout: 120000,
              proxy,
            });
            const content = res.data?.choices?.[0]?.message?.content;
            if (!content) throw new Error('模型返回内容为空');
            console.warn(`[LLM] TLS intercept detected; using campus proxy ${proxy.host}:${proxy.port}`);
            return content;
          } catch (e2: any) {
            last = e2;
            if (e2.response) break; // reached API (auth/model error) — stop hopping proxies
          }
        }
        err = last;
      }
      if (err.response) {
        const msg = err.response.data?.error?.message || err.response.data?.message || JSON.stringify(err.response.data);
        throw new Error(`模型请求失败 (${err.response.status}): ${msg}`);
      }
      const hint = isTlsInterceptError(err)
        ? '（校园网 HTTPS 被劫持。请在开发机保持 Clash，并建立反代：ssh -f -N -R 0.0.0.0:17890:127.0.0.1:7890 root@服务器）'
        : '';
      throw new Error(`模型请求失败: ${err.message}${hint}`);
    }
  }

  /**
   * 多模态调用：发送图片文件 + 文本
   */
  async chatWithImage(textPrompt: string, imagePath: string, options?: { temperature?: number; systemPrompt?: string; maxTokens?: number; userId?: string }): Promise<string> {
    if (!fs.existsSync(imagePath)) throw new Error(`图片不存在: ${imagePath}`);

    const ext = path.extname(imagePath).toLowerCase().replace('.', '') || 'png';
    const mimeType = ext === 'jpg' ? 'jpeg' : ext;
    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');
    const dataUri = `data:image/${mimeType};base64,${base64}`;

    const messages: ChatMessage[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: textPrompt },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    });

    return this.chat(messages, options);
  }

  /**
   * 多模态调用：直接发送 data URI 图片 + 文本（用于测试连接）
   */
  async chatWithImageDataUri(textPrompt: string, imageDataUri: string, options?: { temperature?: number; maxTokens?: number; configId?: string }): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: textPrompt },
          { type: 'image_url', image_url: { url: imageDataUri } },
        ],
      },
    ];
    return this.chat(messages, options);
  }
}

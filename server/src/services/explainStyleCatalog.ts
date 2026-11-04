import fs from 'fs';
import path from 'path';

const BUNDLED_DIR = path.resolve(__dirname, '../../assets/explain-styles');

export interface ExplainStyle {
  id: number;
  name: string;
  nameZh: string;
  family: string;
  familyZh?: string;
  description: string;
  motionNotes: string;
  explainerNotes: string;
  folder?: string;
  variants?: Array<{ id: string; name: string; poster?: string }>;
  sourceCredit?: string;
}

let cached: ExplainStyle[] | null = null;

function loadGalleryZh(): Record<string, string> {
  try {
    const root = getExplainStylesRoot();
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'gallery-zh.json'), 'utf-8'));
    const map: Record<string, string> = {};
    if (Array.isArray(raw?.names)) {
      raw.names.forEach((name: string, idx: number) => {
        if (name) map[String(idx + 1)] = String(name);
      });
      return map;
    }
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item?.id != null && item?.nameZh) map[String(item.id)] = String(item.nameZh);
      }
      return map;
    }
  } catch { /* ignore */ }
  return {};
}

export function getExplainStylesRoot(): string {
  return process.env.EXPLAIN_STYLES_DIR || BUNDLED_DIR;
}

export function listExplainStyles(): ExplainStyle[] {
  if (cached) return cached;
  const root = getExplainStylesRoot();
  const zh = loadGalleryZh();
  const base = JSON.parse(fs.readFileSync(path.join(root, 'style-index.json'), 'utf-8')) as any[];
  const custom = JSON.parse(fs.readFileSync(path.join(root, 'custom-style-index.json'), 'utf-8')) as any[];
  const out: ExplainStyle[] = [
    ...base.map((s) => ({
      id: Number(s.id),
      name: String(s.name),
      nameZh: zh[String(s.id)] || String(s.name),
      family: String(s.family || ''),
      description: String(s.description || ''),
      motionNotes: String(s.motionNotes || ''),
      explainerNotes: String(s.explainerNotes || ''),
      folder: String(s.folder || ''),
    })),
    ...custom.map((s) => ({
      id: Number(s.id),
      name: String(s.name),
      nameZh: String(s.nameZh || s.name),
      family: String(s.family || ''),
      familyZh: s.familyZh ? String(s.familyZh) : undefined,
      description: String(s.description || ''),
      motionNotes: String(s.motionNotes || ''),
      explainerNotes: String(s.explainerNotes || ''),
      folder: String(s.folder || ''),
      variants: Array.isArray(s.variants)
        ? s.variants.map((v: any) => ({ id: String(v.id), name: String(v.name), poster: v.poster }))
        : undefined,
      sourceCredit: s.sourceCredit ? String(s.sourceCredit) : undefined,
    })),
  ];
  cached = out;
  return out;
}

export function getExplainStyle(id: number): ExplainStyle | null {
  return listExplainStyles().find((s) => s.id === id) || null;
}

export function getExplainPosterPath(styleId: number, variant?: string | null): string | null {
  const root = getExplainStylesRoot();
  const posters = path.join(root, 'posters');
  if (variant) {
    const alt = path.join(posters, `${styleId}-${variant}.jpg`);
    if (fs.existsSync(alt)) return alt;
  }
  const p = path.join(posters, `${styleId}.jpg`);
  return fs.existsSync(p) ? p : null;
}

/** Compact catalog text for LLM (avoid huge prompts). */
export function styleCatalogForPrompt(limit = 88): string {
  return listExplainStyles()
    .slice(0, limit)
    .map((s) =>
      `#${s.id} ${s.nameZh} / ${s.name} [${s.family}] — ${s.description.slice(0, 160)}`,
    )
    .join('\n');
}

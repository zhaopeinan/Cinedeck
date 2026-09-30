/**
 * Parse multi-speaker dialogue scripts.
 * Supports:
 *   张三：大家好
 *   [李四] 你好
 * Lines starting with # are comments; blank lines ignored.
 */

export interface DialogueSegment {
  speaker: string;
  text: string;
  lineNo: number;
}

export interface ParseDialogueResult {
  segments: DialogueSegment[];
  speakers: string[];
}

const BRACKET_RE = /^\s*\[([^\]]+)\]\s*(.+)$/;
const COLON_RE = /^\s*([^：:\n\r]{1,40})\s*[：:]\s*(.+)$/;

export const DIALOGUE_MAX_SEGMENTS = 800;
export const DIALOGUE_MAX_CHARS = 200_000;

export function parseDialogueScript(script: string): ParseDialogueResult {
  const raw = String(script || '');
  if (!raw.trim()) {
    throw new Error('剧本为空');
  }
  if (raw.length > DIALOGUE_MAX_CHARS) {
    throw new Error(`剧本过长（上限 ${DIALOGUE_MAX_CHARS} 字）`);
  }

  const lines = raw.split(/\r?\n/);
  const segments: DialogueSegment[] = [];
  const speakerSet = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let speaker = '';
    let text = '';
    const bracket = BRACKET_RE.exec(trimmed);
    if (bracket) {
      speaker = bracket[1].trim();
      text = bracket[2].trim();
    } else {
      const colon = COLON_RE.exec(trimmed);
      if (colon) {
        speaker = colon[1].trim();
        text = colon[2].trim();
      }
    }

    if (!speaker || !text) {
      throw new Error(`第 ${i + 1} 行无法解析，请使用「角色：对白」或「[角色] 对白」格式`);
    }
    if (/^[\[【]/.test(speaker) || speaker.includes('：') || speaker.includes(':')) {
      throw new Error(`第 ${i + 1} 行角色名无效：「${speaker}」`);
    }

    segments.push({ speaker, text, lineNo: i + 1 });
    speakerSet.add(speaker);
  }

  if (!segments.length) {
    throw new Error('未解析到任何对白段落');
  }
  if (segments.length > DIALOGUE_MAX_SEGMENTS) {
    throw new Error(`对白段数过多（${segments.length}，上限 ${DIALOGUE_MAX_SEGMENTS}）`);
  }

  return {
    segments,
    speakers: [...speakerSet],
  };
}

/** Ensure every speaker has a voice mapping. */
export function validateCast(
  speakers: string[],
  cast: Record<string, string>,
): { ok: true } | { ok: false; missing: string[] } {
  const missing = speakers.filter((s) => !cast[s] || !String(cast[s]).trim());
  if (missing.length) return { ok: false, missing };
  return { ok: true };
}

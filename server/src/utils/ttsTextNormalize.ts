/**
 * Normalize script text before sending to Chinese TTS (Qwen / Voicebox).
 *
 * All-caps Latin acronyms like "KES" are often misread as English words
 * ("ees" / "is"). Insert spaces so the model spells letters: "K E S".
 */
export function normalizeTtsText(text: string): string {
  if (!text) return text;

  // 2+ consecutive A–Z → spell out with spaces (KES → K E S)
  // Does not touch already-spaced "K E S", mixed case (iPhone), or digits alone.
  return text.replace(/[A-Z]{2,}/g, (acronym) => acronym.split('').join(' '));
}

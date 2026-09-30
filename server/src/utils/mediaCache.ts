import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PROJECTS_DIR = path.resolve(process.cwd(), '..', 'data', 'projects');

/** Stable short id for a Voicebox audio URL (or local path). */
export function audioCacheKey(audioPath: string): string {
  return crypto.createHash('sha1').update(audioPath).digest('hex').slice(0, 12);
}

export function projectDirFromId(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId);
}

/**
 * Cached audio file for a slide. Includes URL/path hash so regenerating dubbing
 * (new Voicebox URL) never silently reuses the previous wav.
 */
export function slideAudioCachePath(projectDir: string, pageIndex: number, audioPath: string): string {
  const key = audioCacheKey(audioPath);
  return path.join(projectDir, 'audio_cache', `slide_${pageIndex}_${key}.wav`);
}

/** Legacy fixed cache name (pre-hash). */
export function legacySlideAudioCachePath(projectDir: string, pageIndex: number): string {
  return path.join(projectDir, 'audio_cache', `slide_${pageIndex}_audio.wav`);
}

export function slideSegmentPath(projectDir: string, pageIndex: number): string {
  return path.join(projectDir, 'segments', `segment_${pageIndex}.mkv`);
}

/**
 * After dubbing is regenerated, drop stale compose/avatar audio caches and the
 * page video segment so the next preview/compose uses the new voice.
 */
export function invalidateSlideMediaCache(projectId: string, pageIndex: number): void {
  const projectDir = projectDirFromId(projectId);
  const targets: string[] = [
    legacySlideAudioCachePath(projectDir, pageIndex),
    slideSegmentPath(projectDir, pageIndex),
    path.join(projectDir, 'segments', `pause_${pageIndex}.mkv`),
    path.join(projectDir, 'output.mp4'),
  ];

  // Export uses loop-index filenames; wipe export cache so a later export won't mix old audio.
  const exportDir = path.join(projectDir, 'export_segments');
  if (fs.existsSync(exportDir)) {
    for (const name of fs.readdirSync(exportDir)) {
      targets.push(path.join(exportDir, name));
    }
  }

  const audioDir = path.join(projectDir, 'audio_cache');
  if (fs.existsSync(audioDir)) {
    for (const name of fs.readdirSync(audioDir)) {
      if (name.startsWith(`slide_${pageIndex}_`) && name.endsWith('.wav')) {
        targets.push(path.join(audioDir, name));
      }
    }
  }

  for (const p of targets) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[Cache] Invalidated ${p}`);
      }
    } catch (err: any) {
      console.warn(`[Cache] Failed to remove ${p}: ${err?.message || err}`);
    }
  }
}

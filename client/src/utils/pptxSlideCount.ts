/**
 * Count slides in a PPTX by scanning ZIP entry names / Content_Types paths.
 *
 * Most PPTX use forward slashes (`ppt/slides/slideN.xml`), but some Windows /
 * WPS exports store backslashes (`ppt\slides\slideN.xml`). Content_Types.xml
 * usually still uses `/ppt/slides/slideN.xml`.
 */
export async function countPptxSlides(file: File): Promise<number> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const found = new Set<number>();

  // Prefer Content_Types / zip names that clearly mean real slides
  // (exclude notesSlides, slideLayouts, slideMasters).
  const needles = [
    'ppt/slides/slide',
    'ppt\\slides\\slide',
    '/ppt/slides/slide',
  ];

  for (const needle of needles) {
    scanNeedle(bytes, needle, found);
  }

  return found.size;
}

function scanNeedle(bytes: Uint8Array, needle: string, found: Set<number>) {
  const n0 = needle.charCodeAt(0);
  for (let i = 0; i < bytes.length - needle.length - 6; i++) {
    if (bytes[i] !== n0) continue;
    let ok = true;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Reject notesSlides / slideLayouts false positives if somehow matched
    // (e.g. "...notesSlides/slide" should not occur with our needles)

    let k = i + needle.length;
    let num = '';
    while (k < bytes.length && bytes[k] >= 0x30 && bytes[k] <= 0x39) {
      num += String.fromCharCode(bytes[k]);
      k++;
    }
    // Accept slideN.xml (and slideN.xml.rels — same page index)
    if (!num || bytes[k] !== 0x2e /* . */) continue;
    const n = parseInt(num, 10);
    if (Number.isFinite(n) && n >= 1) found.add(n);
  }
}

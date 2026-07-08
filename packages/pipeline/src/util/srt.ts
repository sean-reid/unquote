/**
 * SubRip to cues. One cue per subtitle block, matching the granularity of the
 * other transcript sources; downstream cleaning (lyrics, brackets, credits)
 * happens in the utterances stage, so this stays mechanical: drop indexes and
 * timestamps, strip markup, join a block's lines with a space.
 */

const TIMESTAMP = /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/;

export function srtToCues(srt: string): string[] {
  const text = srt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    if (/^\s*\d+\s*$/.test(lines[0]!)) lines.shift();
    if (lines.length > 0 && TIMESTAMP.test(lines[0]!)) lines.shift();
    const joined = lines
      .join(' ')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (joined.length > 0) cues.push(joined);
  }
  return cues;
}

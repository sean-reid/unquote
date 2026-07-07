const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '-',
  '&ndash;': '-',
  '&hellip;': '...',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-z]+;/gi, (match) => ENTITIES[match.toLowerCase()] ?? match);
}

/**
 * Extract the inner HTML of the first <div> with the given class. Handles nested
 * divs by counting open/close tags from the match.
 */
export function extractDivByClass(html: string, className: string): string | null {
  const open = new RegExp(`<div[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i');
  const start = html.search(open);
  if (start < 0) return null;
  const openMatch = html.slice(start).match(open)!;
  const bodyStart = start + openMatch[0].length;
  let depth = 1;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(bodyStart, m.index);
  }
  return html.slice(bodyStart);
}

/**
 * Split a Springfield transcript block into its subtitle cues. Each <br>
 * fragment is one cue: tags stripped, entities decoded, whitespace collapsed.
 * Cues keep their raw content (dashes, brackets, music marks); interpreting
 * them is the utterance stage's job.
 */
export function splitCues(inner: string): string[] {
  return inner
    .split(/<br\s*\/?>/i)
    .map((frag) =>
      // Strip tags again after decoding: some pages double-escape markup
      // (&lt;b&gt;), which only becomes a tag once entities are decoded.
      decodeEntities(frag.replace(/<[^>]+>/g, ' '))
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((frag) => frag.length > 0);
}

/**
 * Fallback for the page variant that ships the whole transcript as one block
 * with no <br> structure and inline ALL-CAPS speaker names ("1 Part 1 JUSTINE
 * Sir..."). Strips the speaker tokens and part markers, then cuts sentences
 * after terminal punctuation. Coarser than real cues, far better than one blob.
 */
export function sentenceCues(inner: string): string[] {
  const text = decodeEntities(inner.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\b(?:\d+\s+)?Part\s+\d+\b/gi, ' ')
    .replace(/\b[A-Z][A-Z'.]{2,}(?:\s+[A-Z][A-Z'.]{2,}){0,2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text
    .split(/(?<=[.?!…]["'”’]?)\s+/)
    .map((sentence) => sentence.replace(/^\d+\s+/, '').trim())
    .filter((sentence) => sentence.length > 1);
}

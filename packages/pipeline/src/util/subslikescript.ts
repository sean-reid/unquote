import { decodeEntities, extractDivByClass } from './html.js';

const BASE = 'https://subslikescript.com';

/**
 * Transcript page URL. The site routes on the IMDb id and 301s any slug to the
 * canonical page (verified: Birdman-2562232 redirects to the full title), so
 * the slug is cosmetic; a rough one keeps the cache key readable.
 */
export function movieUrl(title: string, imdbDigits: string): string {
  const slug =
    title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Movie';
  return `${BASE}/movie/${slug}-${imdbDigits}`;
}

/** Year from the page heading: "The Dark Knight (2008) - full transcript". */
export function pageYear(html: string): number | null {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const year = h1?.[1]?.match(/\((\d{4})\)/);
  return year ? Number(year[1]) : null;
}

/**
 * One subtitle-cue div is one cue; its cue-line paragraphs join with a space,
 * which reproduces the dash-marked dual-speaker shape the utterance stage
 * already knows how to split.
 */
export function extractCues(html: string): string[] {
  const container = extractDivByClass(html, 'full-script');
  if (!container) return [];
  const cues: string[] = [];
  for (const cue of container.matchAll(/<div[^>]*class="subtitle-cue"[^>]*>([\s\S]*?)<\/div>/g)) {
    const lines = [...cue[1]!.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((p) =>
      decodeEntities(p[1]!.replace(/<[^>]+>/g, ' '))
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) cues.push(text);
  }
  return cues;
}

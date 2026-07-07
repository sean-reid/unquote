import { politeFetchText } from './http.js';
import { extractDivByClass, splitCues } from './html.js';
import { titleKey } from './title.js';

const SS = 'https://www.springfieldspringfield.co.uk';

export function searchUrl(title: string): string {
  return `${SS}/movie_scripts.php?search=${encodeURIComponent(title)}`;
}

export function scriptUrl(slug: string): string {
  return `${SS}/movie_script.php?movie=${slug}`;
}

/** Find the script slug for a film on its search results page, checking the year. */
export function findSlug(resultsHtml: string, title: string, year: number): string | null {
  const anchor = /<a href="(?:\/)?movie_script\.php\?movie=([^"']+)"[^>]*>([^<]+)<\/a>/gi;
  const want = titleKey(title);
  for (const m of resultsHtml.matchAll(anchor)) {
    const label = m[2]!;
    const yr = label.match(/\((\d{4})\)/);
    const labelYear = yr ? Number(yr[1]) : null;
    const key = titleKey(label.replace(/\(\d{4}\)/, ''));
    if (key === want && (labelYear === null || Math.abs(labelYear - year) <= 1)) {
      return m[1]!;
    }
  }
  return null;
}

/**
 * Locate a film's transcript (offline via the HTTP cache) and return its ordered
 * subtitle cues, or null when the lookup misses.
 */
export async function fetchCues(title: string, year: number): Promise<string[] | null> {
  const results = await politeFetchText(searchUrl(title));
  if (!results) return null;
  const slug = findSlug(results, title, year);
  if (!slug) return null;
  const page = await politeFetchText(scriptUrl(slug));
  if (!page) return null;
  const inner = extractDivByClass(page, 'scrolling-script-container');
  if (!inner) return null;
  const cues = splitCues(inner);
  return cues.length > 0 ? cues : null;
}

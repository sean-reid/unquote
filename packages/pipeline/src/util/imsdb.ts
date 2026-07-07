import { politeFetchText } from './http.js';
import { decodeEntities } from './html.js';
import { titleKey } from './title.js';
import { log } from './log.js';
import type { ScreenplayLine } from './screenplay.js';

const IMSDB = 'https://imsdb.com';

/** titleKey -> movie page URL, built from the master index. */
export async function loadIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const html = await politeFetchText(`${IMSDB}/all-scripts.html`);
  if (!html) {
    log.warn('imsdb index unavailable');
    return index;
  }
  const anchor = /<a href="(\/Movie Scripts\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  for (const m of html.matchAll(anchor)) {
    const key = titleKey(m[2]!.trim());
    if (key && !index.has(key)) index.set(key, IMSDB + encodeURI(m[1]!));
  }
  log.info(`imsdb index: ${index.size} scripts`);
  return index;
}

/** The "Read ... Script" link on a movie page. */
export function findScriptHref(moviePageHtml: string): string | null {
  const m = moviePageHtml.match(/<a href="(\/scripts\/[^"]+)"/i);
  return m ? m[1]! : null;
}

/**
 * Extract the screenplay from a script page as ordered lines with their bold
 * flag. IMSDb wraps the script in a pre block and marks character cues and
 * scene slugs bold; indentation inside the pre is meaningful, so whitespace
 * is preserved rather than collapsed.
 */
export function extractScreenplayLines(scriptPageHtml: string): ScreenplayLine[] {
  const pres = [...scriptPageHtml.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)];
  if (pres.length === 0) return [];
  const inner = pres.reduce((a, b) => (a[1]!.length >= b[1]!.length ? a : b))[1]!;

  return inner.split('\n').map((rawLine) => {
    const bold = /<b>/i.test(rawLine);
    const text = decodeEntities(rawLine.replace(/<[^>]+>/g, '')).replace(/[\t\r]/g, ' ');
    return { text: text.replace(/\s+$/, ''), bold };
  });
}

/** TMDb titles whose IMSDb listing uses a different name. */
const TITLE_ALIASES: Record<string, string> = {
  harrypotterandthephilosophersstone: 'harrypotterandthesorcerersstone',
};

/** Find the index entry for a title: exact, alias, franchise prefix, then containment. */
export function resolvePageUrl(index: Map<string, string>, title: string): string | null {
  const key = titleKey(title);
  const candidates = [key, TITLE_ALIASES[key] ?? '', `starwars${key}`, `starwarsthe${key}`].filter(
    (c) => c.length > 0,
  );
  for (const candidate of candidates) {
    const hit = index.get(candidate);
    if (hit) return hit;
  }
  if (key.length >= 10) {
    for (const [k, v] of index) {
      if (k.startsWith(key) || k.endsWith(key)) return v;
    }
  }
  return null;
}

export type ImsdbResult =
  | { lines: ScreenplayLine[]; pageUrl: string }
  | { miss: 'not-indexed' | 'page-unavailable' | 'no-script-link' | 'script-unavailable' };

/** Resolve one film against the index and fetch its screenplay lines. */
export async function fetchScreenplay(
  index: Map<string, string>,
  title: string,
): Promise<ImsdbResult> {
  const pageUrl = resolvePageUrl(index, title);
  if (!pageUrl) return { miss: 'not-indexed' };

  const moviePage = await politeFetchText(pageUrl);
  if (!moviePage) return { miss: 'page-unavailable' };
  const href = findScriptHref(moviePage);
  if (!href) return { miss: 'no-script-link' };
  const scriptPage = await politeFetchText(IMSDB + encodeURI(href));
  if (!scriptPage) return { miss: 'script-unavailable' };
  const lines = extractScreenplayLines(scriptPage);
  if (lines.length === 0) return { miss: 'script-unavailable' };
  return { lines, pageUrl };
}

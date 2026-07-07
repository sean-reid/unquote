import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CACHE_DIR } from '../config.js';
import { hostLimiter } from './limiter.js';
import { log, sleep } from './log.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_CACHE = resolve(CACHE_DIR, 'tmdb');
// TMDb tolerates high throughput; a modest concurrency keeps us fast and safe.
const TMDB_CONCURRENCY = 8;
const MAX_RETRIES = 6;
const BACKOFF_BASE_MS = 1000;

const NETWORK_ALLOWED = process.env.ALLOW_NETWORK === '1';

// Same cache key scheme as the original discover-era client (path?query, no
// api key), so responses cached by earlier runs keep hitting.
function cacheKey(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return createHash('sha1').update(`${path}?${query}`).digest('hex');
}

async function readCache(key: string): Promise<unknown | null> {
  try {
    const raw = await readFile(resolve(TMDB_CACHE, `${key}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  await mkdir(TMDB_CACHE, { recursive: true });
  await writeFile(resolve(TMDB_CACHE, `${key}.json`), JSON.stringify(value), 'utf8');
}

async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  const key = cacheKey(path, params);
  const cached = await readCache(key);
  if (cached !== null) return cached as T;

  if (!NETWORK_ALLOWED) {
    log.warn(`tmdb cache miss (network disabled): ${path}`);
    return null;
  }
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error('TMDB_API_KEY is not set');

  const url = new URL(`${TMDB_BASE}${path}`);
  for (const [k, v] of Object.entries({ ...params, api_key: apiKey })) {
    url.searchParams.set(k, v);
  }

  return hostLimiter(
    'api.themoviedb.org',
    TMDB_CONCURRENCY,
  )(async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (response.ok) {
        const body = (await response.json()) as T;
        await writeCache(key, body);
        return body;
      }
      if (response.status === 404) return null;
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : BACKOFF_BASE_MS * 2 ** attempt;
        log.warn(`tmdb ${response.status}, backing off ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw new Error(`tmdb failed: ${response.status} ${path}`);
    }
    throw new Error(`tmdb exhausted retries: ${path}`);
  });
}

/**
 * IMDb id for a TMDb film as bare digits ("tt0468569" becomes "468569"),
 * the form subslikescript uses in its URLs. Null when TMDb has no IMDb id.
 */
export async function imdbDigits(tmdbId: number): Promise<string | null> {
  const ids = await tmdbGet<{ imdb_id?: string | null }>(`/movie/${tmdbId}/external_ids`);
  const raw = ids?.imdb_id;
  if (!raw) return null;
  const digits = raw.replace(/^tt0*/, '');
  return /^\d+$/.test(digits) ? digits : null;
}

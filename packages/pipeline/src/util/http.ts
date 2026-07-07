import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CACHE_DIR } from '../config.js';
import { hostLimiter } from './limiter.js';
import { log, sleep } from './log.js';

const TEXT_CACHE = resolve(CACHE_DIR, 'http');
// A few concurrent requests per host: fast but gentle, and 429s trigger backoff.
const HOST_CONCURRENCY = 4;
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;

// The corpus was fetched once and lives in the cache. Stages replay it offline;
// hitting the network is opt-in so a bug can never turn into a crawl.
const NETWORK_ALLOWED = process.env.ALLOW_NETWORK === '1';

function keyFor(url: string): string {
  return createHash('sha1').update(url).digest('hex');
}

async function readCache(key: string): Promise<string | null> {
  try {
    return await readFile(resolve(TEXT_CACHE, `${key}.html`), 'utf8');
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: string): Promise<void> {
  await mkdir(TEXT_CACHE, { recursive: true });
  await writeFile(resolve(TEXT_CACHE, `${key}.html`), value, 'utf8');
}

/**
 * Fetch a URL as text with manners: on-disk cache, bounded per-host concurrency,
 * and backoff on throttling or server errors. Returns null on a 404 so callers
 * can treat a missing script as a miss rather than a crash. Without ALLOW_NETWORK=1
 * a cache miss is also just a miss.
 */
export async function politeFetchText(url: string): Promise<string | null> {
  const key = keyFor(url);
  const cached = await readCache(key);
  if (cached !== null) return cached;

  if (!NETWORK_ALLOWED) {
    log.warn(`cache miss (network disabled): ${url}`);
    return null;
  }

  const host = new URL(url).host;
  return hostLimiter(
    host,
    HOST_CONCURRENCY,
  )(async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'unquote-pipeline/0.1 (personal project)',
          accept: 'text/html,application/xhtml+xml',
        },
      });

      if (response.ok) {
        const body = await response.text();
        await writeCache(key, body);
        return body;
      }

      if (response.status === 404) return null;

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : BACKOFF_BASE_MS * 2 ** attempt;
        log.warn(`http ${response.status} on ${host}, backing off ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      throw new Error(`fetch failed: ${response.status} ${url}`);
    }
    throw new Error(`fetch exhausted retries: ${url}`);
  });
}

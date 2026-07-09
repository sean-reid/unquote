import type { RequestEvent } from '@sveltejs/kit';
import { normalize, type SearchResponse } from '@unquote/shared';
import { db } from './db.js';

/**
 * First-party, cookie-free analytics written straight into ClickHouse.
 * Visitors are counted by a hash that rotates daily and never stores the
 * raw IP or user agent. Useful reads:
 *
 *   zero-result queries, most wanted first:
 *     SELECT query_norm, count() AS misses FROM search_log
 *     WHERE hits = 0 GROUP BY query_norm ORDER BY misses DESC
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/** Coarse user agent: enough to separate browsers, not enough to fingerprint. */
export function coarseAgent(userAgent: string): string {
  return userAgent.slice(0, 32);
}

/**
 * Daily-rotating anonymous visitor key. Same visitor hashes the same within a
 * UTC day and differently across days; the inputs are never stored.
 */
export function visitorHash(ip: string, userAgent: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return fnv1a64(`${ip}|${coarseAgent(userAgent)}|${day}`).toString();
}

/** Honor Do Not Track and Global Privacy Control. */
export function optedOut(headers: Headers): boolean {
  return headers.get('dnt') === '1' || headers.get('sec-gpc') === '1';
}

function visitorFor(event: RequestEvent): string {
  let ip = '';
  try {
    ip = event.getClientAddress();
  } catch {
    // Some adapters cannot resolve an address (e.g. prerender); count as blank.
  }
  return visitorHash(ip, event.request.headers.get('user-agent') ?? '');
}

let insertWarned = false;

function insert(table: string, row: Record<string, unknown>): void {
  void db
    .insert({
      table,
      values: [row],
      format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 0 },
    })
    .catch((error: unknown) => {
      // Analytics must never break the request path, but a broken sink has
      // to say so once, or months of writes vanish without a trace.
      if (!insertWarned) {
        insertWarned = true;
        console.warn(
          `analytics insert into ${table} failing:`,
          error instanceof Error ? error.message : error,
        );
      }
    });
}

export function logSearch(event: RequestEvent, response: SearchResponse, tookMs: number): void {
  if (optedOut(event.request.headers)) return;
  const queryNorm = normalize(response.query);
  if (queryNorm.length === 0) return;
  insert('search_log', {
    ts: Math.floor(Date.now() / 1000),
    query: response.query.slice(0, 200),
    query_norm: queryNorm.slice(0, 200),
    hits: Math.min(response.hits.length, 65535),
    strong: Math.min(response.strongCount, 65535),
    had_movie: response.movie ? 1 : 0,
    took_ms: Math.min(Math.round(tookMs), 65535),
    visitor_hash: visitorFor(event),
  });
}

export function logPageview(event: RequestEvent): void {
  if (optedOut(event.request.headers)) return;
  insert('pageviews', {
    ts: Math.floor(Date.now() / 1000),
    path: event.url.pathname.slice(0, 200),
    referrer: event.request.headers.get('referer')?.slice(0, 200) ?? '',
    visitor_hash: visitorFor(event),
  });
}

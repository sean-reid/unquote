/**
 * OpenSubtitles REST client, built to be kind rather than merely compliant.
 * Requests are single-flight with a one-second floor between them; the
 * account's 4/s ceiling is an emergency bound, never a target. Any non-2xx
 * gets one well-spaced retry with jitter (honoring Retry-After), then the
 * error surfaces so the caller can park the film for the next run. Search
 * responses and downloaded subtitle files are cached on disk and never
 * fetched twice. Downloads track the account's remaining daily quota from
 * the response body and stop cleanly at zero.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CACHE_DIR } from '../config.js';
import { log, sleep } from './log.js';

const API = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'unquote/1.0';
const MIN_GAP_MS = 1000;
const MAX_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 4000;
const OS_CACHE = resolve(CACHE_DIR, 'opensubtitles');

const NETWORK_ALLOWED = process.env.ALLOW_NETWORK === '1';

export interface SubtitleFile {
  fileId: number;
  fileName: string;
  downloadCount: number;
  hearingImpaired: boolean;
  fromTrusted: boolean;
  year: number | null;
}

export class QuotaExhausted extends Error {
  constructor(public resetTime: string | null) {
    super(`download quota exhausted${resetTime ? `; resets ${resetTime}` : ''}`);
  }
}

interface RawSearch {
  data: Array<{
    attributes: {
      language: string;
      download_count: number;
      hearing_impaired: boolean;
      from_trusted: boolean;
      feature_details?: { year?: number };
      files: Array<{ file_id: number; file_name: string }>;
    };
  }>;
}

interface RawDownload {
  link?: string;
  remaining?: number;
  reset_time_utc?: string;
  message?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class OsClient {
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  /** Unknown until the first download response reports it. */
  remaining: number | null = null;
  resetTime: string | null = null;

  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
    private sleepImpl: (ms: number) => Promise<void> = sleep,
    private minGapMs: number = MIN_GAP_MS,
  ) {}

  /** Every request funnels through here: one at a time, spaced, two attempts. */
  private request(url: string, init?: RequestInit): Promise<Response> {
    const run = async (): Promise<Response> => {
      for (let attempt = 1; ; attempt++) {
        const wait = this.lastRequestAt + this.minGapMs - Date.now();
        if (wait > 0) await this.sleepImpl(wait);
        this.lastRequestAt = Date.now();
        const response = await this.fetchImpl(url, {
          ...init,
          headers: {
            'Api-Key': this.apiKey,
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            ...init?.headers,
          },
        });
        if (response.ok || attempt >= MAX_ATTEMPTS) return response;
        const header = response.headers.get('retry-after');
        const retryAfter = header === null ? NaN : Number(header);
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : BACKOFF_BASE_MS * 2 ** (attempt - 1);
        const jitter = Math.floor(Math.random() * 2000);
        log.warn(`opensubtitles ${response.status}, backing off ${backoff + jitter}ms`);
        await this.sleepImpl(backoff + jitter);
        this.lastRequestAt = Date.now();
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** English subtitles for a TMDb id, best first. Cached on disk forever. */
  async search(tmdbId: number): Promise<SubtitleFile[]> {
    const cachePath = resolve(OS_CACHE, 'search', `${tmdbId}.json`);
    let raw: RawSearch;
    try {
      raw = JSON.parse(await readFile(cachePath, 'utf8')) as RawSearch;
    } catch {
      if (!NETWORK_ALLOWED) {
        log.warn(`opensubtitles cache miss (network disabled): tmdb ${tmdbId}`);
        return [];
      }
      const url = `${API}/subtitles?tmdb_id=${tmdbId}&languages=en&order_by=download_count&order_direction=desc`;
      const response = await this.request(url);
      if (!response.ok) throw new Error(`search failed for tmdb ${tmdbId}: ${response.status}`);
      const body = await response.text();
      raw = JSON.parse(body) as RawSearch;
      await mkdir(resolve(OS_CACHE, 'search'), { recursive: true });
      await writeFile(cachePath, body, 'utf8');
    }
    return raw.data
      .filter((d) => d.attributes.language === 'en' && d.attributes.files.length > 0)
      .map((d) => ({
        fileId: d.attributes.files[0]!.file_id,
        fileName: d.attributes.files[0]!.file_name,
        downloadCount: d.attributes.download_count,
        hearingImpaired: d.attributes.hearing_impaired,
        fromTrusted: d.attributes.from_trusted,
        year: d.attributes.feature_details?.year ?? null,
      }));
  }

  /** Path of a cached subtitle file, or null when it was never downloaded. */
  async cachedSubtitle(fileId: number): Promise<string | null> {
    const path = resolve(OS_CACHE, 'srt', `${fileId}.srt`);
    try {
      await access(path);
      return path;
    } catch {
      return null;
    }
  }

  /**
   * Download one subtitle file, spending one unit of the daily quota. The
   * file lands in the cache; the returned path is stable across runs.
   */
  async download(fileId: number): Promise<string> {
    const cached = await this.cachedSubtitle(fileId);
    if (cached) return cached;
    if (this.remaining !== null && this.remaining <= 0) {
      throw new QuotaExhausted(this.resetTime);
    }
    if (!NETWORK_ALLOWED) throw new Error('network disabled (set ALLOW_NETWORK=1)');

    const response = await this.request(`${API}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const body = (await response.json()) as RawDownload;
    if (typeof body.remaining === 'number') this.remaining = body.remaining;
    if (body.reset_time_utc) this.resetTime = body.reset_time_utc;
    if (response.status === 406 || (!response.ok && body.remaining === 0)) {
      throw new QuotaExhausted(this.resetTime);
    }
    if (!response.ok || !body.link) {
      throw new Error(`download failed for file ${fileId}: ${response.status} ${body.message ?? ''}`);
    }

    const file = await this.request(body.link);
    if (!file.ok) throw new Error(`subtitle fetch failed for file ${fileId}: ${file.status}`);
    const content = await file.text();
    const path = resolve(OS_CACHE, 'srt', `${fileId}.srt`);
    await mkdir(resolve(OS_CACHE, 'srt'), { recursive: true });
    await writeFile(path, content, 'utf8');
    return path;
  }
}

export interface QueueEntry {
  movieId: number;
  title: string;
  status: 'pending' | 'done' | 'no-match' | 'parked';
  attempts: number;
  fileId?: number;
  cues?: number;
  score?: number;
  reason?: string;
}

/** Merge fresh targets into the saved queue without disturbing finished work. */
export function mergeQueue(
  saved: QueueEntry[],
  targets: Array<{ movieId: number; title: string }>,
): QueueEntry[] {
  const byId = new Map(saved.map((e) => [e.movieId, e]));
  for (const t of targets) {
    if (!byId.has(t.movieId)) {
      byId.set(t.movieId, { movieId: t.movieId, title: t.title, status: 'pending', attempts: 0 });
    }
  }
  return [...byId.values()];
}

/**
 * Best candidate for a film: real transcripts over hearing-impaired ones,
 * trusted uploaders over not, then sheer download count; anything a year or
 * more off the film's release is refused outright.
 */
export function pickBest(candidates: SubtitleFile[], filmYear: number): SubtitleFile | null {
  const plausible = candidates.filter((c) => c.year === null || Math.abs(c.year - filmYear) <= 1);
  plausible.sort(
    (a, b) =>
      Number(a.hearingImpaired) - Number(b.hearingImpaired) ||
      Number(b.fromTrusted) - Number(a.fromTrusted) ||
      b.downloadCount - a.downloadCount,
  );
  return plausible[0] ?? null;
}

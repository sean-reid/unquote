import { describe, expect, it } from 'vitest';
import {
  NetworkDisabled,
  OsClient,
  QuotaExhausted,
  mergeQueue,
  pickBest,
  upgradeFilm,
  type QueueEntry,
  type UpgradeDeps,
} from '../src/util/opensubtitles.js';
import { srtToCues } from '../src/util/srt.js';

describe('srtToCues', () => {
  it('drops indexes and timestamps, joins block lines, strips markup', () => {
    const srt = [
      '1',
      '00:01:02,000 --> 00:01:04,500',
      '<i>What do you want?</i>',
      'I want out.',
      '',
      '2',
      '00:01:05,000 --> 00:01:06,000',
      '{\\an8}Then leave.',
      '',
    ].join('\r\n');
    expect(srtToCues(srt)).toEqual(['What do you want? I want out.', 'Then leave.']);
  });

  it('survives a byte-order mark and blocks without index lines', () => {
    const srt = '﻿00:00:01,000 --> 00:00:02,000\nHello there.\n\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral.\n';
    expect(srtToCues(srt)).toEqual(['Hello there.', 'General.']);
  });

  it('returns nothing for an empty or junk file', () => {
    expect(srtToCues('')).toEqual([]);
    expect(srtToCues('42\n\n17\n')).toEqual([]);
  });
});

describe('pickBest', () => {
  const base = { fileName: 'a.srt', downloadCount: 100, hearingImpaired: false, fromTrusted: false };
  it('prefers non-hearing-impaired, then trusted, then downloads, and gates year', () => {
    const best = pickBest(
      [
        { ...base, fileId: 1, downloadCount: 9000, hearingImpaired: true, year: 1995 },
        { ...base, fileId: 2, downloadCount: 50, fromTrusted: true, year: 1995 },
        { ...base, fileId: 3, downloadCount: 500, year: 1995 },
        { ...base, fileId: 4, downloadCount: 99999, year: 1988 },
      ],
      1995,
    );
    expect(best?.fileId).toBe(2);
  });
  it('returns null when nothing plausible remains', () => {
    expect(pickBest([{ ...base, fileId: 1, year: 1970 }], 1995)).toBeNull();
  });
});

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

describe('OsClient request discipline', () => {
  it('is single-flight with a floor between consecutive requests', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    const client = new OsClient(
      'key',
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return response(200, { data: [] });
      },
      undefined,
      50,
    );
    const request = (id: number) => client['request'](`https://example.test/${id}`);
    await Promise.all([request(1), request(2), request(3)]);
    expect(maxInFlight).toBe(1);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(45);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(45);
  });

  it('retries once on a non-2xx with backoff, then surfaces the failure', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new OsClient(
      'key',
      async () => {
        calls += 1;
        return response(503, 'unavailable');
      },
      async (ms) => {
        sleeps.push(ms);
      },
      0,
    );
    const result = await client['request']('https://example.test/');
    expect(result.status).toBe(503);
    expect(calls).toBe(2);
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(4000);
  });

  it('honors Retry-After over its own backoff', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new OsClient(
      'key',
      async () => {
        calls += 1;
        return calls === 1
          ? response(429, 'slow down', { 'retry-after': '7' })
          : response(200, { data: [] });
      },
      async (ms) => {
        sleeps.push(ms);
      },
      0,
    );
    const result = await client['request']('https://example.test/');
    expect(result.status).toBe(200);
    expect(sleeps.some((ms) => ms >= 7000 && ms < 9001)).toBe(true);
  });

  it('stops cleanly once the download quota reports empty', async () => {
    const client = new OsClient(
      'key',
      async () => response(406, { remaining: 0, message: 'quota' }),
      async () => {},
      0,
    );
    client.remaining = 0;
    await expect(client.download(1234)).rejects.toThrow(/quota exhausted/);
  });
});

describe('upgradeFilm outcomes', () => {
  const movie = { id: 603, year: 1999, title: 'The Matrix' };
  const fresh = (): QueueEntry => ({
    movieId: 603,
    title: 'The Matrix',
    status: 'pending',
    attempts: 0,
  });
  const deps = (client: UpgradeDeps['client']): UpgradeDeps => ({
    client,
    toCues: srtToCues,
    minCues: 1,
    read: async () => '1\n00:00:01,000 --> 00:00:02,000\nHello there.\n',
  });

  it('parks a film when the search transport fails, keeping it queued', async () => {
    const entry = fresh();
    const outcome = await upgradeFilm(
      entry,
      movie,
      deps({
        search: async () => {
          throw new TypeError('fetch failed');
        },
        cachedSubtitle: async () => null,
        download: async () => '',
      }),
    );
    expect(entry.status).toBe('parked');
    expect(entry.attempts).toBe(1);
    expect(outcome.stop).toBe(false);
  });

  it('stops the run without charging an attempt when the network is disabled', async () => {
    const entry = fresh();
    const outcome = await upgradeFilm(
      entry,
      movie,
      deps({
        search: async () => {
          throw new NetworkDisabled();
        },
        cachedSubtitle: async () => null,
        download: async () => '',
      }),
    );
    expect(entry.status).toBe('pending');
    expect(entry.attempts).toBe(0);
    expect(outcome.stop).toBe(true);
  });

  it('stops the run when the quota runs out mid-film', async () => {
    const entry = fresh();
    const outcome = await upgradeFilm(
      entry,
      movie,
      deps({
        search: async () => [
          {
            fileId: 9,
            fileName: 'a.srt',
            downloadCount: 10,
            hearingImpaired: false,
            fromTrusted: false,
            year: 1999,
          },
        ],
        cachedSubtitle: async () => null,
        download: async () => {
          throw new QuotaExhausted(null);
        },
      }),
    );
    expect(entry.status).toBe('pending');
    expect(entry.attempts).toBe(0);
    expect(outcome.stop).toBe(true);
  });

  it('marks no-match only for a genuinely empty search result', async () => {
    const entry = fresh();
    const outcome = await upgradeFilm(
      entry,
      movie,
      deps({
        search: async () => [],
        cachedSubtitle: async () => null,
        download: async () => '',
      }),
    );
    expect(entry.status).toBe('no-match');
    expect(outcome.stop).toBe(false);
  });
});

describe('queue resume', () => {
  it('adds new targets without disturbing finished or parked work', () => {
    const saved: QueueEntry[] = [
      { movieId: 807, title: 'Se7en', status: 'done', attempts: 1, fileId: 9, cues: 1500 },
      { movieId: 78, title: 'Blade Runner', status: 'parked', attempts: 2, reason: 'few cues' },
    ];
    const merged = mergeQueue(saved, [
      { movieId: 807, title: 'Se7en' },
      { movieId: 603, title: 'The Matrix' },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged.find((e) => e.movieId === 807)?.status).toBe('done');
    expect(merged.find((e) => e.movieId === 78)?.attempts).toBe(2);
    expect(merged.find((e) => e.movieId === 603)?.status).toBe('pending');
  });
});

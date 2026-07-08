/**
 * Subtitle-based transcript upgrades via OpenSubtitles, budgeted for the free
 * tier. Each run walks a checkpointed queue (draft films from
 * upgrade-report.json first, then anything passed via --movies), downloads at
 * most --budget subtitle files (default 5, the free daily allowance), and
 * regenerates cues-os.jsonl from every film completed so far. The queue file
 * survives between runs, so the backlog drains a budget's worth per day.
 * Films whose fetch fails are parked with a reason and retried on a later
 * run; a spent budget is a normal exit, not an error.
 *
 * Run: ALLOW_NETWORK=1 pnpm upgrade-os [--budget 5] [--movies 807,603]
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson, writeJsonl } from '../util/fs.js';
import { log } from '../util/log.js';
import {
  OsClient,
  QuotaExhausted,
  mergeQueue,
  pickBest,
  type QueueEntry,
} from '../util/opensubtitles.js';
import { scoreFilm } from '../util/quality.js';
import { srtToCues } from '../util/srt.js';
import type { MovieRecord } from '../types.js';

const MIN_CUES = 200;
const MAX_FILM_ATTEMPTS = 3;

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    budget: { type: 'string', default: '5' },
    movies: { type: 'string' },
  },
});

const apiKey = process.env.OPENSUBTITLES_API_KEY;
if (!apiKey) throw new Error('OPENSUBTITLES_API_KEY is not set');

const QUEUE_PATH = resolve(DATA_DIR, 'opensubtitles-queue.json');

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const byId = new Map(movies.map((m) => [m.id, m]));

const targets: Array<{ movieId: number; title: string }> = [];
const reportPath = resolve(DATA_DIR, 'upgrade-report.json');
if (existsSync(reportPath)) {
  const report = await readJson<{ draftsRemaining?: Array<{ movieId: number; title: string }> }>(
    reportPath,
  );
  targets.push(...(report.draftsRemaining ?? []));
}
for (const id of (args.movies ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean)) {
  const movie = byId.get(id);
  if (movie && !targets.some((t) => t.movieId === id)) {
    targets.push({ movieId: id, title: movie.title });
  }
}

const saved = existsSync(QUEUE_PATH) ? await readJson<QueueEntry[]>(QUEUE_PATH) : [];
const queue = mergeQueue(saved, targets);
await writeJson(QUEUE_PATH, queue);

let budget = Number(args.budget);
const client = new OsClient(apiKey);
const runnable = queue.filter(
  (e) =>
    (e.status === 'pending' || (e.status === 'parked' && e.attempts < MAX_FILM_ATTEMPTS)) &&
    byId.has(e.movieId),
);
log.step(
  `opensubtitles: ${runnable.length} films queued, budget ${budget} download${budget === 1 ? '' : 's'}`,
);

for (const entry of runnable) {
  if (budget <= 0) break;
  const movie = byId.get(entry.movieId)!;
  entry.attempts += 1;
  try {
    const candidates = await client.search(movie.id);
    const best = pickBest(candidates, movie.year);
    if (!best) {
      entry.status = 'no-match';
      entry.reason = `no plausible english subtitle among ${candidates.length}`;
      await writeJson(QUEUE_PATH, queue);
      continue;
    }
    const alreadyCached = (await client.cachedSubtitle(best.fileId)) !== null;
    const path = await client.download(best.fileId);
    if (!alreadyCached) budget -= 1;
    const cues = srtToCues(await readFile(path, 'utf8'));
    if (cues.length < MIN_CUES) {
      entry.status = 'parked';
      entry.reason = `too few cues (${cues.length})`;
    } else {
      entry.status = 'done';
      entry.fileId = best.fileId;
      entry.cues = cues.length;
      entry.reason = undefined;
      log.info(`upgraded ${movie.title} (${movie.year}): ${cues.length} cues, file ${best.fileId}`);
    }
  } catch (error) {
    if (error instanceof QuotaExhausted) {
      budget = 0;
      entry.attempts -= 1;
      log.warn(error.message);
    } else {
      entry.status = 'parked';
      entry.reason = error instanceof Error ? error.message : String(error);
      log.warn(`parked ${movie.title}: ${entry.reason}`);
    }
  }
  await writeJson(QUEUE_PATH, queue);
}

// Regenerate the replace layer from everything finished so far. Deterministic
// from the cache, so reruns cannot duplicate rows. Every queued film is an
// explicit target (a draft or a named request), so a real subtitle transcript
// always wins; the quality score rides along in the queue for visibility.
const rows: Array<{ movieId: number; idx: number; text: string }> = [];
let shipped = 0;
for (const entry of queue) {
  if (entry.status !== 'done' || entry.fileId === undefined) continue;
  const path = await client.cachedSubtitle(entry.fileId);
  if (!path) continue;
  const cues = srtToCues(await readFile(path, 'utf8'));
  if (cues.length < MIN_CUES) {
    entry.status = 'parked';
    entry.reason = `cached subtitle too thin (${cues.length} cues)`;
    continue;
  }
  entry.score = scoreFilm(entry.movieId, cues).score;
  cues.forEach((text, idx) => rows.push({ movieId: entry.movieId, idx, text }));
  shipped += 1;
}
await writeJsonl(resolve(DATA_DIR, 'cues-os.jsonl'), rows);
await writeJson(QUEUE_PATH, queue);

const left = queue.filter((e) => e.status === 'pending' || e.status === 'parked').length;
log.step(
  `opensubtitles done: ${shipped} films in cues-os.jsonl, ` +
    `${left} still queued, quota remaining ${client.remaining ?? 'unknown'}` +
    (client.resetTime ? ` (resets ${client.resetTime})` : ''),
);

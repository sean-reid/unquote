import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, readJsonl, writeJson } from '../util/fs.js';
import { politeFetchText } from '../util/http.js';
import { imdbDigits } from '../util/imdb.js';
import { log, sleep } from '../util/log.js';
import { extractCues, movieUrl, pageYear } from '../util/subslikescript.js';
import type { Cue, MovieRecord, ScriptRecord } from '../types.js';

// Same bar as the screenplay rescue: a real feature parses into hundreds of
// cues; anything under this is a stub page or a parse failure.
const MIN_CUES = 200;
const COURTESY_DELAY_MS = 500;

const RESCUE_FILE = resolve(DATA_DIR, 'cues-rescue.jsonl');

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const scripts = await readJson<ScriptRecord[]>(resolve(DATA_DIR, 'scripts.json'));

const have = new Set(scripts.map((s) => s.movieId));
const shipped = new Set<number>();
try {
  for await (const cue of readJsonl<Cue>(RESCUE_FILE)) shipped.add(cue.movieId);
} catch {
  // No prior rescue file; nothing shipped yet.
}

// Subslikescript put up an anti-bot JS challenge on 2026-07-07; every fetch
// 302s to a captcha page. Do not hit the site until it relaxes, and then only
// by explicit opt-in on top of ALLOW_NETWORK.
if (process.env.ALLOW_SUBSLIKESCRIPT !== '1') {
  log.warn('rescue2: subslikescript disabled (anti-bot challenge); set ALLOW_SUBSLIKESCRIPT=1');
  process.exit(0);
}

const gaps = movies.filter((m) => !have.has(m.id) && !shipped.has(m.id));
log.info(`rescue2: ${gaps.length} films still missing (springfield + imsdb covered the rest)`);

interface Miss {
  movieId: number;
  title: string;
  reason: string;
}

const misses: Miss[] = [];
const shippedNow: Array<{ movieId: number; title: string; cues: number }> = [];

// Appending keeps the utterance stage's single-file contract; idempotence
// comes from the shipped-id skip above.
const out = createWriteStream(RESCUE_FILE, { flags: 'a' });

for (const movie of gaps) {
  await sleep(COURTESY_DELAY_MS);

  const digits = await imdbDigits(movie.id);
  if (!digits) {
    misses.push({ movieId: movie.id, title: movie.title, reason: 'no imdb id' });
    continue;
  }

  const html = await politeFetchText(movieUrl(movie.title, digits));
  if (!html) {
    misses.push({ movieId: movie.id, title: movie.title, reason: 'not on subslikescript' });
    continue;
  }

  const year = pageYear(html);
  if (year !== null && Math.abs(year - movie.year) > 1) {
    misses.push({
      movieId: movie.id,
      title: movie.title,
      reason: `year mismatch (page says ${year}, film is ${movie.year})`,
    });
    continue;
  }

  const cues = extractCues(html);
  if (cues.length < MIN_CUES) {
    misses.push({
      movieId: movie.id,
      title: movie.title,
      reason: `too few cues (${cues.length})`,
    });
    continue;
  }

  cues.forEach((text, idx) => {
    out.write(JSON.stringify({ movieId: movie.id, idx, text }) + '\n');
  });
  shippedNow.push({ movieId: movie.id, title: movie.title, cues: cues.length });
  log.info(`rescued ${movie.title} (${movie.year}): ${cues.length} cues`);
}

await new Promise<void>((res, rej) => {
  out.end(() => res());
  out.on('error', rej);
});

await writeJson(resolve(DATA_DIR, 'rescue2-report.json'), {
  attempted: gaps.length,
  shipped: shippedNow.length,
  cues: shippedNow.reduce((sum, f) => sum + f.cues, 0),
  films: shippedNow,
  misses,
});

log.info(
  `rescue2 done: ${shippedNow.length}/${gaps.length} shipped, ` +
    `${misses.length} misses (${misses.filter((m) => m.reason === 'not on subslikescript').length} not on site)`,
);

/**
 * Transcript upgrades. Three groups of films get a better source when one
 * exists: the IMSDb screenplay drafts (rescue-report.json), a short named list
 * of known-bad transcripts, and the downranked worst decile from quality.json.
 *
 * Subslikescript is tried first for every target. Draft films that miss there
 * get a second chance on Springfield under title variants, since the original
 * miss may have been a title-matching failure rather than absence. Downranked
 * films only ship when the fetched transcript actually scores better than what
 * they have; drafts and the named list always prefer a real transcript.
 *
 * Writes cues-upgrade.jsonl (a replace layer over cues.jsonl/cues-rescue.jsonl)
 * and upgrade-report.json.
 *
 * Run: ALLOW_NETWORK=1 pnpm upgrade-transcripts
 */
import { createWriteStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, readJsonl, writeJson } from '../util/fs.js';
import { politeFetchText } from '../util/http.js';
import { imdbDigits } from '../util/imdb.js';
import { log, sleep } from '../util/log.js';
import { scoreFilm } from '../util/quality.js';
import { fetchCues } from '../util/springfield.js';
import { extractCues, movieUrl, pageYear } from '../util/subslikescript.js';
import type { Cue, MovieRecord } from '../types.js';

const MIN_CUES = 200;
const COURTESY_DELAY_MS = 500;

// Subslikescript put up an anti-bot JS challenge on 2026-07-07; every fetch
// 302s to a captcha page that parses as zero cues. Do not hit the site again
// until it relaxes, and then only by explicit opt-in on top of ALLOW_NETWORK.
const SUBSLIKESCRIPT_ENABLED = process.env.ALLOW_SUBSLIKESCRIPT === '1';

// Transcripts Sean has called out as bad enough to replace on sight.
const NAMED_TARGETS = new Set([597, 78, 2323]); // Titanic, Blade Runner, Field of Dreams

/** Search-title spellings worth a second Springfield attempt. */
export function titleVariants(title: string): string[] {
  const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const beforeColon = title.split(':')[0]!.trim();
  const raw = [
    title,
    beforeColon,
    title.replace(/&/g, 'and'),
    title.replace(/'/g, ''),
    fold(title),
    fold(beforeColon),
  ];
  return [...new Set(raw.map((t) => t.trim()).filter((t) => t.length >= 2))];
}

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const byId = new Map(movies.map((m) => [m.id, m]));

const rescueReport = await readJson<{ films: Array<{ movieId: number }> }>(
  resolve(DATA_DIR, 'rescue-report.json'),
);
const draftIds = new Set(rescueReport.films.map((f) => f.movieId));

const quality = await readJson<Record<string, { downrank: boolean }>>(
  resolve(DATA_DIR, 'quality.json'),
);
const downrankIds = new Set(
  Object.entries(quality)
    .filter(([, q]) => q.downrank)
    .map(([id]) => Number(id)),
);

const targetIds = [...new Set([...draftIds, ...NAMED_TARGETS, ...downrankIds])]
  .filter((id) => byId.has(id))
  .sort((a, b) => a - b);

// Current cues per target, for the is-it-actually-better gate.
const currentCues = new Map<number, string[]>();
const wanted = new Set(targetIds);
for (const file of ['cues.jsonl', 'cues-rescue.jsonl']) {
  const path = resolve(DATA_DIR, file);
  if (!existsSync(path)) continue;
  const layer = new Map<number, string[]>();
  for await (const cue of readJsonl<Cue>(path)) {
    if (!wanted.has(cue.movieId)) continue;
    let list = layer.get(cue.movieId);
    if (!list) {
      list = [];
      layer.set(cue.movieId, list);
    }
    list.push(cue.text);
  }
  for (const [movieId, list] of layer) currentCues.set(movieId, list);
}

log.step(
  `upgrade: ${targetIds.length} targets ` +
    `(${draftIds.size} drafts, ${NAMED_TARGETS.size} named, ${downrankIds.size} downranked)`,
);

interface Upgraded {
  movieId: number;
  title: string;
  route: 'subslikescript' | 'springfield';
  cues: number;
  oldScore: number;
  newScore: number;
}
interface Skipped {
  movieId: number;
  title: string;
  reason: string;
}

const upgraded: Upgraded[] = [];
const skipped: Skipped[] = [];
const out = createWriteStream(resolve(DATA_DIR, 'cues-upgrade.jsonl'), { flags: 'w' });

async function fetchSubslikescript(movie: MovieRecord): Promise<string[] | { miss: string }> {
  if (!SUBSLIKESCRIPT_ENABLED) return { miss: 'subslikescript disabled (anti-bot challenge)' };
  const digits = await imdbDigits(movie.id);
  if (!digits) return { miss: 'no imdb id' };
  const html = await politeFetchText(movieUrl(movie.title, digits));
  if (!html) return { miss: 'not on subslikescript' };
  const year = pageYear(html);
  if (year !== null && Math.abs(year - movie.year) > 1) {
    return { miss: `year mismatch (page says ${year}, film is ${movie.year})` };
  }
  const cues = extractCues(html);
  if (cues.length < MIN_CUES) return { miss: `too few cues (${cues.length})` };
  return cues;
}

async function fetchSpringfieldVariants(movie: MovieRecord): Promise<string[] | { miss: string }> {
  for (const variant of titleVariants(movie.title)) {
    const result = await fetchCues(variant, movie.year);
    if (result && result.cues.length >= MIN_CUES) return result.cues;
    await sleep(COURTESY_DELAY_MS);
  }
  return { miss: 'no springfield match under any title variant' };
}

for (const movieId of targetIds) {
  const movie = byId.get(movieId)!;
  const isDraft = draftIds.has(movieId);
  const alwaysPrefer = isDraft || NAMED_TARGETS.has(movieId);
  await sleep(COURTESY_DELAY_MS);

  let route: Upgraded['route'] = 'subslikescript';
  let fetched = await fetchSubslikescript(movie);
  if ('miss' in fetched && isDraft) {
    const retry = await fetchSpringfieldVariants(movie);
    if (!('miss' in retry)) {
      route = 'springfield';
      fetched = retry;
    } else {
      fetched = { miss: `${fetched.miss}; ${retry.miss}` };
    }
  }
  if ('miss' in fetched) {
    skipped.push({ movieId, title: movie.title, reason: fetched.miss });
    continue;
  }

  const oldScore = scoreFilm(movieId, currentCues.get(movieId) ?? []).score;
  const newScore = scoreFilm(movieId, fetched).score;
  // A draft is worth replacing with any real transcript; a downranked
  // transcript only moves when the replacement measures better.
  if (!alwaysPrefer && newScore <= oldScore) {
    skipped.push({
      movieId,
      title: movie.title,
      reason: `not better (old ${oldScore}, new ${newScore})`,
    });
    continue;
  }

  fetched.forEach((text, idx) => {
    out.write(JSON.stringify({ movieId, idx, text }) + '\n');
  });
  upgraded.push({ movieId, title: movie.title, route, cues: fetched.length, oldScore, newScore });
  log.info(`upgraded ${movie.title} (${movie.year}) via ${route}: ${fetched.length} cues`);
}

await new Promise<void>((res, rej) => {
  out.end(() => res());
  out.on('error', rej);
});

const upgradedIds = new Set(upgraded.map((u) => u.movieId));
const draftsRemaining = [...draftIds]
  .filter((id) => !upgradedIds.has(id))
  .map((id) => ({ movieId: id, title: byId.get(id)?.title ?? String(id) }));

await writeJson(resolve(DATA_DIR, 'upgrade-report.json'), {
  targets: targetIds.length,
  upgraded: upgraded.length,
  cues: upgraded.reduce((sum, u) => sum + u.cues, 0),
  films: upgraded,
  skipped,
  draftsRemaining,
});

log.step(
  `upgrade done: ${upgraded.length}/${targetIds.length} shipped, ` +
    `${draftsRemaining.length} drafts remain unupgraded`,
);
for (const d of draftsRemaining) log.warn(`still a draft: ${d.title}`);

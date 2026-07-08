import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, readJsonl, writeJson, writeJsonl } from '../util/fs.js';
import { log } from '../util/log.js';
import { fetchCues } from '../util/springfield.js';
import type { Cue, MovieRecord } from '../types.js';

const MIN_CUES = 200;

// Springfield lists a few films under a different release title than TMDb.
const SEARCH_ALIAS = new Map<number, string>([
  [923, 'Zombie: Dawn of the Dead'], // Dawn of the Dead (1978), European title
]);

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const slice = await readJson<number[]>(resolve(DATA_DIR, 'slice.json'));
const byId = new Map(movies.map((m) => [m.id, m]));

// Films the rescue passes already cover; a springfield miss for them is
// expected, not a warning.
const rescued = new Set<number>();
if (existsSync(resolve(DATA_DIR, 'cues-rescue.jsonl'))) {
  for await (const cue of readJsonl<Cue>(resolve(DATA_DIR, 'cues-rescue.jsonl'))) {
    rescued.add(cue.movieId);
  }
}

const cues: Cue[] = [];
const warnings: string[] = [];
const rescueCovered: string[] = [];
const fallbackFilms: string[] = [];
let films = 0;

for (const movieId of slice) {
  const movie = byId.get(movieId);
  if (!movie) {
    warnings.push(`movie ${movieId} not in movies.json`);
    continue;
  }
  const result = await fetchCues(SEARCH_ALIAS.get(movieId) ?? movie.title, movie.year);
  if (!result) {
    if (rescued.has(movieId)) rescueCovered.push(`${movie.title} (${movie.year})`);
    else warnings.push(`${movie.title} (${movie.year}): transcript not found in cache`);
    continue;
  }
  if (result.fallback) {
    fallbackFilms.push(`${movie.title} (${movie.year})`);
  }
  if (result.cues.length < MIN_CUES) {
    warnings.push(`${movie.title} (${movie.year}): only ${result.cues.length} cues`);
  }
  result.cues.forEach((text, idx) => cues.push({ movieId, idx, text }));
  films += 1;
}

await writeJsonl(resolve(DATA_DIR, 'cues.jsonl'), cues);
await writeJson(resolve(DATA_DIR, 'extract-report.json'), {
  films,
  cues: cues.length,
  fallbackFilms,
  rescueCovered,
  warnings,
});

log.info(
  `extract: ${films}/${slice.length} films, ${cues.length} cues` +
    (fallbackFilms.length > 0 ? `, ${fallbackFilms.length} via sentence fallback` : '') +
    (rescueCovered.length > 0 ? `, ${rescueCovered.length} rescue-covered misses` : ''),
);
for (const w of warnings) log.warn(w);

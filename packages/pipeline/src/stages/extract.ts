import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson, writeJsonl } from '../util/fs.js';
import { log } from '../util/log.js';
import { fetchCues } from '../util/springfield.js';
import type { Cue, MovieRecord } from '../types.js';

const MIN_CUES = 200;

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const slice = await readJson<number[]>(resolve(DATA_DIR, 'slice.json'));
const byId = new Map(movies.map((m) => [m.id, m]));

const cues: Cue[] = [];
const warnings: string[] = [];
let films = 0;

for (const movieId of slice) {
  const movie = byId.get(movieId);
  if (!movie) {
    warnings.push(`movie ${movieId} not in movies.json`);
    continue;
  }
  const filmCues = await fetchCues(movie.title, movie.year);
  if (!filmCues) {
    warnings.push(`${movie.title} (${movie.year}): transcript not found in cache`);
    continue;
  }
  if (filmCues.length < MIN_CUES) {
    warnings.push(`${movie.title} (${movie.year}): only ${filmCues.length} cues`);
  }
  filmCues.forEach((text, idx) => cues.push({ movieId, idx, text }));
  films += 1;
}

await writeJsonl(resolve(DATA_DIR, 'cues.jsonl'), cues);
await writeJson(resolve(DATA_DIR, 'extract-report.json'), {
  films,
  cues: cues.length,
  warnings,
});

log.info(`extract: ${films}/${slice.length} films, ${cues.length} cues`);
for (const w of warnings) log.warn(w);

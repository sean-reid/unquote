import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson, writeJsonl } from '../util/fs.js';
import { log, sleep } from '../util/log.js';
import { loadIndex, fetchScreenplay } from '../util/imsdb.js';
import { parseDialogue, splitBlockText } from '../util/screenplay.js';
import type { Cue, MovieRecord, ScriptRecord } from '../types.js';

// Screenplays run shorter than subtitle transcripts, but a real feature still
// yields hundreds of dialogue sentences; anything under this parsed badly.
const MIN_CUES = 200;
// One extra breath between films on top of the polite client's own limits.
const COURTESY_DELAY_MS = 500;

/** Long all-caps cues are leaked action beats (BB-8 BEEPS...), not speech. */
function isShoutedAction(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  return letters.length > 12 && letters === letters.toUpperCase();
}

// IMSDb resolves these titles to a different film than the TMDb id (remakes
// sharing a name); verified by sampling the parsed dialogue.
const WRONG_MATCH = new Map<number, string>([
  [438631, 'imsdb Dune is the 1984 film'],
  [529485, 'imsdb The Way Back is the 2010 film'],
]);

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const scripts = await readJson<ScriptRecord[]>(resolve(DATA_DIR, 'scripts.json'));
const have = new Set(scripts.map((s) => s.movieId));
const gaps = movies.filter((m) => !have.has(m.id)).sort((a, b) => b.tmdbVotes - a.tmdbVotes);

log.step(`rescue: ${gaps.length} films without transcripts`);

const index = await loadIndex();

interface FilmResult {
  movieId: number;
  title: string;
  year: number;
  cues: number;
  pageUrl: string;
}

const cues: Cue[] = [];
const films: FilmResult[] = [];
const misses: { movieId: number; title: string; year: number; reason: string }[] = [];
let fetched = 0;

for (const movie of gaps) {
  const wrongMatch = WRONG_MATCH.get(movie.id);
  if (wrongMatch) {
    misses.push({ movieId: movie.id, title: movie.title, year: movie.year, reason: wrongMatch });
    continue;
  }
  await sleep(COURTESY_DELAY_MS);
  const script = await fetchScreenplay(index, movie.title);
  if ('miss' in script) {
    misses.push({
      movieId: movie.id,
      title: movie.title,
      year: movie.year,
      reason: script.miss,
    });
    continue;
  }
  fetched += 1;

  const blocks = parseDialogue(script.lines);
  const filmCues = blocks
    .flatMap((block) => splitBlockText(block.text))
    .filter((text) => !isShoutedAction(text));
  if (filmCues.length < MIN_CUES) {
    misses.push({
      movieId: movie.id,
      title: movie.title,
      year: movie.year,
      reason: `parsed only ${filmCues.length} cues`,
    });
    continue;
  }

  filmCues.forEach((text, idx) => cues.push({ movieId: movie.id, idx, text }));
  films.push({
    movieId: movie.id,
    title: movie.title,
    year: movie.year,
    cues: filmCues.length,
    pageUrl: script.pageUrl,
  });
  log.info(`${movie.title} (${movie.year}): ${filmCues.length} cues`);
}

await writeJsonl(resolve(DATA_DIR, 'cues-rescue.jsonl'), cues);
await writeJson(resolve(DATA_DIR, 'rescue-report.json'), {
  attempted: gaps.length,
  fetched,
  parsed: films.length,
  cues: cues.length,
  films,
  misses,
});

log.step(`rescue: ${films.length}/${gaps.length} films recovered, ${cues.length} cues`);
for (const miss of misses) log.warn(`${miss.title} (${miss.year}): ${miss.reason}`);

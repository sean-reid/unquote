import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson } from '../util/fs.js';
import { log } from '../util/log.js';
import type { MovieRecord, ScriptRecord } from '../types.js';

const SLICE_SIZE = 300;
// FULL=1 selects every film with a transcript; default keeps the dev slice.
const full = process.env.FULL === '1';

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const scripts = await readJson<ScriptRecord[]>(resolve(DATA_DIR, 'scripts.json'));

const withTranscript = new Set(
  scripts.filter((s) => s.source === 'springfield').map((s) => s.movieId),
);

const ranked = movies
  .filter((m) => withTranscript.has(m.id))
  .sort((a, b) => b.tmdbVotes - a.tmdbVotes);
const slice = (full ? ranked : ranked.slice(0, SLICE_SIZE)).map((m) => m.id);

await writeJson(resolve(DATA_DIR, 'slice.json'), slice);

const byId = new Map(movies.map((m) => [m.id, m]));
const preview = slice
  .slice(0, 5)
  .map((id) => byId.get(id)!.title)
  .join(', ');
log.info(`slice: ${slice.length} films${full ? ' (full)' : ''} (top by votes: ${preview})`);

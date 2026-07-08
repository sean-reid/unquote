/**
 * Build overlapping beat windows over each film's utterances. SLICE=1 limits
 * to the films in slice.json so gate reviews run on a small corpus.
 *
 * Run: pnpm beats
 */
import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, readJsonl, writeJsonl } from '../util/fs.js';
import { log } from '../util/log.js';
import { beatWindows } from '../util/ladder.js';
import type { Utterance } from '../types.js';

const sliceOnly = process.env.SLICE === '1';
const sliceIds = new Set(await readJson<number[]>(resolve(DATA_DIR, 'slice.json')));

interface BeatRecord {
  movieId: number;
  idx: number;
  startSeq: number;
  endSeq: number;
  arc: number;
  text: string;
}

const byFilm = new Map<number, string[]>();
for await (const u of readJsonl<Utterance>(resolve(DATA_DIR, 'utterances.jsonl'))) {
  if (sliceOnly && !sliceIds.has(u.movieId)) continue;
  let texts = byFilm.get(u.movieId);
  if (!texts) {
    texts = [];
    byFilm.set(u.movieId, texts);
  }
  texts[u.seq] = u.text;
}

const beats: BeatRecord[] = [];
for (const movieId of [...byFilm.keys()].sort((a, b) => a - b)) {
  const texts = byFilm.get(movieId)!;
  for (const window of beatWindows(texts.length)) {
    beats.push({
      movieId,
      idx: window.idx,
      startSeq: window.startSeq,
      endSeq: window.endSeq,
      arc: window.arc,
      text: texts.slice(window.span[0], window.span[1]).join('\n'),
    });
  }
}

await writeJsonl(resolve(DATA_DIR, 'beats.jsonl'), beats);
log.info(
  `beats: ${beats.length} across ${byFilm.size} films` +
    (sliceOnly ? ' (slice)' : '') +
    ` (mean ${(beats.length / byFilm.size).toFixed(0)}/film)`,
);

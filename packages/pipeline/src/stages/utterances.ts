import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DATA_DIR } from '../config.js';
import { readJson, readJsonl, writeJson, writeJsonl } from '../util/fs.js';
import { log } from '../util/log.js';
import { buildUtterances } from '../util/utterances.js';
import { downrankSet, scoreFilm, type FilmQuality } from '../util/quality.js';
import type { Cue, MovieRecord, Utterance } from '../types.js';

const MUSIC_GENRE_ID = 10402;

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const musicals = new Set(
  movies.filter((m) => m.genreIds.includes(MUSIC_GENRE_ID)).map((m) => m.id),
);
const titles = new Map(movies.map((m) => [m.id, m.title]));

// Group cues per film. Springfield extractions come first; screenplay rescues
// (cues-rescue.jsonl, same shape) fill films with no transcript.
const filmCues = new Map<number, string[]>();
async function readCueFile(name: string): Promise<void> {
  const path = resolve(DATA_DIR, name);
  if (!existsSync(path)) return;
  for await (const cue of readJsonl<Cue>(path)) {
    let list = filmCues.get(cue.movieId);
    if (!list) {
      list = [];
      filmCues.set(cue.movieId, list);
    }
    list.push(cue.text);
  }
}
await readCueFile('cues.jsonl');
await readCueFile('cues-rescue.jsonl');

const utterances: Utterance[] = [];
const dropped = { lyrics: 0, empty: 0, short: 0 };
const lengths: number[] = [];
const qualities: FilmQuality[] = [];

for (const movieId of [...filmCues.keys()].sort((a, b) => a - b)) {
  const cues = filmCues.get(movieId)!;
  qualities.push(scoreFilm(movieId, cues));
  const result = buildUtterances(cues, { musical: musicals.has(movieId) });
  dropped.lyrics += result.dropped.lyrics;
  dropped.empty += result.dropped.empty;
  dropped.short += result.dropped.short;
  const n = result.texts.length;
  result.texts.forEach((text, seq) => {
    utterances.push({ movieId, seq, arc: n > 1 ? seq / (n - 1) : 0, text });
    lengths.push(text.length);
  });
}

await writeJsonl(resolve(DATA_DIR, 'utterances.jsonl'), utterances);

const downranked = downrankSet(qualities);
await writeJson(
  resolve(DATA_DIR, 'quality.json'),
  Object.fromEntries(
    qualities.map((q) => [q.movieId, { ...q, downrank: downranked.has(q.movieId) }]),
  ),
);

lengths.sort((a, b) => a - b);
const pct = (p: number) => lengths[Math.floor((lengths.length - 1) * p)] ?? 0;
const buckets = { under20: 0, to60: 0, to120: 0, to200: 0, over200: 0 };
for (const len of lengths) {
  if (len < 20) buckets.under20 += 1;
  else if (len < 60) buckets.to60 += 1;
  else if (len < 120) buckets.to120 += 1;
  else if (len < 200) buckets.to200 += 1;
  else buckets.over200 += 1;
}

const scores = qualities.map((q) => q.score).sort((a, b) => a - b);
const spct = (p: number) => scores[Math.floor((scores.length - 1) * p)] ?? 0;
const worst = [...qualities]
  .sort((a, b) => a.score - b.score)
  .slice(0, 20)
  .map((q) => ({ title: titles.get(q.movieId) ?? String(q.movieId), ...q }));

const report = {
  films: filmCues.size,
  utterances: utterances.length,
  meanPerFilm: Math.round(utterances.length / filmCues.size),
  lengthPercentiles: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9) },
  lengthBuckets: buckets,
  dropped,
  quality: {
    scorePercentiles: { p10: spct(0.1), p50: spct(0.5), p90: spct(0.9) },
    downranked: downranked.size,
    nonEnglish: qualities
      .filter((q) => q.nonEnglish)
      .map((q) => titles.get(q.movieId) ?? String(q.movieId)),
    worst20: worst,
  },
};
await writeJson(resolve(DATA_DIR, 'utterances-report.json'), report);

log.info(
  `utterances: ${report.utterances} across ${report.films} films ` +
    `(mean ${report.meanPerFilm}/film, p50 length ${report.lengthPercentiles.p50})`,
);
log.info(`dropped: ${dropped.lyrics} lyrics, ${dropped.empty} empty, ${dropped.short} short`);
log.info(
  `quality: p50 ${report.quality.scorePercentiles.p50}, ` +
    `${downranked.size} films flagged for downrank`,
);

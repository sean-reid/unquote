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

// Group cues per film in layers: Springfield extractions, then rescue fills
// (cues-rescue.jsonl, same shape), then upgrades (cues-upgrade.jsonl), then
// OpenSubtitles replacements (cues-os.jsonl). A later layer replaces a film's
// cues wholesale, so an upgraded transcript wins.
const filmCues = new Map<number, string[]>();
const filmSource = new Map<number, string>();
async function readCueFile(name: string): Promise<void> {
  const path = resolve(DATA_DIR, name);
  if (!existsSync(path)) return;
  const layer = new Map<number, string[]>();
  for await (const cue of readJsonl<Cue>(path)) {
    let list = layer.get(cue.movieId);
    if (!list) {
      list = [];
      layer.set(cue.movieId, list);
    }
    list.push(cue.text);
  }
  for (const [movieId, list] of layer) {
    filmCues.set(movieId, list);
    filmSource.set(movieId, name);
  }
}
await readCueFile('cues.jsonl');
await readCueFile('cues-rescue.jsonl');
await readCueFile('cues-upgrade.jsonl');
await readCueFile('cues-os.jsonl');

// A film's text is a draft screenplay only when it still rides on the IMSDb
// rescue (rescue-report.json lists those); everything else is a transcript of
// the shot film. The flag feeds movie_quality so downstream consumers know
// which films' wording may diverge from the screen.
const imsdbDraftIds = new Set<number>();
{
  const reportPath = resolve(DATA_DIR, 'rescue-report.json');
  if (existsSync(reportPath)) {
    const report = await readJson<{ films: Array<{ movieId: number }> }>(reportPath);
    for (const film of report.films) imsdbDraftIds.add(film.movieId);
  }
}
function sourceKind(movieId: number): 'transcript' | 'draft' {
  const source = filmSource.get(movieId);
  if (source === 'cues-rescue.jsonl' && imsdbDraftIds.has(movieId)) return 'draft';
  return 'transcript';
}

const utterances: Utterance[] = [];
const dropped = { lyrics: 0, empty: 0, short: 0, credits: 0 };
const lengths: number[] = [];
const qualities: FilmQuality[] = [];

for (const movieId of [...filmCues.keys()].sort((a, b) => a - b)) {
  const cues = filmCues.get(movieId)!;
  qualities.push(scoreFilm(movieId, cues));
  const result = buildUtterances(cues, {
    musical: musicals.has(movieId),
    title: titles.get(movieId),
  });
  dropped.lyrics += result.dropped.lyrics;
  dropped.empty += result.dropped.empty;
  dropped.short += result.dropped.short;
  dropped.credits += result.dropped.credits;
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
    qualities.map((q) => [
      q.movieId,
      { ...q, downrank: downranked.has(q.movieId), sourceKind: sourceKind(q.movieId) },
    ]),
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
log.info(
  `dropped: ${dropped.lyrics} lyrics, ${dropped.empty} empty, ` +
    `${dropped.short} short, ${dropped.credits} credits`,
);
log.info(
  `quality: p50 ${report.quality.scorePercentiles.p50}, ` +
    `${downranked.size} films flagged for downrank`,
);

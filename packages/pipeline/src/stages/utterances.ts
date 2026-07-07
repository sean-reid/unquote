import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJsonl, writeJson, writeJsonl } from '../util/fs.js';
import { log } from '../util/log.js';
import { buildUtterances } from '../util/utterances.js';
import type { Cue, Utterance } from '../types.js';

// Group cues per film (input is ordered by movieId then idx).
const filmCues = new Map<number, string[]>();
for await (const cue of readJsonl<Cue>(resolve(DATA_DIR, 'cues.jsonl'))) {
  let list = filmCues.get(cue.movieId);
  if (!list) {
    list = [];
    filmCues.set(cue.movieId, list);
  }
  list.push(cue.text);
}

const utterances: Utterance[] = [];
const dropped = { music: 0, empty: 0, short: 0 };
const lengths: number[] = [];

for (const [movieId, cues] of filmCues) {
  const result = buildUtterances(cues);
  dropped.music += result.dropped.music;
  dropped.empty += result.dropped.empty;
  dropped.short += result.dropped.short;
  const n = result.texts.length;
  result.texts.forEach((text, seq) => {
    utterances.push({ movieId, seq, arc: n > 1 ? seq / (n - 1) : 0, text });
    lengths.push(text.length);
  });
}

await writeJsonl(resolve(DATA_DIR, 'utterances.jsonl'), utterances);

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

const report = {
  films: filmCues.size,
  utterances: utterances.length,
  meanPerFilm: Math.round(utterances.length / filmCues.size),
  lengthPercentiles: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9) },
  lengthBuckets: buckets,
  dropped,
};
await writeJson(resolve(DATA_DIR, 'utterances-report.json'), report);

log.info(
  `utterances: ${report.utterances} across ${report.films} films ` +
    `(mean ${report.meanPerFilm}/film, p50 length ${report.lengthPercentiles.p50})`,
);
log.info(`dropped: ${dropped.music} music, ${dropped.empty} empty, ${dropped.short} short`);

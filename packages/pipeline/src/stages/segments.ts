/**
 * Cut each film's beat sequence into scene-scale segments where consecutive
 * beats stop resembling each other, and pool member beat vectors into one
 * vector per segment.
 *
 * Run: pnpm segments
 */
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, readJsonl, writeJson, writeJsonl } from '../util/fs.js';
import { log } from '../util/log.js';
import { cutSegments, dot, meanVector } from '../util/ladder.js';

interface BeatRecord {
  movieId: number;
  idx: number;
  startSeq: number;
  endSeq: number;
  arc: number;
}

interface SegmentRecord {
  movieId: number;
  idx: number;
  startBeat: number;
  endBeat: number;
  startSeq: number;
  endSeq: number;
  arc: number;
}

const meta = await readJson<{ dim: number; count: number }>(
  resolve(DATA_DIR, 'beat-embeddings.meta.json'),
);
const dim = meta.dim;

const beats: BeatRecord[] = [];
for await (const beat of readJsonl<BeatRecord>(resolve(DATA_DIR, 'beats.jsonl'))) {
  beats.push(beat);
}
if (beats.length !== meta.count) {
  throw new Error(`beats.jsonl has ${beats.length} rows, embeddings say ${meta.count}`);
}

const file = await open(resolve(DATA_DIR, 'beat-embeddings.bin'), 'r');
const matrix = new Float32Array(beats.length * dim);
await file.read(Buffer.from(matrix.buffer), 0, matrix.byteLength, 0);
await file.close();

const filmRows = new Map<number, number[]>();
beats.forEach((beat, row) => {
  let rows = filmRows.get(beat.movieId);
  if (!rows) {
    rows = [];
    filmRows.set(beat.movieId, rows);
  }
  rows.push(row);
});

const segments: SegmentRecord[] = [];
const vectors: Float32Array[] = [];
const beatsPerSegment: number[] = [];

for (const [movieId, rows] of filmRows) {
  const sims: number[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    sims.push(
      dot(
        matrix.subarray(rows[i]! * dim, rows[i]! * dim + dim),
        matrix.subarray(rows[i + 1]! * dim, rows[i + 1]! * dim + dim),
      ),
    );
  }
  cutSegments(sims, rows.length).forEach(([startBeat, endBeat], idx) => {
    const first = beats[rows[startBeat]!]!;
    const last = beats[rows[endBeat]!]!;
    segments.push({
      movieId,
      idx,
      startBeat,
      endBeat,
      startSeq: first.startSeq,
      endSeq: last.endSeq,
      arc: (first.arc + last.arc) / 2,
    });
    vectors.push(meanVector(rows.slice(startBeat, endBeat + 1), matrix, dim));
    beatsPerSegment.push(endBeat - startBeat + 1);
  });
}

const out = await open(resolve(DATA_DIR, 'segment-embeddings.bin'), 'w');
for (const vec of vectors) {
  await out.write(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
}
await out.close();
await writeJsonl(resolve(DATA_DIR, 'segments.jsonl'), segments);
await writeJson(resolve(DATA_DIR, 'segment-embeddings.meta.json'), {
  dim,
  count: segments.length,
});

const meanBeats = beatsPerSegment.reduce((a, b) => a + b, 0) / beatsPerSegment.length;
log.info(
  `segments: ${segments.length} across ${filmRows.size} films ` +
    `(mean ${(segments.length / filmRows.size).toFixed(1)}/film, ${meanBeats.toFixed(1)} beats/segment)`,
);

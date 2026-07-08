/**
 * Load the context ladder into ClickHouse: beats, segments, movie pairs, the
 * 2D movie map, and the five-lines picks. Staging tables and an atomic swap,
 * mirroring the base load stage.
 *
 * Run: pnpm load-ladder
 */
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { DATA_DIR } from '../config.js';
import { readJsonl } from '../util/fs.js';

const DATABASE = 'unquote';
const INSERT_BATCH = 2000;

interface BeatRecord {
  movieId: number;
  idx: number;
  startSeq: number;
  endSeq: number;
  arc: number;
  text: string;
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

function client(database?: string): ClickHouseClient {
  return createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'unquote-local',
    database,
  });
}

async function readMeta(name: string): Promise<{ dim: number; count: number }> {
  return JSON.parse(await readFile(path.join(DATA_DIR, name), 'utf8'));
}

function vectorIndex(dim: number): string {
  return `INDEX vec_idx vec TYPE vector_similarity('hnsw', 'cosineDistance', ${dim}, 'bf16', 16, 128) GRANULARITY 100000000`;
}

async function createTables(ch: ClickHouseClient, dim: number): Promise<void> {
  const tables: Record<string, string> = {
    beats: `(movie_id UInt32, idx UInt32, start_seq UInt32, end_seq UInt32, arc Float32, text String, vec Array(Float32), ${vectorIndex(dim)}) ENGINE = MergeTree ORDER BY (movie_id, idx)`,
    segments: `(movie_id UInt32, idx UInt32, start_beat UInt32, end_beat UInt32, start_seq UInt32, end_seq UInt32, arc Float32, vec Array(Float32), ${vectorIndex(dim)}) ENGINE = MergeTree ORDER BY (movie_id, idx)`,
    movie_pairs: `(movie_id UInt32, rank UInt8, similar_id UInt32, score Float32) ENGINE = MergeTree ORDER BY (movie_id, rank)`,
    movie_map: `(movie_id UInt32, x Float32, y Float32) ENGINE = MergeTree ORDER BY movie_id`,
    five_lines: `(movie_id UInt32, seqs Array(UInt32)) ENGINE = MergeTree ORDER BY movie_id`,
  };
  for (const [name, schema] of Object.entries(tables)) {
    await ch.command({
      query: `CREATE TABLE IF NOT EXISTS ${name} ${schema}`,
      clickhouse_settings: { allow_experimental_vector_similarity_index: 1 },
    });
    await ch.command({ query: `DROP TABLE IF EXISTS ${name}_staging` });
    await ch.command({
      query: `CREATE TABLE ${name}_staging ${schema}`,
      clickhouse_settings: { allow_experimental_vector_similarity_index: 1 },
    });
  }
}

async function loadVectorRows<T>(
  ch: ClickHouseClient,
  table: string,
  jsonl: string,
  bin: string,
  dim: number,
  toRow: (record: T, vec: number[]) => Record<string, unknown>,
): Promise<number> {
  const rowBytes = dim * 4;
  const file = await open(path.join(DATA_DIR, bin), 'r');
  const buffer = Buffer.alloc(rowBytes);
  let row = 0;
  let batch: Record<string, unknown>[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await ch.insert({ table, values: batch, format: 'JSONEachRow' });
    batch = [];
  };
  for await (const record of readJsonl<T>(path.join(DATA_DIR, jsonl))) {
    await file.read(buffer, 0, rowBytes, row * rowBytes);
    const vec = Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, dim));
    batch.push(toRow(record, vec));
    row += 1;
    if (batch.length >= INSERT_BATCH) await flush();
  }
  await flush();
  await file.close();
  return row;
}

async function main(): Promise<void> {
  const started = Date.now();
  const beatMeta = await readMeta('beat-embeddings.meta.json');
  const segmentMeta = await readMeta('segment-embeddings.meta.json');
  if (beatMeta.dim !== segmentMeta.dim) {
    throw new Error(`beat dim ${beatMeta.dim} differs from segment dim ${segmentMeta.dim}`);
  }
  const dim = beatMeta.dim;

  const admin = client();
  await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${DATABASE}` });
  await admin.close();

  const ch = client(DATABASE);
  await createTables(ch, dim);

  const beatCount = await loadVectorRows<BeatRecord>(
    ch,
    'beats_staging',
    'beats.jsonl',
    'beat-embeddings.bin',
    dim,
    (b, vec) => ({
      movie_id: b.movieId,
      idx: b.idx,
      start_seq: b.startSeq,
      end_seq: b.endSeq,
      arc: b.arc,
      text: b.text,
      vec,
    }),
  );
  if (beatCount !== beatMeta.count) {
    throw new Error(`beats.jsonl has ${beatCount} rows, meta says ${beatMeta.count}`);
  }

  const segmentCount = await loadVectorRows<SegmentRecord>(
    ch,
    'segments_staging',
    'segments.jsonl',
    'segment-embeddings.bin',
    dim,
    (s, vec) => ({
      movie_id: s.movieId,
      idx: s.idx,
      start_beat: s.startBeat,
      end_beat: s.endBeat,
      start_seq: s.startSeq,
      end_seq: s.endSeq,
      arc: s.arc,
      vec,
    }),
  );

  const pairs: Record<string, Array<{ id: number; score: number }>> = JSON.parse(
    await readFile(path.join(DATA_DIR, 'movie-pairs.json'), 'utf8'),
  );
  const pairRows = Object.entries(pairs).flatMap(([movieId, similar]) =>
    similar.map((entry, rank) => ({
      movie_id: Number(movieId),
      rank: rank + 1,
      similar_id: entry.id,
      score: entry.score,
    })),
  );
  await ch.insert({ table: 'movie_pairs_staging', values: pairRows, format: 'JSONEachRow' });

  const map: Record<string, [number, number]> = JSON.parse(
    await readFile(path.join(DATA_DIR, 'movie-map.json'), 'utf8'),
  );
  await ch.insert({
    table: 'movie_map_staging',
    values: Object.entries(map).map(([movieId, [x, y]]) => ({
      movie_id: Number(movieId),
      x,
      y,
    })),
    format: 'JSONEachRow',
  });

  const fiveLines: Record<string, number[]> = JSON.parse(
    await readFile(path.join(DATA_DIR, 'five-lines.json'), 'utf8'),
  );
  await ch.insert({
    table: 'five_lines_staging',
    values: Object.entries(fiveLines).map(([movieId, seqs]) => ({
      movie_id: Number(movieId),
      seqs,
    })),
    format: 'JSONEachRow',
  });

  for (const name of ['beats', 'segments', 'movie_pairs', 'movie_map', 'five_lines']) {
    await ch.command({ query: `EXCHANGE TABLES ${name}_staging AND ${name}` });
  }
  await ch.close();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `loaded ${beatCount} beats, ${segmentCount} segments, ` +
      `${pairRows.length} pairs, ${Object.keys(map).length} map points, ` +
      `${Object.keys(fiveLines).length} five-line films in ${seconds}s`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

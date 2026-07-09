/**
 * Load the context ladder into ClickHouse: beats, segments, movie pairs, the
 * 2D movie map, the five-lines picks, and scene summaries. Staging tables and
 * an atomic swap, mirroring the base load stage.
 *
 * Run: pnpm load-ladder
 */
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { DATA_DIR } from '../config.js';
import { readJsonl } from '../util/fs.js';
import { readGenerated } from '../util/generated.js';

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
    request_timeout: 900_000,
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

interface SummaryRow {
  windowId: string;
  movieId: number;
  headline: string;
  summary: string;
  valid: boolean;
}

async function createTables(ch: ClickHouseClient, dim: number): Promise<void> {
  const tables: Record<string, string> = {
    beats: `(movie_id UInt32, idx UInt32, start_seq UInt32, end_seq UInt32, arc Float32, text String, vec Array(Float32), generic Float32, ${vectorIndex(dim)}) ENGINE = MergeTree ORDER BY (movie_id, idx)`,
    segments: `(movie_id UInt32, idx UInt32, start_beat UInt32, end_beat UInt32, start_seq UInt32, end_seq UInt32, arc Float32, vec Array(Float32), ${vectorIndex(dim)}) ENGINE = MergeTree ORDER BY (movie_id, idx)`,
    movie_pairs: `(movie_id UInt32, rank UInt8, similar_id UInt32, score Float32) ENGINE = MergeTree ORDER BY (movie_id, rank)`,
    movie_map: `(movie_id UInt32, x Float32, y Float32) ENGINE = MergeTree ORDER BY movie_id`,
    five_lines: `(movie_id UInt32, seqs Array(UInt32)) ENGINE = MergeTree ORDER BY movie_id`,
    movie_quality: `(movie_id UInt32, downrank UInt8, non_english UInt8, source_kind LowCardinality(String)) ENGINE = MergeTree ORDER BY movie_id`,
    scene_summaries: `(movie_id UInt32, start_seq UInt32, end_seq UInt32, headline String, summary String) ENGINE = MergeTree ORDER BY (movie_id, start_seq)`,
    summary_vectors: `(movie_id UInt32, start_seq UInt32, end_seq UInt32, vec Array(Float32), ${vectorIndex(dim)}) ENGINE = MergeTree ORDER BY (movie_id, start_seq)`,
  };
  for (const [name, schema] of Object.entries(tables)) {
    await ch.command({
      query: `CREATE TABLE IF NOT EXISTS ${name} ${schema}`,
      clickhouse_settings: { allow_experimental_vector_similarity_index: 1 },
    });
    await ch.command({ query: `DROP TABLE IF EXISTS ${name}_staging` });
    // Staging skips the vector index so bulk inserts stay fast and lean; the
    // index is added and materialized sequentially afterwards, one table at a
    // time, memory-capped, because the whole Docker VM has under 8GB.
    const stagingSchema = schema
      .replace(`${vectorIndex(dim)}, `, '')
      .replace(`, ${vectorIndex(dim)}`, '');
    await ch.command({ query: `CREATE TABLE ${name}_staging ${stagingSchema}` });
  }
}

async function loadVectorRows<T>(
  ch: ClickHouseClient,
  table: string,
  jsonl: string,
  bin: string,
  dim: number,
  toRow: (record: T, vec: number[], row: number) => Record<string, unknown>,
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
    batch.push(toRow(record, vec, row));
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

  // Genericness rides along with the beat rows; the bridge and neighbor
  // surfaces penalize universal-filler moments with it.
  const genericBytes = await readFile(path.join(DATA_DIR, 'beat-generic.bin'));
  const generic = new Float32Array(
    genericBytes.buffer,
    genericBytes.byteOffset,
    genericBytes.byteLength / 4,
  );

  const beatCount = await loadVectorRows<BeatRecord>(
    ch,
    'beats_staging',
    'beats.jsonl',
    'beat-embeddings.bin',
    dim,
    (b, vec, row) => ({
      movie_id: b.movieId,
      idx: b.idx,
      start_seq: b.startSeq,
      end_seq: b.endSeq,
      arc: b.arc,
      text: b.text,
      vec,
      generic: generic[row] ?? 0,
    }),
  );
  if (generic.length !== beatCount) {
    throw new Error(`beat-generic.bin has ${generic.length} rows, beats.jsonl has ${beatCount}`);
  }
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

  // The picker's five-lines.json seeds every film; films the curated
  // generation store covers get its picks instead. Both stores are
  // append-only with the last row per key authoritative.
  const fiveLines: Record<string, number[]> = JSON.parse(
    await readFile(path.join(DATA_DIR, 'five-lines.json'), 'utf8'),
  );
  let curatedCount = 0;
  for (const row of readGenerated<{ movieId: number; quotes: Array<{ seq: number }> }>(
    'five-quotes.jsonl',
  ).values()) {
    if (row.quotes.length === 0) continue;
    fiveLines[String(row.movieId)] = row.quotes.map((q) => q.seq);
    curatedCount += 1;
  }
  await ch.insert({
    table: 'five_lines_staging',
    values: Object.entries(fiveLines).map(([movieId, seqs]) => ({
      movie_id: Number(movieId),
      seqs,
    })),
    format: 'JSONEachRow',
  });

  // Scene summaries trickle in over days of generation; whatever the store
  // holds right now ships, and films without rows fall back in the app.
  const summaries = [...readGenerated<SummaryRow>('scene-summary.jsonl').values()].filter(
    (row) => row.valid,
  );
  for (let at = 0; at < summaries.length; at += INSERT_BATCH) {
    await ch.insert({
      table: 'scene_summaries_staging',
      values: summaries.slice(at, at + INSERT_BATCH).map((row) => {
        const [, span] = row.windowId.split(':');
        const [startSeq, endSeq] = span!.split('-').map(Number);
        return {
          movie_id: row.movieId,
          start_seq: startSeq,
          end_seq: endSeq,
          headline: row.headline,
          summary: row.summary,
        };
      }),
      format: 'JSONEachRow',
    });
  }

  // Summary vectors come from the embed-summaries artifact, which lags the
  // store by design: a summary searches only once it has been embedded. A
  // missing artifact just means an empty retrieval table this load.
  let summaryVecCount = 0;
  if (existsSync(path.join(DATA_DIR, 'summary-embeddings.bin'))) {
    const summaryMeta = await readMeta('summary-embeddings.meta.json');
    if (summaryMeta.dim !== dim) {
      throw new Error(`summary dim ${summaryMeta.dim} differs from beat dim ${dim}`);
    }
    summaryVecCount = await loadVectorRows<{ movieId: number; startSeq: number; endSeq: number }>(
      ch,
      'summary_vectors_staging',
      'summaries.jsonl',
      'summary-embeddings.bin',
      dim,
      (s, vec) => ({
        movie_id: s.movieId,
        start_seq: s.startSeq,
        end_seq: s.endSeq,
        vec,
      }),
    );
    if (summaryVecCount !== summaryMeta.count) {
      throw new Error(
        `summaries.jsonl has ${summaryVecCount} rows, meta says ${summaryMeta.count}`,
      );
    }
  }

  // Per-film quality flags. source_kind marks films whose text is a draft
  // screenplay rather than a transcript of the shot film; the app and the
  // summary pipeline treat draft wording with less confidence.
  const quality: Record<string, { downrank: boolean; nonEnglish: boolean; sourceKind?: string }> =
    JSON.parse(await readFile(path.join(DATA_DIR, 'quality.json'), 'utf8'));
  await ch.insert({
    table: 'movie_quality_staging',
    values: Object.entries(quality).map(([movieId, q]) => ({
      movie_id: Number(movieId),
      downrank: q.downrank ? 1 : 0,
      non_english: q.nonEnglish ? 1 : 0,
      source_kind: q.sourceKind ?? 'transcript',
    })),
    format: 'JSONEachRow',
  });

  // Vector indexes build one table at a time with a hard memory cap; the
  // container shares a small VM and parallel HNSW builds have taken it down.
  for (const name of ['beats', 'segments', 'summary_vectors']) {
    await ch.command({
      query: `ALTER TABLE ${name}_staging ADD INDEX vec_idx vec TYPE vector_similarity('hnsw', 'cosineDistance', ${dim}, 'bf16', 16, 128) GRANULARITY 100000000`,
      clickhouse_settings: { allow_experimental_vector_similarity_index: 1 },
    });
    console.log(`materializing ${name} vector index...`);
    await ch.command({
      query: `ALTER TABLE ${name}_staging MATERIALIZE INDEX vec_idx`,
      clickhouse_settings: {
        allow_experimental_vector_similarity_index: 1,
        mutations_sync: '2',
        max_memory_usage: '3500000000',
        // The index build can outlive the socket idle timeout; progress
        // headers keep the connection alive for however long it takes.
        send_progress_in_http_headers: 1,
        http_headers_progress_interval_ms: '20000',
      },
    });
  }

  for (const name of [
    'beats',
    'segments',
    'movie_pairs',
    'movie_map',
    'five_lines',
    'movie_quality',
    'scene_summaries',
    'summary_vectors',
  ]) {
    await ch.command({ query: `EXCHANGE TABLES ${name}_staging AND ${name}` });
  }
  await ch.close();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `loaded ${beatCount} beats, ${segmentCount} segments, ` +
      `${pairRows.length} pairs, ${Object.keys(map).length} map points, ` +
      `${Object.keys(fiveLines).length} five-line films (${curatedCount} curated), ` +
      `${summaries.length} scene summaries (${summaryVecCount} searchable) in ${seconds}s`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

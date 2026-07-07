/**
 * Load the slice into ClickHouse. Reads movies.json, slice.json,
 * utterances.jsonl, and embeddings.bin, writes into staging tables, then
 * swaps them in atomically so a running app never sees a partial dataset.
 *
 * Run: pnpm exec tsx src/stages/load.ts
 */
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { normalize, EMBED_DIM } from '@unquote/shared';
import { DATA_DIR } from '../config.js';

interface MovieRecord {
  id: number;
  title: string;
  year: number;
  decade: number;
  tmdbRating: number;
  tmdbVotes: number;
  posterPath: string | null;
  genreIds: number[];
}

interface UtteranceRecord {
  movieId: number;
  seq: number;
  arc: number;
  text: string;
}

const DATABASE = 'unquote';
const INSERT_BATCH = 5000;

function client(database?: string): ClickHouseClient {
  return createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'unquote-local',
    database,
  });
}

async function ensureSchema(ch: ClickHouseClient): Promise<void> {
  await ch.command({ query: `CREATE DATABASE IF NOT EXISTS ${DATABASE}` });
}

const MOVIES_COLUMNS = `
  id UInt32,
  title String,
  year UInt16,
  decade UInt16,
  rating Float32,
  votes UInt32,
  poster_path Nullable(String),
  genre_ids Array(UInt16)
`;

const LINES_COLUMNS = `
  movie_id UInt32,
  seq UInt32,
  arc Float32,
  text String,
  text_norm String,
  vec Array(Float32),
  INDEX idx_text_norm text_norm TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4
`;

async function createTables(ch: ClickHouseClient): Promise<void> {
  await ch.command({
    query: `CREATE TABLE IF NOT EXISTS movies (${MOVIES_COLUMNS}) ENGINE = MergeTree ORDER BY id`,
  });
  await ch.command({
    query: `CREATE TABLE IF NOT EXISTS lines (${LINES_COLUMNS}) ENGINE = MergeTree ORDER BY (movie_id, seq)`,
  });
  await ch.command({ query: 'DROP TABLE IF EXISTS movies_staging' });
  await ch.command({ query: 'DROP TABLE IF EXISTS lines_staging' });
  await ch.command({
    query: `CREATE TABLE movies_staging (${MOVIES_COLUMNS}) ENGINE = MergeTree ORDER BY id`,
  });
  await ch.command({
    query: `CREATE TABLE lines_staging (${LINES_COLUMNS}) ENGINE = MergeTree ORDER BY (movie_id, seq)`,
  });
}

async function loadMovies(ch: ClickHouseClient, sliceIds: Set<number>): Promise<number> {
  const all: MovieRecord[] = JSON.parse(await readFile(path.join(DATA_DIR, 'movies.json'), 'utf8'));
  const rows = all
    .filter((m) => sliceIds.has(m.id))
    .map((m) => ({
      id: m.id,
      title: m.title,
      year: m.year,
      decade: m.decade,
      rating: m.tmdbRating,
      votes: m.tmdbVotes,
      poster_path: m.posterPath,
      genre_ids: m.genreIds,
    }));
  await ch.insert({ table: 'movies_staging', values: rows, format: 'JSONEachRow' });
  return rows.length;
}

async function loadLines(ch: ClickHouseClient, sliceIds: Set<number>): Promise<number> {
  const meta = JSON.parse(await readFile(path.join(DATA_DIR, 'embeddings.meta.json'), 'utf8'));
  if (meta.dim !== EMBED_DIM) {
    throw new Error(`embeddings dim ${meta.dim} does not match contract ${EMBED_DIM}`);
  }
  const rowBytes = EMBED_DIM * 4;
  const embeddings = await open(path.join(DATA_DIR, 'embeddings.bin'), 'r');
  const vecBuffer = Buffer.alloc(rowBytes);

  const reader = createInterface({
    input: createReadStream(path.join(DATA_DIR, 'utterances.jsonl')),
    crlfDelay: Infinity,
  });

  let row = 0;
  let inserted = 0;
  let batch: Record<string, unknown>[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await ch.insert({ table: 'lines_staging', values: batch, format: 'JSONEachRow' });
    inserted += batch.length;
    batch = [];
  };

  for await (const line of reader) {
    if (!line.trim()) continue;
    const utterance: UtteranceRecord = JSON.parse(line);
    const index = row;
    row += 1;
    if (!sliceIds.has(utterance.movieId)) continue;

    await embeddings.read(vecBuffer, 0, rowBytes, index * rowBytes);
    const vec = Array.from(new Float32Array(vecBuffer.buffer, vecBuffer.byteOffset, EMBED_DIM));
    batch.push({
      movie_id: utterance.movieId,
      seq: utterance.seq,
      arc: utterance.arc,
      text: utterance.text,
      text_norm: normalize(utterance.text),
      vec,
    });
    if (batch.length >= INSERT_BATCH) await flush();
  }
  await flush();
  await embeddings.close();

  if (row !== meta.count) {
    throw new Error(`utterances.jsonl has ${row} rows but embeddings.meta.json says ${meta.count}`);
  }
  return inserted;
}

async function swap(ch: ClickHouseClient): Promise<void> {
  await ch.command({ query: 'EXCHANGE TABLES movies_staging AND movies' });
  await ch.command({ query: 'EXCHANGE TABLES lines_staging AND lines' });
  await ch.command({ query: 'DROP TABLE IF EXISTS movies_staging' });
  await ch.command({ query: 'DROP TABLE IF EXISTS lines_staging' });
}

async function main(): Promise<void> {
  const started = Date.now();
  const sliceIds = new Set<number>(
    JSON.parse(await readFile(path.join(DATA_DIR, 'slice.json'), 'utf8')),
  );

  const admin = client();
  await ensureSchema(admin);
  await admin.close();

  const ch = client(DATABASE);
  await createTables(ch);
  const movieCount = await loadMovies(ch, sliceIds);
  const lineCount = await loadLines(ch, sliceIds);
  await swap(ch);
  await ch.close();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`loaded ${movieCount} movies, ${lineCount} lines in ${seconds}s`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

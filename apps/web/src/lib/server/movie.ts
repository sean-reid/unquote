import type { MomentNeighbor, NeighborLevels } from '@unquote/shared';
import { db } from './db.js';

export interface MovieHeader {
  id: number;
  title: string;
  year: number;
  posterPath: string | null;
  lineCount: number;
}

export interface FiveLine {
  seq: number;
  arc: number;
  text: string;
}

export interface SegmentBlock {
  idx: number;
  startSeq: number;
  endSeq: number;
  arc: number;
  snippet: string;
}

export interface SimilarMovie {
  movieId: number;
  title: string;
  year: number;
  posterPath: string | null;
  score: number;
}

export interface BridgePair {
  arcA: number;
  arcB: number;
  startSeqA: number;
  startSeqB: number;
  excerptA: string;
  excerptB: string;
  score: number;
}

const HNSW = { allow_experimental_vector_similarity_index: 1 };
/** Server-enforced excerpt bound: never more than three lines per neighbor. */
const EXCERPT_LINES = 3;
const EXCERPT_CHARS = 220;

/**
 * The ladder tables land after the app ships; every section that reads one
 * degrades to empty rather than failing the page.
 */
async function rows<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch {
    return [];
  }
}

export async function movieHeader(id: number): Promise<MovieHeader | null> {
  const result = await db.query({
    query: `
      SELECT m.id AS id, m.title AS title, m.year AS year, m.poster_path AS poster_path,
             (SELECT count() FROM lines WHERE movie_id = {id:UInt32}) AS line_count
      FROM movies AS m
      WHERE m.id = {id:UInt32}
    `,
    query_params: { id },
    format: 'JSONEachRow',
  });
  const found = (await result.json()) as Array<{
    id: number;
    title: string;
    year: number;
    poster_path: string | null;
    line_count: string | number;
  }>;
  const row = found[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    year: row.year,
    posterPath: row.poster_path,
    lineCount: Number(row.line_count),
  };
}

export async function fiveLines(id: number): Promise<FiveLine[]> {
  return rows(async () => {
    const result = await db.query({
      query: `
        SELECT l.seq AS seq, l.arc AS arc, l.text AS text
        FROM lines AS l
        WHERE l.movie_id = {id:UInt32}
          AND l.seq IN (SELECT arrayJoin(seqs) FROM five_lines WHERE movie_id = {id:UInt32})
        ORDER BY l.seq
      `,
      query_params: { id },
      format: 'JSONEachRow',
    });
    return (await result.json()) as FiveLine[];
  });
}

export async function segmentBlocks(id: number): Promise<SegmentBlock[]> {
  return rows(async () => {
    const result = await db.query({
      query: `
        SELECT s.idx AS idx, s.start_seq AS startSeq, s.end_seq AS endSeq, s.arc AS arc,
               (SELECT text FROM lines WHERE movie_id = {id:UInt32} AND seq = s.start_seq) AS snippet
        FROM segments AS s
        WHERE s.movie_id = {id:UInt32}
        ORDER BY s.idx
      `,
      query_params: { id },
      format: 'JSONEachRow',
    });
    return (await result.json()) as SegmentBlock[];
  });
}

export async function similarMovies(id: number): Promise<SimilarMovie[]> {
  return rows(async () => {
    const result = await db.query({
      query: `
        SELECT p.similar_id AS movieId, m.title AS title, m.year AS year,
               m.poster_path AS posterPath, p.score AS score
        FROM movie_pairs AS p
        INNER JOIN movies AS m ON m.id = p.similar_id
        WHERE p.movie_id = {id:UInt32}
        ORDER BY p.rank
        LIMIT 8
      `,
      query_params: { id },
      format: 'JSONEachRow',
    });
    return (await result.json()) as SimilarMovie[];
  });
}

interface VecRow {
  vec: number[];
}

async function vectorOf(
  table: 'lines' | 'beats' | 'segments',
  id: number,
  where: string,
  params: Record<string, number>,
): Promise<number[] | null> {
  const result = await db.query({
    query: `SELECT vec FROM ${table} WHERE movie_id = {id:UInt32} AND ${where} LIMIT 1`,
    query_params: { id, ...params },
    format: 'JSONEachRow',
  });
  const found = (await result.json()) as VecRow[];
  return found[0]?.vec ?? null;
}

function clip(text: string): string {
  if (text.length <= EXCERPT_CHARS) return text;
  const cut = text.slice(0, EXCERPT_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(' '))}...`;
}

interface NeighborRow {
  movie_id: number;
  title: string;
  year: number;
  poster_path: string | null;
  arc: number;
  start_seq: number;
  excerpt: string;
  score: number;
}

function toNeighbor(row: NeighborRow): MomentNeighbor {
  return {
    movieId: row.movie_id,
    title: row.title,
    year: row.year,
    posterPath: row.poster_path,
    arc: row.arc,
    excerpt: clip(row.excerpt),
    startSeq: row.start_seq,
    score: row.score,
  };
}

async function nearestLines(id: number, vec: number[]): Promise<MomentNeighbor[]> {
  const result = await db.query({
    query: `
      SELECT l.movie_id AS movie_id, m.title AS title, m.year AS year,
             m.poster_path AS poster_path, l.arc AS arc, l.seq AS start_seq,
             l.text AS excerpt, 1 - cosineDistance(l.vec, {vec:Array(Float32)}) AS score
      FROM lines AS l
      INNER JOIN movies AS m ON m.id = l.movie_id
      WHERE l.movie_id != {id:UInt32}
      ORDER BY cosineDistance(l.vec, {vec:Array(Float32)}) ASC
      LIMIT 16
    `,
    query_params: { id, vec },
    format: 'JSONEachRow',
    clickhouse_settings: HNSW,
  });
  return dedupeByFilm(((await result.json()) as NeighborRow[]).map(toNeighbor), 8);
}

async function nearestBeats(id: number, vec: number[]): Promise<MomentNeighbor[]> {
  const result = await db.query({
    query: `
      SELECT b.movie_id AS movie_id, m.title AS title, m.year AS year,
             m.poster_path AS poster_path, b.arc AS arc, b.start_seq AS start_seq,
             b.text AS excerpt, 1 - cosineDistance(b.vec, {vec:Array(Float32)}) AS score
      FROM beats AS b
      INNER JOIN movies AS m ON m.id = b.movie_id
      WHERE b.movie_id != {id:UInt32}
      ORDER BY cosineDistance(b.vec, {vec:Array(Float32)}) ASC
      LIMIT 16
    `,
    query_params: { id, vec },
    format: 'JSONEachRow',
    clickhouse_settings: HNSW,
  });
  return dedupeByFilm(((await result.json()) as NeighborRow[]).map(toNeighbor), 8);
}

async function nearestSegments(id: number, vec: number[]): Promise<MomentNeighbor[]> {
  const result = await db.query({
    query: `
      SELECT s.movie_id AS movie_id, m.title AS title, m.year AS year,
             m.poster_path AS poster_path, s.arc AS arc, s.start_seq AS start_seq,
             '' AS excerpt, 1 - cosineDistance(s.vec, {vec:Array(Float32)}) AS score
      FROM segments AS s
      INNER JOIN movies AS m ON m.id = s.movie_id
      WHERE s.movie_id != {id:UInt32}
      ORDER BY cosineDistance(s.vec, {vec:Array(Float32)}) ASC
      LIMIT 16
    `,
    query_params: { id, vec },
    format: 'JSONEachRow',
    clickhouse_settings: HNSW,
  });
  const neighbors = dedupeByFilm(((await result.json()) as NeighborRow[]).map(toNeighbor), 8);
  await fillExcerpts(neighbors);
  return neighbors;
}

/** One query fills the opening lines of every segment neighbor. */
async function fillExcerpts(neighbors: MomentNeighbor[]): Promise<void> {
  if (neighbors.length === 0) return;
  const clauses = neighbors
    .map((_, i) => `(movie_id = {m${i}:UInt32} AND seq >= {s${i}:UInt32} AND seq < {e${i}:UInt32})`)
    .join(' OR ');
  const params: Record<string, number> = {};
  neighbors.forEach((n, i) => {
    params[`m${i}`] = n.movieId;
    params[`s${i}`] = n.startSeq;
    params[`e${i}`] = n.startSeq + EXCERPT_LINES;
  });
  const result = await db.query({
    query: `SELECT movie_id, seq, text FROM lines WHERE ${clauses} ORDER BY movie_id, seq`,
    query_params: params,
    format: 'JSONEachRow',
  });
  const lines = (await result.json()) as Array<{ movie_id: number; seq: number; text: string }>;
  for (const neighbor of neighbors) {
    // Constrain by seq range too: two neighbors from the same film must not
    // share one merged excerpt.
    const own = lines
      .filter(
        (l) =>
          l.movie_id === neighbor.movieId &&
          l.seq >= neighbor.startSeq &&
          l.seq < neighbor.startSeq + EXCERPT_LINES,
      )
      .map((l) => l.text);
    neighbor.excerpt = clip(own.join(' '));
  }
}

/** One neighbor per film, best first; variety beats near-duplicates in a short list. */
function dedupeByFilm(neighbors: MomentNeighbor[], keep: number): MomentNeighbor[] {
  const seen = new Set<number>();
  const out: MomentNeighbor[] = [];
  for (const neighbor of neighbors) {
    if (seen.has(neighbor.movieId)) continue;
    seen.add(neighbor.movieId);
    out.push(neighbor);
    if (out.length === keep) break;
  }
  return out;
}

async function movieNeighbors(id: number): Promise<MomentNeighbor[]> {
  const similar = await similarMovies(id);
  return similar.map((s) => ({
    movieId: s.movieId,
    title: s.title,
    year: s.year,
    posterPath: s.posterPath,
    arc: 0,
    excerpt: '',
    startSeq: 0,
    score: s.score,
  }));
}

/** All four dial levels for one scrub position, one request. */
export async function neighborLevels(id: number, seq: number): Promise<NeighborLevels | null> {
  const started = Date.now();
  const lineVec = await vectorOf('lines', id, 'seq = {seq:UInt32}', { seq });
  if (!lineVec) return null;

  const [beatVec, segmentVec] = await Promise.all([
    rows(() =>
      vectorOf('beats', id, 'start_seq <= {seq:UInt32} AND end_seq >= {seq:UInt32}', {
        seq,
      }).then((v) => (v ? [v] : [])),
    ).then((v) => v[0] ?? null),
    rows(() =>
      vectorOf('segments', id, 'start_seq <= {seq:UInt32} AND end_seq >= {seq:UInt32}', {
        seq,
      }).then((v) => (v ? [v] : [])),
    ).then((v) => v[0] ?? null),
  ]);

  const [line, beat, segment, movie] = await Promise.all([
    rows(() => nearestLines(id, lineVec)),
    beatVec ? rows(() => nearestBeats(id, beatVec)) : Promise.resolve([]),
    segmentVec ? rows(() => nearestSegments(id, segmentVec)) : Promise.resolve([]),
    rows(() => movieNeighbors(id)),
  ]);

  console.log(`neighbors: movie ${id} seq ${seq} in ${Date.now() - started}ms`);
  return { line, beat, segment, movie };
}

/** The five closest segment pairs between two films, both sides excerpted. */
export async function bridgePairs(a: number, b: number): Promise<BridgePair[]> {
  return rows(async () => {
    const result = await db.query({
      query: `
        SELECT sa.arc AS arcA, sb.arc AS arcB,
               sa.start_seq AS startSeqA, sb.start_seq AS startSeqB,
               1 - cosineDistance(sa.vec, sb.vec) AS score
        FROM segments AS sa
        CROSS JOIN segments AS sb
        WHERE sa.movie_id = {a:UInt32} AND sb.movie_id = {b:UInt32}
        ORDER BY cosineDistance(sa.vec, sb.vec) ASC
        LIMIT 5
      `,
      query_params: { a, b },
      format: 'JSONEachRow',
    });
    const pairs = (await result.json()) as Array<{
      arcA: number;
      arcB: number;
      startSeqA: number;
      startSeqB: number;
      score: number;
    }>;
    if (pairs.length === 0) return [];

    const sides: MomentNeighbor[] = [];
    for (const pair of pairs) {
      sides.push(
        { movieId: a, startSeq: pair.startSeqA } as MomentNeighbor,
        { movieId: b, startSeq: pair.startSeqB } as MomentNeighbor,
      );
    }
    await fillExcerpts(sides);
    return pairs.map((pair, i) => ({
      ...pair,
      excerptA: sides[i * 2]!.excerpt,
      excerptB: sides[i * 2 + 1]!.excerpt,
    }));
  });
}

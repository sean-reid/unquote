import {
  normalize,
  rrf,
  tokenize,
  type MovieMatch,
  type SearchArm,
  type SearchHit,
  type SearchResponse,
} from '@unquote/shared';
import { db } from './db.js';
import { embedQuery } from './embed.js';

interface MovieRow {
  id: number;
  title: string;
  year: number;
  votes: number;
  poster_path: string | null;
}

interface LineRow {
  movie_id: number;
  seq: number;
  arc: number;
  text: string;
}

const EXACT_LIMIT = 50;
const KEYWORD_LIMIT = 100;
const SEMANTIC_LIMIT = 100;
/** rrf scores top out around 0.05; this keeps verbatim hits above any fusion of fuzzy ones. */
const EXACT_BOOST = 1;
const MOVIE_CACHE_MS = 60_000;

let movieCache: { rows: MovieRow[]; at: number } | null = null;

async function allMovies(): Promise<MovieRow[]> {
  if (movieCache && Date.now() - movieCache.at < MOVIE_CACHE_MS) return movieCache.rows;
  const result = await db.query({
    query: 'SELECT id, title, year, votes, poster_path FROM movies',
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as MovieRow[];
  movieCache = { rows, at: Date.now() };
  return rows;
}

function toMatch(row: MovieRow): MovieMatch {
  return { movieId: row.id, title: row.title, year: row.year, posterPath: row.poster_path };
}

/** A query that is exactly a film title, preferring the most voted on ties. */
async function titleArm(queryNorm: string): Promise<MovieMatch | null> {
  const movies = await allMovies();
  let best: MovieRow | null = null;
  for (const movie of movies) {
    if (normalize(movie.title) !== queryNorm) continue;
    if (!best || movie.votes > best.votes) best = movie;
  }
  return best ? toMatch(best) : null;
}

async function exactArm(queryNorm: string): Promise<LineRow[]> {
  const result = await db.query({
    query: `
      SELECT movie_id, seq, arc, text
      FROM lines
      WHERE positionCaseInsensitive(text_norm, {q:String}) > 0
      ORDER BY length(text_norm) ASC, movie_id, seq
      LIMIT {limit:UInt32}
    `,
    query_params: { q: queryNorm, limit: EXACT_LIMIT },
    format: 'JSONEachRow',
  });
  return (await result.json()) as LineRow[];
}

/**
 * hasToken needles cannot contain separator characters, and ClickHouse's
 * tokenizer splits stored text on apostrophes anyway ("you're" indexes as
 * "you" and "re"), so query tokens get the same split.
 */
function tokenNeedles(tokens: string[]): string[] {
  return tokens.flatMap((token) => token.split("'")).filter((token) => token.length >= 2);
}

async function keywordArm(tokens: string[]): Promise<LineRow[]> {
  const clauses = tokens.map((_, i) => `hasToken(text_norm, {t${i}:String})`).join(' AND ');
  const params: Record<string, string | number> = { limit: KEYWORD_LIMIT };
  tokens.forEach((token, i) => {
    params[`t${i}`] = token;
  });
  const result = await db.query({
    query: `
      SELECT movie_id, seq, arc, text
      FROM lines
      WHERE ${clauses}
      ORDER BY length(text_norm) ASC, movie_id, seq
      LIMIT {limit:UInt32}
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  return (await result.json()) as LineRow[];
}

async function semanticArm(query: string): Promise<LineRow[]> {
  const vec = await embedQuery(query);
  const started = Date.now();
  const result = await db.query({
    query: `
      SELECT movie_id, seq, arc, text, dotProduct(vec, {vec:Array(Float32)}) AS score
      FROM lines
      ORDER BY score DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { vec: Array.from(vec), limit: SEMANTIC_LIMIT },
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as LineRow[];
  console.log(`semantic arm: ${Date.now() - started}ms`);
  return rows;
}

function lineKey(row: LineRow): string {
  return `${row.movie_id}:${row.seq}`;
}

/**
 * Divider position: hits before the largest relative score drop in the top 20.
 * With fewer than four hits everything counts as strong.
 */
function findCliff(scores: number[]): number {
  if (scores.length < 4) return scores.length;
  let cliff = scores.length;
  let biggestDrop = 1;
  const window = Math.min(scores.length - 1, 20);
  for (let i = 0; i < window; i++) {
    const drop = scores[i]! / Math.max(scores[i + 1]!, 1e-9);
    if (drop > biggestDrop) {
      biggestDrop = drop;
      cliff = i + 1;
    }
  }
  return biggestDrop >= 1.5 ? cliff : scores.length;
}

export async function search(query: string): Promise<SearchResponse> {
  const queryNorm = normalize(query);
  const tokens = tokenize(query);
  if (queryNorm.length === 0) {
    return { query, hits: [], strongCount: 0, movie: null };
  }

  const needles = tokenNeedles(tokens);
  const [movie, exact, keyword, semantic] = await Promise.all([
    titleArm(queryNorm),
    exactArm(queryNorm),
    needles.length > 0 ? keywordArm(needles) : Promise.resolve([]),
    semanticArm(query),
  ]);

  const byKey = new Map<string, { row: LineRow; arms: Set<SearchArm> }>();
  const record = (rows: LineRow[], arm: SearchArm) => {
    for (const row of rows) {
      const key = lineKey(row);
      const entry = byKey.get(key) ?? { row, arms: new Set<SearchArm>() };
      entry.arms.add(arm);
      byKey.set(key, entry);
    }
  };
  record(exact, 'exact');
  record(keyword, 'keyword');
  record(semantic, 'semantic');

  const fused = rrf([exact.map(lineKey), keyword.map(lineKey), semantic.map(lineKey)]);

  const movies = await allMovies();
  const movieById = new Map(movies.map((m) => [m.id, m]));

  const hits: SearchHit[] = [];
  for (const [key, entry] of byKey) {
    const meta = movieById.get(entry.row.movie_id);
    if (!meta) continue;
    let score = fused.get(key) ?? 0;
    if (entry.arms.has('exact')) score += EXACT_BOOST;
    score += Math.log10(1 + meta.votes) / 1e5;
    hits.push({
      movieId: entry.row.movie_id,
      title: meta.title,
      year: meta.year,
      posterPath: meta.poster_path,
      seq: entry.row.seq,
      arc: entry.row.arc,
      text: entry.row.text,
      score,
      arms: [...entry.arms],
      occurrences: 1,
    });
  }
  hits.sort((a, b) => b.score - a.score);

  // A film often repeats a line ("May the Force be with you" four times in one
  // movie). Collapse identical text within a film to its best occurrence.
  const seen = new Map<string, SearchHit>();
  const deduped: SearchHit[] = [];
  for (const hit of hits) {
    const key = `${hit.movieId}:${normalize(hit.text)}`;
    const first = seen.get(key);
    if (first) {
      first.occurrences += 1;
      continue;
    }
    seen.set(key, hit);
    deduped.push(hit);
  }
  const top = deduped.slice(0, 50);

  return {
    query,
    hits: top,
    strongCount: findCliff(top.map((h) => h.score)),
    movie,
  };
}

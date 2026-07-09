import {
  diffStats,
  normalize,
  rrf,
  tokenize,
  type MisquoteMatch,
  type MovieMatch,
  type PhraseStats,
  type SearchArm,
  type SearchHit,
  type SearchResponse,
} from '@unquote/shared';
import { db } from './db.js';
import { embedQuery, embedQueryWide, WIDE_EMBED_DIM } from './embed.js';
import misquoteEntries from './misquotes.json' with { type: 'json' };

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
/** Distinct films required before a phrase earns its statistics card. */
const PHRASE_MIN_FILMS = 8;

const misquotesByQuery = new Map<string, MisquoteMatch>(
  (misquoteEntries as MisquoteMatch[]).map((entry) => [normalize(entry.popular), entry]),
);
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

/** Indexed film count for the corpus banner; 0 when the database is unreachable. */
export async function movieCount(): Promise<number> {
  try {
    return (await allMovies()).length;
  } catch {
    return 0;
  }
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
      SELECT l.movie_id AS movie_id, l.seq AS seq, l.arc AS arc, l.text AS text
      FROM lines AS l
      INNER JOIN movies AS m ON m.id = l.movie_id
      WHERE position(l.text_norm, {q:String}) > 0
      ORDER BY m.votes DESC, length(l.text_norm) ASC, l.movie_id, l.seq
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
  const clauses = tokens.map((_, i) => `hasToken(l.text_norm, {t${i}:String})`).join(' AND ');
  const params: Record<string, string | number> = { limit: KEYWORD_LIMIT };
  tokens.forEach((token, i) => {
    params[`t${i}`] = token;
  });
  const result = await db.query({
    query: `
      SELECT l.movie_id AS movie_id, l.seq AS seq, l.arc AS arc, l.text AS text
      FROM lines AS l
      INNER JOIN movies AS m ON m.id = l.movie_id
      WHERE ${clauses}
      ORDER BY m.votes DESC, length(l.text_norm) ASC, l.movie_id, l.seq
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
  // cosineDistance ascending is the form the HNSW index accelerates; on
  // normalized vectors it ranks identically to dot product descending.
  const result = await db.query({
    query: `
      SELECT movie_id, seq, arc, text
      FROM lines
      ORDER BY cosineDistance(vec, {vec:Array(Float32)}) ASC
      LIMIT {limit:UInt32}
    `,
    query_params: { vec: Array.from(vec), limit: SEMANTIC_LIMIT },
    format: 'JSONEachRow',
    clickhouse_settings: { allow_experimental_vector_similarity_index: 1 },
  });
  const rows = (await result.json()) as LineRow[];
  console.log(`semantic arm: ${Date.now() - started}ms`);
  return rows;
}

interface BeatRow {
  movie_id: number;
  start_seq: number;
  arc: number;
  text: string;
}

let beatsUsable: boolean | null = null;
let beatsProbeWarned = false;

/** Beats join the search only when their vectors share the query encoder's dims. */
async function beatsAvailable(): Promise<boolean> {
  if (beatsUsable !== null) return beatsUsable;
  try {
    const result = await db.query({
      query: 'SELECT length(vec) AS dim FROM beats LIMIT 1',
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ dim: number }>;
    beatsUsable = rows[0]?.dim === WIDE_EMBED_DIM;
    if (rows.length > 0 && !beatsUsable) {
      console.log(`beats disabled for search: dim ${rows[0]!.dim} != ${WIDE_EMBED_DIM}`);
    }
  } catch (error) {
    // A missing or unreadable table degrades the arm; without this line it
    // degrades invisibly and looks like bad ranking.
    if (!beatsProbeWarned) {
      beatsProbeWarned = true;
      console.warn('beats arm disabled:', error instanceof Error ? error.message : error);
    }
    beatsUsable = null;
    return false;
  }
  return beatsUsable ?? false;
}

/**
 * Descriptive queries and lines that split across cues live at exchange
 * width; when nothing matches verbatim, nearby beats fill the gap.
 */
async function beatsArm(query: string): Promise<Array<BeatRow & { dist: number }>> {
  if (!(await beatsAvailable())) return [];
  const vec = await embedQueryWide(query);
  const result = await db.query({
    query: `
      SELECT movie_id, start_seq, arc, text,
             cosineDistance(vec, {vec:Array(Float32)}) AS dist
      FROM beats
      ORDER BY dist ASC
      LIMIT 24
    `,
    query_params: { vec: Array.from(vec) },
    format: 'JSONEachRow',
    clickhouse_settings: { allow_experimental_vector_similarity_index: 1 },
  });
  return (await result.json()) as Array<BeatRow & { dist: number }>;
}

let summariesUsable: boolean | null = null;
let summariesProbeWarned = false;

/** Summary vectors join the search once the table has embedded rows. */
async function summariesAvailable(): Promise<boolean> {
  if (summariesUsable !== null) return summariesUsable;
  try {
    const result = await db.query({
      query: 'SELECT length(vec) AS dim FROM summary_vectors LIMIT 1',
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ dim: number }>;
    summariesUsable = rows[0]?.dim === WIDE_EMBED_DIM;
  } catch (error) {
    if (!summariesProbeWarned) {
      summariesProbeWarned = true;
      console.warn('summaries arm disabled:', error instanceof Error ? error.message : error);
    }
    summariesUsable = null;
    return false;
  }
  return summariesUsable ?? false;
}

/**
 * A described scene matches the summary layer in its own register: summaries
 * are event-phrased the way memories are, where dialogue only shares words
 * with a memory by luck. Hits come back as the verbatim dialogue of the beat
 * opening the summarized span, so ranking uses the summary but the screen
 * only ever shows lines from the film.
 */
async function summariesArm(query: string): Promise<Array<BeatRow & { dist: number }>> {
  if (!(await summariesAvailable())) return [];
  const vec = await embedQueryWide(query);
  const result = await db.query({
    query: `
      SELECT movie_id, start_seq, end_seq,
             cosineDistance(vec, {vec:Array(Float32)}) AS dist
      FROM summary_vectors
      WHERE movie_id NOT IN (
        SELECT movie_id FROM movie_quality WHERE non_english = 1 OR downrank = 1
      )
      ORDER BY dist ASC
      LIMIT 24
    `,
    query_params: { vec: Array.from(vec) },
    format: 'JSONEachRow',
    clickhouse_settings: { allow_experimental_vector_similarity_index: 1 },
  });
  const spans = (await result.json()) as Array<{
    movie_id: number;
    start_seq: number;
    end_seq: number;
    dist: number;
  }>;
  const byFilm = new Map<number, { start_seq: number; end_seq: number; dist: number }>();
  for (const span of spans) {
    if (!byFilm.has(span.movie_id)) byFilm.set(span.movie_id, span);
  }
  const films = [...byFilm.entries()].slice(0, 12);
  const beats = await Promise.all(
    films.map(async ([movieId, span]) => {
      const overlap = await db.query({
        query: `
          SELECT movie_id, start_seq, arc, text
          FROM beats
          WHERE movie_id = {id:UInt32} AND end_seq >= {s:UInt32} AND start_seq <= {e:UInt32}
          ORDER BY idx ASC
          LIMIT 1
        `,
        query_params: { id: movieId, s: span.start_seq, e: span.end_seq },
        format: 'JSONEachRow',
      });
      const rows = (await overlap.json()) as BeatRow[];
      return rows[0] ? { ...rows[0], dist: span.dist } : null;
    }),
  );
  return beats.filter((row): row is BeatRow & { dist: number } => row !== null);
}

interface PhraseRow {
  films: number;
  occurrences: number;
  first_year: number;
  first_title: string;
  arc_map: Record<string, string>;
  decade_map: Record<string, string>;
}

/** Corpus-wide statistics for a phrase already known to have exact matches. */
async function phraseStats(queryNorm: string): Promise<PhraseStats | null> {
  const started = Date.now();
  const result = await db.query({
    query: `
      SELECT
        uniqExact(l.movie_id) AS films,
        count() AS occurrences,
        min(m.year) AS first_year,
        argMin(m.title, m.year) AS first_title,
        sumMap(map(least(toUInt8(floor(l.arc * 10)), 9), toUInt64(1))) AS arc_map,
        uniqExactMap(map(m.decade, l.movie_id)) AS decade_map
      FROM lines AS l
      INNER JOIN movies AS m ON m.id = l.movie_id
      WHERE position(l.text_norm, {q:String}) > 0
    `,
    query_params: { q: queryNorm },
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as PhraseRow[];
  console.log(`phrase card: ${Date.now() - started}ms`);
  const row = rows[0];
  if (!row || Number(row.films) < PHRASE_MIN_FILMS) return null;

  const arcBuckets = new Array<number>(10).fill(0);
  for (const [bucket, count] of Object.entries(row.arc_map)) {
    arcBuckets[Number(bucket)] = Number(count);
  }
  // Normalize by corpus coverage: raw counts would show every phrase "rising"
  // simply because recent decades have more films. Zero-fill the full corpus
  // range so absent decades read as absence, not as a shorter timeline.
  const corpusByDecade = new Map<number, number>();
  for (const movie of await allMovies()) {
    const decade = Math.floor(movie.year / 10) * 10;
    corpusByDecade.set(decade, (corpusByDecade.get(decade) ?? 0) + 1);
  }
  const allDecades = [...corpusByDecade.keys()].sort((a, b) => a - b);
  const filmsByDecade = new Map(
    Object.entries(row.decade_map).map(([decade, films]) => [Number(decade), Number(films)]),
  );
  const decades = allDecades.map((decade) => {
    const films = filmsByDecade.get(decade) ?? 0;
    const corpusFilms = corpusByDecade.get(decade) ?? 0;
    return { decade, films, corpusFilms, share: corpusFilms ? films / corpusFilms : 0 };
  });

  return {
    films: Number(row.films),
    occurrences: Number(row.occurrences),
    firstTitle: row.first_title,
    firstYear: Number(row.first_year),
    arcBuckets,
    decades,
  };
}

/**
 * The top hit reads like what the user was trying to remember when it came
 * from the semantic arm alone and sits a few word swaps away from the query.
 */
function markNearMiss(queryNorm: string, top: SearchHit[]): void {
  const first = top[0];
  if (!first) return;
  // A word diff against a multi-speaker exchange is meaningless.
  if (first.moment) return;
  if (first.arms.length !== 1 || first.arms[0] !== 'semantic') return;
  const stats = diffStats(queryNorm, normalize(first.text));
  if (
    stats.substitutions >= 1 &&
    stats.substitutions <= 3 &&
    stats.extras <= 2 &&
    stats.sharedRatio >= 0.6
  ) {
    first.nearMiss = true;
  }
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
  try {
    return await searchInner(query);
  } catch (error) {
    // A database mid-load or mid-swap answers with empty results, not a 500;
    // the page pairs this with the library-loading notice when films read 0.
    console.error('search degraded:', error instanceof Error ? error.message : error);
    return { query, hits: [], strongCount: 0, movie: null, misquote: null, phrase: null };
  }
}

async function searchInner(query: string): Promise<SearchResponse> {
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
  // Identical lines embed identically, so among films sharing a verbatim
  // match every arm's ordering is an arbitrary tie-break; fame is the only
  // real signal left and it orders the exact set. The originator of a line
  // (Terminator for "I'll be back") is cultural knowledge no ranking can
  // recover; the curated signature-line badge carries that instead. Fuzzy
  // hits keep pure score order so descriptive queries are never steamrolled.
  const isExact = (hit: SearchHit): boolean => hit.arms.includes('exact');
  const votesOf = (hit: SearchHit): number => movieById.get(hit.movieId)?.votes ?? 0;
  hits.sort((a, b) => {
    if (isExact(a) && isExact(b)) return votesOf(b) - votesOf(a) || b.score - a.score;
    return b.score - a.score;
  });

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
  let top = deduped.slice(0, 50);

  // With no verbatim match the query is a memory of meaning, not of words
  // (a described scene, or a line split across speakers). Scene-width beats
  // are the right unit for that, so they join as a first-class arm weighted
  // to outrank word-coincidence lines: a top beat scores above a line that
  // merely shares vocabulary with the query across two arms.
  if (exact.length === 0) {
    const DESCRIPTIVE_BEAT_WEIGHT = 1.8;
    const MAX_UTTERANCES = 4;
    // Beats and summaries embed in the same space against the same query
    // vector, so their cosine distances are directly comparable: one merged
    // list ordered by distance, no per-arm weighting. A film the summary
    // store has not reached yet competes through its beats on equal terms,
    // which matters while generation is still filling the store.
    const [beats, summaryBeats] = await Promise.all([beatsArm(query), summariesArm(query)]);
    const momentRows = [...summaryBeats, ...beats].sort((a, b) => a.dist - b.dist);
    const beatHits: SearchHit[] = [];
    const filmSeen = new Set<number>();
    for (const [rank, row] of momentRows.entries()) {
      const meta = movieById.get(row.movie_id);
      if (!meta) continue;
      // Overlapping windows make adjacent beats near-duplicates; one per film.
      if (filmSeen.has(row.movie_id)) continue;
      filmSeen.add(row.movie_id);
      const utterances = row.text.split('\n').filter((line) => line.trim().length > 0);
      // Cap at four rendered lines; when cut, the fourth slot is the ellipsis
      // so truncation is always visible and never lands mid-utterance.
      const shown =
        utterances.length > MAX_UTTERANCES
          ? [...utterances.slice(0, MAX_UTTERANCES - 1), '\u2026']
          : utterances;
      beatHits.push({
        movieId: row.movie_id,
        title: meta.title,
        year: meta.year,
        posterPath: meta.poster_path,
        seq: row.start_seq,
        arc: row.arc,
        text: shown.join('\n'),
        score: DESCRIPTIVE_BEAT_WEIGHT / (60 + rank + 1),
        arms: ['semantic'],
        occurrences: 1,
        moment: true,
      });
    }
    const known = new Set(top.map((hit) => `${hit.movieId}:${hit.seq}`));
    top = top
      .concat(beatHits.filter((hit) => !known.has(`${hit.movieId}:${hit.seq}`)))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }

  const misquote = misquotesByQuery.get(queryNorm) ?? null;
  if (!misquote) markNearMiss(queryNorm, top);

  // Raw exact rows cap at EXACT_LIMIT, so use them only as a cheap gate; the
  // aggregate counts every occurrence corpus-wide.
  const phrase =
    exact.length >= PHRASE_MIN_FILMS && !misquote ? await phraseStats(queryNorm) : null;

  return {
    query,
    hits: top,
    strongCount: findCliff(top.map((h) => h.score)),
    movie,
    misquote,
    phrase,
  };
}

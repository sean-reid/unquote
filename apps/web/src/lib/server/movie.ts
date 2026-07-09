import type { MomentNeighbor } from '@unquote/shared';
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
const MOVIE_META_MS = 60_000;

interface MovieMeta {
  id: number;
  title: string;
  year: number;
  poster_path: string | null;
}

let movieMetaCache: { byId: Map<number, MovieMeta>; at: number } | null = null;

/**
 * Joining movies inside the HNSW queries forces ClickHouse to abandon the
 * vector index and scan; hydrating titles from this small in-memory map keeps
 * every nearest-x query on the index path.
 */
async function movieMeta(): Promise<Map<number, MovieMeta>> {
  if (movieMetaCache && Date.now() - movieMetaCache.at < MOVIE_META_MS) return movieMetaCache.byId;
  const result = await db.query({
    query: 'SELECT id, title, year, poster_path FROM movies',
    format: 'JSONEachRow',
  });
  const metas = (await result.json()) as MovieMeta[];
  movieMetaCache = { byId: new Map(metas.map((m) => [m.id, m])), at: Date.now() };
  return movieMetaCache.byId;
}
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
        SELECT s.idx AS idx, s.start_seq AS startSeq, s.end_seq AS endSeq, s.arc AS arc
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

export type ExpandableNeighbor = MomentNeighbor & {
  /** Fuller subtitle-style excerpt for the in-place preview, capped server-side. */
  expandedLines: string[];
};

function toNeighbor(row: NeighborRow): ExpandableNeighbor {
  return {
    movieId: row.movie_id,
    title: row.title,
    year: row.year,
    posterPath: row.poster_path,
    arc: row.arc,
    excerpt: clip(row.excerpt),
    startSeq: row.start_seq,
    score: row.score,
    expandedLines: [],
  };
}

interface BareNeighborRow {
  movie_id: number;
  arc: number;
  start_seq: number;
  excerpt: string;
  score: number;
}

async function hydrate(rows: BareNeighborRow[]): Promise<ExpandableNeighbor[]> {
  const metas = await movieMeta();
  return rows.flatMap((row) => {
    const meta = metas.get(row.movie_id);
    if (!meta) return [];
    return [
      toNeighbor({
        ...row,
        title: meta.title,
        year: meta.year,
        poster_path: meta.poster_path,
      }),
    ];
  });
}

/** First lines of a newline-joined text, breaks preserved for subtitle rendering. */
function excerptLines(text: string, lines = EXCERPT_LINES): string {
  return clip(text.split('\n').slice(0, lines).join('\n'));
}

async function nearestBeats(id: number, vec: number[]): Promise<ExpandableNeighbor[]> {
  const result = await db.query({
    query: `
      SELECT movie_id, arc, start_seq, text AS excerpt,
             1 - cosineDistance(vec, {vec:Array(Float32)}) AS score
      FROM beats
      WHERE movie_id != {id:UInt32}
        AND movie_id NOT IN (SELECT movie_id FROM movie_quality WHERE non_english = 1 OR downrank = 1)
      ORDER BY cosineDistance(vec, {vec:Array(Float32)}) ASC
      LIMIT 16
    `,
    query_params: { id, vec },
    format: 'JSONEachRow',
    clickhouse_settings: HNSW,
  });
  const neighbors = dedupeByFilm(await hydrate((await result.json()) as BareNeighborRow[]), 8);
  for (const n of neighbors) {
    n.expandedLines = n.excerpt.split('\n').filter(Boolean).slice(0, SOURCE_MAX_LINES);
    n.excerpt = excerptLines(n.excerpt);
  }
  return neighbors;
}

/** One neighbor per film, best first; variety beats near-duplicates in a short list. */
function dedupeByFilm(neighbors: ExpandableNeighbor[], keep: number): ExpandableNeighbor[] {
  const seen = new Set<number>();
  const out: ExpandableNeighbor[] = [];
  for (const neighbor of neighbors) {
    if (seen.has(neighbor.movieId)) continue;
    seen.add(neighbor.movieId);
    out.push(neighbor);
    if (out.length === keep) break;
  }
  return out;
}

/** Hard bound on how much of a scene one request may reveal. */
const SOURCE_MAX_LINES = 25;

interface SpanRow {
  start_seq: number;
  end_seq: number;
  text: string;
  vec: number[];
}

/**
 * Windows overlap by construction (segments inherit beat stride), so plain
 * containment picks the EARLIER overlapping window and every click lands one
 * part back. Resolution is by nearest midpoint among containers, or by exact
 * idx when the client says which block it clicked.
 */
async function spanOf(
  table: 'beats' | 'segments',
  id: number,
  seq: number,
  idx: number | null = null,
): Promise<SpanRow | null> {
  const byIdx = idx !== null && table === 'segments';
  const found = await rows(async () => {
    const result = await db.query({
      query: byIdx
        ? `SELECT start_seq, end_seq, '' AS text, vec FROM segments
           WHERE movie_id = {id:UInt32} AND idx = {idx:UInt32} LIMIT 1`
        : `SELECT start_seq, end_seq, ${table === 'beats' ? 'text' : "'' AS text"}, vec
           FROM ${table}
           WHERE movie_id = {id:UInt32} AND start_seq <= {seq:UInt32} AND end_seq >= {seq:UInt32}
           ORDER BY abs(toInt64(start_seq + end_seq) - 2 * {seq:Int64}) ASC
           LIMIT 1`,
      query_params: { id, seq, idx: idx ?? 0 },
      format: 'JSONEachRow',
    });
    return (await result.json()) as SpanRow[];
  });
  return found[0] ?? null;
}

async function segmentSourceLines(
  id: number,
  span: SpanRow,
): Promise<{ lines: string[]; totalLines: number }> {
  const capEnd = Math.min(span.start_seq + SOURCE_MAX_LINES - 1, span.end_seq);
  const found = await rows(async () => {
    const result = await db.query({
      query: `SELECT text FROM lines
              WHERE movie_id = {id:UInt32} AND seq >= {s:UInt32} AND seq <= {e:UInt32}
              ORDER BY seq`,
      query_params: { id, s: span.start_seq, e: capEnd },
      format: 'JSONEachRow',
    });
    return (await result.json()) as Array<{ text: string }>;
  });
  return { lines: found.map((r) => r.text), totalLines: span.end_seq - span.start_seq + 1 };
}

export interface SceneSummary {
  headline: string;
  summary: string;
}

/** What the panel shows for one selected scene. */
export interface ScenePanel {
  /** Generated scene summary; null until the store covers this scene. */
  summary: SceneSummary | null;
  /** The scene's own dialogue, capped server-side. */
  evidence: { lines: string[]; totalLines: number };
  moments: ExpandableNeighbor[];
}

/**
 * Summaries are keyed by the exact segment span they were generated from;
 * a scene the store has not reached yet simply has no row.
 */
async function sceneSummary(
  id: number,
  startSeq: number,
  endSeq: number,
): Promise<SceneSummary | null> {
  const found = await rows(async () => {
    const result = await db.query({
      query: `
        SELECT headline, summary FROM scene_summaries
        WHERE movie_id = {id:UInt32} AND start_seq = {s:UInt32} AND end_seq = {e:UInt32}
        LIMIT 1
      `,
      query_params: { id, s: startSeq, e: endSeq },
      format: 'JSONEachRow',
    });
    return (await result.json()) as SceneSummary[];
  });
  return found[0] ?? null;
}

/**
 * One selected scene, one request: its summary when generated, its dialogue
 * as evidence, and the closest moments across the library. Moments match at
 * beat width, the sharpest signal the ladder has (segment vectors average
 * a whole scene into mush; bridges use beats for the same reason).
 */
export async function scenePanel(
  id: number,
  seq: number,
  segmentIdx: number | null = null,
): Promise<ScenePanel | null> {
  const started = Date.now();
  const segmentSpan = await spanOf('segments', id, seq, segmentIdx);
  // Inside an explicit block selection, the beat is the one at its center.
  const beatSeq = segmentSpan ? Math.floor((segmentSpan.start_seq + segmentSpan.end_seq) / 2) : seq;
  const beatSpan = await spanOf('beats', id, segmentIdx !== null ? beatSeq : seq);

  const [summary, moments, segmentSource, lineRows] = await Promise.all([
    segmentSpan
      ? sceneSummary(id, segmentSpan.start_seq, segmentSpan.end_seq)
      : Promise.resolve(null),
    beatSpan ? rows(() => nearestBeats(id, beatSpan.vec)) : Promise.resolve([]),
    segmentSpan ? segmentSourceLines(id, segmentSpan) : Promise.resolve(null),
    segmentSpan || beatSpan
      ? Promise.resolve([])
      : rows(async () => {
          const result = await db.query({
            query:
              'SELECT text FROM lines WHERE movie_id = {id:UInt32} AND seq = {seq:UInt32} LIMIT 1',
            query_params: { id, seq },
            format: 'JSONEachRow',
          });
          return (await result.json()) as Array<{ text: string }>;
        }),
  ]);

  const evidence = segmentSource
    ? { lines: segmentSource.lines, totalLines: segmentSource.totalLines }
    : beatSpan
      ? (() => {
          const lines = beatSpan.text.split('\n').filter(Boolean);
          return { lines, totalLines: lines.length };
        })()
      : { lines: lineRows.map((r) => r.text), totalLines: lineRows.length };
  if (evidence.lines.length === 0) return null;

  console.log(`panel: movie ${id} seq ${seq} in ${Date.now() - started}ms`);
  return { summary, evidence, moments };
}

/**
 * Bridge matching runs at beat width: beat vectors are sharper than averaged
 * segments, and the displayed excerpt is then the matching moment itself.
 * Genericness (a beat's mean similarity to its closest cross-corpus
 * neighbors, computed in the pipeline) is subtracted so universal filler
 * cannot win; greedy one-to-one assignment stops magnet moments repeating;
 * pairs below the strength bar are dropped entirely, and an empty result is
 * rendered honestly rather than padded with mush.
 */
// Tuned against fixture pairs with live genericness values: 0.75 separates
// distinctive thematic matches from common genre texture; 0.30 lets related
// war/mob/sci-fi pairs through while unrelated films (Toy Story vs Se7en)
// honestly show nothing.
const BRIDGE_LAMBDA = 0.75;
/**
 * Pairs must beat the two films' AMBIENT cross-similarity by this much. Same
 * franchise films share names, idiom, and character voice, so their raw
 * scores run high everywhere; thresholding the excess over ambient keeps
 * franchise texture out while real parallels still clear the bar. Mirrored by
 * BRIDGE_EXCESS_THRESHOLD in the vs page's stroke mapping.
 */
const BRIDGE_EXCESS_THRESHOLD = 0.16;
/** Above this ambient, two films sound alike throughout; the empty state says so. */
export const BRIDGE_HIGH_AMBIENT = 0.22;
const BRIDGE_PAIRS = 5;

interface BridgeBeat {
  idx: number;
  start_seq: number;
  arc: number;
  text: string;
  vec: number[];
  generic: number;
}

let beatsHaveGeneric: boolean | null = null;

async function bridgeBeats(movieId: number): Promise<BridgeBeat[]> {
  if (beatsHaveGeneric === null) {
    const probe = await db.query({
      query:
        "SELECT count() AS n FROM system.columns WHERE database = currentDatabase() AND table = 'beats' AND name = 'generic'",
      format: 'JSONEachRow',
    });
    beatsHaveGeneric = Number(((await probe.json()) as Array<{ n: string | number }>)[0]?.n) > 0;
  }
  const genericExpr = beatsHaveGeneric ? 'generic' : '0 AS generic';
  const result = await db.query({
    query: `SELECT idx, start_seq, arc, text, vec, ${genericExpr} FROM beats WHERE movie_id = {id:UInt32} ORDER BY idx`,
    query_params: { id: movieId },
    format: 'JSONEachRow',
  });
  return (await result.json()) as BridgeBeat[];
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export interface BridgeResult {
  pairs: BridgePair[];
  /** Mean adjusted cross-similarity of the two films: how alike they sound overall. */
  ambient: number;
}

const EMPTY_BRIDGE: BridgeResult = { pairs: [], ambient: 0 };

export async function bridgePairs(a: number, b: number): Promise<BridgeResult> {
  const result = await rows(async () => {
    // A wrong-language transcript matches its own language, not meaning; a
    // bridge with such a film shows the distance state rather than noise.
    const flagged = await db.query({
      query:
        'SELECT count() AS n FROM movie_quality WHERE movie_id IN ({a:UInt32}, {b:UInt32}) AND non_english = 1',
      query_params: { a, b },
      format: 'JSONEachRow',
    });
    if (Number(((await flagged.json()) as Array<{ n: string | number }>)[0]?.n) > 0) {
      return [EMPTY_BRIDGE];
    }

    const [beatsA, beatsB] = await Promise.all([bridgeBeats(a), bridgeBeats(b)]);
    if (beatsA.length === 0 || beatsB.length === 0) return [EMPTY_BRIDGE];

    const adjusted = (beatA: BridgeBeat, beatB: BridgeBeat): number =>
      dot(beatA.vec, beatB.vec) - (BRIDGE_LAMBDA * (beatA.generic + beatB.generic)) / 2;

    // One pass over the full cross product: keep every adjusted score plus
    // per-beat means. A real parallel is a spike above what its beat scores
    // against the whole other film; franchise texture is a plateau, high
    // everywhere and peaked nowhere.
    const nA = beatsA.length;
    const nB = beatsB.length;
    const cross = new Float32Array(nA * nB);
    const meanA = new Float64Array(nA);
    const meanB = new Float64Array(nB);
    let ambientSum = 0;
    for (let ia = 0; ia < nA; ia++) {
      const beatA = beatsA[ia]!;
      for (let ib = 0; ib < nB; ib++) {
        const score = adjusted(beatA, beatsB[ib]!);
        cross[ia * nB + ib] = score;
        meanA[ia] = (meanA[ia] ?? 0) + score;
        meanB[ib] = (meanB[ib] ?? 0) + score;
        ambientSum += score;
      }
    }
    for (let ia = 0; ia < nA; ia++) meanA[ia] = meanA[ia]! / nB;
    for (let ib = 0; ib < nB; ib++) meanB[ib] = meanB[ib]! / nA;
    const ambient = nA * nB > 0 ? ambientSum / (nA * nB) : 0;

    interface Scored {
      ia: number;
      ib: number;
      strength: number;
    }
    // Contrast gates texture out; adjusted strength ranks what remains, so a
    // universally resonant opening still beats a merely spiky exchange.
    const scored: Scored[] = [];
    for (let ia = 0; ia < nA; ia++) {
      for (let ib = 0; ib < nB; ib++) {
        const score = cross[ia * nB + ib]!;
        const contrast = score - (meanA[ia]! + meanB[ib]!) / 2;
        if (contrast >= BRIDGE_EXCESS_THRESHOLD) scored.push({ ia, ib, strength: score });
      }
    }
    scored.sort((x, y) => y.strength - x.strength);

    const usedA = new Set<number>();
    const usedB = new Set<number>();
    const picked: Scored[] = [];
    for (const pair of scored) {
      if (usedA.has(pair.ia) || usedB.has(pair.ib)) continue;
      usedA.add(pair.ia);
      usedB.add(pair.ib);
      picked.push(pair);
      if (picked.length === BRIDGE_PAIRS) break;
    }

    // A single passing pair is always the dregs of the distribution; the
    // honest empty state reads better than one weak ribbon.
    if (picked.length < 2) picked.length = 0;

    const excerptOf = (text: string): string =>
      clip(text.split('\n').slice(0, EXCERPT_LINES).join(' '));
    console.log(`bridge ${a} vs ${b}: ambient ${ambient.toFixed(3)}, ${picked.length} pairs`);
    const pairs = picked.map((pair) => {
      const beatA = beatsA[pair.ia]!;
      const beatB = beatsB[pair.ib]!;
      return {
        arcA: beatA.arc,
        arcB: beatB.arc,
        startSeqA: beatA.start_seq,
        startSeqB: beatB.start_seq,
        excerptA: excerptOf(beatA.text),
        excerptB: excerptOf(beatB.text),
        score: pair.strength,
      };
    });
    return [{ pairs, ambient }];
  });
  return result[0] ?? EMPTY_BRIDGE;
}

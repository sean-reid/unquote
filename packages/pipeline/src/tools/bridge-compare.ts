/**
 * Head-to-head harness for bridge pairing: the shipped beat-only algorithm
 * against summary-space candidates corroborated by dialogue consensus. Both
 * run on the same film pairs from local ClickHouse and print side by side so
 * the comparison is judged on real output, not theory. Thresholds are flags,
 * so tuning sessions leave a paper trail in the command line.
 *
 * Run: tsx src/tools/bridge-compare.ts [--pairs a:b,c:d] [--sumex 0.1]
 *      [--consensus 0.55] [--verbose]
 */
import { createClient } from '@clickhouse/client';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    pairs: { type: 'string' },
    sumex: { type: 'string', default: '0.05' },
    smin: { type: 'string', default: '0.25' },
    consensus: { type: 'string', default: '0.28' },
    lambda: { type: 'string', default: '0.75' },
    verbose: { type: 'boolean', default: false },
  },
});

const SUMMARY_EXCESS = Number(args.sumex);
const STRENGTH_MIN = Number(args.smin);
const CONSENSUS_MIN = Number(args.consensus);
const LAMBDA = Number(args.lambda);
const BRIDGE_EXCESS_THRESHOLD = 0.16;
const BRIDGE_PAIRS = 5;

const db = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'unquote-local',
  database: 'unquote',
});

interface Beat {
  idx: number;
  start_seq: number;
  arc: number;
  text: string;
  vec: number[];
  generic: number;
}

interface Win {
  start_seq: number;
  end_seq: number;
  vec: number[];
  generic: number;
  headline: string;
}

async function rows<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
  const result = await db.query({ query, query_params: params, format: 'JSONEachRow' });
  return (await result.json()) as T[];
}

const beatsOf = (id: number) =>
  rows<Beat>(
    'SELECT idx, start_seq, arc, text, vec, generic FROM beats WHERE movie_id = {id:UInt32} ORDER BY idx',
    { id },
  );

const winsOf = (id: number) =>
  rows<Win>(
    `SELECT sv.start_seq AS start_seq, sv.end_seq AS end_seq, sv.vec AS vec, sv.generic AS generic,
            any(ss.headline) AS headline
     FROM summary_vectors sv
     LEFT JOIN scene_summaries ss
       ON ss.movie_id = sv.movie_id AND ss.start_seq = sv.start_seq AND ss.end_seq = sv.end_seq
     WHERE sv.movie_id = {id:UInt32}
     GROUP BY sv.start_seq, sv.end_seq, sv.vec, sv.generic
     ORDER BY sv.start_seq`,
    { id },
  );

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

interface Pick {
  arcA: number;
  arcB: number;
  excerptA: string;
  excerptB: string;
  labelA?: string;
  labelB?: string;
  strength: number;
  contrast: number;
  consensus?: number;
}

interface Outcome {
  pairs: Pick[];
  ambient: number;
}

const excerptOf = (text: string): string =>
  text.split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 110);

/** The shipped algorithm, copied faithfully from movie.ts bridgePairs. */
function beatBridge(beatsA: Beat[], beatsB: Beat[]): Outcome {
  const nA = beatsA.length;
  const nB = beatsB.length;
  const cross = new Float32Array(nA * nB);
  const meanA = new Float64Array(nA);
  const meanB = new Float64Array(nB);
  let ambientSum = 0;
  for (let ia = 0; ia < nA; ia++) {
    for (let ib = 0; ib < nB; ib++) {
      const score =
        dot(beatsA[ia]!.vec, beatsB[ib]!.vec) -
        (LAMBDA * (beatsA[ia]!.generic + beatsB[ib]!.generic)) / 2;
      cross[ia * nB + ib] = score;
      meanA[ia] = (meanA[ia] ?? 0) + score;
      meanB[ib] = (meanB[ib] ?? 0) + score;
      ambientSum += score;
    }
  }
  for (let ia = 0; ia < nA; ia++) meanA[ia] = meanA[ia]! / nB;
  for (let ib = 0; ib < nB; ib++) meanB[ib] = meanB[ib]! / nA;
  const ambient = nA * nB > 0 ? ambientSum / (nA * nB) : 0;

  const scored: Array<{ ia: number; ib: number; strength: number; contrast: number }> = [];
  for (let ia = 0; ia < nA; ia++) {
    for (let ib = 0; ib < nB; ib++) {
      const score = cross[ia * nB + ib]!;
      const contrast = score - (meanA[ia]! + meanB[ib]!) / 2;
      if (contrast >= BRIDGE_EXCESS_THRESHOLD) {
        scored.push({ ia, ib, strength: score, contrast });
      }
    }
  }
  scored.sort((x, y) => y.strength - x.strength);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const picked: typeof scored = [];
  for (const pair of scored) {
    if (usedA.has(pair.ia) || usedB.has(pair.ib)) continue;
    usedA.add(pair.ia);
    usedB.add(pair.ib);
    picked.push(pair);
    if (picked.length === BRIDGE_PAIRS) break;
  }
  if (picked.length < 2) picked.length = 0;
  return {
    ambient,
    pairs: picked.map((p) => ({
      arcA: beatsA[p.ia]!.arc,
      arcB: beatsB[p.ib]!.arc,
      excerptA: excerptOf(beatsA[p.ia]!.text),
      excerptB: excerptOf(beatsB[p.ib]!.text),
      strength: p.strength,
      contrast: p.contrast,
    })),
  };
}

/** Candidates from summary space, kept only when in-span dialogue agrees. */
function consensusBridge(winsA: Win[], winsB: Win[], beatsA: Beat[], beatsB: Beat[]): Outcome {
  const nA = winsA.length;
  const nB = winsB.length;
  if (nA === 0 || nB === 0) return { pairs: [], ambient: 0 };
  const cross = new Float32Array(nA * nB);
  const meanA = new Float64Array(nA);
  const meanB = new Float64Array(nB);
  let ambientSum = 0;
  for (let ia = 0; ia < nA; ia++) {
    for (let ib = 0; ib < nB; ib++) {
      const score =
        dot(winsA[ia]!.vec, winsB[ib]!.vec) -
        (LAMBDA * (winsA[ia]!.generic + winsB[ib]!.generic)) / 2;
      cross[ia * nB + ib] = score;
      meanA[ia] = (meanA[ia] ?? 0) + score;
      meanB[ib] = (meanB[ib] ?? 0) + score;
      ambientSum += score;
    }
  }
  for (let ia = 0; ia < nA; ia++) meanA[ia] = meanA[ia]! / nB;
  for (let ib = 0; ib < nB; ib++) meanB[ib] = meanB[ib]! / nA;
  const ambient = ambientSum / (nA * nB);

  const inSpan = (beats: Beat[], win: Win) =>
    beats.filter((beat) => beat.start_seq >= win.start_seq && beat.start_seq <= win.end_seq);

  const candidates: Array<{ ia: number; ib: number; strength: number; contrast: number }> = [];
  for (let ia = 0; ia < nA; ia++) {
    for (let ib = 0; ib < nB; ib++) {
      const score = cross[ia * nB + ib]!;
      const contrast = score - (meanA[ia]! + meanB[ib]!) / 2;
      if (contrast >= SUMMARY_EXCESS) {
        candidates.push({ ia, ib, strength: score, contrast });
      }
    }
  }
  candidates.sort((x, y) => y.strength - x.strength);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const usedBeats = new Set<string>();
  const picked: Pick[] = [];
  for (const cand of candidates) {
    if (cand.strength < STRENGTH_MIN) break;
    if (usedA.has(cand.ia) || usedB.has(cand.ib)) continue;
    const winA = winsA[cand.ia]!;
    const winB = winsB[cand.ib]!;
    const spanA = inSpan(beatsA, winA);
    const spanB = inSpan(beatsB, winB);
    let best = -Infinity;
    let anchorA: Beat | null = null;
    let anchorB: Beat | null = null;
    for (const beatA of spanA) {
      for (const beatB of spanB) {
        const agree = dot(beatA.vec, beatB.vec) - (LAMBDA * (beatA.generic + beatB.generic)) / 2;
        if (agree > best && !usedBeats.has(`a${beatA.idx}`) && !usedBeats.has(`b${beatB.idx}`)) {
          best = agree;
          anchorA = beatA;
          anchorB = beatB;
        }
      }
    }
    if (!anchorA || !anchorB || best < CONSENSUS_MIN) continue;
    usedA.add(cand.ia);
    usedB.add(cand.ib);
    usedBeats.add(`a${anchorA.idx}`);
    usedBeats.add(`b${anchorB.idx}`);
    picked.push({
      arcA: anchorA.arc,
      arcB: anchorB.arc,
      excerptA: excerptOf(anchorA.text),
      excerptB: excerptOf(anchorB.text),
      labelA: winA.headline,
      labelB: winB.headline,
      strength: cand.strength,
      contrast: cand.contrast,
      consensus: best,
    });
    if (picked.length === BRIDGE_PAIRS) break;
  }
  if (picked.length < 2) picked.length = 0;
  return { pairs: picked, ambient };
}

const DEFAULT_PAIRS: Array<[number, number, string]> = [
  [11, 1891, 'Star Wars vs Empire (franchise texture; audit era)'],
  [603, 78, 'Matrix vs Blade Runner (thematic sci-fi; audit era)'],
  [862, 807, 'Toy Story vs Se7en (must stay empty)'],
  [238, 769, 'Godfather vs GoodFellas (mob)'],
  [857, 1251, 'Saving Private Ryan vs Letters from Iwo Jima (war, two sides)'],
  [348, 679, 'Alien vs Aliens (franchise)'],
  [62, 168, '2001 vs Star Trek IV (live neighbor link)'],
  [424, 289222, 'Schindler vs Zookeeper (live neighbor link)'],
  [578, 551, 'Jaws vs Poseidon (live neighbor link)'],
  [621, 9603, 'Grease vs Clueless (live neighbor link)'],
  [4951, 2255, '10 Things vs Chasing Amy (live neighbor link)'],
  [27205, 581726, 'Inception vs Infinite (live neighbor link)'],
  [68718, 4512, 'Django vs Jesse James (live neighbor link)'],
  [597, 218, 'Titanic vs Terminator (unrelated control)'],
];

async function main(): Promise<void> {
  const list: Array<[number, number, string]> = args.pairs
    ? args.pairs.split(',').map((s) => {
        const [a, b] = s.split(':');
        return [Number(a), Number(b), 'cli'];
      })
    : DEFAULT_PAIRS;

  for (const [a, b, note] of list) {
    const titles = new Map(
      (
        await rows<{ id: number; title: string }>(
          'SELECT id, title FROM movies WHERE id IN ({a:UInt32}, {b:UInt32})',
          { a, b },
        )
      ).map((r) => [r.id, r.title]),
    );
    const [beatsA, beatsB, winsA, winsB] = await Promise.all([
      beatsOf(a),
      beatsOf(b),
      winsOf(a),
      winsOf(b),
    ]);
    const old = beatBridge(beatsA, beatsB);
    const neo = consensusBridge(winsA, winsB, beatsA, beatsB);
    console.log(`\n=== ${titles.get(a)} vs ${titles.get(b)} (${note})`);
    console.log(
      `old: ${old.pairs.length} pairs, ambient ${old.ambient.toFixed(3)} | new: ${neo.pairs.length} pairs, ambient ${neo.ambient.toFixed(3)}`,
    );
    const width = Math.max(old.pairs.length, neo.pairs.length);
    for (let i = 0; i < width; i++) {
      const o = old.pairs[i];
      const n = neo.pairs[i];
      if (o)
        console.log(
          `  OLD ${i + 1} (s${o.strength.toFixed(2)} c${o.contrast.toFixed(2)}): ${o.excerptA}  <->  ${o.excerptB}`,
        );
      if (n) {
        console.log(
          `  NEW ${i + 1} (s${n.strength.toFixed(2)} c${n.contrast.toFixed(2)} k${n.consensus?.toFixed(2)}): [${n.labelA}] <-> [${n.labelB}]`,
        );
        if (args.verbose) console.log(`        ${n.excerptA}  <->  ${n.excerptB}`);
      }
    }
  }
  await db.close();
}

await main();

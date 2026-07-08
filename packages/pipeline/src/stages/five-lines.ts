/**
 * Pick five arc-spanning lines per film for the movie page opener: one per
 * quintile, blending how central a line is to the film's own voice (closeness
 * to the film's line-vector centroid) with how distinctive its vocabulary is
 * against the corpus, so the picks read as the film in miniature.
 *
 * Run: pnpm five-lines
 */
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tokenize, EMBED_DIM } from '@unquote/shared';
import { DATA_DIR } from '../config.js';
import { readJson, readJsonl, writeJson } from '../util/fs.js';
import { log } from '../util/log.js';
import type { Utterance } from '../types.js';

const MIN_CHARS = 25;
const MAX_CHARS = 120;
const QUINTILES = 5;

const sliceOnly = process.env.SLICE === '1';
const sliceIds = new Set(await readJson<number[]>(resolve(DATA_DIR, 'slice.json')));

// Document frequency over films: in how many films does a token appear?
const filmTokens = new Map<number, Map<number, string[]>>();
const df = new Map<string, number>();
const seenIn = new Map<string, number>();
let filmCount = 0;

for await (const u of readJsonl<Utterance>(resolve(DATA_DIR, 'utterances.jsonl'))) {
  if (sliceOnly && !sliceIds.has(u.movieId)) continue;
  let seqs = filmTokens.get(u.movieId);
  if (!seqs) {
    seqs = new Map();
    filmTokens.set(u.movieId, seqs);
    filmCount += 1;
  }
  const tokens = tokenize(u.text);
  seqs.set(u.seq, tokens);
  for (const token of new Set(tokens)) {
    if (seenIn.get(token) !== u.movieId) {
      seenIn.set(token, u.movieId);
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
}

// Embedding rows align with utterances.jsonl line order; remember each
// utterance's global row so its vector can be read back for centrality.
const utterancesByFilm = new Map<number, Utterance[]>();
const rowBySeq = new Map<number, Map<number, number>>();
let globalRow = 0;
for await (const u of readJsonl<Utterance>(resolve(DATA_DIR, 'utterances.jsonl'))) {
  const row = globalRow;
  globalRow += 1;
  if (sliceOnly && !sliceIds.has(u.movieId)) continue;
  let list = utterancesByFilm.get(u.movieId);
  if (!list) {
    list = [];
    utterancesByFilm.set(u.movieId, list);
    rowBySeq.set(u.movieId, new Map());
  }
  list.push(u);
  rowBySeq.get(u.movieId)!.set(u.seq, row);
}

const embeddings = await open(resolve(DATA_DIR, 'embeddings.bin'), 'r');
const ROW_BYTES = EMBED_DIM * 4;

async function filmVectors(movieId: number): Promise<Map<number, Float32Array>> {
  const rows = rowBySeq.get(movieId)!;
  const vectors = new Map<number, Float32Array>();
  const buffer = Buffer.alloc(ROW_BYTES);
  for (const [seq, row] of rows) {
    await embeddings.read(buffer, 0, ROW_BYTES, row * ROW_BYTES);
    vectors.set(
      seq,
      new Float32Array(new Float32Array(buffer.buffer, buffer.byteOffset, EMBED_DIM)),
    );
  }
  return vectors;
}

function centroidOf(vectors: Map<number, Float32Array>): Float32Array {
  const centroid = new Float32Array(EMBED_DIM);
  for (const vec of vectors.values()) {
    for (let i = 0; i < EMBED_DIM; i++) centroid[i] = centroid[i]! + vec[i]!;
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += centroid[i]! * centroid[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) centroid[i] = centroid[i]! / norm;
  return centroid;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < EMBED_DIM; i++) sum += a[i]! * b[i]!;
  return sum;
}

function idf(token: string): number {
  return Math.log(filmCount / (1 + (df.get(token) ?? 0)));
}

// Dedications and credit cards live at the arc extremes and read as rare
// vocabulary, which idf scoring otherwise adores (Scarface's "dedicated to
// HOWARD HAWKS and BEN HECH" scored a slot at 100% through).
const ARC_MARGIN = 0.02;
const CREDIT_TEXT =
  /\b(dedicated to|in (loving )?memory|subtitles? by|directed by|produced by|screenplay by|based (up)?on the)\b/i;

function isCreditCard(u: Utterance): boolean {
  if (CREDIT_TEXT.test(u.text)) return true;
  if (u.arc > 1 - ARC_MARGIN || u.arc < ARC_MARGIN) {
    const letters = u.text.replace(/[^a-zA-Z]/g, '');
    const upper = letters.replace(/[^A-Z]/g, '');
    if (letters.length > 0 && upper.length / letters.length > 0.5) return true;
  }
  return false;
}

// Pure idf worships proper-noun roll calls ("Wehrmacht 346 lnfantry, von Luck
// Kampfgruppe" was Saving Private Ryan's top line). A memorable line has rare
// anchors inside common sentence structure, so demand the structure.
function hasSentenceShape(u: Utterance, tokens: string[]): boolean {
  if (/^["'”’“]/.test(u.text.trim())) return false; // orphaned quote fragment
  if (tokens.some((t) => /\d/.test(t))) return false; // unit numbers, dates
  const words = u.text.split(/\s+/);
  const capitalized = words.slice(1).filter((w) => /^[A-Z]/.test(w)).length;
  if (capitalized / Math.max(words.length - 1, 1) > 0.4) return false; // name lists
  const common = tokens.filter((t) => (df.get(t) ?? 0) > filmCount * 0.2).length;
  return common / tokens.length >= 0.4; // enough everyday words to read as speech
}

function distinctiveness(u: Utterance, tokens: string[]): number {
  if (u.text.length < MIN_CHARS || u.text.length > MAX_CHARS) return -1;
  if (tokens.length < 4) return -1;
  if (isCreditCard(u)) return -1;
  if (!hasSentenceShape(u, tokens)) return -1;
  const score = tokens.reduce((sum, token) => sum + idf(token), 0);
  return score / Math.sqrt(tokens.length);
}

// Blend within-film ranks: a candidate must be BOTH near the film's voice
// (centrality) and unusual for the corpus (distinctiveness). Rank-normalize
// each factor over the quintile's candidates so the scales cannot fight.
const CENTRALITY_WEIGHT = 0.6;

// Five lines about the same character read as a roll call, not a film in
// miniature (Saving Private Ryan picked Mellish three times). Sharing a name
// with an earlier pick costs rank positions; it does not disqualify.
const NAME_REPEAT_PENALTY = 0.5;

function nameTokens(text: string): Set<string> {
  const names = new Set<string>();
  const words = text.split(/\s+/);
  words.forEach((word, i) => {
    // Any capitalized word counts mid-sentence; at sentence start only a
    // vocative ("Mellish, check the tower.") is safely a name.
    if (i === 0 && !/^[A-Z][a-z]{2,},$/.test(word)) return;
    const m = word.match(/^[A-Z][a-z]{2,}/);
    if (m) names.add(m[0].toLowerCase());
  });
  return names;
}

const fiveLines: Record<string, number[]> = {};
for (const [movieId, utterances] of utterancesByFilm) {
  const tokensBySeq = filmTokens.get(movieId)!;
  const textBySeq = new Map(utterances.map((u) => [u.seq, u.text]));
  const vectors = await filmVectors(movieId);
  const centroid = centroidOf(vectors);
  const picks: number[] = [];
  const pickedNames = new Set<string>();
  for (let q = 0; q < QUINTILES; q++) {
    const candidates: Array<{ u: Utterance; dist: number; central: number }> = [];
    for (const u of utterances) {
      const quintile = Math.min(Math.floor(u.arc * QUINTILES), QUINTILES - 1);
      if (quintile !== q) continue;
      const dist = distinctiveness(u, tokensBySeq.get(u.seq) ?? []);
      if (dist < 0) continue;
      const vec = vectors.get(u.seq);
      if (!vec) continue;
      candidates.push({ u, dist, central: dot(vec, centroid) });
    }
    if (candidates.length === 0) continue;
    const byDist = [...candidates].sort((a, b) => b.dist - a.dist);
    const byCentral = [...candidates].sort((a, b) => b.central - a.central);
    const distRank = new Map(byDist.map((c, i) => [c.u.seq, i]));
    const centralRank = new Map(byCentral.map((c, i) => [c.u.seq, i]));
    let best: Utterance | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      const names = nameTokens(c.u.text);
      const repeatsName = [...names].some((n) => pickedNames.has(n));
      const score =
        CENTRALITY_WEIGHT * centralRank.get(c.u.seq)! +
        (1 - CENTRALITY_WEIGHT) * distRank.get(c.u.seq)! +
        (repeatsName ? NAME_REPEAT_PENALTY * candidates.length : 0);
      if (score < bestScore) {
        bestScore = score;
        best = c.u;
      }
    }
    if (best) {
      picks.push(best.seq);
      for (const n of nameTokens(textBySeq.get(best.seq) ?? '')) pickedNames.add(n);
    }
  }
  if (picks.length > 0) fiveLines[movieId] = picks;
}

await embeddings.close();

await writeJson(resolve(DATA_DIR, 'five-lines.json'), fiveLines);
log.info(`five lines: ${Object.keys(fiveLines).length} films${sliceOnly ? ' (slice)' : ''}`);

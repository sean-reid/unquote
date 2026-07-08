/**
 * Pick five arc-spanning distinctive lines per film for the movie page
 * opener: one per quintile, scored by rarity of vocabulary against the corpus
 * so catchphrases beat filler.
 *
 * Run: pnpm five-lines
 */
import { resolve } from 'node:path';
import { tokenize } from '@unquote/shared';
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

const utterancesByFilm = new Map<number, Utterance[]>();
for await (const u of readJsonl<Utterance>(resolve(DATA_DIR, 'utterances.jsonl'))) {
  if (sliceOnly && !sliceIds.has(u.movieId)) continue;
  let list = utterancesByFilm.get(u.movieId);
  if (!list) {
    list = [];
    utterancesByFilm.set(u.movieId, list);
  }
  list.push(u);
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

const fiveLines: Record<string, number[]> = {};
for (const [movieId, utterances] of utterancesByFilm) {
  const tokensBySeq = filmTokens.get(movieId)!;
  const picks: number[] = [];
  for (let q = 0; q < QUINTILES; q++) {
    let best: Utterance | null = null;
    let bestScore = -1;
    for (const u of utterances) {
      const quintile = Math.min(Math.floor(u.arc * QUINTILES), QUINTILES - 1);
      if (quintile !== q) continue;
      const score = distinctiveness(u, tokensBySeq.get(u.seq) ?? []);
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    if (best) picks.push(best.seq);
  }
  if (picks.length > 0) fiveLines[movieId] = picks;
}

await writeJson(resolve(DATA_DIR, 'five-lines.json'), fiveLines);
log.info(`five lines: ${Object.keys(fiveLines).length} films${sliceOnly ? ' (slice)' : ''}`);

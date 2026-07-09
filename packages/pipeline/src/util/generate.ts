/**
 * Validation and bookkeeping for the generation pipeline: verbatim matching
 * of generated quotes against a film's lines, a tf-idf snap for near misses,
 * an evidence lint for scene summaries, and the {inputHash, promptVersion}
 * keying that makes reruns incremental.
 */
import { createHash } from 'node:crypto';
import type { Utterance } from '../types.js';

/** Case, curly quotes, and punctuation do not count as a wording difference. */
export function normalizeQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  return normalizeQuote(text).split(' ').filter(Boolean);
}

export interface SnapResult {
  line: Utterance;
  score: number;
  verbatim: boolean;
}

/**
 * Match a generated quote to one film's lines. Verbatim (normalized) match
 * wins outright; otherwise the closest line by tf-idf cosine is offered with
 * its score, and the caller decides whether the snap is honest enough to keep.
 */
export class FilmMatcher {
  private byNorm = new Map<string, Utterance>();
  private bySeq = new Map<number, Utterance>();
  private df = new Map<string, number>();
  private vectors: Array<Map<string, number>> = [];

  constructor(private lines: Utterance[]) {
    for (const line of lines) {
      const norm = normalizeQuote(line.text);
      if (norm && !this.byNorm.has(norm)) this.byNorm.set(norm, line);
      this.bySeq.set(line.seq, line);
    }
    for (const line of lines) {
      for (const token of new Set(tokenize(line.text))) {
        this.df.set(token, (this.df.get(token) ?? 0) + 1);
      }
    }
    this.vectors = lines.map((line) => this.vector(tokenize(line.text)));
  }

  private idf(token: string): number {
    return Math.log((this.lines.length + 1) / ((this.df.get(token) ?? 0) + 1)) + 1;
  }

  private vector(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    let normSq = 0;
    for (const [t, count] of tf) {
      const w = count * this.idf(t);
      vec.set(t, w);
      normSq += w * w;
    }
    const norm = Math.sqrt(normSq) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    return vec;
  }

  match(quote: string, seqHint?: number | null): SnapResult | null {
    const norm = normalizeQuote(quote);
    // A repeated line lives at several seqs; when the model named one and the
    // text there agrees, that occurrence wins over the first one found.
    if (seqHint != null) {
      const hinted = this.bySeq.get(seqHint);
      if (hinted && normalizeQuote(hinted.text) === norm) {
        return { line: hinted, score: 1, verbatim: true };
      }
    }
    const exact = this.byNorm.get(norm);
    if (exact) return { line: exact, score: 1, verbatim: true };

    const query = this.vector(tokenize(quote));
    if (query.size === 0) return null;
    let best = -1;
    let bestIdx = -1;
    this.vectors.forEach((vec, idx) => {
      let dot = 0;
      for (const [t, w] of query) {
        const lw = vec.get(t);
        if (lw) dot += w * lw;
      }
      if (dot > best) {
        best = dot;
        bestIdx = idx;
      }
    });
    if (bestIdx < 0) return null;
    return { line: this.lines[bestIdx]!, score: best, verbatim: false };
  }
}

export interface EvidenceRange {
  start: number;
  end: number;
}

export interface LintIssue {
  kind: 'no-evidence' | 'bad-range' | 'invented-noun';
  detail: string;
}

/**
 * A summary is trusted only if every evidence range points inside the window
 * it was generated from, and every proper noun it uses appears in the window
 * dialogue or the film title. Sentence-leading capitals are not nouns.
 */
export function lintSummary(
  summary: string,
  evidence: EvidenceRange[],
  window: { startSeq: number; endSeq: number; texts: string[] },
  title: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  if (evidence.length === 0) {
    issues.push({ kind: 'no-evidence', detail: 'summary carries no evidence ranges' });
  }
  for (const range of evidence) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start > range.end ||
      range.start < window.startSeq ||
      range.end > window.endSeq
    ) {
      issues.push({
        kind: 'bad-range',
        detail: `evidence ${range.start}-${range.end} outside window ${window.startSeq}-${window.endSeq}`,
      });
    }
  }

  const known = new Set<string>();
  for (const text of window.texts) for (const t of tokenize(text)) known.add(t);
  for (const t of tokenize(title)) known.add(t);

  for (const sentence of summary.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/);
    words.forEach((word, i) => {
      if (i === 0) return;
      // A capital opening or following quoted speech is dialogue casing,
      // not a name; verbatim quotes ground themselves via the window text.
      if (/^["'“]/.test(word) || /["'”’]$/.test(words[i - 1] ?? '')) return;
      const m = word.match(/^\(?([A-Z][a-z]+)/);
      if (!m) return;
      const noun = m[1]!.toLowerCase();
      if (NOT_NAMES.has(noun)) return;
      if (!known.has(noun)) {
        issues.push({ kind: 'invented-noun', detail: `"${m[1]}" appears nowhere in the window` });
      }
    });
  }
  return issues;
}

// Capitalized mid-sentence by quoting or splitter stumbles, never a name.
const NOT_NAMES = new Set(
  (
    'he she it we they you i who what when where why how the a an and but or nor so yet ' +
    'his her its our their your this that these those there then now no yes not'
  ).split(' '),
);

/** Content hash of the exact texts a generation saw; 16 hex chars is plenty. */
export function inputHash(texts: string[]): string {
  const h = createHash('sha256');
  for (const t of texts) h.update(t).update('\n');
  return h.digest('hex').slice(0, 16);
}

export interface GenerationKey {
  inputHash: string;
  promptVersion: number;
}

/** A row reruns when its input or its prompt changed; otherwise it is done. */
export function needsRun(
  existing: GenerationKey | undefined,
  hash: string,
  promptVersion: number,
): boolean {
  return !existing || existing.inputHash !== hash || existing.promptVersion !== promptVersion;
}

/** Prompt files open with a `promptVersion: N` line; the body follows. */
export function parsePrompt(raw: string): { promptVersion: number; body: string } {
  const match = raw.match(/^promptVersion:\s*(\d+)\s*\n/);
  if (!match) throw new Error('prompt file must open with a promptVersion line');
  return { promptVersion: Number(match[1]), body: raw.slice(match[0].length).trim() };
}

/** Pull the first JSON array or object out of a model reply, fences and all. */
export function extractJson<T>(reply: string): T {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : reply;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in reply');
  const close = candidate[start] === '[' ? ']' : '}';
  const end = candidate.lastIndexOf(close);
  if (end <= start) throw new Error('unterminated JSON in reply');
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

/**
 * Readers and row logic for the generation stores. The stores are
 * append-only JSONL that a running generation may still be writing: the
 * last row per key wins, a missing file is an empty store, and a torn
 * final line (a write caught mid-append) is skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import {
  inputHash,
  lintSummary,
  needsRun,
  type EvidenceRange,
  type GenerationKey,
  type LintIssue,
} from './generate.js';

export function readGenerated<T extends { movieId: number; windowId?: string }>(
  name: string,
  dir: string = path.join(DATA_DIR, 'generated'),
): Map<string, T> {
  const file = path.join(dir, name);
  const rows = new Map<string, T>();
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as T;
      rows.set(row.windowId ?? String(row.movieId), row);
    } catch {
      // The trailing line of a live append; the next read picks it up.
    }
  }
  return rows;
}

export interface SummaryRow {
  windowId: string;
  movieId: number;
  inputHash: string;
  promptVersion: number;
  model?: string;
  headline?: string;
  summary?: string;
  evidence?: EvidenceRange[];
  issues?: LintIssue[];
  valid?: boolean;
  refused?: boolean;
  draftSource?: boolean;
  canonicalConfidence?: string;
}

export function parseWindowId(id: string): { movieId: number; startSeq: number; endSeq: number } {
  const m = id.match(/^(\d+):(\d+)-(\d+)$/);
  if (!m) throw new Error(`malformed windowId: ${id}`);
  return { movieId: Number(m[1]), startSeq: Number(m[2]), endSeq: Number(m[3]) };
}

/**
 * A stored rejection the lint alone might clear: it failed on grounding
 * (not policy refusal), and it kept its text. Evidence-range failures are
 * facts about the stored ranges and can never re-lint differently.
 */
export function rescuable(row: SummaryRow): boolean {
  return (
    row.valid === false &&
    !row.refused &&
    typeof row.headline === 'string' &&
    typeof row.summary === 'string' &&
    (row.issues ?? []).some((i) => i.kind === 'invented-noun')
  );
}

/**
 * Re-lint a stored row against its window's real texts. A clean pass
 * returns the corrected row to append (same key, valid, no issues);
 * a row that still fails returns null and stays as it was.
 */
export function revalidateRow(row: SummaryRow, texts: string[], title: string): SummaryRow | null {
  const { startSeq, endSeq } = parseWindowId(row.windowId);
  const issues = lintSummary(
    `${row.headline}. ${row.summary}`,
    row.evidence ?? [],
    { startSeq, endSeq, texts },
    title,
  );
  if ((row.headline ?? '').length > 90) {
    issues.push({ kind: 'bad-range', detail: `headline is ${row.headline!.length} chars` });
  }
  if (issues.length > 0) return null;
  return { ...row, issues: [], valid: true };
}

/** Rows a repair run regenerates: real failures, not refusals or successes. */
export function repairTargets(rows: Map<string, SummaryRow>): SummaryRow[] {
  return [...rows.values()].filter((r) => r.windowId && r.valid === false && !r.refused);
}

export interface SelectedWindow {
  windowId: string;
  movieId: number;
  startSeq: number;
  endSeq: number;
  lines: Array<{ seq: number; text: string }>;
  feedback?: string[];
}

/**
 * One film's windows that need a generation pass. Normal runs skip windows
 * whose {inputHash, promptVersion} already sit in the store; a repair run
 * regenerates its spans regardless, carrying the lint findings of the
 * failed attempt so the model can avoid repeating them.
 */
export function selectWindows(
  movieId: number,
  filmLines: Array<{ seq: number; text: string }>,
  spans: Array<{ startSeq: number; endSeq: number }>,
  existing: Map<string, GenerationKey>,
  promptVersion: number,
  repair: boolean,
  feedback?: Map<string, string[]>,
): SelectedWindow[] {
  const out: SelectedWindow[] = [];
  for (const span of spans) {
    const lines = filmLines.filter((u) => u.seq >= span.startSeq && u.seq <= span.endSeq);
    if (lines.length === 0) continue;
    const windowId = `${movieId}:${span.startSeq}-${span.endSeq}`;
    if (
      !repair &&
      !needsRun(existing.get(windowId), inputHash(lines.map((l) => l.text)), promptVersion)
    ) {
      continue;
    }
    const notes = feedback?.get(windowId);
    out.push({
      windowId,
      movieId,
      startSeq: span.startSeq,
      endSeq: span.endSeq,
      lines,
      ...(notes && notes.length > 0 ? { feedback: notes } : {}),
    });
  }
  return out;
}

/** The window as the model sees it; feedback rides only when present. */
export function windowPayload(
  w: SelectedWindow,
  movie: { title: string; year: number } | undefined,
): SelectedWindow & { title?: string; year?: number } {
  return { ...w, title: movie?.title, year: movie?.year };
}

/**
 * A row-aligned Float32 score file is only trustworthy when its length
 * matches the artifact it scores; anything else (stale run, mid-write read)
 * loads as null and the caller falls back to zeros.
 */
export function alignedScores(bytes: Buffer, expectedRows: number): Float32Array | null {
  if (bytes.byteLength !== expectedRows * 4) return null;
  return new Float32Array(bytes.buffer, bytes.byteOffset, expectedRows);
}

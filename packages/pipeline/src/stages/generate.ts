/**
 * Generation driver: feeds films (or dialogue windows) through a versioned
 * prompt via headless claude, validates everything that comes back, and
 * appends the survivors to a JSONL store keyed by {inputHash, promptVersion}.
 * A rerun skips rows whose key is unchanged, so corpus growth or a prompt
 * bump regenerates only what actually changed. The store is appended after
 * every invocation; a killed run loses at most one batch.
 *
 * Run: pnpm generate --kind five-quotes --movies 11,2493,807
 *      pnpm generate --kind scene-summary --movies 11 --windows 3
 *      pnpm generate --kind five-quotes            (whole corpus)
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DATA_DIR } from '../config.js';
import { readJson, readJsonl } from '../util/fs.js';
import {
  FilmMatcher,
  extractJson,
  inputHash,
  lintSummary,
  needsRun,
  parsePrompt,
  tokenize,
  type EvidenceRange,
  type GenerationKey,
} from '../util/generate.js';
import { log } from '../util/log.js';
import type { MovieRecord, Utterance } from '../types.js';

const BATCH = 10;
const SNAP_MIN = 0.55;
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
const WINDOW_LINES = 12;

const { values: args } = parseArgs({
  // pnpm forwards script flags behind a bare --, which parseArgs would
  // otherwise demote to positionals.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  allowPositionals: true,
  options: {
    kind: { type: 'string' },
    movies: { type: 'string' },
    limit: { type: 'string' },
    windows: { type: 'string' },
  },
});
const kind = args.kind;
if (kind !== 'five-quotes' && kind !== 'scene-summary') {
  throw new Error('--kind must be five-quotes or scene-summary');
}

const promptRaw = await readFile(
  resolve(dirname(new URL(import.meta.url).pathname), `../../prompts/${kind}.md`),
  'utf8',
);
const { promptVersion, body: promptBody } = parsePrompt(promptRaw);

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const byId = new Map(movies.map((m) => [m.id, m]));

const upgradePath = resolve(DATA_DIR, 'upgrade-report.json');
const draftIds = new Set<number>(
  existsSync(upgradePath)
    ? (
        await readJson<{ draftsRemaining?: Array<{ movieId: number }> }>(upgradePath)
      ).draftsRemaining?.map((d) => d.movieId) ?? []
    : [],
);

const wanted = args.movies
  ? new Set(args.movies.split(',').map((s) => Number(s.trim())))
  : null;
const filmLimit = args.limit ? Number(args.limit) : Infinity;

const storePath = resolve(DATA_DIR, 'generated', `${kind}.jsonl`);
await mkdir(dirname(storePath), { recursive: true });
const existing = new Map<string, GenerationKey>();
if (existsSync(storePath)) {
  for await (const row of readJsonl<GenerationKey & { movieId: number; windowId?: string }>(
    storePath,
  )) {
    existing.set(row.windowId ?? String(row.movieId), row);
  }
}

/** Candidate slate: dialogue-shaped lines, stratified across the arc so the
 * model sees the whole film, capped so ten films fit one invocation. */
function slate(lines: Utterance[]): Utterance[] {
  const gated = lines.filter((u) => {
    if (u.text.length < 15 || u.text.length > 160) return false;
    const tokens = tokenize(u.text);
    if (tokens.length < 4) return false;
    if (/\d/.test(u.text)) return false;
    const words = u.text.split(/\s+/);
    const caps = words.slice(1).filter((w) => /^[A-Z]/.test(w)).length;
    return caps / Math.max(words.length - 1, 1) <= 0.4;
  });
  const bins = 12;
  const perBin = 10;
  const picked: Utterance[] = [];
  for (let b = 0; b < bins; b++) {
    const bin = gated.filter((u) => u.arc >= b / bins && u.arc < (b + 1) / bins);
    const step = Math.max(1, Math.floor(bin.length / perBin));
    picked.push(...bin.filter((_, i) => i % step === 0).slice(0, perBin));
  }
  return picked;
}

function windows(lines: Utterance[], count: number): Utterance[][] {
  const out: Utterance[][] = [];
  for (let w = 1; w <= count; w++) {
    const at = Math.floor((lines.length * w) / (count + 1));
    const start = Math.max(0, Math.min(at, lines.length - WINDOW_LINES));
    out.push(lines.slice(start, start + WINDOW_LINES));
  }
  return out;
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(
      'claude',
      ['-p', '--output-format', 'json'],
      { maxBuffer: 64 * 1024 * 1024, timeout: CLAUDE_TIMEOUT_MS },
      (err, stdout) => (err ? rej(err) : res(stdout)),
    );
    child.stdin!.end(prompt);
  });
}

interface Envelope {
  is_error?: boolean;
  result?: string;
  modelUsage?: Record<string, unknown>;
}

async function invoke(payload: unknown): Promise<{ reply: string; model: string }> {
  const stdout = await runClaude(
    `${promptBody}\n\n## Payload\n\n${JSON.stringify(payload)}\n\nReply with JSON only.`,
  );
  const envelope = JSON.parse(stdout) as Envelope;
  if (envelope.is_error || typeof envelope.result !== 'string') {
    throw new Error(`claude returned an error envelope: ${stdout.slice(0, 300)}`);
  }
  return { reply: envelope.result, model: Object.keys(envelope.modelUsage ?? {})[0] ?? 'claude' };
}

interface PendingFilm {
  movieId: number;
  hash: string;
  lines: Utterance[];
}

// Films stream grouped by movieId, so one film is buffered at a time while
// collecting; only films that actually need a run are retained.
const pending: PendingFilm[] = [];
let skipped = 0;
let current: Utterance[] = [];
let currentId = -1;

function takeFilm(): void {
  if (current.length === 0 || pending.length >= filmLimit) return;
  const hash = inputHash(current.map((u) => u.text));
  const upToDate =
    kind === 'five-quotes'
      ? !needsRun(existing.get(String(currentId)), hash, promptVersion)
      : windows(current, Number(args.windows ?? 3)).every((w) => {
          const id = `${currentId}:${w[0]!.seq}-${w[w.length - 1]!.seq}`;
          return !needsRun(existing.get(id), inputHash(w.map((u) => u.text)), promptVersion);
        });
  if (upToDate) {
    skipped += 1;
    return;
  }
  pending.push({ movieId: currentId, hash, lines: current });
}

for await (const u of readJsonl<Utterance>(resolve(DATA_DIR, 'utterances.jsonl'))) {
  if (u.movieId !== currentId) {
    takeFilm();
    currentId = u.movieId;
    current = [];
  }
  if (!wanted || wanted.has(u.movieId)) current.push(u);
}
takeFilm();

log.step(`${kind} v${promptVersion}: ${pending.length} films to run, ${skipped} up to date`);

let verbatim = 0;
let snapped = 0;
let dropped = 0;
let lintFailed = 0;

for (let at = 0; at < pending.length; at += BATCH) {
  const batch = pending.slice(at, at + BATCH);
  const rows: unknown[] = [];

  if (kind === 'five-quotes') {
    const payload = batch.map((f) => ({
      movieId: f.movieId,
      title: byId.get(f.movieId)?.title,
      year: byId.get(f.movieId)?.year,
      lines: slate(f.lines).map((u) => ({ seq: u.seq, text: u.text })),
    }));
    const { reply, model } = await invoke(payload);
    const parsed = extractJson<Array<{ movieId: number; quotes: Array<{ text: string }> }>>(reply);
    for (const film of batch) {
      const answer = parsed.find((p) => p.movieId === film.movieId);
      const matcher = new FilmMatcher(film.lines);
      const quotes: unknown[] = [];
      const misses: string[] = [];
      for (const q of answer?.quotes ?? []) {
        const m = matcher.match(q.text);
        if (m?.verbatim) {
          verbatim += 1;
          quotes.push({ seq: m.line.seq, arc: m.line.arc, text: m.line.text, source: 'verbatim' });
        } else if (m && m.score >= SNAP_MIN) {
          snapped += 1;
          quotes.push({
            seq: m.line.seq,
            arc: m.line.arc,
            text: m.line.text,
            source: 'snapped',
            score: Number(m.score.toFixed(3)),
            asGenerated: q.text,
          });
        } else {
          dropped += 1;
          misses.push(q.text);
        }
      }
      rows.push({
        movieId: film.movieId,
        inputHash: film.hash,
        promptVersion,
        model,
        quotes,
        dropped: misses,
        draftSource: draftIds.has(film.movieId),
        canonicalConfidence: draftIds.has(film.movieId) ? 'low' : 'normal',
      });
    }
  } else {
    const windowCount = Number(args.windows ?? 3);
    const items = batch
      .flatMap((f) =>
        windows(f.lines, windowCount).map((w) => ({
          windowId: `${f.movieId}:${w[0]!.seq}-${w[w.length - 1]!.seq}`,
          movieId: f.movieId,
          title: byId.get(f.movieId)?.title,
          year: byId.get(f.movieId)?.year,
          startSeq: w[0]!.seq,
          endSeq: w[w.length - 1]!.seq,
          lines: w.map((u) => ({ seq: u.seq, text: u.text })),
        })),
      )
      .filter((item) =>
        needsRun(
          existing.get(item.windowId),
          inputHash(item.lines.map((l) => l.text)),
          promptVersion,
        ),
      );
    const { reply, model } = await invoke(items);
    const parsed =
      extractJson<
        Array<{ windowId: string; headline: string; summary: string; evidence: EvidenceRange[] }>
      >(reply);
    for (const item of items) {
      const answer = parsed.find((p) => p.windowId === item.windowId);
      if (!answer) continue;
      // The headline is a sentence of its own; joining with a period keeps
      // the summary's first word from reading as a mid-sentence proper noun.
      const issues = lintSummary(
        `${answer.headline}. ${answer.summary}`,
        answer.evidence ?? [],
        { startSeq: item.startSeq, endSeq: item.endSeq, texts: item.lines.map((l) => l.text) },
        item.title ?? '',
      );
      if (answer.headline.length > 90) {
        issues.push({ kind: 'bad-range', detail: `headline is ${answer.headline.length} chars` });
      }
      if (issues.length > 0) lintFailed += 1;
      rows.push({
        windowId: item.windowId,
        movieId: item.movieId,
        inputHash: inputHash(item.lines.map((l) => l.text)),
        promptVersion,
        model,
        headline: answer.headline,
        summary: answer.summary,
        evidence: answer.evidence ?? [],
        issues,
        valid: issues.length === 0,
        draftSource: draftIds.has(item.movieId),
        canonicalConfidence: draftIds.has(item.movieId) ? 'low' : 'normal',
      });
    }
  }

  await appendFile(storePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  log.info(`batch ${at / BATCH + 1}/${Math.ceil(pending.length / BATCH)}: ${rows.length} rows`);
}

if (kind === 'five-quotes') {
  log.step(`done: ${verbatim} verbatim, ${snapped} snapped, ${dropped} dropped`);
} else {
  log.step(`done: ${lintFailed} of the generated summaries failed lint`);
}

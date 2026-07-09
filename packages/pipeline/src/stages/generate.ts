/**
 * Generation driver: feeds films (or dialogue windows) through a versioned
 * prompt via headless claude, validates everything that comes back, and
 * appends the survivors to a JSONL store keyed by {inputHash, promptVersion}.
 * A rerun skips rows whose key is unchanged, so corpus growth or a prompt
 * bump regenerates only what actually changed. The store is appended after
 * every invocation; a killed run loses at most one batch.
 *
 * Run: pnpm generate --kind five-quotes --movies 11,2493,807
 *      pnpm generate --kind scene-summary --tier 1
 *      pnpm generate --kind five-quotes            (whole corpus)
 *
 * Scene-summary windows are the ladder's segments (tier 1: the surfaced
 * slice per film, tier 2: the rest), so summaries describe the same moments
 * the site navigates to.
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
import {
  beatFallback,
  rankWindows,
  tierWindows,
  type RankedWindow,
  type SegmentSpan,
} from '../util/windows.js';
import type { MovieRecord, Utterance } from '../types.js';

const BATCH = 10;
const WINDOW_BATCH = 12;
const SNAP_MIN = 0.55;
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;

const { values: args } = parseArgs({
  // pnpm forwards script flags behind a bare --, which parseArgs would
  // otherwise demote to positionals.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  allowPositionals: true,
  options: {
    kind: { type: 'string' },
    movies: { type: 'string' },
    limit: { type: 'string' },
    tier: { type: 'string', default: '1' },
    model: { type: 'string', default: 'sonnet' },
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

// Scene-summary windows come from the ladder artifacts, not evenly spaced
// samples: each window is a segment's utterance span, ranked per film by
// beat genericness so the surfaced tier generates first. Films the segments
// stage skipped (none today) fall back to their beats.
const surfaced = new Map<number, RankedWindow[]>();
if (kind === 'scene-summary') {
  const tier = args.tier as '1' | '2' | 'all';
  if (tier !== '1' && tier !== '2' && tier !== 'all') {
    throw new Error('--tier must be 1, 2, or all');
  }
  const genericBytes = await readFile(resolve(DATA_DIR, 'beat-generic.bin'));
  const generic = new Float32Array(
    genericBytes.buffer,
    genericBytes.byteOffset,
    genericBytes.byteLength / 4,
  );
  const segsByMovie = new Map<number, SegmentSpan[]>();
  for await (const s of readJsonl<SegmentSpan>(resolve(DATA_DIR, 'segments.jsonl'))) {
    const list = segsByMovie.get(s.movieId);
    if (list) list.push(s);
    else segsByMovie.set(s.movieId, [s]);
  }
  const beatBase = new Map<number, number>();
  const orphanBeats = new Map<
    number,
    Array<{ movieId: number; idx: number; startSeq: number; endSeq: number }>
  >();
  let row = 0;
  for await (const b of readJsonl<{
    movieId: number;
    idx: number;
    startSeq: number;
    endSeq: number;
  }>(resolve(DATA_DIR, 'beats.jsonl'))) {
    if (!beatBase.has(b.movieId)) beatBase.set(b.movieId, row);
    if (!segsByMovie.has(b.movieId)) {
      const list = orphanBeats.get(b.movieId);
      const span = { movieId: b.movieId, idx: b.idx, startSeq: b.startSeq, endSeq: b.endSeq };
      if (list) list.push(span);
      else orphanBeats.set(b.movieId, [span]);
    }
    row += 1;
  }
  for (const [movieId, segs] of segsByMovie) {
    surfaced.set(movieId, tierWindows(rankWindows(segs, generic, beatBase.get(movieId) ?? 0), tier));
  }
  for (const [movieId, beats] of orphanBeats) {
    surfaced.set(movieId, tierWindows(beatFallback(beats, generic, beatBase.get(movieId) ?? 0), tier));
  }
  const total = [...surfaced.values()].reduce((n, w) => n + w.length, 0);
  log.info(`tier ${tier}: ${total} windows across ${surfaced.size} films`);
}

function runClaudeOnce(prompt: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(
      'claude',
      ['-p', '--output-format', 'json', '--model', args.model!],
      { maxBuffer: 64 * 1024 * 1024, timeout: CLAUDE_TIMEOUT_MS },
      (err, stdout, stderr) =>
        err
          ? rej(
              new Error(
                `claude exited: ${String(stderr).slice(0, 200)} ${String(stdout).slice(0, 300)}`,
              ),
            )
          : res(stdout),
    );
    child.stdin!.end(prompt);
  });
}

// A single flaky exit must not kill a 265-batch run; the store checkpoints
// per batch, so the only unrecoverable failure is one that repeats.
async function runClaude(prompt: string): Promise<string> {
  const waits = [30_000, 90_000, 180_000];
  for (const wait of waits) {
    try {
      return await runClaudeOnce(prompt);
    } catch (err) {
      // A usage-policy refusal is deterministic; retrying only burns time.
      if (String(err).includes('Usage Policy')) throw err;
      log.warn(`claude invocation failed, retrying in ${wait / 1000}s: ${String(err)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return runClaudeOnce(prompt);
}

interface Envelope {
  is_error?: boolean;
  result?: string;
  modelUsage?: Record<string, { outputTokens?: number }>;
}

async function invoke(payload: unknown): Promise<{ reply: string; model: string }> {
  const stdout = await runClaude(
    `${promptBody}\n\n## Payload\n\n${JSON.stringify(payload)}\n\nReply with JSON only.`,
  );
  const envelope = JSON.parse(stdout) as Envelope;
  if (envelope.is_error || typeof envelope.result !== 'string') {
    throw new Error(`claude returned an error envelope: ${stdout.slice(0, 300)}`);
  }
  // modelUsage also lists auxiliary models; the one that wrote the reply is
  // the one with the output tokens.
  const model = Object.entries(envelope.modelUsage ?? {}).sort(
    (a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0),
  )[0]?.[0];
  return { reply: envelope.result, model: model ?? args.model! };
}

interface WindowItem {
  windowId: string;
  movieId: number;
  startSeq: number;
  endSeq: number;
  lines: Array<{ seq: number; text: string }>;
}

interface PendingFilm {
  movieId: number;
  hash: string;
  lines: Utterance[];
  windows: WindowItem[];
}

// Films stream grouped by movieId, so one film is buffered at a time while
// collecting; only films that actually need a run are retained. Scene-summary
// films keep just the window slices that need generating, not the transcript:
// a corpus-wide run must not hold 3.7M lines in memory.
const pending: PendingFilm[] = [];
let skipped = 0;
let current: Utterance[] = [];
let currentId = -1;

function takeFilm(): void {
  if (current.length === 0 || pending.length >= filmLimit) return;
  if (kind === 'five-quotes') {
    const hash = inputHash(current.map((u) => u.text));
    if (!needsRun(existing.get(String(currentId)), hash, promptVersion)) {
      skipped += 1;
      return;
    }
    pending.push({ movieId: currentId, hash, lines: current, windows: [] });
    return;
  }
  const needed: WindowItem[] = [];
  for (const w of surfaced.get(currentId) ?? []) {
    const lines = current
      .filter((u) => u.seq >= w.startSeq && u.seq <= w.endSeq)
      .map((u) => ({ seq: u.seq, text: u.text }));
    if (lines.length === 0) continue;
    const windowId = `${currentId}:${w.startSeq}-${w.endSeq}`;
    if (needsRun(existing.get(windowId), inputHash(lines.map((l) => l.text)), promptVersion)) {
      needed.push({ windowId, movieId: currentId, startSeq: w.startSeq, endSeq: w.endSeq, lines });
    }
  }
  if (needed.length === 0) {
    skipped += 1;
    return;
  }
  pending.push({ movieId: currentId, hash: '', lines: [], windows: needed });
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
let unanswered = 0;
let lintFailed = 0;

if (kind === 'five-quotes') {
for (let at = 0; at < pending.length; at += BATCH) {
  const batch = pending.slice(at, at + BATCH);
  const rows: unknown[] = [];

  {
    const payload = batch.map((f) => ({
      movieId: f.movieId,
      title: byId.get(f.movieId)?.title,
      year: byId.get(f.movieId)?.year,
      lines: slate(f.lines).map((u) => ({ seq: u.seq, text: u.text })),
    }));
    const { reply, model } = await invoke(payload);
    const parsed =
      extractJson<Array<{ movieId: number; quotes: Array<{ seq?: number | null; text: string }> }>>(
        reply,
      );
    for (const film of batch) {
      const answer = parsed.find((p) => p.movieId === film.movieId);
      const matcher = new FilmMatcher(film.lines);
      const quotes: unknown[] = [];
      const misses: string[] = [];
      for (const q of answer?.quotes ?? []) {
        const m = matcher.match(q.text, q.seq);
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
      // A film the model skipped, or whose picks all failed validation, must
      // not be keyed as done: leaving it out of the store makes the next run
      // retry it instead of shipping an empty entry forever.
      if (quotes.length === 0) {
        unanswered += 1;
        log.warn(`movie ${film.movieId}: no quotes survived, will retry next run`);
        continue;
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
  }

  await appendFile(storePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  log.info(`batch ${at / BATCH + 1}/${Math.ceil(pending.length / BATCH)}: ${rows.length} rows`);
}
} else {
  // Windows batch by payload size, not by count: a segment span is many
  // times the size of a five-quotes slate line, and a cluster of long
  // segments packed twelve to an invocation overflows the prompt, which
  // claude rejects. A window too big even alone keeps its head and tail;
  // the lint only checks claims against the lines actually supplied.
  const PAYLOAD_BUDGET = 60_000;
  const trimWindow = (w: (typeof pending)[number]['windows'][number]) => {
    const size = w.lines.reduce((n, l) => n + l.text.length + 24, 0);
    if (size <= PAYLOAD_BUDGET) return w;
    const keep = Math.floor((w.lines.length * PAYLOAD_BUDGET) / size);
    const head = Math.max(1, Math.floor(keep * 0.7));
    const tail = Math.max(1, keep - head);
    return { ...w, lines: [...w.lines.slice(0, head), ...w.lines.slice(-tail)] };
  };
  const allWindows = pending.flatMap((f) => f.windows).map(trimWindow);
  log.step(`${allWindows.length} windows to generate`);
  let at = 0;
  while (at < allWindows.length) {
    let size = 0;
    let take = 0;
    while (at + take < allWindows.length && take < WINDOW_BATCH) {
      const w = allWindows[at + take]!;
      const wSize = w.lines.reduce((n, l) => n + l.text.length + 24, 0);
      if (take > 0 && size + wSize > PAYLOAD_BUDGET) break;
      size += wSize;
      take += 1;
    }
    const items = allWindows.slice(at, at + take).map((w) => ({
      ...w,
      title: byId.get(w.movieId)?.title,
      year: byId.get(w.movieId)?.year,
    }));
    at += take;
    const rows: unknown[] = [];
    type Answer = { windowId: string; headline: string; summary: string; evidence: EvidenceRange[] };
    const refused = new Set<string>();
    let model = args.model!;
    // A policy refusal poisons a whole batch; bisect to isolate the window
    // that triggers it, park just that one, and generate the rest.
    const summarize = async (slice: typeof items): Promise<Answer[]> => {
      try {
        const result = await invoke(slice);
        model = result.model;
        return extractJson<Answer[]>(result.reply);
      } catch (err) {
        if (!String(err).includes('Usage Policy')) throw err;
        if (slice.length === 1) {
          refused.add(slice[0]!.windowId);
          log.warn(`window ${slice[0]!.windowId} refused on policy; parked`);
          return [];
        }
        const mid = Math.ceil(slice.length / 2);
        return [
          ...(await summarize(slice.slice(0, mid))),
          ...(await summarize(slice.slice(mid))),
        ];
      }
    };
    const parsed = await summarize(items);
    for (const item of items) {
      if (refused.has(item.windowId)) {
        rows.push({
          windowId: item.windowId,
          movieId: item.movieId,
          inputHash: inputHash(item.lines.map((l) => l.text)),
          promptVersion,
          model,
          refused: true,
          valid: false,
        });
        continue;
      }
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
    if (rows.length > 0) {
      await appendFile(storePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    log.info(`windows ${at}/${allWindows.length}: ${rows.length} rows`);
  }
}

if (kind === 'five-quotes') {
  log.step(
    `done: ${verbatim} verbatim, ${snapped} snapped, ${dropped} dropped, ${unanswered} films left for retry`,
  );
} else {
  log.step(`done: ${lintFailed} of the generated summaries failed lint`);
}

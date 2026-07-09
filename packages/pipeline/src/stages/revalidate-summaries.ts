/**
 * Rescue stored summaries the lint wrongly rejected. The lint improves
 * independently of generation: a row rejected under an older lint keeps
 * its full text, so re-running the current lint against the window's real
 * transcript flips false positives back to valid without spending a single
 * invocation. Corrected rows append to the store and win by being last;
 * rows that still fail are left for the repair pass. Safe to run while a
 * generation is appending: the store read tolerates a torn final line.
 *
 * Run: pnpm revalidate-summaries
 */
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, readJsonl } from '../util/fs.js';
import {
  parseWindowId,
  readGenerated,
  rescuable,
  revalidateRow,
  type SummaryRow,
} from '../util/generated.js';
import { log } from '../util/log.js';
import type { MovieRecord, Utterance } from '../types.js';

const rows = readGenerated<SummaryRow>('scene-summary.jsonl');
const candidates = [...rows.values()].filter(rescuable);
log.step(`${rows.size} stored summaries, ${candidates.length} rescue candidates`);

const byMovie = new Map<number, SummaryRow[]>();
for (const row of candidates) {
  const list = byMovie.get(row.movieId);
  if (list) list.push(row);
  else byMovie.set(row.movieId, [row]);
}

const movies = await readJson<MovieRecord[]>(resolve(DATA_DIR, 'movies.json'));
const titles = new Map(movies.map((m) => [m.id, m.title]));

const corrected: SummaryRow[] = [];
let still = 0;
let currentId = -1;
let current: Array<{ seq: number; text: string }> = [];

const flush = (): void => {
  for (const row of byMovie.get(currentId) ?? []) {
    const { startSeq, endSeq } = parseWindowId(row.windowId);
    const texts = current.filter((u) => u.seq >= startSeq && u.seq <= endSeq).map((u) => u.text);
    if (texts.length === 0) continue;
    const fixed = revalidateRow(row, texts, titles.get(row.movieId) ?? '');
    if (fixed) corrected.push(fixed);
    else still += 1;
  }
};

if (candidates.length > 0) {
  for await (const u of readJsonl<Utterance>(resolve(DATA_DIR, 'utterances.jsonl'))) {
    if (u.movieId !== currentId) {
      flush();
      currentId = u.movieId;
      current = [];
    }
    if (byMovie.has(u.movieId)) current.push({ seq: u.seq, text: u.text });
  }
  flush();
}

if (corrected.length > 0) {
  await appendFile(
    resolve(DATA_DIR, 'generated', 'scene-summary.jsonl'),
    corrected.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}
log.step(
  `rescued ${corrected.length} of ${candidates.length}; ${still} still failing, left for repair`,
);

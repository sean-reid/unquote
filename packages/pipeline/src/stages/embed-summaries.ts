/**
 * Embed scene summaries for retrieval: keep the last valid row per window
 * from the generation store, write a row-aligned summaries.jsonl, and embed
 * headline plus summary on the wide model. The store grows for days, so a
 * rerun reconciles against the prior artifact and only windows new since
 * last time touch the GPU.
 *
 * Run: pnpm embed-summaries
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { readGenerated } from '../util/generated.js';
import { log } from '../util/log.js';

const WIDE_MODEL = 'BAAI/bge-base-en-v1.5';

interface SummaryRow {
  windowId: string;
  movieId: number;
  headline: string;
  summary: string;
  valid: boolean;
  refused?: boolean;
}

const rows = [...readGenerated<SummaryRow>('scene-summary.jsonl').values()]
  .filter((r) => r.valid && !r.refused && r.headline && r.summary)
  .map((r) => {
    const [, span] = r.windowId.split(':');
    const [startSeq, endSeq] = span!.split('-').map(Number);
    return {
      windowId: r.windowId,
      movieId: r.movieId,
      startSeq: startSeq!,
      endSeq: endSeq!,
      text: `${r.headline}. ${r.summary}`,
    };
  })
  .sort((a, b) => a.movieId - b.movieId || a.startSeq - b.startSeq);

if (rows.length === 0) {
  log.step('no valid summaries in the store yet; nothing to embed');
  process.exit(0);
}

const jsonl = path.join(DATA_DIR, 'summaries.jsonl');
const bin = path.join(DATA_DIR, 'summary-embeddings.bin');
const meta = path.join(DATA_DIR, 'summary-embeddings.meta.json');
const prevJsonl = path.join(DATA_DIR, 'summaries.prev.jsonl');
const prevBin = path.join(DATA_DIR, 'summary-embeddings.prev.bin');
const prevMeta = path.join(DATA_DIR, 'summary-embeddings.prev.meta.json');

// A complete artifact rotates to .prev and seeds the reconcile. After a
// failed run the .prev trio is still sitting there; reuse it rather than
// paying for a full embed.
if (existsSync(jsonl) && existsSync(bin) && existsSync(meta)) {
  await rename(jsonl, prevJsonl);
  await rename(bin, prevBin);
  await rename(meta, prevMeta);
}
const havePrev = existsSync(prevJsonl) && existsSync(prevBin) && existsSync(prevMeta);
await writeFile(jsonl, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
log.step(`${rows.length} summaries to embed (${havePrev ? 'reconciling' : 'full run'})`);

const uvArgs = havePrev
  ? [
      'run',
      '--project',
      'python',
      'python/reconcile.py',
      '--old-jsonl',
      'data/summaries.prev.jsonl',
      '--old-bin',
      'data/summary-embeddings.prev.bin',
      '--new-jsonl',
      'data/summaries.jsonl',
      '--out-bin',
      'data/summary-embeddings.bin',
    ]
  : [
      'run',
      '--project',
      'python',
      'python/embed.py',
      '--input',
      'data/summaries.jsonl',
      '--output',
      'data/summary-embeddings.bin',
      '--model',
      WIDE_MODEL,
    ];

const result = spawnSync('uv', uvArgs, {
  stdio: 'inherit',
  cwd: path.resolve(DATA_DIR, '..'),
});
if (result.status !== 0) {
  // The prior artifact is untouched under its .prev names; a rerun rotates
  // it back into place through the reconcile path.
  throw new Error(`embedding exited with ${result.status ?? 'signal'}`);
}
if (havePrev) {
  await rm(prevJsonl);
  await rm(prevBin);
  await rm(prevMeta);
}
log.step(`summary embeddings ready: ${rows.length} rows`);

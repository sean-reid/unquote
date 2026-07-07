import { open, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from '@huggingface/transformers';
import { EMBED_DIM, EMBED_MODEL } from '@unquote/shared';
import { DATA_DIR } from '../config.js';
import { readJsonl } from '../util/fs.js';
import { log } from '../util/log.js';
import type { Utterance } from '../types.js';

const BATCH = 64;
const CHECKPOINT_EVERY = 50; // batches
const BIN = resolve(DATA_DIR, 'embeddings.bin');
const PROGRESS = resolve(DATA_DIR, 'embeddings.progress.json');
const META = resolve(DATA_DIR, 'embeddings.meta.json');

const texts: string[] = [];
for await (const u of readJsonl<Utterance>(resolve(DATA_DIR, 'utterances.jsonl'))) {
  texts.push(u.text);
}
log.info(`embedding ${texts.length} utterances with ${EMBED_MODEL}`);

// Resume from the last checkpoint if a previous run died mid-way.
let done = 0;
try {
  done = JSON.parse(await readFile(PROGRESS, 'utf8')).rows as number;
  await truncate(BIN, done * EMBED_DIM * 4);
  log.info(`resuming at row ${done}`);
} catch {
  await rm(BIN, { force: true });
}

const embed = await pipeline('feature-extraction', EMBED_MODEL);

const file = await open(BIN, 'a');
const started = Date.now();
let sinceCheckpoint = 0;

for (let i = done; i < texts.length; i += BATCH) {
  const batch = texts.slice(i, i + BATCH);
  const output = await embed(batch, { pooling: 'mean', normalize: true });
  const data = output.data as Float32Array;
  await file.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));

  done = Math.min(i + BATCH, texts.length);
  sinceCheckpoint += 1;
  if (sinceCheckpoint >= CHECKPOINT_EVERY || done === texts.length) {
    await file.sync();
    await writeFile(PROGRESS, JSON.stringify({ rows: done }), 'utf8');
    sinceCheckpoint = 0;
  }
  if (done % 5120 < BATCH || done === texts.length) {
    const rate = done / ((Date.now() - started) / 1000);
    log.info(`embedded ${done}/${texts.length} (${Math.round(rate)}/s)`);
  }
}

await file.close();
await writeFile(
  META,
  JSON.stringify({ model: EMBED_MODEL, dim: EMBED_DIM, count: texts.length }, null, 2),
  'utf8',
);
await rm(PROGRESS, { force: true });
log.info(`embeddings complete: ${texts.length} rows, ${EMBED_DIM} dims`);

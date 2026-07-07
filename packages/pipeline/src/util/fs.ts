import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

/** Stream-write an array of records as JSONL without holding the string in memory. */
export async function writeJsonl(path: string, records: Iterable<unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const stream = createWriteStream(path, 'utf8');
  for (const record of records) {
    if (!stream.write(JSON.stringify(record) + '\n')) {
      await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
    }
  }
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.on('error', reject);
  });
}

/** Iterate a JSONL file line by line. */
export async function* readJsonl<T>(path: string): AsyncGenerator<T> {
  const rl = readline.createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim().length > 0) yield JSON.parse(line) as T;
  }
}

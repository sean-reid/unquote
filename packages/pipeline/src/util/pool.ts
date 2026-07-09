/**
 * Concurrency primitives for the generation driver: a fixed-size worker pool,
 * a writer that serializes appends so concurrent batches never interleave
 * partial lines, and a throttle that drains the pool to single file for a
 * cooldown window when the model API signals a usage limit.
 */
import { appendFile } from 'node:fs/promises';
import { log } from './log.js';

const LIMIT_PATTERN = /\b429\b|rate.?limit|overloaded|quota|\blimit\b/i;

export function limitFlavored(err: unknown): boolean {
  return LIMIT_PATTERN.test(String(err));
}

/**
 * Runs items through fn with at most `concurrency` in flight. A failure stops
 * workers from taking new items; in-flight items drain, then the first error
 * throws, so a supervisor sees a clean nonzero exit instead of a torn pool.
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const index = next;
      next += 1;
      try {
        await fn(items[index]!, index);
      } catch (err) {
        failure = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  if (failure !== null) throw failure;
}

/** Appends whole payloads one at a time, in completion order. */
export class SerialWriter {
  private chain: Promise<void> = Promise.resolve();

  write(path: string, payload: string): Promise<void> {
    const turn = this.chain.then(() => appendFile(path, payload));
    // The chain survives a failed write so later writes still run; the
    // failure itself surfaces to the caller that awaited this turn.
    this.chain = turn.catch(() => undefined);
    return turn;
  }
}

/**
 * After a limit-flavored failure, gated calls run one at a time until the
 * cooldown passes; at full health the gate is a passthrough.
 */
export class Throttle {
  private cooldownUntil = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private cooldownMs = 5 * 60_000) {}

  note(err: unknown): void {
    if (!limitFlavored(err)) return;
    if (this.cooling()) return;
    this.cooldownUntil = Date.now() + this.cooldownMs;
    log.warn(
      `limit signal from the api; pool drains to single file for ${Math.round(this.cooldownMs / 1000)}s`,
    );
  }

  cooling(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  async gate<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.cooling()) return fn();
    const turn = this.chain;
    let release!: () => void;
    this.chain = new Promise((r) => (release = r));
    await turn;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

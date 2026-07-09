/**
 * Concurrency primitives for the generation driver: a fixed-size worker pool,
 * a writer that serializes appends so concurrent batches never interleave
 * partial lines, and a throttle that drains the pool to single file for a
 * cooldown window when the model API signals a usage limit.
 *
 * The two synchronized moments — the pool's first wave and the return from a
 * cooldown — launch jittered rather than as a burst, since those are exactly
 * when a rate limiter is watching; the steady state self-staggers.
 */
import { appendFile } from 'node:fs/promises';
import { log } from './log.js';

const LIMIT_PATTERN = /\b429\b|rate.?limit|overloaded|quota|\blimit\b/i;

export function limitFlavored(err: unknown): boolean {
  return LIMIT_PATTERN.test(String(err));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PoolOptions {
  /** Delay before a worker's first item; slot i waits about i times this. */
  staggerMs?: number;
  rng?: () => number;
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
  options: PoolOptions = {},
): Promise<void> {
  const { staggerMs = 6_000, rng = Math.random } = options;
  let next = 0;
  let failure: unknown = null;
  const worker = async (slot: number): Promise<void> => {
    if (slot > 0 && staggerMs > 0) await sleep(slot * staggerMs * (0.75 + rng() * 0.5));
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
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, i) => worker(i)));
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

export interface ThrottleOptions {
  cooldownMs?: number;
  /** Calls arriving just after a cooldown spread out over this window. */
  restoreSpreadMs?: number;
  rng?: () => number;
}

/**
 * After a limit-flavored failure, gated calls run one at a time until the
 * cooldown passes, then rejoin spread across the restore window instead of
 * as one burst; at full health the gate is a passthrough.
 */
export class Throttle {
  private cooldownUntil = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly cooldownMs: number;
  private readonly restoreSpreadMs: number;
  private readonly rng: () => number;

  constructor(options: ThrottleOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
    this.restoreSpreadMs = options.restoreSpreadMs ?? 45_000;
    this.rng = options.rng ?? Math.random;
  }

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
    if (!this.cooling()) {
      const sinceRestore = Date.now() - this.cooldownUntil;
      if (this.cooldownUntil > 0 && sinceRestore < this.restoreSpreadMs) {
        await sleep(this.rng() * (this.restoreSpreadMs - sinceRestore));
      }
      return fn();
    }
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

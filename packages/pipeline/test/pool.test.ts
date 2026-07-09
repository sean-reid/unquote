import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SerialWriter, Throttle, limitFlavored, runPool } from '../src/util/pool.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runPool', () => {
  it('caps in-flight work and finishes everything', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool([...Array(20).keys()], 4, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      seen.push(n);
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(seen.length).toBe(20);
  });

  it('runs serially at concurrency 1', async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool([1, 2, 3, 4], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(3);
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  it('stops taking work after a failure and rethrows it', async () => {
    const seen: number[] = [];
    await expect(
      runPool([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        seen.push(n);
        await sleep(5);
      }),
    ).rejects.toThrow('boom');
    expect(seen.length).toBeLessThan(7);
  });
});

describe('SerialWriter', () => {
  it('keeps concurrent multi-line appends whole', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pool-'));
    const path = join(dir, 'store.jsonl');
    const writer = new SerialWriter();
    await runPool([...Array(12).keys()], 6, async (n) => {
      const rows = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ n, i, pad: 'x'.repeat(500) }),
      );
      await sleep(Math.random() * 10);
      await writer.write(path, rows.join('\n') + '\n');
    });
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines.length).toBe(60);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    await rm(dir, { recursive: true });
  });
});

describe('Throttle', () => {
  it('flags limit-flavored errors only', () => {
    expect(limitFlavored(new Error('429 too many requests'))).toBe(true);
    expect(limitFlavored(new Error('rate limit exceeded'))).toBe(true);
    expect(limitFlavored(new Error('Overloaded'))).toBe(true);
    expect(limitFlavored(new Error('usage quota reached'))).toBe(true);
    expect(limitFlavored(new Error('claude exited: JSON parse'))).toBe(false);
  });

  it('drains gated calls to single file during cooldown, restores after', async () => {
    const throttle = new Throttle(80);
    let inFlight = 0;
    let peak = 0;
    const gated = () =>
      throttle.gate(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(10);
        inFlight -= 1;
      });
    throttle.note(new Error('429'));
    expect(throttle.cooling()).toBe(true);
    await Promise.all([gated(), gated(), gated()]);
    expect(peak).toBe(1);
    await sleep(100);
    expect(throttle.cooling()).toBe(false);
    peak = 0;
    await Promise.all([gated(), gated(), gated()]);
    expect(peak).toBeGreaterThan(1);
  });

  it('ignores non-limit errors', () => {
    const throttle = new Throttle(80);
    throttle.note(new Error('some other failure'));
    expect(throttle.cooling()).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  BEAT_SIZE,
  BEAT_STRIDE,
  SEGMENT_MAX_BEATS,
  beatWindows,
  cutSegments,
  meanVector,
} from '../src/util/ladder.js';

describe('beatWindows', () => {
  it('covers a short film with a single window', () => {
    const windows = beatWindows(8);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ startSeq: 0, endSeq: 7, arc: 0.5 });
  });

  it('strides half a window so every line lands in about two beats', () => {
    const windows = beatWindows(100);
    expect(windows[0]!.startSeq).toBe(0);
    expect(windows[1]!.startSeq).toBe(BEAT_STRIDE);
    expect(windows[0]!.endSeq).toBe(BEAT_SIZE - 1);
    const last = windows[windows.length - 1]!;
    expect(last.endSeq).toBe(99);
  });

  it('covers every utterance exactly', () => {
    for (const n of [1, 11, 12, 13, 25, 99, 100]) {
      const windows = beatWindows(n);
      const covered = new Set<number>();
      for (const w of windows) {
        for (let s = w.startSeq; s <= w.endSeq; s++) covered.add(s);
      }
      expect(covered.size).toBe(n);
    }
  });

  it('keeps arcs monotonic and in range', () => {
    const arcs = beatWindows(200).map((w) => w.arc);
    expect(arcs.every((a) => a >= 0 && a <= 1)).toBe(true);
    expect([...arcs].sort((a, b) => a - b)).toEqual(arcs);
  });
});

describe('cutSegments', () => {
  it('keeps a coherent film as one segment when nothing drops', () => {
    const sims = Array(9).fill(0.9);
    expect(cutSegments(sims, 10)).toEqual([[0, 9]]);
  });

  it('cuts at a similarity cliff', () => {
    const sims = [0.9, 0.9, 0.9, 0.2, 0.9, 0.9];
    const segments = cutSegments(sims, 7);
    expect(segments[0]).toEqual([0, 3]);
    expect(segments.at(-1)![1]).toBe(6);
  });

  it('never exceeds the maximum segment size', () => {
    const sims = Array(50).fill(0.95);
    const segments = cutSegments(sims, 51);
    for (const [start, end] of segments) {
      expect(end - start + 1).toBeLessThanOrEqual(SEGMENT_MAX_BEATS);
    }
  });

  it('joins a trailing stub into the previous segment', () => {
    const sims = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.2];
    const segments = cutSegments(sims, 12);
    const last = segments.at(-1)!;
    expect(last[1]).toBe(11);
    for (const [start, end] of segments) {
      expect(end - start + 1).toBeGreaterThanOrEqual(2);
    }
  });

  it('partitions beats without gaps or overlaps', () => {
    const sims = [0.9, 0.3, 0.8, 0.85, 0.2, 0.9, 0.7, 0.4, 0.95];
    const segments = cutSegments(sims, 10);
    let next = 0;
    for (const [start, end] of segments) {
      expect(start).toBe(next);
      next = end + 1;
    }
    expect(next).toBe(10);
  });
});

describe('meanVector', () => {
  it('pools rows into a unit vector', () => {
    const matrix = new Float32Array([1, 0, 0, 1]);
    const pooled = meanVector([0, 1], matrix, 2);
    const norm = Math.hypot(pooled[0]!, pooled[1]!);
    expect(norm).toBeCloseTo(1);
    expect(pooled[0]).toBeCloseTo(pooled[1]!);
  });
});

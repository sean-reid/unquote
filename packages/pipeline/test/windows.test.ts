import { describe, expect, it } from 'vitest';
import { TIER1_PER_FILM, beatFallback, rankWindows, tierWindows } from '../src/util/windows.js';

const seg = (
  idx: number,
  startBeat: number,
  endBeat: number,
  startSeq: number,
  endSeq: number,
) => ({
  movieId: 7,
  idx,
  startBeat,
  endBeat,
  startSeq,
  endSeq,
});

describe('rankWindows', () => {
  it('ranks segments by mean beat genericness, least generic first', () => {
    // beats 0-1 very generic, 2-3 distinctive, 4 middling; beatBase offsets into the corpus array
    const generic = [9, 9, 0.9, 0.8, 0.7, 0.1, 0.2, 0.5];
    const ranked = rankWindows(
      [seg(0, 0, 1, 0, 20), seg(1, 2, 3, 21, 40), seg(2, 4, 5, 41, 60)],
      generic,
      2,
    );
    expect(ranked.map((w) => w.startSeq)).toEqual([41, 21, 0]);
    expect(ranked[0]!.score).toBeCloseTo(0.35);
  });

  it('breaks score ties by segment order so reruns select identically', () => {
    const generic = [0.5, 0.5, 0.5, 0.5];
    const ranked = rankWindows([seg(1, 2, 3, 30, 40), seg(0, 0, 1, 0, 20)], generic, 0);
    expect(ranked.map((w) => w.startSeq)).toEqual([0, 30]);
  });
});

describe('tierWindows', () => {
  const ranked = Array.from({ length: 14 }, (_, i) => ({
    movieId: 7,
    startSeq: (13 - i) * 10,
    endSeq: (13 - i) * 10 + 9,
    score: i / 14,
  }));

  it('tier 1 is the most distinctive slice per film, in story order', () => {
    const one = tierWindows(ranked, '1');
    expect(one).toHaveLength(TIER1_PER_FILM);
    expect(one.map((w) => w.startSeq)).toEqual(
      [...one.map((w) => w.startSeq)].sort((a, b) => a - b),
    );
    const kept = new Set(one.map((w) => w.startSeq));
    for (const w of ranked.slice(0, TIER1_PER_FILM)) expect(kept.has(w.startSeq)).toBe(true);
  });

  it('tier 2 is exactly the remainder and all covers everything', () => {
    const one = tierWindows(ranked, '1');
    const two = tierWindows(ranked, '2');
    expect(two).toHaveLength(ranked.length - TIER1_PER_FILM);
    const union = new Set([...one, ...two].map((w) => w.startSeq));
    expect(union.size).toBe(ranked.length);
    expect(tierWindows(ranked, 'all')).toHaveLength(ranked.length);
  });

  it('a short film puts everything in tier 1 and nothing in tier 2', () => {
    const few = ranked.slice(0, 4);
    expect(tierWindows(few, '1')).toHaveLength(4);
    expect(tierWindows(few, '2')).toHaveLength(0);
  });
});

describe('beatFallback', () => {
  it('treats each beat as its own window ranked by its genericness', () => {
    const beats = [
      { movieId: 9, idx: 0, startSeq: 0, endSeq: 11 },
      { movieId: 9, idx: 1, startSeq: 6, endSeq: 17 },
    ];
    const ranked = beatFallback(beats, [0.9, 0.1], 0);
    expect(ranked[0]!.startSeq).toBe(6);
    expect(ranked[0]!.score).toBeCloseTo(0.1);
  });
});

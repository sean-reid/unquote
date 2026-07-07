import { describe, expect, it } from 'vitest';
import { alignWords, diffStats } from '../src/diff.js';

describe('alignWords', () => {
  it('marks substituted words as changed', () => {
    const result = alignWords('luke i am your father', 'No, I am your father.');
    expect(result.map((w) => w.word)).toEqual(['No,', 'I', 'am', 'your', 'father.']);
    expect(result.map((w) => w.changed)).toEqual([true, false, false, false, false]);
  });

  it('ignores punctuation and case differences', () => {
    const result = alignWords("we're gonna need a bigger boat", "You're gonna need a bigger boat.");
    expect(result.filter((w) => w.changed).map((w) => w.word)).toEqual(["You're"]);
  });

  it('marks nothing when texts match', () => {
    const result = alignWords('May the Force be with you', 'may the force be with you.');
    expect(result.every((w) => !w.changed)).toBe(true);
  });

  it('handles inserted words', () => {
    const result = alignWords('play it again sam', "Play it, Sam. Play 'As Time Goes By.'");
    const changed = result.filter((w) => w.changed).map((w) => w.word);
    expect(changed).toContain("'As");
    // The first Play aligns with the source; the second is an insertion.
    expect(result[0]).toEqual({ word: 'Play', changed: false });
    expect(result[3]?.word).toBe('Play');
    expect(result[3]?.changed).toBe(true);
  });
});

describe('diffStats', () => {
  it('counts a single substitution', () => {
    const stats = diffStats('luke i am your father', 'no i am your father');
    expect(stats.substitutions).toBe(1);
    expect(stats.extras).toBe(0);
    expect(stats.shared).toBe(4);
    expect(stats.sharedRatio).toBeCloseTo(0.8);
  });

  it('is identity for equal strings', () => {
    const stats = diffStats('a bigger boat', 'a bigger boat');
    expect(stats.substitutions).toBe(0);
    expect(stats.sharedRatio).toBe(1);
  });

  it('counts extras when lengths differ', () => {
    const stats = diffStats(
      'magic mirror on the wall',
      'mirror mirror on the wall who is the fairest',
    );
    expect(stats.shared).toBeGreaterThanOrEqual(4);
    expect(stats.extras).toBeGreaterThan(0);
  });
});

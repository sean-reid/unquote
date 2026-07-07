import { describe, expect, it } from 'vitest';
import { jaccard, normalize, tokenize } from '../src/text.js';

describe('normalize', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalize('Frankly, my dear, I don’t give a damn.')).toBe(
      "frankly my dear i don't give a damn",
    );
  });

  it('collapses whitespace', () => {
    expect(normalize('  toto,   I’ve a feeling ')).toBe("toto i've a feeling");
  });

  it('strips diacritics', () => {
    expect(normalize('Amélie café')).toBe('amelie cafe');
  });
});

describe('tokenize', () => {
  it('splits on whitespace after normalizing', () => {
    expect(tokenize("Here's looking at you, kid.")).toEqual([
      "here's",
      'looking',
      'at',
      'you',
      'kid',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(tokenize('  ...  ')).toEqual([]);
  });
});

describe('jaccard', () => {
  it('is 1 for identical token sets', () => {
    expect(jaccard(['a', 'b'], ['b', 'a'])).toBe(1);
  });

  it('is 0 for disjoint sets', () => {
    expect(jaccard(['a'], ['b'])).toBe(0);
  });

  it('handles partial overlap', () => {
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5);
  });
});

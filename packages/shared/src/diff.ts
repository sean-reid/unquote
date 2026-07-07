import { normalize } from './text.js';

export interface WordAlignment {
  /** Original word from the target text, punctuation intact. */
  word: string;
  /** True when this word has no aligned match in the source text. */
  changed: boolean;
}

export interface DiffStats {
  /** Words aligned between the two texts. */
  shared: number;
  /** Paired mismatches, one word swapped for another. */
  substitutions: number;
  /** Unpaired extra words on either side. */
  extras: number;
  /** shared / max(word counts), 0 to 1. */
  sharedRatio: number;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function normalizedWords(text: string): string[] {
  return words(text).map((w) => normalize(w));
}

/** Longest common subsequence over normalized word arrays; returns matched index pairs. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] && a[i] !== ''
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j] && a[i] !== '') {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Align the target text against a source text word by word. Words the two
 * texts share stay unchanged; everything else in the target is marked changed.
 * Pure punctuation differences do not count as changes.
 */
export function alignWords(source: string, target: string): WordAlignment[] {
  const sourceNorm = normalizedWords(source);
  const targetWords = words(target);
  const targetNorm = targetWords.map((w) => normalize(w));
  const matched = new Set(lcsPairs(sourceNorm, targetNorm).map(([, j]) => j));
  return targetWords.map((word, index) => ({
    word,
    changed: !matched.has(index) && targetNorm[index] !== '',
  }));
}

/** Summary of how far apart two texts are at the word level. */
export function diffStats(a: string, b: string): DiffStats {
  const aNorm = normalizedWords(a).filter((w) => w !== '');
  const bNorm = normalizedWords(b).filter((w) => w !== '');
  const shared = lcsPairs(aNorm, bNorm).length;
  const aOnly = aNorm.length - shared;
  const bOnly = bNorm.length - shared;
  const substitutions = Math.min(aOnly, bOnly);
  const extras = Math.abs(aOnly - bOnly);
  const longest = Math.max(aNorm.length, bNorm.length);
  return {
    shared,
    substitutions,
    extras,
    sharedRatio: longest === 0 ? 1 : shared / longest,
  };
}

import { describe, expect, it } from 'vitest';
import {
  FilmMatcher,
  extractJson,
  inputHash,
  lintSummary,
  needsRun,
  normalizeQuote,
  parsePrompt,
} from '../src/util/generate.js';
import type { Utterance } from '../src/types.js';

function line(seq: number, text: string): Utterance {
  return { movieId: 1, seq, arc: seq / 100, text };
}

describe('normalizeQuote', () => {
  it('ignores case, curly quotes, and punctuation', () => {
    expect(normalizeQuote('I’ll be back.')).toBe("i'll be back");
    expect(normalizeQuote('“Fly, you fools!”')).toBe('fly you fools');
  });
});

describe('FilmMatcher', () => {
  const lines = [
    line(0, 'Did you hear that?'),
    line(1, "They've shut down the main reactor."),
    line(2, 'May the Force be with you.'),
    line(3, "We'll be destroyed for sure."),
  ];
  const matcher = new FilmMatcher(lines);

  it('matches verbatim through normalization differences', () => {
    const m = matcher.match('may the force be with you');
    expect(m?.verbatim).toBe(true);
    expect(m?.line.seq).toBe(2);
  });

  it('snaps a close paraphrase to the nearest line with a real score', () => {
    const m = matcher.match('They shut down the reactor');
    expect(m?.verbatim).toBe(false);
    expect(m?.line.seq).toBe(1);
    expect(m!.score).toBeGreaterThan(0.5);
  });

  it('scores an unrelated quote too low to keep', () => {
    const m = matcher.match('Here is looking at you, kid');
    expect(m === null || m.score < 0.55).toBe(true);
  });

  it('resolves a repeated line to the hinted occurrence', () => {
    const repeated = new FilmMatcher([
      line(5, 'My name is Inigo Montoya.'),
      line(6, 'Stop saying that!'),
      line(80, 'My name is Inigo Montoya.'),
    ]);
    expect(repeated.match('My name is Inigo Montoya.')?.line.seq).toBe(5);
    expect(repeated.match('My name is Inigo Montoya.', 80)?.line.seq).toBe(80);
  });

  it('ignores a seq hint whose text does not agree', () => {
    const m = matcher.match('May the Force be with you.', 0);
    expect(m?.verbatim).toBe(true);
    expect(m?.line.seq).toBe(2);
  });
});

describe('lintSummary', () => {
  const window = {
    startSeq: 100,
    endSeq: 111,
    texts: ['You come to me on the day of my wedding.', 'I ask for justice.'],
  };

  it('passes a grounded summary with in-window evidence', () => {
    const issues = lintSummary(
      'A man asks for justice on a wedding day.',
      [{ start: 100, end: 101 }],
      window,
      'The Godfather',
    );
    expect(issues).toEqual([]);
  });

  it('rejects evidence outside the window', () => {
    const issues = lintSummary(
      'A man asks for justice.',
      [{ start: 90, end: 101 }],
      window,
      'The Godfather',
    );
    expect(issues.some((i) => i.kind === 'bad-range')).toBe(true);
  });

  it('rejects a summary with no evidence at all', () => {
    const issues = lintSummary('A man asks for justice.', [], window, 'The Godfather');
    expect(issues.some((i) => i.kind === 'no-evidence')).toBe(true);
  });

  it('does not flag pronouns or quote-opened capitals as nouns', () => {
    const issues = lintSummary(
      'A man pleads. They refuse, saying "Never again." He walks out.',
      [{ start: 100, end: 101 }],
      window,
      'The Godfather',
    );
    expect(issues).toEqual([]);
  });

  it('flags proper nouns the window never shows', () => {
    const issues = lintSummary(
      'A man petitions Corleone for justice.',
      [{ start: 100, end: 101 }],
      window,
      'The Godfather',
    );
    expect(issues.some((i) => i.kind === 'invented-noun' && i.detail.includes('Corleone'))).toBe(
      true,
    );
  });

  it('allows nouns that appear in the title', () => {
    const issues = lintSummary(
      'A wedding-day plea from the Godfather.',
      [{ start: 100, end: 101 }],
      window,
      'The Godfather',
    );
    expect(issues).toEqual([]);
  });
});

describe('incremental keying', () => {
  it('reruns on input or prompt change, skips when both match', () => {
    const hash = inputHash(['a', 'b']);
    expect(needsRun(undefined, hash, 1)).toBe(true);
    expect(needsRun({ inputHash: hash, promptVersion: 1 }, hash, 1)).toBe(false);
    expect(needsRun({ inputHash: hash, promptVersion: 1 }, hash, 2)).toBe(true);
    expect(needsRun({ inputHash: hash, promptVersion: 1 }, inputHash(['a', 'c']), 1)).toBe(true);
  });

  it('hashes content, not identity', () => {
    expect(inputHash(['x', 'y'])).toBe(inputHash(['x', 'y']));
    expect(inputHash(['x', 'y'])).not.toBe(inputHash(['x', 'z']));
    expect(inputHash(['ab', 'c'])).not.toBe(inputHash(['a', 'bc']));
  });
});

describe('parsePrompt', () => {
  it('reads the version line and returns the body', () => {
    const { promptVersion, body } = parsePrompt('promptVersion: 3\n\n# Task\nDo the thing.');
    expect(promptVersion).toBe(3);
    expect(body.startsWith('# Task')).toBe(true);
  });

  it('refuses a prompt without a version', () => {
    expect(() => parsePrompt('# Task\n')).toThrow();
  });
});

describe('extractJson', () => {
  it('parses bare JSON, fenced JSON, and JSON with chatter around it', () => {
    expect(extractJson('[1,2]')).toEqual([1, 2]);
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n[{"a":1}]\nDone.')).toEqual([{ a: 1 }]);
  });
});

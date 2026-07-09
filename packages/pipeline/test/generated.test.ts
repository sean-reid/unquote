import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inputHash } from '../src/util/generate.js';
import {
  parseWindowId,
  readGenerated,
  repairTargets,
  rescuable,
  revalidateRow,
  selectWindows,
  windowPayload,
  type SummaryRow,
} from '../src/util/generated.js';

function summaryRow(overrides: Partial<SummaryRow>): SummaryRow {
  return {
    windowId: '7:100-105',
    movieId: 7,
    inputHash: 'abc',
    promptVersion: 1,
    model: 'sonnet',
    headline: 'A man asks for justice',
    summary: 'They refuse to help him at first.',
    evidence: [{ start: 100, end: 101 }],
    issues: [{ kind: 'invented-noun', detail: '"They" appears nowhere in the window' }],
    valid: false,
    ...overrides,
  };
}

const windowTexts = ['You come to me on the day of my wedding.', 'I ask for justice.'];

describe('readGenerated', () => {
  it('keeps the last row per key and skips a torn final line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-store-'));
    writeFileSync(
      join(dir, 'scene-summary.jsonl'),
      [
        JSON.stringify(summaryRow({ valid: false })),
        JSON.stringify(summaryRow({ valid: true, issues: [] })),
        '{"windowId":"9:1-4","movieId":9,"va',
      ].join('\n'),
    );
    const rows = readGenerated<SummaryRow>('scene-summary.jsonl', dir);
    expect(rows.size).toBe(1);
    expect(rows.get('7:100-105')!.valid).toBe(true);
  });

  it('treats a missing file as an empty store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-store-'));
    expect(readGenerated<SummaryRow>('scene-summary.jsonl', dir).size).toBe(0);
  });
});

describe('parseWindowId', () => {
  it('splits movie and span', () => {
    expect(parseWindowId('11:120-131')).toEqual({ movieId: 11, startSeq: 120, endSeq: 131 });
  });

  it('refuses a malformed id', () => {
    expect(() => parseWindowId('11:120')).toThrow();
  });
});

describe('revalidation', () => {
  it('rescues a pronoun false positive under the current lint', () => {
    const row = summaryRow({});
    expect(rescuable(row)).toBe(true);
    const fixed = revalidateRow(row, windowTexts, 'The Godfather');
    expect(fixed).not.toBeNull();
    expect(fixed!.valid).toBe(true);
    expect(fixed!.issues).toEqual([]);
    expect(fixed!.windowId).toBe(row.windowId);
    expect(fixed!.inputHash).toBe(row.inputHash);
    expect(fixed!.promptVersion).toBe(row.promptVersion);
    expect(fixed!.model).toBe(row.model);
  });

  it('leaves a genuine invented noun untouched', () => {
    const row = summaryRow({
      summary: 'He petitions Corleone for justice.',
      issues: [{ kind: 'invented-noun', detail: '"Corleone" appears nowhere in the window' }],
    });
    expect(rescuable(row)).toBe(true);
    expect(revalidateRow(row, ['You come to me.', 'I ask for justice.'], 'Some Film')).toBeNull();
  });

  it('does not consider refusals or range failures rescuable', () => {
    expect(rescuable(summaryRow({ refused: true, headline: undefined, summary: undefined }))).toBe(
      false,
    );
    expect(
      rescuable(
        summaryRow({ issues: [{ kind: 'bad-range', detail: 'evidence 1-2 outside window' }] }),
      ),
    ).toBe(false);
    expect(rescuable(summaryRow({ valid: true, issues: [] }))).toBe(false);
  });
});

describe('repairTargets', () => {
  it('picks only rows still failing after revalidation', () => {
    const rows = new Map<string, SummaryRow>([
      ['1:1-5', summaryRow({ windowId: '1:1-5', movieId: 1, valid: true, issues: [] })],
      ['2:1-5', summaryRow({ windowId: '2:1-5', movieId: 2, valid: false })],
      ['3:1-5', summaryRow({ windowId: '3:1-5', movieId: 3, valid: false, refused: true })],
    ]);
    expect(repairTargets(rows).map((r) => r.windowId)).toEqual(['2:1-5']);
  });
});

describe('selectWindows', () => {
  const filmLines = [
    { seq: 100, text: 'You come to me on the day of my wedding.' },
    { seq: 101, text: 'I ask for justice.' },
    { seq: 200, text: 'Leave the gun.' },
    { seq: 201, text: 'Take the cannoli.' },
  ];
  const spanA = { startSeq: 100, endSeq: 101 };
  const spanB = { startSeq: 200, endSeq: 201 };
  const hashA = inputHash(filmLines.slice(0, 2).map((l) => l.text));

  it('skips up-to-date windows on a normal run and keeps stale ones', () => {
    const existing = new Map([['7:100-101', { inputHash: hashA, promptVersion: 1 }]]);
    const picked = selectWindows(7, filmLines, [spanA, spanB], existing, 1, false);
    expect(picked.map((w) => w.windowId)).toEqual(['7:200-201']);
    expect(picked[0]!.feedback).toBeUndefined();
  });

  it('regenerates stored windows on a repair run, carrying feedback', () => {
    const existing = new Map([['7:100-101', { inputHash: hashA, promptVersion: 1 }]]);
    const feedback = new Map([['7:100-101', ['"They" appears nowhere in the window']]]);
    const picked = selectWindows(7, filmLines, [spanA], existing, 1, true, feedback);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.feedback).toEqual(['"They" appears nowhere in the window']);
  });

  it('drops spans with no surviving lines', () => {
    expect(
      selectWindows(7, filmLines, [{ startSeq: 900, endSeq: 999 }], new Map(), 1, true),
    ).toEqual([]);
  });
});

describe('windowPayload', () => {
  const base = {
    windowId: '7:100-101',
    movieId: 7,
    startSeq: 100,
    endSeq: 101,
    lines: [{ seq: 100, text: 'You come to me.' }],
  };

  it('serializes feedback only when a window carries it', () => {
    const movie = { title: 'The Godfather', year: 1972 };
    const plain = JSON.parse(JSON.stringify(windowPayload(base, movie))) as Record<string, unknown>;
    expect('feedback' in plain).toBe(false);
    const repaired = JSON.parse(
      JSON.stringify(windowPayload({ ...base, feedback: ['no names'] }, movie)),
    ) as Record<string, unknown>;
    expect(repaired.feedback).toEqual(['no names']);
    expect(repaired.title).toBe('The Godfather');
  });
});

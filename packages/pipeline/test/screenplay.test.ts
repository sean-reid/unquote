import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractScreenplayLines, findScriptHref } from '../src/util/imsdb.js';
import { isCue, parseDialogue, splitBlockText } from '../src/util/screenplay.js';
import type { ScreenplayLine } from '../src/util/screenplay.js';

function plain(lines: string[]): ScreenplayLine[] {
  return lines.map((text) => ({ text, bold: false }));
}

describe('isCue', () => {
  it('accepts character names with qualifiers', () => {
    expect(isCue('          DETECTIVE')).toBe(true);
    expect(isCue("DETECTIVE (CONT'D)")).toBe(true);
    expect(isCue('DETECTIVE (V.O.)')).toBe(true);
    expect(isCue('OBI-WAN')).toBe(true);
  });

  it('rejects slugs, transitions, and boilerplate', () => {
    expect(isCue('INT. WAREHOUSE - NIGHT')).toBe(false);
    expect(isCue('CUT TO:')).toBe(false);
    expect(isCue('FADE IN')).toBe(false);
    expect(isCue('THE END')).toBe(false);
    expect(isCue('MORE')).toBe(false);
    expect(isCue('42')).toBe(false);
    expect(isCue('A very long line that could not possibly be a name')).toBe(false);
  });
});

describe('parseDialogue', () => {
  it('collects dialogue under a cue and stops at blank lines', () => {
    const blocks = parseDialogue(
      plain([
        '          DETECTIVE',
        '     Where were you on the night of',
        '     the fourteenth?',
        '',
        'The Detective slams the file on the table.',
      ]),
    );
    expect(blocks).toEqual([
      { character: 'Detective', text: 'Where were you on the night of the fourteenth?' },
    ]);
  });

  it('drops parentheticals inside dialogue', () => {
    const blocks = parseDialogue(
      plain(['          SUSPECT', '     (lighting a cigarette)', '     You already know.']),
    );
    expect(blocks).toEqual([{ character: 'Suspect', text: 'You already know.' }]);
  });

  it('stops when indentation falls back to the action margin', () => {
    const blocks = parseDialogue(
      plain(['          DETECTIVE', '     Everyone talks.', 'A door bursts open somewhere.']),
    );
    expect(blocks).toEqual([{ character: 'Detective', text: 'Everyone talks.' }]);
  });

  it('handles flattened scripts without indentation', () => {
    const blocks = parseDialogue(plain(['DETECTIVE', 'Everyone talks.', '', 'He leaves.']));
    expect(blocks).toEqual([{ character: 'Detective', text: 'Everyone talks.' }]);
  });
});

describe('splitBlockText', () => {
  it('splits a monologue into sentences', () => {
    expect(splitBlockText('Everyone talks. Eventually. You will too, friend!')).toEqual([
      'Everyone talks.',
      'Eventually.',
      'You will too, friend!',
    ]);
  });
});

describe('imsdb page parsing', () => {
  it('extracts screenplay lines with bold flags and parses the fixture', async () => {
    const html = await readFile(resolve(__dirname, 'fixtures/screenplay-page.html'), 'utf8');
    const lines = extractScreenplayLines(html);
    expect(lines.some((l) => l.bold && /INT\. WAREHOUSE/.test(l.text))).toBe(true);

    const blocks = parseDialogue(lines);
    expect(blocks).toEqual([
      { character: 'Detective', text: 'Where were you on the night of the fourteenth?' },
      { character: 'Suspect', text: "You already know the answer. That's why you're sweating." },
      { character: 'Detective', text: 'Everyone talks. Eventually.' },
    ]);
    const all = blocks.map((b) => b.text).join(' ');
    expect(all).not.toMatch(/bare bulb|slams the file|Written by/);
  });

  it('finds the script link on a movie page', () => {
    expect(findScriptHref('<a href="/scripts/Fixture-Script.html">Read Script</a>')).toBe(
      '/scripts/Fixture-Script.html',
    );
  });
});

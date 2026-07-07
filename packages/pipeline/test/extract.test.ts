import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDivByClass, splitCues } from '../src/util/html.js';

const page = readFileSync(resolve(import.meta.dirname, 'fixtures/script-page.html'), 'utf8');

describe('extractDivByClass', () => {
  it('finds the transcript container and stops at its closing tag', () => {
    const inner = extractDivByClass(page, 'scrolling-script-container');
    expect(inner).not.toBeNull();
    expect(inner).toContain('Chrissy');
    expect(inner).not.toContain('site footer');
  });

  it('returns null when the class is absent', () => {
    expect(extractDivByClass(page, 'no-such-container')).toBeNull();
  });
});

describe('splitCues', () => {
  it('yields one cue per <br> fragment, cleaned of tags and whitespace', () => {
    const inner = extractDivByClass(page, 'scrolling-script-container')!;
    const cues = splitCues(inner);
    expect(cues.length).toBeGreaterThan(40);
    expect(cues[0]).toBe("- What's your name again?");
    expect(cues).toContain("How come the sun didn't");
    expect(cues.every((c) => c.length > 0 && !c.includes('<'))).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractCues, movieUrl, pageYear } from '../src/util/subslikescript.js';

const page = readFileSync(
  resolve(import.meta.dirname, 'fixtures/subslikescript-page.html'),
  'utf8',
);

describe('movieUrl', () => {
  it('slugs the title and appends the imdb digits', () => {
    expect(movieUrl('The Dark Knight', '468569')).toBe(
      'https://subslikescript.com/movie/The_Dark_Knight-468569',
    );
  });

  it('handles punctuation and ampersands', () => {
    expect(movieUrl('Birdman or (The Unexpected Virtue of Ignorance)', '2562232')).toBe(
      'https://subslikescript.com/movie/Birdman_or_The_Unexpected_Virtue_of_Ignorance-2562232',
    );
    expect(movieUrl('Fast & Furious', '1013752')).toBe(
      'https://subslikescript.com/movie/Fast_and_Furious-1013752',
    );
  });
});

describe('pageYear', () => {
  it('reads the year from the heading', () => {
    expect(pageYear(page)).toBe(2008);
  });
});

describe('extractCues', () => {
  it('joins the cue lines of each subtitle cue', () => {
    const cues = extractCues(page);
    expect(cues).toHaveLength(6);
    expect(cues[0]).toBe("- Three of a kind, let's do this. - That's it? Three guys?");
    expect(cues[1]).toBe('Two guys on the roof. Every guy gets a share. Five shares is plenty.');
  });

  it('returns nothing when the container is missing', () => {
    expect(extractCues('<html><body><p>no transcript</p></body></html>')).toEqual([]);
  });
});

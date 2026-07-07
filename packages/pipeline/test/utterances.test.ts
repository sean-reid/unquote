import { describe, expect, it } from 'vitest';
import {
  buildUtterances,
  cleanCueText,
  isMusicCue,
  splitTurns,
} from '../src/util/utterances.js';

describe('cleanCueText', () => {
  it('strips bracketed sound labels', () => {
    expect(cleanCueText('[THUNDER RUMBLING] Get inside.')).toBe('Get inside.');
  });

  it('strips parenthetical stage directions and orphaned halves', () => {
    expect(cleanCueText('(SIGHS) Fine, have it your way.')).toBe('Fine, have it your way.');
    expect(cleanCueText('GROANING) Not again.')).toBe('Not again.');
    expect(cleanCueText('Cut the rope! (CHEERING')).toBe('Cut the rope!');
  });

  it('drops leading speaker labels', () => {
    expect(cleanCueText('BRODY: Get out of the water!')).toBe('Get out of the water!');
  });

  it('repairs subtitle OCR damage', () => {
    expect(cleanCueText("l'm not sure wouIdn't matter")).toBe("I'm not sure wouldn't matter");
    expect(cleanCueText('it"s over, l said')).toBe("it's over, I said");
    expect(cleanCueText("we weren 't there")).toBe("we weren't there");
  });
});

describe('isMusicCue', () => {
  it('flags note and hash marked lyrics', () => {
    expect(isMusicCue('♪ Show me the way to go home ♪')).toBe(true);
    expect(isMusicCue('# Somewhere beyond the sea')).toBe(true);
    expect(isMusicCue('She said no.')).toBe(false);
  });
});

describe('splitTurns', () => {
  it('splits dash-marked dual-speaker cues into separate turns', () => {
    expect(splitTurns("- What, his name's Teddy? - Teddy, yeah")).toEqual([
      { text: "What, his name's Teddy?", newSpeaker: true },
      { text: 'Teddy, yeah', newSpeaker: true },
    ]);
  });

  it('treats an undashed cue as a single turn', () => {
    expect(splitTurns('Slow up. Slow down some.')).toEqual([
      { text: 'Slow up. Slow down some.', newSpeaker: false },
    ]);
  });

  it('does not split hyphenated words', () => {
    expect(splitTurns('- He was a well-known man')).toEqual([
      { text: 'He was a well-known man', newSpeaker: true },
    ]);
  });
});

describe('buildUtterances', () => {
  it('merges a sentence split across cues', () => {
    const { texts } = buildUtterances(["How come the sun didn't", 'use to shine in here?']);
    expect(texts).toEqual(["How come the sun didn't use to shine in here?"]);
  });

  it('keeps complete cues separate', () => {
    const { texts } = buildUtterances(['Help me!', "I'm coming. I'm coming."]);
    expect(texts).toEqual(['Help me!', "I'm coming. I'm coming."]);
  });

  it('starts a new utterance at a dash turn even mid-flow', () => {
    const { texts } = buildUtterances(['- Where are we going?', '- Swimming.']);
    expect(texts).toEqual(['Where are we going?', 'Swimming.']);
  });

  it('merges lowercase continuations past terminal punctuation', () => {
    const { texts } = buildUtterances(['We bought the house in the fall,', 'and this is summer.']);
    expect(texts).toEqual(['We bought the house in the fall, and this is summer.']);
  });

  it('drops music and counts it', () => {
    const { texts, dropped } = buildUtterances(['♪ Farewell and adieu ♪', 'Nice song.']);
    expect(texts).toEqual(['Nice song.']);
    expect(dropped.music).toBe(1);
  });

  it('drops cues that are only stage direction', () => {
    const { texts, dropped } = buildUtterances(['[DOOR SLAMS]', 'Who is it?']);
    expect(texts).toEqual(['Who is it?']);
    expect(dropped.empty).toBe(1);
  });

  it('caps runaway merges near 280 chars', () => {
    const fragment = 'and then something happened,';
    const { texts } = buildUtterances(Array(30).fill(fragment));
    expect(Math.max(...texts.map((t) => t.length))).toBeLessThanOrEqual(280);
    expect(texts.length).toBeGreaterThan(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildUtterances,
  cleanCueText,
  isMusicCue,
  lyricRunMask,
  splitLongText,
  splitTurns,
  unmarkedLyricMask,
} from '../src/util/utterances.js';
import { downrankSet, scoreFilm } from '../src/util/quality.js';

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

  it('strips de-bracketed bold markers from damaged source pages', () => {
    expect(cleanCueText("bYou've been a tremendous help./b")).toBe(
      "You've been a tremendous help.",
    );
    expect(cleanCueText('b...I need to use the chair./b')).toBe('...I need to use the chair.');
    expect(cleanCueText('but I never said that')).toBe('but I never said that');
  });

  it('repairs subtitle OCR damage', () => {
    expect(cleanCueText("l'm not sure wouIdn't matter")).toBe("I'm not sure wouldn't matter");
    expect(cleanCueText('it"s over, l said')).toBe("it's over, I said");
    expect(cleanCueText("we weren 't there")).toBe("we weren't there");
    expect(cleanCueText('you feII and got kiIIed')).toBe('you fell and got killed');
    expect(cleanCueText('World War II ended')).toBe('World War II ended');
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

  it('drops marked lyrics and counts them', () => {
    const { texts, dropped } = buildUtterances(['♪ Farewell and adieu ♪', 'Nice song.']);
    expect(texts).toEqual(['Nice song.']);
    expect(dropped.lyrics).toBe(1);
  });

  it('does not merge across a speaker change after a dangling fragment', () => {
    const { texts } = buildUtterances(["I'm gassy.. okay", 'Hold it right there, glitch!']);
    expect(texts).toEqual(["I'm gassy.. okay", 'Hold it right there, glitch!']);
  });

  it('never merges past a question or exclamation', () => {
    const { texts } = buildUtterances(['Are you serious?', 'dead serious.']);
    expect(texts).toEqual(['Are you serious?', 'dead serious.']);
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

describe('lyricRunMask', () => {
  it('bridges unmarked continuations between marked lyric cues', () => {
    const cues = [
      '# You are the one that I want',
      'ooh ooh ooh honey',
      '# The one that I want',
      'Tell me about it, stud.',
    ];
    const mask = lyricRunMask(cues, false);
    expect(mask).toEqual([true, true, true, false]);
  });

  it('extends over unpunctuated neighbors at run edges', () => {
    const cues = ['sailing away on the crest', '♪ of a wave ♪', "It's over."];
    expect(lyricRunMask(cues, false)).toEqual([true, true, false]);
  });

  it('leaves an unmarked film untouched', () => {
    const cues = ['Hello.', 'Goodbye.'];
    expect(lyricRunMask(cues, true)).toEqual([false, false]);
  });
});

describe('scoreFilm', () => {
  const healthy = [
    "You're gonna need a bigger boat.",
    'We were on the Indianapolis.',
    'Smile, you son of a...',
    'This shark, swallow you whole.',
  ];
  const damaged = [
    'weII l suppose lt was',
    'he said lt"s over and',
    'l dont know whlch way',
    'the paln ls everywhere now',
  ];

  it('scores clean dialogue above OCR damage', () => {
    const good = scoreFilm(1, healthy);
    const bad = scoreFilm(2, damaged);
    expect(good.score).toBeGreaterThan(bad.score + 20);
  });

  it('flags the worst decile for downranking', () => {
    const qualities = Array.from({ length: 20 }, (_, i) => scoreFilm(i, i < 2 ? damaged : healthy));
    const flagged = downrankSet(qualities);
    expect(flagged.size).toBe(2);
    expect(flagged.has(0)).toBe(true);
    expect(flagged.has(1)).toBe(true);
  });
});

describe('unmarkedLyricMask', () => {
  const rap = [
    'Protect me',
    'My technique go X speed',
    'On highways and Jet Skis',
    "Look, I ain't got no time",
    'To be hanging around nobody',
    'Trying to figure out',
    'If they good or evil',
    "I'm fighting the crime",
    'Saving your lives',
  ];
  const dialogue = [
    'Where were you last night?',
    'I was at home.',
    'Nobody saw you leave.',
    'Because I never left.',
    'Then explain the car.',
    'What car?',
    'The one outside your house.',
    'That is not mine.',
  ];

  it('flags a long unpunctuated title-case verse run', () => {
    // Enough surrounding dialogue that the film reads as normally punctuated;
    // a 16+ cue run needs no music marker (credits raps are never short).
    const longRap = [...rap, ...rap];
    const film = [...dialogue, ...dialogue, ...dialogue, ...dialogue, ...longRap];
    const mask = unmarkedLyricMask(film);
    expect(mask.slice(dialogue.length * 4).every(Boolean)).toBe(true);
    expect(mask.slice(0, dialogue.length * 4).every((m) => !m)).toBe(true);
  });

  it('flags a short verse run only next to a music signal', () => {
    const marked = ['["Sunflower" playing]', ...rap];
    const film = [...dialogue, ...dialogue, ...marked];
    const mask = unmarkedLyricMask(film);
    expect(mask.slice(dialogue.length * 2 + 1).every(Boolean)).toBe(true);
    const bare = [...dialogue, ...dialogue, ...rap];
    const bareMask = unmarkedLyricMask(bare);
    expect(bareMask.some(Boolean)).toBe(false);
  });

  it('spares a short recited poem with no music context', () => {
    const poem = [
      'Do not go gentle into that good night',
      'Old age should burn and rave at close of day',
      'Rage, rage against the dying of the light',
      'Though wise men at their end',
      'Know dark is right',
      'Because their words had forked no lightning',
    ];
    const film = [...dialogue, ...dialogue, ...poem, ...dialogue];
    expect(unmarkedLyricMask(film).some(Boolean)).toBe(false);
  });

  it('leaves normally punctuated dialogue alone', () => {
    expect(unmarkedLyricMask(dialogue).some(Boolean)).toBe(false);
  });

  it('stands down entirely on films with sparse punctuation', () => {
    const ocrDamaged = rap.concat(rap, rap);
    expect(unmarkedLyricMask(ocrDamaged).some(Boolean)).toBe(false);
  });
});

describe('quote-wrapped singing convention', () => {
  it('drops consecutive quote-wrapped sung lines but keeps a lone quoted line', () => {
    const cues = [
      'Thank you. Where are you going?',
      'To get my job back.',
      '"Yeah, yeah"',
      '"I am great Yeah, yeah"',
      '"I am..." Good grief.',
      "Is that what I'm drivin'?",
      'He said "make it so." Remember?',
    ];
    const mask = lyricRunMask(cues, false);
    expect(mask[2]).toBe(true);
    expect(mask[3]).toBe(true);
    expect(mask[0]).toBe(false);
    expect(mask[6]).toBe(false);
  });
});

describe('dash-masked speaker labels', () => {
  it('strips a label hidden behind a dash turn marker', () => {
    const { texts } = buildUtterances(['- ANNE: Abigail, do you think the people are angry?']);
    expect(texts).toEqual(['Abigail, do you think the people are angry?']);
  });

  it('strips labels from both sides of a dual-speaker cue', () => {
    const { texts } = buildUtterances(['- ANNE: Yes, I do. - SARAH: They are not.']);
    expect(texts).toEqual(['Yes, I do.', 'They are not.']);
  });

  it('leaves dash turns without labels alone', () => {
    const { texts } = buildUtterances(['- He was a well-known man.']);
    expect(texts).toEqual(['He was a well-known man.']);
  });
});

describe('splitLongText', () => {
  it('passes short text through untouched', () => {
    expect(splitLongText('Take your knives and throw them into the sea.')).toEqual([
      'Take your knives and throw them into the sea.',
    ]);
  });

  it('splits a paragraph cue at sentence boundaries near the cap', () => {
    const paragraph =
      'Mandela has traveled to Durban in an effort to persuade one hundred thousand angry ' +
      'young supporters to make peace. Take your knives and your guns and throw them into the sea. ' +
      'After four years of talks the day black South Africans have been fighting for has finally ' +
      'arrived. For the first time they are free to cast their vote along side whites. And an ' +
      'estimated twenty three million people went to the polls today. Never, never and never ' +
      'again shall it be that this beautiful land will again experience the oppression of one ' +
      'by another and suffer the indignity of being the skunk of the world.';
    const { texts } = buildUtterances([paragraph]);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(280);
    }
    expect(texts[0]).toMatch(/^Mandela has traveled/);
    expect(texts.join(' ')).toContain('skunk of the world');
    for (const text of texts) {
      expect(text).toMatch(/^[A-Z"']/);
    }
  });

  it('falls back to commas and spaces when punctuation is missing', () => {
    const runOn = Array(20).fill('they cheer for the team and wave the flags').join(', ');
    const chunks = splitLongText(runOn);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(280);
    }
    expect(chunks.join(', ').replace(/, ,/g, ',')).toBeTruthy();
  });
});

describe('label-only cues', () => {
  it('drops a cue that is nothing but a speaker label', () => {
    const { texts, dropped } = buildUtterances(['WOMAN:', 'I know, I did.']);
    expect(texts).toEqual(['I know, I did.']);
    expect(dropped.empty).toBe(1);
  });
});

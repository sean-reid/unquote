/**
 * Subtitle cues are display fragments, not spoken lines: sentences split across
 * cues, two speakers share one cue behind "- " markers, and sound labels ride
 * along in brackets. This module rebuilds utterances from ordered cues.
 */

// Leading speaker labels like "MAN:", "Don Corleone:" (1-3 capitalized words then a colon).
const SPEAKER_LABEL = /^[A-Z][A-Za-z'.]*(?:\s+[A-Z][A-Za-z'.]*){0,2}:\s+/;

const MAX_UTTERANCE_CHARS = 280;

/** Lyric cues are marked with music notes or hash marks anywhere in the cue. */
export function isMusicCue(text: string): boolean {
  return /[♪#]/.test(text);
}

/** Some sources wrap sung lines in double quotes instead of music marks. */
function isQuoteWrapped(text: string): boolean {
  return /^["“][^"”]+["”]$/.test(text.trim());
}

/**
 * Sources mark lyrics inconsistently: Grease hashes some lyric lines but not
 * their continuations. Treat marked cues as anchors and drop whole runs, with
 * anchors closer than the gap bridged into one interval and the interval edges
 * extended over unpunctuated neighbors (mid-verse fragments). Musicals get a
 * wider gap since their lyric coverage is denser and their marking spottier.
 */
export function lyricRunMask(cues: string[], musical: boolean): boolean[] {
  const mask = cues.map(() => false);
  const anchors: number[] = [];
  cues.forEach((cue, i) => {
    // A lone quote-wrapped cue may be a character quoting something; two in a
    // row is the singing convention (Bruce Almighty wraps every sung line).
    const sung =
      isQuoteWrapped(cue) &&
      ((i > 0 && isQuoteWrapped(cues[i - 1]!)) ||
        (i + 1 < cues.length && isQuoteWrapped(cues[i + 1]!)));
    if (isMusicCue(cue) || sung) anchors.push(i);
  });
  if (anchors.length === 0) return mask;

  const gap = musical ? 6 : 3;
  const unpunctuated = (i: number): boolean =>
    i >= 0 && i < cues.length && !/[.?!…]["'”’]?\s*$/.test(cues[i]!.trim());

  let start = anchors[0]!;
  let end = anchors[0]!;
  const intervals: Array<[number, number]> = [];
  for (const anchor of anchors.slice(1)) {
    if (anchor - end <= gap) {
      end = anchor;
    } else {
      intervals.push([start, end]);
      start = anchor;
      end = anchor;
    }
  }
  intervals.push([start, end]);

  for (let [lo, hi] of intervals) {
    while (unpunctuated(lo - 1)) lo -= 1;
    while (unpunctuated(hi + 1)) hi += 1;
    for (let i = lo; i <= hi; i++) mask[i] = true;
  }
  return mask;
}

/**
 * Unmarked lyrics (credits raps, musicals whose source hashes nothing) have a
 * shape dialogue never sustains: long runs of cues that end without terminal
 * punctuation while starting in title case, verse after verse. Flag runs of 6+
 * cues where at most 20% end punctuated and at least 60% start uppercase. Only
 * applies when the film itself is normally punctuated, so OCR-damaged sources
 * do not lose real dialogue to this rule.
 */
export function unmarkedLyricMask(cues: string[]): boolean[] {
  const mask = cues.map(() => false);
  const punctuated = (cue: string): boolean => /[.?!…]["'”’]?\s*$/.test(cue.trim());
  const filmRate = cues.length ? cues.filter(punctuated).length / cues.length : 0;
  if (filmRate < 0.6) return mask;

  // Short verse-shaped runs are ambiguous: Interstellar's recited "Do not go
  // gentle" reads exactly like a verse. Long runs are always songs; short ones
  // count only with a music signal ("[song playing]", humming, notes) nearby.
  const MIN_RUN = 6;
  const UNCONDITIONAL_RUN = 16;
  const MUSIC_CONTEXT = /[♪#]|[[(][^\])]*\b(playing|singing|song|music|humming|vocalizing)\b/i;
  const nearMusic = (lo: number, hi: number): boolean => {
    for (let i = Math.max(0, lo - 3); i <= Math.min(cues.length - 1, hi + 3); i++) {
      if (MUSIC_CONTEXT.test(cues[i]!)) return true;
    }
    return false;
  };

  let start = 0;
  while (start < cues.length) {
    if (punctuated(cues[start]!)) {
      start += 1;
      continue;
    }
    let end = start;
    let unpunct = 0;
    let upper = 0;
    let length = 0;
    // Grow the run while it keeps looking like verse: sparse punctuation overall.
    for (let i = start; i < cues.length; i++) {
      const cue = cues[i]!.trim();
      length += 1;
      if (!punctuated(cue)) unpunct += 1;
      if (/^["'”’]?[A-Z]/.test(cue)) upper += 1;
      if (unpunct / length < 0.8) break;
      end = i;
    }
    const runLength = end - start + 1;
    const verseShaped = runLength >= MIN_RUN && upper / length >= 0.6;
    if (verseShaped && (runLength >= UNCONDITIONAL_RUN || nearMusic(start, end))) {
      for (let i = start; i <= end; i++) mask[i] = true;
    }
    start = end + 1;
  }
  return mask;
}

/** Strip stage directions, speaker labels, and subtitle OCR damage from one cue. */
export function cleanCueText(raw: string): string {
  return (
    raw
      // Some source pages lost the angle brackets off their bold tags, leaving
      // literal "bYou've been a tremendous help./b" pairs around every cue.
      .replace(/^\s*b(\S.*?)\/b\s*$/, '$1')
      .replace(/\s*\/b(?=\s|$)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ') // [sound or speaker label]
      .replace(/\([^)]*\)/g, ' ') // (stage direction)
      .replace(/^[A-Z][A-Z\s,]*\)\s*/, '') // orphaned "GROANING) " from a cue break
      .replace(/\s*\([A-Z][A-Z\s,]*$/, '') // orphaned trailing "(CHEERING"
      .replace(/[|@]+/g, ' ') // stray subtitle markers
      .replace(SPEAKER_LABEL, '')
      .replace(/([a-z])"([a-z])/g, "$1'$2") // it"s -> it's
      // Subtitle OCR confuses "l" and "I": mid-word capital I is really l
      // (wouIdn't, feII, kiIIed), and a leading lowercase l is really I (l'm).
      .replace(/([a-z])II(?=[a-z]|\b)/g, '$1ll')
      .replace(/([a-z])I([a-z])/g, '$1l$2')
      .replace(/([a-z])I([a-z])/g, '$1l$2')
      .replace(/\bl'(m|ll|ve|d|re|s)\b/g, "I'$1")
      .replace(/\bl\b/g, 'I')
      .replace(/(\w)\s+'(t|s|re|ll|ve|d|m)\b/gi, "$1'$2") // weren 't -> weren't
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export interface Turn {
  text: string;
  /** True when the cue marked this as a new speaker with a leading dash. */
  newSpeaker: boolean;
}

/**
 * Split one cleaned cue into speaker turns. A cue that opens with a dash uses
 * the subtitle convention where every "- " starts a new speaker; other cues
 * are a single turn (mid-line dashes there are usually pauses, not speakers).
 */
export function splitTurns(cue: string): Turn[] {
  if (!/^[-–]\s*/.test(cue)) {
    return [{ text: cue, newSpeaker: false }];
  }
  const body = cue.replace(/^[-–]\s*/, '');
  return body
    .split(/\s[-–]\s+(?=\S)/)
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ text, newSpeaker: true }));
}

export interface BuildResult {
  texts: string[];
  dropped: { lyrics: number; empty: number; short: number };
}

export interface BuildOptions {
  /** TMDb Music genre; widens lyric-run detection. */
  musical?: boolean;
}

// Questions and exclamations are hard stops: dialogue never continues a
// sentence past them, so an uppercase follow-on is a new speaker or new line.
const HARD_STOP = /[?!]["'”’]?$/;

/** Rebuild utterances from one film's ordered cues. */
export function buildUtterances(cues: string[], options: BuildOptions = {}): BuildResult {
  const dropped = { lyrics: 0, empty: 0, short: 0 };
  const texts: string[] = [];
  let buffer = '';

  const flush = (): void => {
    const text = buffer.trim();
    buffer = '';
    if (text.length === 0) return;
    if (text.length < 2 || !/[a-zA-Z]/.test(text)) {
      dropped.short += 1;
      return;
    }
    texts.push(text);
  };

  const marked = lyricRunMask(cues, options.musical ?? false);
  const unmarked = unmarkedLyricMask(cues);
  const lyric = marked.map((m, i) => m || unmarked[i]!);

  cues.forEach((raw, index) => {
    if (lyric[index]) {
      dropped.lyrics += 1;
      return;
    }
    const cleaned = cleanCueText(raw);
    if (cleaned.length === 0) {
      dropped.empty += 1;
      return;
    }
    for (const turn of splitTurns(cleaned)) {
      if (buffer.length === 0) {
        buffer = turn.text;
        continue;
      }
      // Merge only a genuine continuation: same speaker, next fragment starts
      // lowercase, and the buffer does not end on a hard stop. An uppercase
      // start after a dangling fragment is far more often a speaker change
      // than a sentence continuing into a proper noun.
      const continues = !turn.newSpeaker && /^[a-z]/.test(turn.text) && !HARD_STOP.test(buffer);
      if (continues && buffer.length + turn.text.length + 1 <= MAX_UTTERANCE_CHARS) {
        buffer = `${buffer} ${turn.text}`;
      } else {
        flush();
        buffer = turn.text;
      }
    }
  });
  flush();

  return { texts, dropped };
}

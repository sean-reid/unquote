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
      // A cue that is nothing but a speaker label ('WOMAN:') names, says nothing.
      .replace(/^[A-Z][A-Za-z'.]*(?:\s+[A-Z][A-Za-z'.]*){0,2}:$/, '')
      // Group labels survive mid-text after merges ("ALL: Aye!"); the leading
      // form is caught by SPEAKER_LABEL, this catches the rest.
      .replace(/(^|\s)(?:ALL|BOTH|CROWD|EVERYONE|TOGETHER)\s*:\s+/g, '$1')
      // Quote marks around a single word fragment the embedding (Say "what"
      // again); the word carries the meaning, the marks carry nothing.
      .replace(/["\u201c\u201d]([A-Za-z']+)["\u201c\u201d]/g, '$1')
      .replace(/([a-z])"([a-z])/g, "$1'$2") // it"s -> it's
      // Subtitle OCR confuses "l" and "I": mid-word capital I is really l
      // (wouIdn't, feII, kiIIed), and a leading lowercase l is really I (l'm).
      .replace(/([a-z])II(?=[a-z]|\b)/g, '$1ll')
      .replace(/([a-z])I([a-z])/g, '$1l$2')
      .replace(/([a-z])I([a-z])/g, '$1l$2')
      .replace(/\bl'(m|ll|ve|d|re|s)\b/g, "I'$1")
      .replace(/\bl\b/g, 'I')
      .replace(/(\w)\s+'(t|s|re|ll|ve|d|m)\b/gi, "$1'$2") // weren 't -> weren't
      // An opening quote whose closer never arrives is a cue-break artifact.
      .replace(/^\s*["\u201c](?=[^"\u201c\u201d]*$)/, '')
      .replace(/\s+/g, ' ')
      // Subtitle rips space punctuation the French way ("Manure ! I hate
      // manure !"); a space before punctuation is never right in English.
      .replace(/ (?=[.,!?;:])/g, '')
      .trim()
  );
}

/**
 * Subtitle-OCR sources misread capital I as lowercase l ("lf you build it",
 * "lt's alive"). The rewrite is unambiguous but only runs in films that show
 * the OCR signature, so a clean transcript is never touched — "lt." is a
 * lowercased Lieutenant in a film this never fires on. It must see cleaned
 * text: fused markup ("blt's okay./b") hides the word boundaries the rewrite
 * anchors on. The l fix needs a following consonant, boundary, or apostrophe:
 * "look", "llama", and "lbs" stay as written.
 */
const OCR_SIGNATURE = /\b(?:lf|lt|ln|l'm|l've|l'll|l'd)\b/;

export function fixOcrArtifacts(cues: string[]): string[] {
  let hits = 0;
  for (const cue of cues) {
    if (OCR_SIGNATURE.test(cue)) hits += 1;
    if (hits >= 3) break;
  }
  if (hits < 3) return cues;
  return cues.map((cue) => cue.replace(/\bl(?=[cdfgjkmnpqstvwxz]|\b|')/g, 'I'));
}

/**
 * Bracketed directions can straddle cue boundaries ("[TIRES SCREECHING" then
 * "THEN CAR HORN HONKING]"). Track the open bracket across cues and drop
 * everything until its closer; single-cue brackets are untouched here and die
 * later in cleanCueText.
 */
export function stripCrossCueDirections(cues: string[]): string[] {
  let openBracket = false;
  return cues.map((cue) => {
    let out = '';
    let i = 0;
    while (i < cue.length) {
      const ch = cue[i]!;
      if (openBracket) {
        if (ch === ']') openBracket = false;
        i += 1;
        continue;
      }
      if (ch === '[') {
        const close = cue.indexOf(']', i);
        if (close === -1) {
          openBracket = true;
          i = cue.length;
          continue;
        }
        i = close + 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out.replace(/\s+/g, ' ').trim();
  });
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
  return (
    body
      .split(/\s[-–]\s+(?=\S)/)
      .map((text) => text.trim())
      // A dash hides the label from the cue-level strip ("- ANNE: Abigail...");
      // each turn starts a speaker, so strip again here.
      .map((text) => text.replace(SPEAKER_LABEL, ''))
      .filter((text) => text.length > 0)
      .map((text) => ({ text, newSpeaker: true }))
  );
}

/**
 * A single cue can arrive as a whole paragraph (fallback-extracted films ship
 * entire scenes in one cue). Split at sentence boundaries into chunks near the
 * cap, falling back to commas and then to the last space when the source has
 * no usable punctuation.
 */
export function splitLongText(text: string, cap = MAX_UTTERANCE_CHARS): string[] {
  if (text.length <= cap) return [text];
  const sentences = text.split(/(?<=[.?!…]["'”’]?)\s+/);
  const chunks: string[] = [];
  let current = '';
  const push = (): void => {
    if (current.length > 0) chunks.push(current);
    current = '';
  };
  const hardSplit = (piece: string): void => {
    let rest = piece;
    while (rest.length > cap) {
      const comma = rest.lastIndexOf(', ', cap);
      const space = rest.lastIndexOf(' ', cap);
      const cut = comma > cap / 2 ? comma + 1 : space > 0 ? space : cap;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest.length > 0) chunks.push(rest);
  };
  for (const sentence of sentences) {
    if (sentence.length > cap) {
      push();
      hardSplit(sentence);
      continue;
    }
    if (current.length + sentence.length + 1 > cap) push();
    current = current.length === 0 ? sentence : `${current} ${sentence}`;
  }
  push();
  return chunks;
}

export interface BuildResult {
  texts: string[];
  dropped: { lyrics: number; empty: number; short: number; credits: number };
}

export interface BuildOptions {
  /** TMDb Music genre; widens lyric-run detection. */
  musical?: boolean;
  /** Film title, for recognizing its own title card fused into a cue. */
  title?: string;
}

const lettersOnly = (text: string): string => text.replace(/[^a-z]/gi, '').toLowerCase();

/**
 * On-screen title cards fuse into dialogue cues ("PROMETHEUS Get Charlie.").
 * Strip a leading unpunctuated ALL-CAPS run when it matches the film's own
 * title (OCR-tolerant) or sits in the opening 3% before sentence-case text.
 * Punctuated shouting ("STOP! Get down!") keeps its caps.
 */
export function stripTitleCardPrefix(
  text: string,
  title: string | undefined,
  frac: number,
): string {
  const match = text.match(/^([A-Z][A-Z0-9 :&'-]{2,}?)\s+(?=[A-Z][a-z]|I\b)/);
  if (!match) return text;
  const run = match[1]!;
  if (/[.?!]$/.test(run.trim())) return text;
  const runLetters = lettersOnly(run);
  if (runLetters.length < 3) return text;
  const titleLetters = title ? lettersOnly(title) : '';
  const titleMatch =
    titleLetters.length >= 3 &&
    (runLetters === titleLetters ||
      (Math.abs(runLetters.length - titleLetters.length) <= 2 &&
        (titleLetters.startsWith(runLetters.slice(0, -1)) ||
          runLetters.startsWith(titleLetters.slice(0, -1)))));
  if (titleMatch || frac < 0.03) return text.slice(match[0].length);
  return text;
}

// Dedications and production credits read as dialogue to every other filter.
const CREDIT_TEXT =
  /\b(dedicated to|in (loving )?memory of|subtitles? (by|downloaded)|directed by|produced by|screenplay by|based (up)?on the (novel|book|play|story))\b/i;

function isCreditUtterance(text: string, index: number, total: number): boolean {
  if (CREDIT_TEXT.test(text)) return true;
  const margin = Math.max(1, Math.floor(total * 0.02));
  if (index < margin || index >= total - margin) {
    const letters = text.replace(/[^a-zA-Z]/g, '');
    const upper = letters.replace(/[^A-Z]/g, '');
    if (letters.length >= 8 && upper.length / letters.length > 0.5) return true;
  }
  return false;
}

// Questions and exclamations are hard stops: dialogue never continues a
// sentence past them, so an uppercase follow-on is a new speaker or new line.
const HARD_STOP = /[?!]["'”’]?$/;

/** Rebuild utterances from one film's ordered cues. */
export function buildUtterances(cues: string[], options: BuildOptions = {}): BuildResult {
  const dropped = { lyrics: 0, empty: 0, short: 0, credits: 0 };
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
  // Masks see the original cues (their music markers live in brackets); the
  // text pipeline sees cues with cross-cue direction spans removed.
  const stripped = stripCrossCueDirections(cues);
  // The gated OCR pass runs on cleaned text: markup fused to a misread
  // ("blt's okay./b") hides the word boundary the rewrite needs, so raw cues
  // would leave exactly the famous lines it exists to fix.
  const cleanedAll = fixOcrArtifacts(
    stripped.map((cue, index) =>
      cleanCueText(
        stripTitleCardPrefix(cue, options.title, cues.length > 0 ? index / cues.length : 0),
      ),
    ),
  );

  cues.forEach((_raw, index) => {
    if (lyric[index]) {
      dropped.lyrics += 1;
      return;
    }
    const cleaned = cleanedAll[index]!;
    if (cleaned.length === 0) {
      dropped.empty += 1;
      return;
    }
    for (const turn of splitTurns(cleaned)) {
      // A paragraph-sized single turn never merges; it splits into its own
      // utterances at sentence boundaries.
      if (turn.text.length > MAX_UTTERANCE_CHARS) {
        flush();
        for (const piece of splitLongText(turn.text)) {
          buffer = piece;
          flush();
        }
        continue;
      }
      if (buffer.length === 0) {
        buffer = turn.text;
        continue;
      }
      // Merge only a genuine continuation: same speaker, next fragment starts
      // lowercase, and the buffer does not end on a hard stop. An uppercase
      // start after a dangling fragment is far more often a speaker change
      // than a sentence continuing into a proper noun.
      // An ellipsis handing off to an ellipsis is one thought split for
      // timing ("Get busy living... / ...or get busy dying.").
      const ellipsisHandoff =
        !turn.newSpeaker && /(\.\.\.|\u2026)$/.test(buffer) && /^(\.\.\.|\u2026)/.test(turn.text);
      const continues =
        (!turn.newSpeaker && /^[a-z]/.test(turn.text) && !HARD_STOP.test(buffer)) ||
        ellipsisHandoff;
      if (continues && buffer.length + turn.text.length + 1 <= MAX_UTTERANCE_CHARS) {
        buffer = ellipsisHandoff
          ? `${buffer} ${turn.text.replace(/^(\.\.\.|\u2026)\s*/, '')}`
          : `${buffer} ${turn.text}`;
      } else {
        flush();
        buffer = turn.text;
      }
    }
  });
  flush();

  const kept = texts.filter((text, index) => {
    if (isCreditUtterance(text, index, texts.length)) {
      dropped.credits += 1;
      return false;
    }
    return true;
  });

  return { texts: kept, dropped };
}

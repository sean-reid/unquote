/**
 * Subtitle cues are display fragments, not spoken lines: sentences split across
 * cues, two speakers share one cue behind "- " markers, and sound labels ride
 * along in brackets. This module rebuilds utterances from ordered cues.
 */

// Leading speaker labels like "MAN:", "Don Corleone:" (1-3 capitalized words then a colon).
const SPEAKER_LABEL = /^[A-Z][A-Za-z'.]*(?:\s+[A-Z][A-Za-z'.]*){0,2}:\s+/;

// A buffer ending in terminal punctuation (optionally quoted) is a complete utterance.
const TERMINAL = /[.?!…]["'”’]?$/;

const MAX_UTTERANCE_CHARS = 280;

/** Lyric cues are marked with music notes or hash marks anywhere in the cue. */
export function isMusicCue(text: string): boolean {
  return /[♪#]/.test(text);
}

/** Strip stage directions, speaker labels, and subtitle OCR damage from one cue. */
export function cleanCueText(raw: string): string {
  return (
    raw
      .replace(/\[[^\]]*\]/g, ' ') // [sound or speaker label]
      .replace(/\([^)]*\)/g, ' ') // (stage direction)
      .replace(/^[A-Z][A-Z\s,]*\)\s*/, '') // orphaned "GROANING) " from a cue break
      .replace(/\s*\([A-Z][A-Z\s,]*$/, '') // orphaned trailing "(CHEERING"
      .replace(/[|@]+/g, ' ') // stray subtitle markers
      .replace(SPEAKER_LABEL, '')
      .replace(/([a-z])"([a-z])/g, "$1'$2") // it"s -> it's
      // Subtitle OCR confuses "l" and "I": mid-word capital I is really l
      // (wouIdn't), and a leading lowercase l is really I (l'm, standalone l).
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
  dropped: { music: number; empty: number; short: number };
}

/** Rebuild utterances from one film's ordered cues. */
export function buildUtterances(cues: string[]): BuildResult {
  const dropped = { music: 0, empty: 0, short: 0 };
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

  for (const raw of cues) {
    if (isMusicCue(raw)) {
      dropped.music += 1;
      continue;
    }
    const cleaned = cleanCueText(raw);
    if (cleaned.length === 0) {
      dropped.empty += 1;
      continue;
    }
    for (const turn of splitTurns(cleaned)) {
      if (buffer.length === 0) {
        buffer = turn.text;
        continue;
      }
      const continues = !turn.newSpeaker && (!TERMINAL.test(buffer) || /^[a-z]/.test(turn.text));
      if (continues && buffer.length + turn.text.length + 1 <= MAX_UTTERANCE_CHARS) {
        buffer = `${buffer} ${turn.text}`;
      } else {
        flush();
        buffer = turn.text;
      }
    }
  }
  flush();

  return { texts, dropped };
}

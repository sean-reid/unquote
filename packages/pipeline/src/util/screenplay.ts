/**
 * Screenplay dialogue extraction for IMSDb-style scripts. Unlike transcripts,
 * screenplays interleave dialogue with action description; the parser walks a
 * character-cue state machine and uses indentation, where the source preserves
 * it, to keep action lines out of dialogue blocks.
 */

export interface DialogueBlock {
  character: string;
  text: string;
}

export interface ScreenplayLine {
  text: string;
  /** True when the source marked the line bold (IMSDb wraps cues and slugs in b tags). */
  bold: boolean;
}

const CUE_ALLOWED = /^[A-Z0-9 .,'&-]+$/;
const SLUG_PREFIX =
  /^(INT|EXT|FADE|CUT|DISSOLVE|SMASH|MATCH|THE END|CONTINUED|OMITTED|ANGLE|CLOSE|WIDE|POV|INSERT|BACK TO|LATER|MONTAGE|TITLE|SUPER|CREDITS|SCENE|NEW ANGLE|REVERSE|MORE|FLASHBACK|END OF|INTERCUT|BEAT|PAGE|DRAFT|REVISION|SHOOTING|FINAL|SCREENPLAY|WRITTEN|STORY|BASED ON)\b/;

/** Trailing cue qualifiers such as (V.O.), (O.S.), (CONT'D). */
function stripParenthetical(line: string): string {
  return line
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A character cue: a short all-caps name line that is not a heading or transition. */
export function isCue(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 32) return false;
  const name = stripParenthetical(t);
  if (name.length === 0 || name.length > 28) return false;
  if (name.includes(':')) return false;
  if (!CUE_ALLOWED.test(name)) return false;
  if (/[a-z]/.test(name)) return false;
  if (!/[A-Z]/.test(name)) return false;
  if (/^\d+$/.test(name)) return false;
  if (SLUG_PREFIX.test(name)) return false;
  return true;
}

function indentOf(line: string): number {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

/** A line that reads like scene description rather than speech. */
function looksLikeAction(text: string): boolean {
  const t = text.trim();
  if (SLUG_PREFIX.test(t)) return true;
  const letters = t.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 8) {
    const upper = letters.replace(/[^A-Z]/g, '').length;
    if (upper / letters.length > 0.7) return true;
  }
  return false;
}

/**
 * Parse screenplay lines into dialogue blocks. A block opens at a character cue
 * and consumes lines until a blank line, the next cue, a bold line, or a line
 * whose indentation falls clearly back toward the action margin. Scripts with
 * flattened indentation degrade to the blank-line rule alone.
 */
export function parseDialogue(lines: ScreenplayLine[]): DialogueBlock[] {
  const blocks: DialogueBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isCue(line.text)) continue;
    const character = toTitleCase(stripParenthetical(line.text.trim()));
    const cueIndent = indentOf(line.text);
    i++;

    const spoken: string[] = [];
    let dialogueIndent: number | null = null;
    while (i < lines.length) {
      const candidate = lines[i]!;
      const trimmed = candidate.text.trim();
      if (trimmed === '' || candidate.bold || isCue(candidate.text)) break;
      const indent = indentOf(candidate.text);
      if (dialogueIndent === null) {
        // Dialogue sits at or left of its cue but right of the action margin.
        if (cueIndent > 2 && indent <= 1) break;
        if (looksLikeAction(trimmed)) break;
        dialogueIndent = indent;
      } else {
        if (indent < dialogueIndent - 1) break;
        if (looksLikeAction(trimmed)) break;
      }
      spoken.push(trimmed);
      i++;
    }
    i--;

    const text = spoken
      .join(' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 0) blocks.push({ character, text });
  }

  return blocks;
}

/** Split a dialogue block into sentence-sized cues so long monologues stay searchable. */
export function splitBlockText(text: string): string[] {
  return text
    .split(/(?<=[.?!…]["'”’]?)\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function toTitleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scene-summary windows come from the ladder's segment artifact, ranked per
 * film by distinctiveness. A segment's score is the mean genericness of its
 * beats; the least generic scenes are the ones cross-film navigation lands
 * on (bridges and neighbor lists suppress generic moments by construction),
 * so those generate first as tier 1 and the long tail completes later.
 */

export interface SegmentSpan {
  movieId: number;
  idx: number;
  startBeat: number;
  endBeat: number;
  startSeq: number;
  endSeq: number;
}

export interface RankedWindow {
  movieId: number;
  startSeq: number;
  endSeq: number;
  score: number;
}

export const TIER1_PER_FILM = 10;

/**
 * Rank one film's segments by mean beat genericness, least generic first.
 * beatBase is the film's first beat's index into the corpus-wide generic
 * array; ties keep segment order so reruns select identically.
 */
export function rankWindows(
  segments: SegmentSpan[],
  generic: ArrayLike<number>,
  beatBase: number,
): RankedWindow[] {
  return segments
    .map((s) => {
      let sum = 0;
      for (let b = s.startBeat; b <= s.endBeat; b++) sum += Number(generic[beatBase + b] ?? 0);
      return {
        movieId: s.movieId,
        startSeq: s.startSeq,
        endSeq: s.endSeq,
        score: sum / (s.endBeat - s.startBeat + 1),
        idx: s.idx,
      };
    })
    .sort((a, b) => a.score - b.score || a.idx - b.idx)
    .map(({ movieId, startSeq, endSeq, score }) => ({ movieId, startSeq, endSeq, score }));
}

/** Tier 1 is the surfaced slice per film; tier 2 the remainder. Selection
 * returns story order so generation payloads read front to back. */
export function tierWindows(ranked: RankedWindow[], tier: '1' | '2' | 'all'): RankedWindow[] {
  const chosen =
    tier === '1'
      ? ranked.slice(0, TIER1_PER_FILM)
      : tier === '2'
        ? ranked.slice(TIER1_PER_FILM)
        : ranked;
  return [...chosen].sort((a, b) => a.startSeq - b.startSeq);
}

/** A film with no segments falls back to its beats as windows. */
export function beatFallback(
  beats: Array<{ movieId: number; idx: number; startSeq: number; endSeq: number }>,
  generic: ArrayLike<number>,
  beatBase: number,
): RankedWindow[] {
  return rankWindows(
    beats.map((b) => ({ ...b, startBeat: b.idx, endBeat: b.idx })),
    generic,
    beatBase,
  );
}

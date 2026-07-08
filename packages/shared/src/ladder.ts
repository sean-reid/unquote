/**
 * The context ladder: a line belongs to a beat (a short exchange), a beat to a
 * segment (a scene-scale stretch found by similarity drop), a segment to the
 * film. UI copy never says beat or segment; the user-facing levels are
 * Exact line, Exchange, Scene, and Whole movie.
 */

export interface Beat {
  movieId: number;
  idx: number;
  startSeq: number;
  endSeq: number;
  /** Film position of the window center, 0 to 1. */
  arc: number;
  text: string;
}

export interface Segment {
  movieId: number;
  idx: number;
  startBeat: number;
  endBeat: number;
  startSeq: number;
  endSeq: number;
  arc: number;
}

export type ContextLevel = 'line' | 'beat' | 'segment' | 'movie';

/** One cross-film neighbor at some ladder level. */
export interface MomentNeighbor {
  movieId: number;
  title: string;
  year: number;
  posterPath: string | null;
  arc: number;
  /** Bounded excerpt of the matching moment. */
  excerpt: string;
  /** Where the excerpt starts, for linking into the film. */
  startSeq: number;
  score: number;
}

/** All four dial levels for one scrub position, fetched in a single request. */
export interface NeighborLevels {
  line: MomentNeighbor[];
  beat: MomentNeighbor[];
  segment: MomentNeighbor[];
  movie: MomentNeighbor[];
}

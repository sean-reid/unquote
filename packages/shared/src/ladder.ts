/**
 * The context ladder: a line belongs to a beat (a short exchange), a beat to a
 * segment (a scene-scale stretch found by similarity drop), a segment to the
 * film. UI copy never says beat or segment; the user-facing unit is the scene.
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

/** One cross-film neighbor moment. */
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

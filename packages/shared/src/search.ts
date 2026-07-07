/** A single retrieval arm. Fusion happens over per-arm ranked lists. */
export type SearchArm = 'exact' | 'keyword' | 'semantic';

export interface SearchHit {
  movieId: number;
  title: string;
  year: number;
  posterPath: string | null;
  /** Utterance position within the film's dialogue. */
  seq: number;
  /** Normalized position in the film, 0 to 1. */
  arc: number;
  text: string;
  /** Fused relevance score, higher is better. */
  score: number;
  /** Arms that surfaced this hit. */
  arms: SearchArm[];
  /** How many times this film says this exact line; hits are deduped to the best occurrence. */
  occurrences: number;
}

export interface MovieMatch {
  movieId: number;
  title: string;
  year: number;
  posterPath: string | null;
}

export interface SearchResponse {
  query: string;
  /** Hits ordered by fused score. */
  hits: SearchHit[];
  /** Number of leading hits considered strong; the UI divider goes after them. */
  strongCount: number;
  /** Present when the query names a film. */
  movie: MovieMatch | null;
}

/**
 * Reciprocal rank fusion. Each list is ranked best-first; a document's fused
 * score is the sum over lists of 1 / (k + rank). k=60 is the standard damping.
 */
export function rrf(rankLists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

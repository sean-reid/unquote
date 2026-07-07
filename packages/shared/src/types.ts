export interface Movie {
  id: number;
  title: string;
  year: number;
  decade: number;
  tmdbRating: number;
  tmdbVotes: number;
  posterPath: string | null;
  genreIds: number[];
  keywordIds: number[];
}

export interface Genre {
  id: number;
  name: string;
}

/** One reconstructed utterance of dialogue, the atomic search unit. */
export interface Line {
  movieId: number;
  /** Position of this utterance within the film's dialogue, starting at 0. */
  seq: number;
  /** Normalized position in the film, 0 to 1. */
  arc: number;
  text: string;
}

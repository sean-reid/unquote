export interface MovieRecord {
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

export interface ScriptRecord {
  movieId: number;
  source: string;
  kind: 'screenplay' | 'transcript';
  r2Key: string;
  chars: number;
}

export interface Cue {
  movieId: number;
  idx: number;
  text: string;
}

export interface Utterance {
  movieId: number;
  seq: number;
  arc: number;
  text: string;
}

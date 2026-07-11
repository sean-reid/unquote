import { error } from '@sveltejs/kit';
import {
  PERVASIVE_ALIKE_MIN,
  bridgePairs,
  movieHeader,
  pairSimilarity,
} from '$lib/server/movie.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ params }) => {
  const a = Number(params.id);
  const b = Number(params.other);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    error(404, 'no such pair');
  }

  const [movieA, movieB] = await Promise.all([movieHeader(a), movieHeader(b)]);
  if (!movieA || !movieB) error(404, 'no such pair');

  const [bridge, similarity] = await Promise.all([bridgePairs(a, b), pairSimilarity(a, b)]);
  return {
    movieA,
    movieB,
    pairs: bridge.pairs,
    // Pervasively similar films can honestly produce no single standout
    // moment; the empty copy must not read as "unrelated" for them.
    soundAlikeThroughout: bridge.pairs.length === 0 && similarity >= PERVASIVE_ALIKE_MIN,
  };
};

import { error } from '@sveltejs/kit';
import { BRIDGE_HIGH_AMBIENT, bridgePairs, movieHeader } from '$lib/server/movie.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ params }) => {
  const a = Number(params.id);
  const b = Number(params.other);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    error(404, 'no such pair');
  }

  const [movieA, movieB] = await Promise.all([movieHeader(a), movieHeader(b)]);
  if (!movieA || !movieB) error(404, 'no such pair');

  const bridge = await bridgePairs(a, b);
  return {
    movieA,
    movieB,
    pairs: bridge.pairs,
    soundAlikeThroughout: bridge.pairs.length === 0 && bridge.ambient >= BRIDGE_HIGH_AMBIENT,
  };
};

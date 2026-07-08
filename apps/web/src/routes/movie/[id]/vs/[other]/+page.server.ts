import { error } from '@sveltejs/kit';
import { bridgePairs, movieHeader } from '$lib/server/movie.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ params }) => {
  const a = Number(params.id);
  const b = Number(params.other);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    error(404, 'no such pair');
  }

  const [movieA, movieB] = await Promise.all([movieHeader(a), movieHeader(b)]);
  if (!movieA || !movieB) error(404, 'no such pair');

  return { movieA, movieB, pairs: await bridgePairs(a, b) };
};

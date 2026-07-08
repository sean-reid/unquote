import { error } from '@sveltejs/kit';
import { fiveLines, movieHeader, segmentBlocks, similarMovies } from '$lib/server/movie.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ params, url }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) error(404, 'no such film');

  const movie = await movieHeader(id);
  if (!movie) error(404, 'no such film');

  const [lines, segments, similar] = await Promise.all([
    fiveLines(id),
    segmentBlocks(id),
    similarMovies(id),
  ]);

  const seqParam = url.searchParams.get('seq');
  const seq = seqParam === null ? null : Number(seqParam);

  return {
    movie,
    lines,
    segments,
    similar,
    initialSeq: seq !== null && Number.isInteger(seq) && seq >= 0 ? seq : null,
  };
};

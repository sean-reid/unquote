import { error, json } from '@sveltejs/kit';
import { neighborLevels } from '$lib/server/movie.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ params, url, setHeaders }) => {
  const id = Number(params.id);
  const seq = Number(url.searchParams.get('seq'));
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(seq) || seq < 0) {
    error(400, 'movie id and seq required');
  }
  const levels = await neighborLevels(id, seq);
  if (!levels) error(404, 'no such line');
  setHeaders({ 'cache-control': 'public, max-age=300' });
  return json(levels);
};

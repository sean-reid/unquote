import { error, json } from '@sveltejs/kit';
import { scenePanel } from '$lib/server/movie.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ params, url, setHeaders }) => {
  const id = Number(params.id);
  const seq = Number(url.searchParams.get('seq'));
  const segmentParam = url.searchParams.get('segment');
  const segmentIdx = segmentParam === null ? null : Number(segmentParam);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(seq) || seq < 0) {
    error(400, 'movie id and seq required');
  }
  if (segmentIdx !== null && (!Number.isInteger(segmentIdx) || segmentIdx < 0)) {
    error(400, 'segment must be a non-negative integer');
  }
  const panel = await scenePanel(id, seq, segmentIdx);
  if (!panel) error(404, 'no such line');
  setHeaders({ 'cache-control': 'public, max-age=300' });
  return json(panel);
};

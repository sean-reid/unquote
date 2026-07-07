import { json } from '@sveltejs/kit';
import { logSearch } from '$lib/server/analytics.js';
import { search } from '$lib/server/search.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async (event) => {
  const query = event.url.searchParams.get('q')?.slice(0, 200) ?? '';
  const started = Date.now();
  const response = await search(query);
  logSearch(event, response, Date.now() - started);
  return json(response, {
    headers: { 'cache-control': 'public, max-age=60' },
  });
};

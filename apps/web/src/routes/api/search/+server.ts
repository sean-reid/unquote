import { json } from '@sveltejs/kit';
import { search } from '$lib/server/search.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ url }) => {
  const query = url.searchParams.get('q')?.slice(0, 200) ?? '';
  const response = await search(query);
  return json(response, {
    headers: { 'cache-control': 'public, max-age=60' },
  });
};

import { logSearch } from '$lib/server/analytics.js';
import { movieCount, search } from '$lib/server/search.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async (event) => {
  const query = event.url.searchParams.get('q')?.slice(0, 200) ?? '';
  if (!query.trim()) {
    return { response: null, filmCount: await movieCount() };
  }
  const started = Date.now();
  const response = await search(query);
  logSearch(event, response, Date.now() - started);
  return { response, filmCount: null };
};

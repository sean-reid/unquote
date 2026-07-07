import { search } from '$lib/server/search.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ url }) => {
  const query = url.searchParams.get('q')?.slice(0, 200) ?? '';
  if (!query.trim()) return { response: null };
  return { response: await search(query) };
};

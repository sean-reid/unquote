import type { Handle } from '@sveltejs/kit';
import { logPageview } from '$lib/server/analytics.js';
import { warmup } from '$lib/server/embed.js';

// Load the query encoder at boot rather than on the first search, so no user
// request ever pays the model cold start.
void warmup();

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  const isPage =
    event.request.method === 'GET' &&
    response.ok &&
    !event.url.pathname.startsWith('/api') &&
    (response.headers.get('content-type') ?? '').includes('text/html');
  const isPrefetch =
    event.request.headers.get('purpose') === 'prefetch' ||
    (event.request.headers.get('sec-purpose') ?? '').includes('prefetch');
  if (isPage && !isPrefetch) logPageview(event);

  return response;
};

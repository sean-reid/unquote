import { warmup } from '$lib/server/embed.js';

// Load the query encoder at boot rather than on the first search, so no user
// request ever pays the model cold start.
void warmup();

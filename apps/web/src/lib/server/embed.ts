import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBED_MODEL, QUERY_PREFIX } from '@unquote/shared';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function extractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
  return extractorPromise;
}

/** Start loading the model; called from the server boot hook. */
export async function warmup(): Promise<void> {
  await extractor();
}

const CACHE_MAX = 200;
const cache = new Map<string, Float32Array>();

/** Encode a search query to a normalized 384d vector, with a small LRU cache. */
export async function embedQuery(query: string): Promise<Float32Array> {
  const key = query.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const model = await extractor();
  const output = await model(QUERY_PREFIX + query, { pooling: 'mean', normalize: true });
  const vec = new Float32Array(output.data as Float32Array);

  cache.set(key, vec);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return vec;
}

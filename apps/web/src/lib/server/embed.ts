import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBED_MODEL, QUERY_PREFIX } from '@unquote/shared';

/**
 * ONNX port of the model the pipeline embeds beats and segments with
 * (BAAI/bge-base-en-v1.5, 768d, mean pooling). Same bge family as the line
 * encoder, so the query prefix convention is shared.
 */
export const WIDE_EMBED_MODEL = 'Xenova/bge-base-en-v1.5';
export const WIDE_EMBED_DIM = 768;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let wideExtractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function extractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
  return extractorPromise;
}

function wideExtractor(): Promise<FeatureExtractionPipeline> {
  wideExtractorPromise ??= pipeline('feature-extraction', WIDE_EMBED_MODEL, { dtype: 'q8' });
  return wideExtractorPromise;
}

/** Start loading both query encoders; called from the server boot hook. */
export async function warmup(): Promise<void> {
  await Promise.all([extractor(), wideExtractor()]);
}

const CACHE_MAX = 200;

function makeCachedEncoder(
  loader: () => Promise<FeatureExtractionPipeline>,
): (query: string) => Promise<Float32Array> {
  const cache = new Map<string, Float32Array>();
  return async (query: string) => {
    const key = query.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const model = await loader();
    const output = await model(QUERY_PREFIX + query, { pooling: 'mean', normalize: true });
    const vec = new Float32Array(output.data as Float32Array);
    cache.set(key, vec);
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return vec;
  };
}

/** Encode a search query to a normalized 384d vector, with a small LRU cache. */
export const embedQuery = makeCachedEncoder(extractor);

/** Encode a query at beat and segment width (768d), same recipe. */
export const embedQueryWide = makeCachedEncoder(wideExtractor);

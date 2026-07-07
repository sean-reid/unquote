/**
 * Embedding model contract. The same model must encode both stored lines and
 * live user queries, so these constants are shared by the pipeline and the app.
 */
export const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBED_DIM = 384;

/** bge v1.5 retrieval convention: queries get this prefix, passages do not. */
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

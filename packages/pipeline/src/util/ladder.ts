/**
 * Context ladder construction: overlapping beat windows over a film's
 * utterances, and scene-scale segments cut where consecutive beats stop
 * resembling each other.
 */

export const BEAT_SIZE = 12;
export const BEAT_STRIDE = 6;
export const SEGMENT_MIN_BEATS = 2;
export const SEGMENT_MAX_BEATS = 12;

export interface BeatWindow {
  idx: number;
  startSeq: number;
  endSeq: number;
  arc: number;
  span: [start: number, end: number];
}

/**
 * Overlapping windows over n utterances: BEAT_SIZE wide, BEAT_STRIDE apart,
 * so every line belongs to about two beats. Short films get a single window.
 */
export function beatWindows(n: number): BeatWindow[] {
  if (n <= 0) return [];
  const windows: BeatWindow[] = [];
  if (n <= BEAT_SIZE) {
    windows.push({ idx: 0, startSeq: 0, endSeq: n - 1, arc: 0.5, span: [0, n] });
    return windows;
  }
  let idx = 0;
  for (let start = 0; start < n - BEAT_STRIDE; start += BEAT_STRIDE) {
    const end = Math.min(start + BEAT_SIZE, n);
    const center = (start + end - 1) / 2;
    windows.push({
      idx,
      startSeq: start,
      endSeq: end - 1,
      arc: n > 1 ? center / (n - 1) : 0,
      span: [start, end],
    });
    idx += 1;
    if (end >= n) break;
  }
  return windows;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** L2-normalized mean of a set of rows from a flat vector matrix. */
export function meanVector(rows: number[], matrix: Float32Array, dim: number): Float32Array {
  const out = new Float32Array(dim);
  for (const row of rows) {
    const base = row * dim;
    for (let i = 0; i < dim; i++) out[i]! += matrix[base + i]!;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i]! * out[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i]! /= norm;
  return out;
}

/**
 * Cut a film's beat sequence into segments at similarity drops. A boundary
 * opens where the cosine between consecutive beats falls below the film's own
 * mean minus one standard deviation, subject to segment size bounds. Films
 * with too few beats become a single segment.
 */
export function cutSegments(similarities: number[], beatCount: number): Array<[number, number]> {
  if (beatCount <= 0) return [];
  if (beatCount === 1 || similarities.length === 0) return [[0, beatCount - 1]];

  const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
  const variance =
    similarities.reduce((a, b) => a + (b - mean) * (b - mean), 0) / similarities.length;
  const threshold = mean - Math.sqrt(variance);

  const segments: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < similarities.length; i++) {
    const length = i + 1 - start;
    const drop = similarities[i]! < threshold;
    if ((drop && length >= SEGMENT_MIN_BEATS) || length >= SEGMENT_MAX_BEATS) {
      segments.push([start, i]);
      start = i + 1;
    }
  }
  if (start <= beatCount - 1) {
    const last = segments[segments.length - 1];
    // A trailing stub shorter than the minimum joins the previous segment.
    if (beatCount - start < SEGMENT_MIN_BEATS && last) {
      last[1] = beatCount - 1;
    } else {
      segments.push([start, beatCount - 1]);
    }
  }
  return segments;
}

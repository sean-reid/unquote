/**
 * Project movie vectors to 2D with UMAP for the movie-page mini map.
 * Coordinates are normalized to [0, 1] on both axes.
 *
 * Run: pnpm map
 */
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UMAP } from 'umap-js';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson } from '../util/fs.js';
import { log } from '../util/log.js';

const meta = await readJson<{ dim: number; count: number; movieIds: number[] }>(
  resolve(DATA_DIR, 'movie-vectors.meta.json'),
);

const file = await open(resolve(DATA_DIR, 'movie-vectors.bin'), 'r');
const matrix = new Float32Array(meta.count * meta.dim);
await file.read(Buffer.from(matrix.buffer), 0, matrix.byteLength, 0);
await file.close();

const rows: number[][] = [];
for (let i = 0; i < meta.count; i++) {
  rows.push(Array.from(matrix.subarray(i * meta.dim, (i + 1) * meta.dim)));
}

// Deterministic layout: umap-js takes a seeded random source.
let seed = 42;
const random = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const umap = new UMAP({ nComponents: 2, nNeighbors: 15, minDist: 0.1, random });
const projected = umap.fit(rows);

const xs = projected.map((p) => p[0]!);
const ys = projected.map((p) => p[1]!);
const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];

const map: Record<string, [number, number]> = {};
meta.movieIds.forEach((movieId, i) => {
  map[movieId] = [
    (projected[i]![0]! - minX) / (maxX - minX || 1),
    (projected[i]![1]! - minY) / (maxY - minY || 1),
  ];
});

await writeJson(resolve(DATA_DIR, 'movie-map.json'), map);
log.info(`movie map: ${meta.count} films projected`);

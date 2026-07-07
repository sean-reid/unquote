import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** All pipeline artifacts live under data/, which is gitignored. */
export const DATA_DIR = path.resolve(root, '../data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');

/**
 * Readers for the generation stores. They are append-only JSONL that a
 * running generation may still be writing: the last row per key wins, a
 * missing file is an empty store, and a torn final line (a write caught
 * mid-append) is skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export function readGenerated<T extends { movieId: number; windowId?: string }>(
  name: string,
): Map<string, T> {
  const file = path.join(DATA_DIR, 'generated', name);
  const rows = new Map<string, T>();
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as T;
      rows.set(row.windowId ?? String(row.movieId), row);
    } catch {
      // The trailing line of a live append; the next read picks it up.
    }
  }
  return rows;
}

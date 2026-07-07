/** Lowercase, strip punctuation and diacritics, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalize(text);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/** Jaccard similarity over token sets, 0 to 1. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

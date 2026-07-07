/**
 * Reduce a film title to a comparable key so TMDb titles line up with the way
 * script sites list them. Handles "Godfather, The" vs "The Godfather", ampersands,
 * punctuation, and leading articles.
 */
export function titleKey(raw: string): string {
  let t = raw.toLowerCase().trim();
  t = t.replace(/&/g, ' and ');
  // "godfather, the" -> "the godfather"
  t = t.replace(/^(.*),\s*(the|a|an)$/, '$2 $1');
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  t = t.replace(/^(the|a|an)\s+/, '');
  return t.replace(/\s+/g, '');
}

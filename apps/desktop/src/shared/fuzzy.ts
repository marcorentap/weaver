/**
 * Tiny fuzzy matcher shared by the renderer's `@`-link completion and the
 * main process's link providers. Deliberately not a dependency: it scores a
 * query against a candidate as an ordered subsequence, so `adtx` finds
 * `apps/desktop/src/...` and the ranking stays stable across both sides of
 * the IPC boundary.
 *
 * The scale is open-ended above 0 (higher is better); a non-match is
 * `-Infinity`, so callers filter with `Number.isFinite`.
 */

/** Split a candidate into lowercase segments once per score. A boundary is
 *  the start of the string, any non-alphanumeric byte, or a lower-to-upper
 *  camelCase transition, which is where a typed query is most likely to
 *  resume. */
function boundaries(text: string): number[] {
  const at: number[] = [];
  let previous = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    const upper = char >= "A" && char <= "Z";
    const previousLower = previous >= "a" && previous <= "z";
    if (i === 0 || !/[a-z0-9]/i.test(previous) || (upper && previousLower)) {
      at.push(i);
    }
    previous = char;
  }
  return at;
}

/** Score `query` against `text`, or `-Infinity` when `query`'s characters
 *  do not all appear in `text` in order. Consecutive matches, matches at a
 *  segment boundary, and a shorter candidate are all rewarded, in that
 *  order of weight, so an exact prefix beats a scattered subsequence. */
export function fuzzyScore(query: string, text: string): number {
  if (query === "") return 0;
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  const marks = boundaries(text);
  const isBoundary = new Set(marks);

  let score = 0;
  let textIndex = 0;
  let previousMatch = -1;
  for (const char of lowerQuery) {
    const found = lowerText.indexOf(char, textIndex);
    if (found === -1) return -Infinity;
    score += 1;
    if (found === previousMatch + 1) score += 2;
    if (isBoundary.has(found)) score += 3;
    if (found === 0) score += 1;
    previousMatch = found;
    textIndex = found + 1;
  }
  // Prefer the candidate that is not much longer than the query it matched.
  score -= Math.min(text.length, 64) * 0.01;
  return score;
}

/** Rank `items` by `fuzzyScore(query, key(item))`, dropping non-matches and
 *  capping at `limit`. An empty query keeps every item in its original
 *  order, so the "no query yet" list is the provider's own default. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string,
  limit: number,
): T[] {
  if (query === "") return items.slice(0, limit);
  const scored = items
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.item);
}

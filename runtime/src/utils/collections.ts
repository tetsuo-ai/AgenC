/**
 * Generic collection utilities.
 *
 * @module
 */

/** Group items by a key selector, returning a Map from key → item[]. */
export function groupBy<T, K>(
  items: T[],
  keySelector: (item: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();

  for (const item of items) {
    const key = keySelector(item);
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
      continue;
    }
    groups.set(key, [item]);
  }

  return groups;
}

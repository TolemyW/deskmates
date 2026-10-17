// ADR-0041 decision 5: reciprocal rank fusion of the bm25 and vector lists, then a reranked head.
// Pure functions, so the order is testable without a service.

/** `score(id) = Σ 1 / (k + rank)` over the lists that hold it (rank from 1); ties by id. */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k: number): string[] {
  const scores = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
}

/**
 * The first `scores.length` ids reordered by score (higher first, ties keep their fused order),
 * followed by the rest unchanged.
 */
export function applyRerank(fused: readonly string[], scores: readonly number[]): string[] {
  const head = fused
    .slice(0, scores.length)
    .map((id, index) => ({ id, index, score: scores[index] ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.id);
  return [...head, ...fused.slice(scores.length)];
}

/** The `limit` best ids by score at or above `floor`, ties by id. */
export function topByScore(scores: ReadonlyMap<string, number>, floor: number, limit: number) {
  return [...scores.entries()]
    .filter(([, score]) => score >= floor)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([id]) => id);
}

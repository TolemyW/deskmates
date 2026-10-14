// Paging of the Knowledge documents, search results and proposals (#113 slice K1).

import type { PageResult } from "../../lib/use-paged-query.js";

/** Documents, search results and proposals: 25 a page. */
export const KNOWLEDGE_PAGE_SIZE = 25;

/** A Gateway page answer as the paging hook reads it. */
export function pageOf<P extends { nextCursor?: string; total?: number }, T>(
  page: P,
  items: (page: P) => T[] | undefined,
): PageResult<T> {
  return {
    items: items(page) ?? [],
    ...(page.total !== undefined ? { total: page.total } : {}),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

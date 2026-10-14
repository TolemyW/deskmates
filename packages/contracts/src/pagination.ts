// Shared list-pagination contract (#113, docs/design/pagination-coverage-2026-10-13.md §3.1).
// Types and limit validation only. Cursors are opaque to every package but the Gateway, which
// builds and checks them; the web passes them back unchanged.

/** The default ceiling for a page; a surface may lower it, never raise it silently. */
export const PAGE_LIMIT_MAX = 100;

/** One surface's page size: what an unpaged request gets, and the largest accepted limit. */
export interface PageLimitPolicy {
  readonly default: number;
  readonly max: number;
}

export interface CursorPageRequest {
  cursor?: string;
  limit?: number;
}

/** `nextCursor` present means there is more; `total` only where an indexed count is cheap. */
export interface CursorPageMeta {
  nextCursor?: string;
  total?: number;
}

export interface OffsetPageRequest {
  offset?: number;
  limit?: number;
}

/** An offset page always carries the honest total of the filtered collection. */
export interface OffsetPageMeta {
  offset: number;
  limit: number;
  total: number;
  truncated?: boolean;
}

function integerValue(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw === "string" && /^\d{1,9}$/.test(raw)) return Number(raw);
  return null;
}

/**
 * Validate a requested page size. Absent means the surface default. Anything that is not an
 * integer, is below 1 or is above the surface's maximum is refused, never clamped: a caller that
 * asks for 500 must learn it did not get 500.
 */
export function parsePageLimit(
  raw: unknown,
  policy: PageLimitPolicy,
): { ok: true; limit: number } | { ok: false; field: "limit" } {
  const value = integerValue(raw);
  if (value === undefined) return { ok: true, limit: policy.default };
  if (value === null || value < 1 || value > policy.max) return { ok: false, field: "limit" };
  return { ok: true, limit: value };
}

/** Validate a requested offset: absent is 0, anything but a non-negative integer is refused. */
export function parsePageOffset(
  raw: unknown,
): { ok: true; offset: number } | { ok: false; field: "offset" } {
  const value = integerValue(raw);
  if (value === undefined) return { ok: true, offset: 0 };
  if (value === null || value < 0) return { ok: false, field: "offset" };
  return { ok: true, offset: value };
}

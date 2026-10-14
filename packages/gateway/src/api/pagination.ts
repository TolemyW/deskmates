// Gateway half of the list-pagination contract (#113, pagination coverage plan §3.1).
// A cursor is base64url JSON `{ v: 1, k: [sortKey..., id], f: <scope hash> }`. The scope hash
// covers the tenant, the workspace or parent record and every filter, so a cursor presented under
// another scope or filter is refused as `validation` and cannot carry rows across scopes. The
// query that reads the page still applies its own tenant/workspace condition; the hash is a
// consistency check, not the access boundary. The web treats cursors as opaque.

import { createHash } from "node:crypto";
import {
  DeskmatesError,
  type PageLimitPolicy,
  parsePageLimit,
  parsePageOffset,
} from "@deskmates/contracts";

/** Everything a page depends on besides its position: tenant, scope id, filters, sort. */
export type CursorScope = readonly (string | number | boolean | null)[];
export type CursorKey = string | number;
type KeyShape = readonly ("string" | "number")[];

const CURSOR_VERSION = 1;
const CURSOR_MAX_LENGTH = 1024;

function scopeHash(scope: CursorScope): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("base64url").slice(0, 16);
}

export function encodeCursor(keys: readonly CursorKey[], scope: CursorScope): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, k: keys, f: scopeHash(scope) }),
    "utf8",
  ).toString("base64url");
}

function invalidCursor(): DeskmatesError {
  return new DeskmatesError("validation", "Invalid pagination cursor", { field: "cursor" });
}

/**
 * Decode a cursor for this scope and key shape. Absent is the first page. A malformed cursor, one
 * of another version, shape, scope or filter, is refused as `validation`, never a database error.
 */
export function decodeCursor(
  raw: unknown,
  scope: CursorScope,
  shape: KeyShape,
): CursorKey[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > CURSOR_MAX_LENGTH) throw invalidCursor();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (typeof value !== "object" || value === null) throw invalidCursor();
  const { v, k, f } = value as { v?: unknown; k?: unknown; f?: unknown };
  if (v !== CURSOR_VERSION || f !== scopeHash(scope) || !Array.isArray(k)) throw invalidCursor();
  const fits = (key: unknown, kind: KeyShape[number] | undefined): boolean =>
    kind === "string" ? typeof key === "string" : typeof key === "number" && Number.isFinite(key);
  if (k.length !== shape.length || k.some((key, i) => !fits(key, shape[i]))) throw invalidCursor();
  return k as CursorKey[];
}

function limitOrThrow(raw: unknown, policy: PageLimitPolicy): number {
  const parsed = parsePageLimit(raw, policy);
  if (!parsed.ok)
    throw new DeskmatesError("validation", `Invalid page limit (1 to ${policy.max})`, {
      field: "limit",
      max: policy.max,
    });
  return parsed.limit;
}

export interface CursorQuery {
  limit: number;
  after?: CursorKey[];
}

/** Parse `?cursor=&limit=` for a keyset list. */
export function parseCursorQuery(
  query: { cursor?: unknown; limit?: unknown },
  policy: PageLimitPolicy,
  scope: CursorScope,
  shape: KeyShape,
): CursorQuery {
  const limit = limitOrThrow(query.limit, policy);
  const after = decodeCursor(query.cursor, scope, shape);
  return after ? { limit, after } : { limit };
}

export interface OffsetQuery {
  offset: number;
  limit: number;
}

/** Parse `?offset=&limit=` for a numbered management list. */
export function parseOffsetQuery(
  query: { offset?: unknown; limit?: unknown },
  policy: PageLimitPolicy,
): OffsetQuery {
  const limit = limitOrThrow(query.limit, policy);
  const offset = parsePageOffset(query.offset);
  if (!offset.ok)
    throw new DeskmatesError("validation", "Invalid page offset", { field: "offset" });
  return { offset: offset.offset, limit };
}

/**
 * Cut a keyset page from rows read with `LIMIT limit + 1`. The extra row only says whether more
 * exist; the cursor names the last visible row.
 */
export function keysetPage<R>(
  rows: readonly R[],
  limit: number,
  keyOf: (row: R) => readonly CursorKey[],
  scope: CursorScope,
): { items: R[]; nextCursor?: string } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return rows.length > limit && last !== undefined
    ? { items, nextCursor: encodeCursor(keyOf(last), scope) }
    : { items };
}

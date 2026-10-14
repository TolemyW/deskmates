import { DeskmatesError } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  keysetPage,
  parseCursorQuery,
  parseOffsetQuery,
} from "./pagination.js";

const policy = { default: 25, max: 100 };
const scope = ["tenant_a", "ws_1", "pending"] as const;
const shape = ["string", "string"] as const;

function validation(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DeskmatesError);
    expect((error as DeskmatesError).code).toBe("validation");
    return (error as DeskmatesError).details as Record<string, unknown>;
  }
  throw new Error("expected a validation error");
}

describe("cursor encoding", () => {
  it("round-trips the sort key and tie-breaker under the same scope", () => {
    const cursor = encodeCursor(["2026-10-13T00:00:00.000Z", "id_9"], scope);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, scope, shape)).toEqual(["2026-10-13T00:00:00.000Z", "id_9"]);
  });

  it("treats an absent cursor as the first page", () => {
    expect(decodeCursor(undefined, scope, shape)).toBeUndefined();
    expect(decodeCursor("", scope, shape)).toBeUndefined();
  });

  it("refuses a cursor from another tenant, workspace or filter", () => {
    const cursor = encodeCursor(["t", "id"], scope);
    validation(() => decodeCursor(cursor, ["tenant_b", "ws_1", "pending"], shape));
    validation(() => decodeCursor(cursor, ["tenant_a", "ws_2", "pending"], shape));
    validation(() => decodeCursor(cursor, ["tenant_a", "ws_1", "approved"], shape));
  });

  it("refuses malformed, foreign-shaped and oversized cursors", () => {
    expect(validation(() => decodeCursor("not json!", scope, shape))).toEqual({
      field: "cursor",
    });
    validation(() => decodeCursor(Buffer.from("[1,2]").toString("base64url"), scope, shape));
    validation(() => decodeCursor(encodeCursor([1, "id"], scope), scope, shape));
    validation(() => decodeCursor(encodeCursor(["a"], scope), scope, shape));
    validation(() => decodeCursor("a".repeat(2000), scope, shape));
    validation(() => decodeCursor(["x"], scope, shape));
  });
});

describe("query parsing", () => {
  it("rejects a limit above the maximum instead of clamping", () => {
    expect(validation(() => parseCursorQuery({ limit: "101" }, policy, scope, shape))).toEqual({
      field: "limit",
      max: 100,
    });
    validation(() => parseOffsetQuery({ limit: "500" }, policy));
  });

  it("defaults the limit and offset", () => {
    expect(parseCursorQuery({}, policy, scope, shape)).toEqual({ limit: 25 });
    expect(parseOffsetQuery({}, policy)).toEqual({ offset: 0, limit: 25 });
    expect(parseOffsetQuery({ offset: "50", limit: "10" }, policy)).toEqual({
      offset: 50,
      limit: 10,
    });
  });

  it("rejects a negative offset", () => {
    expect(validation(() => parseOffsetQuery({ offset: "-1" }, policy))).toEqual({
      field: "offset",
    });
  });
});

describe("keysetPage", () => {
  const rows = [
    { at: "3", id: "c" },
    { at: "2", id: "b" },
    { at: "2", id: "a" },
  ];
  it("names the last visible row when an extra row was read", () => {
    const page = keysetPage(rows, 2, (r) => [r.at, r.id], scope);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor, scope, shape)).toEqual(["2", "b"]);
  });

  it("has no cursor on the last page", () => {
    expect(keysetPage(rows, 3, (r) => [r.at, r.id], scope)).toEqual({ items: rows });
  });
});

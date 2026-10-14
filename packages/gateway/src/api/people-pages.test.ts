// T1, #113 slice M (pagination plan §3.1, §4): People's members and invitations are offset pages
// of 25, at most 100, with an honest total under the role and status filters. Pages are stable
// across equal sort keys, a limit or offset out of range is a 400 and never clamped, an offset
// past the end is an empty page, and every page stays inside the named workspace.

import type { InvitationsPage, MembersPage } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import { FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function seed(): Promise<{ harness: Harness; ws: string; other: string }> {
  h = await startHarness({ auth: FAST_AUTH });
  const { ctx } = h.app.deskmates;
  const ws = ctx.workspaces.create({ name: "W", sandboxProvider: "docker" }).id;
  const other = ctx.workspaces.create({ name: "Other", sandboxProvider: "docker" }).id;
  // Thirty people with the same display name, so only the user id orders them; every third a
  // Guest. One person in another workspace must never appear.
  for (let i = 0; i < 30; i++)
    await ctx.auth.createUser({
      loginName: `p${String(i).padStart(2, "0")}`,
      displayName: "Same Name",
      password: TEST_PASSWORD,
      role: i % 3 === 0 ? "guest" : "member",
      workspaceId: ws,
    });
  await ctx.auth.createUser({
    loginName: "elsewhere",
    displayName: "Elsewhere",
    password: TEST_PASSWORD,
    role: "member",
    workspaceId: other,
  });
  for (let i = 0; i < 27; i++)
    ctx.auth.createInvitation(DEFAULT_TENANT_ID, {
      workspaceId: ws,
      role: "member",
      target: { kind: "local_signup" },
      createdBy: "operator",
    });
  return { harness: h, ws, other };
}

describe("People pages (#113 slice M)", () => {
  it("pages members by status, name and id with a total, filtered by role and status", async () => {
    const { harness, ws } = await seed();
    const page = (query: string) =>
      harness.api<MembersPage>("GET", `/api/members?workspaceId=${ws}&${query}`);
    const first = await page("");
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ offset: 0, limit: 25, total: 30 });
    expect(first.json.members).toHaveLength(25);
    const seen: string[] = [];
    for (let offset = 0; offset < 30; offset += 10) {
      const next = await page(`offset=${offset}&limit=10`);
      expect(next.json.total).toBe(30);
      seen.push(...next.json.members.map((m) => m.userId));
    }
    // Every person once, in user id order (equal names), none of another workspace.
    expect(new Set(seen).size).toBe(30);
    expect(seen).toEqual([...seen].sort());
    expect(first.json.members.every((m) => m.workspaceId === ws)).toBe(true);
    // Past the end: an empty page with the same total.
    const past = await page("offset=30&limit=10");
    expect(past.json).toMatchObject({ members: [], total: 30 });
    // Filters change the total, not the order.
    const guests = await page("role=guest&limit=100");
    expect(guests.json.total).toBe(10);
    expect(guests.json.members.every((m) => m.role === "guest")).toBe(true);
    expect((await page("status=removed")).json.total).toBe(0);
    // Out of range or malformed: refused, never clamped.
    for (const bad of ["limit=101", "limit=0", "limit=x", "offset=-1", "role=root", "status=gone"])
      expect((await page(bad)).status, bad).toBe(400);
  });

  it("pages invitations newest first with a total, inside their workspace", async () => {
    const { harness, ws, other } = await seed();
    const page = (workspaceId: string, query: string) =>
      harness.api<InvitationsPage>("GET", `/api/invitations?workspaceId=${workspaceId}&${query}`);
    const first = await page(ws, "");
    expect(first.json).toMatchObject({ offset: 0, limit: 25, total: 27 });
    const all = [...first.json.invitations, ...(await page(ws, "offset=25")).json.invitations];
    expect(all).toHaveLength(27);
    expect(new Set(all.map((i) => i.id)).size).toBe(27);
    // Newest first, then by id: the order is total even within one millisecond.
    const keys = all.map((i) => [i.createdAt, i.id] as const);
    for (let i = 1; i < keys.length; i++) {
      const [a, b] = [keys[i - 1], keys[i]] as [
        readonly [string, string],
        readonly [string, string],
      ];
      expect(a[0] > b[0] || (a[0] === b[0] && a[1] < b[1]), `${a} then ${b}`).toBe(true);
    }
    expect((await page(other, "")).json).toMatchObject({ invitations: [], total: 0 });
    expect((await page(ws, "limit=500")).status).toBe(400);
  });
});

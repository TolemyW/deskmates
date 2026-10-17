// T1 (ADR-0011 amendment 4, A26, A27, A29): the revalidation queue, its decisions and Knowledge
// drafts over HTTP within one workspace; the queue pages with the #113 cursor contract.

import type {
  KnowledgeProposal,
  MemoryRevalidation,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayContext } from "../context.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { memoryRoutePolicies } from "./route-policies/memory.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const OLD = new Date(Date.now() - 200 * 86_400_000).toISOString();

function note(ctx: GatewayContext, workspaceId: WorkspaceId, body: string, observedAt = OLD) {
  return ctx.memory.entries.insert({
    workspaceId,
    scope: "workspace",
    kind: "note",
    body,
    authority: "fact",
    trust: "trusted",
    sourceKind: "human",
    observedAt,
    by: "human:o",
  });
}

async function workspaces(harness: Harness): Promise<[Workspace, Workspace]> {
  const make = async (name: string) =>
    (
      await harness.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
        name,
        egressAllowlist: ["docs.example.test"],
      })
    ).json.workspace;
  return [await make("a"), await make("b")];
}

describe("revalidation routes", () => {
  it("pages open flags after a sweep, refuses a foreign cursor, and decides a flag", async () => {
    h = await startHarness();
    const ctx = h.app.deskmates.ctx;
    const [a, b] = await workspaces(h);
    for (let i = 0; i < 3; i += 1) note(ctx, a.id, `Old fact ${i} about host h${i}.`);
    note(ctx, b.id, "Old fact about host hb.");
    const base = `/api/workspaces/${a.id}/memory/revalidations`;

    const first = await h.api<{
      revalidations: MemoryRevalidation[];
      nextCursor?: string;
      total: number;
      byReason: Record<string, number>;
    }>("GET", `${base}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ total: 3, byReason: { age: 3 } });
    expect(first.json.revalidations).toHaveLength(2);
    const second = await h.api<{ revalidations: MemoryRevalidation[]; nextCursor?: string }>(
      "GET",
      `${base}?limit=2&cursor=${first.json.nextCursor}`,
    );
    expect(second.json.revalidations).toHaveLength(1);
    expect(second.json.nextCursor).toBeUndefined();
    const ids = [...first.json.revalidations, ...second.json.revalidations].map((r) => r.id);
    expect(new Set(ids).size).toBe(3);

    const foreign = await h.api(
      "GET",
      `/api/workspaces/${b.id}/memory/revalidations?cursor=${first.json.nextCursor}`,
    );
    expect(foreign.status).toBe(400);
    expect((await h.api("GET", `${base}?limit=101`)).status).toBe(400);

    const flag = first.json.revalidations[0] as MemoryRevalidation;
    const elsewhere = await h.api(
      "POST",
      `/api/workspaces/${b.id}/memory/revalidations/${flag.id}`,
      { decision: "dismiss" },
    );
    expect(elsewhere.status).toBe(404);
    const decided = await h.api<{ revalidation: MemoryRevalidation }>(
      "POST",
      `${base}/${flag.id}`,
      { decision: "still_true" },
    );
    expect(decided.status).toBe(200);
    expect(decided.json.revalidation.status).toBe("still_true");
    const after = await h.api<{ total: number }>("GET", base);
    expect(after.json.total).toBe(2);
  });

  it("deciding is an Admin's; reading is a Member's", () => {
    const role = (key: string) => {
      const policy = memoryRoutePolicies[key];
      return policy && "role" in policy ? policy.role : undefined;
    };
    expect(role("GET /api/workspaces/:id/memory/revalidations")).toBe("member");
    expect(role("POST /api/workspaces/:id/memory/revalidations/:itemId")).toBe("admin");
    expect(role("POST /api/workspaces/:id/memory/document-drafts")).toBe("admin");
    expect(role("POST /api/workspaces/:id/memory/organize")).toBe("admin");
    expect(role("POST /api/workspaces/:id/memory/splits/:itemId")).toBe("admin");
    // A34: settings are read by a Member, changed by an Owner or Admin.
    expect(role("GET /api/workspaces/:id/memory/maintenance")).toBe("member");
    expect(role("PUT /api/workspaces/:id/memory/maintenance")).toBe("admin");
  });
});

describe("document draft route", () => {
  it("creates a pending proposal citing the notes and refuses an untrusted one", async () => {
    h = await startHarness();
    const ctx = h.app.deskmates.ctx;
    const [a] = await workspaces(h);
    const fact = note(ctx, a.id, "VendorDB has no LISTEN/NOTIFY.", new Date().toISOString());
    const res = await h.api<{ proposal: KnowledgeProposal }>(
      "POST",
      `/api/workspaces/${a.id}/memory/document-drafts`,
      { entryIds: [fact.id], title: "VendorDB notes" },
    );
    expect(res.status).toBe(201);
    expect(res.json.proposal).toMatchObject({ status: "pending", title: "VendorDB notes" });
    expect(res.json.proposal.citations?.[0]).toMatchObject({ entryId: fact.id, changed: false });
    const listed = await h.api<{ proposals: KnowledgeProposal[] }>(
      "GET",
      "/api/knowledge/proposals",
    );
    expect(listed.json.proposals.map((p) => p.id)).toContain(res.json.proposal.id);

    const untrusted = ctx.memory.entries.insert({
      workspaceId: a.id,
      scope: "workspace",
      kind: "note",
      body: "The pricing page lists 3 plans.",
      authority: "fact",
      trust: "untrusted",
      sourceKind: "page",
      by: "test",
    });
    const refused = await h.api("POST", `/api/workspaces/${a.id}/memory/document-drafts`, {
      entryIds: [untrusted.id],
      title: "Pricing",
    });
    expect(refused.status).toBe(400);
  });
});

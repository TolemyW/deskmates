// T2: real workspace image for memory; real on-disk Gateway store for reviewed knowledge.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  KnowledgeDocument,
  KnowledgeProposal,
  KnowledgeVersion,
  MemorySuggestion,
} from "@deskmates/contracts";
import { buildGateway } from "@deskmates/gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
describe.skipIf(!available)("M2 knowledge and memory (real image and on-disk store)", () => {
  let stack: Stack;
  let publishedId: string;
  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({
      modelBaseUrl: "http://127.0.0.1:1",
      modelAuthToken: "unused-t2-token",
      defaultModel: "unused-model",
      cheapModel: "unused-cheap-model",
      label: "m2-knowledge",
    });
  }, 120_000);
  afterAll(async () => stopStack(stack), 120_000);

  it("keeps drafts hidden, preserves immutable versions, and cleans only orphan versions", async () => {
    const proposed = await stack.api<{ proposal: KnowledgeProposal }>(
      "POST",
      "/api/knowledge/proposals",
      { title: "Dispatch guide", body: "dispatchmarker original" },
    );
    expect(proposed.status).toBe(201);
    const proposal = proposed.json.proposal;
    expect(
      (await stack.api<{ documents: unknown[] }>("GET", "/api/knowledge?q=dispatchmarker")).json
        .documents,
    ).toEqual([]);
    expect((await stack.api("GET", `/api/knowledge/${proposal.id}`)).status).toBe(404);
    const drafts = await Promise.all(
      Array.from({ length: 26 }, (_, index) =>
        stack.api<{ proposal: KnowledgeProposal }>("POST", "/api/knowledge/proposals", {
          title: `Unpublished ${index}`,
          body: `draftmarker ${index}`,
        }),
      ),
    );
    expect(drafts.every((item) => item.status === 201)).toBe(true);
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await stack.api<{ proposals: KnowledgeProposal[]; nextCursor?: string }>(
        "GET",
        `/api/knowledge/proposals?status=pending&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.status).toBe(200);
      for (const item of page.json.proposals) seen.add(item.id);
      cursor = page.json.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(27);
    const rejected = await stack.api<{ proposal: KnowledgeProposal }>(
      "POST",
      `/api/knowledge/proposals/${drafts[0]?.json.proposal.id}/review`,
      { decision: "reject", authorId: "m2-reviewer" },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.json.proposal.status).toBe("rejected");
    expect(
      (await stack.api<{ documents: unknown[] }>("GET", "/api/knowledge?q=draftmarker")).json
        .documents,
    ).toEqual([]);
    const approved = await stack.api<{ proposal: KnowledgeProposal }>(
      "POST",
      `/api/knowledge/proposals/${proposal.id}/review`,
      { decision: "approve", authorId: "m2-reviewer" },
    );
    expect(approved.status).toBe(200);
    const id = approved.json.proposal.documentId;
    expect(id).toMatch(/^kb_/);
    if (!id) throw new Error("approved proposal has no document ID");
    publishedId = id;
    expect(
      (
        await stack.api("POST", `/api/knowledge/proposals/${proposal.id}/review`, {
          decision: "approve",
        })
      ).status,
    ).toBe(409);
    const read = await stack.api<{ document: KnowledgeDocument }>("GET", `/api/knowledge/${id}`);
    expect(read.json.document).toMatchObject({
      id,
      version: 1,
      approvedBy: "human:m2-reviewer",
      body: "dispatchmarker original",
    });
    const edit = await stack.api<{ document: KnowledgeDocument }>("PATCH", `/api/knowledge/${id}`, {
      title: "Dispatch guide v2",
      body: "dispatchmarker revised",
      version: 1,
      authorId: "m2-editor",
    });
    expect(edit.status).toBe(200);
    expect(edit.json.document.version).toBe(2);
    expect(
      (
        await stack.api("PATCH", `/api/knowledge/${id}`, {
          title: "stale",
          body: "stale",
          version: 1,
        })
      ).status,
    ).toBe(409);
    const history = await stack.api<{ versions: KnowledgeVersion[] }>(
      "GET",
      `/api/knowledge/${id}/history`,
    );
    expect(history.json.versions.map((v) => [v.version, v.body])).toEqual([
      [2, "dispatchmarker revised"],
      [1, "dispatchmarker original"],
    ]);
    expect(
      (
        await stack.api<{ documents: { id: string; version: number }[] }>(
          "GET",
          "/api/knowledge?q=dispatchmarker",
        )
      ).json.documents,
    ).toContainEqual(expect.objectContaining({ id, version: 2 }));

    const versionDir = join(stack.tmpDir, "knowledge");
    // The live store chooses this directory from the DB path; inspect the actual files first.
    const files = existsSync(versionDir) ? readdirSync(versionDir) : [];
    expect(files.length).toBeGreaterThanOrEqual(2);
    const orphan = "kb_abcdef.3.00000000-0000-4000-8000-000000000000.md";
    writeFileSync(join(versionDir, orphan), "orphan");
    const cleanup = await stack.api<{ removed: number; retained: number }>(
      "POST",
      "/api/knowledge/versions/cleanup",
    );
    expect(cleanup.status).toBe(200);
    expect(cleanup.json).toMatchObject({ removed: 1 });
    expect(existsSync(join(versionDir, orphan))).toBe(false);
    expect(files.every((file) => existsSync(join(versionDir, file)))).toBe(true);
  }, 30_000);

  it("uses the real image helper for memory read, edit, stale conflict, export and clear", async () => {
    const path = `/api/bots/${stack.bot.id}/memory`;
    const original = await stack.api<{ memory: { body: string; version: string } }>("GET", path);
    expect(original.status).toBe(200);
    const edited = await stack.api<{ memory: { body: string; version: string } }>("PATCH", path, {
      body: "# Memory\nremember m2 memory marker\n",
      expectedVersion: original.json.memory.version,
    });
    expect(edited.status).toBe(200);
    expect(edited.json.memory.body).toContain("m2 memory marker");
    expect(edited.json.memory.version).not.toBe(original.json.memory.version);
    expect(
      (
        await stack.api("PATCH", path, {
          body: "stale overwrite",
          expectedVersion: original.json.memory.version,
        })
      ).status,
    ).toBe(409);
    const exported = await fetch(`${stack.gatewayUrl}${path}/export`, {
      headers: { authorization: `Bearer ${stack.config.operatorToken}` },
    });
    expect(exported.status).toBe(200);
    // ADR-0011: the MEMORY.md export is the bot's trusted experience, not the operator's file.
    expect(await exported.text()).toContain(`# ${stack.bot.name}: experience`);
    const cleared = await stack.api<{ memory: { body: string } }>("PATCH", path, {
      body: "",
      expectedVersion: edited.json.memory.version,
    });
    expect(cleared.status).toBe(200);
    expect((await stack.api<{ memory: { body: string } }>("GET", path)).json.memory.body).toBe("");
    expect((await fetch(`${stack.gatewayUrl}${path}`)).status).toBe(401);
  }, 30_000);

  // ADR-0011: the queue holds only gated items; applying one writes a trusted bot-scope memory
  // note with the human as source and leaves MEMORY.md exactly as it was.
  it("applies a gated learned item once and rejects another without changing MEMORY.md", async () => {
    const ctx = stack.app.deskmates.ctx;
    const run = ctx.runs.create({
      botId: stack.bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "m2-memory-source",
      config: ctx.runConfig(),
    });
    const bodies = [
      "Always use the approved Delta desk routing rule.",
      "Never answer this suggestion; it must be rejected.",
    ];
    for (const [ordinal, body] of bodies.entries())
      ctx.memory.confirmations.gate({
        workspaceId: stack.bot.workspaceId,
        runId: run.id,
        botId: stack.bot.id,
        ordinal,
        body,
        proposedScope: "bot",
        authority: "procedure",
        trust: "untrusted",
        sourceKind: "webhook",
        reasons: ["imperative"],
      });
    ctx.runs.transition(run.id, "cancelled");
    const listed = await stack.api<{ suggestions: MemorySuggestion[] }>(
      "GET",
      `/api/memory-suggestions?botId=${stack.bot.id}&status=pending`,
    );
    expect(listed.status).toBe(200);
    const fromRun = listed.json.suggestions.filter((item) => item.runId === run.id);
    expect(fromRun).toHaveLength(2);
    const suggestions = [
      fromRun.find((item) => item.body.includes("Delta desk")),
      fromRun.find((item) => item.body.includes("must be rejected")),
    ];
    const memoryPath = `/api/bots/${stack.bot.id}/memory`;
    const before = await stack.api<{ memory: { body: string; version: string } }>(
      "GET",
      memoryPath,
    );
    const applied = await stack.api<{
      suggestion: MemorySuggestion;
      entry: { id: string; scope: string; trust: string; sourceKind: string; body: string };
    }>("POST", `/api/memory-suggestions/${suggestions[0]?.id}/review`, {
      decision: "apply",
      authorId: "m2-reviewer",
    });
    expect(applied.status).toBe(200);
    expect(applied.json.suggestion).toMatchObject({
      status: "applied",
      runId: run.id,
      reviewedBy: "human:m2-reviewer",
    });
    expect(applied.json.entry).toMatchObject({
      scope: "bot",
      trust: "trusted",
      sourceKind: "human",
    });
    const repeated = await stack.api<{ suggestion: MemorySuggestion }>(
      "POST",
      `/api/memory-suggestions/${suggestions[0]?.id}/review`,
      { decision: "apply" },
    );
    expect(repeated.status).toBe(200);
    expect(repeated.json.suggestion.status).toBe("applied");
    const rejected = await stack.api<{ suggestion: MemorySuggestion }>(
      "POST",
      `/api/memory-suggestions/${suggestions[1]?.id}/review`,
      { decision: "reject", authorId: "m2-reviewer" },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.json.suggestion.status).toBe("rejected");
    const after = await stack.api<{ memory: { body: string; version: string } }>("GET", memoryPath);
    expect(after.json.memory).toEqual(before.json.memory);
    const exported = await fetch(`${stack.gatewayUrl}${memoryPath}/export`, {
      headers: { authorization: `Bearer ${stack.config.operatorToken}` },
    });
    const text = await exported.text();
    expect(text).toContain("Delta desk");
    expect(text).not.toContain("must be rejected");
  }, 30_000);

  it("reopens the Gateway against the same database and verifies published search and history", async () => {
    expect(publishedId).toMatch(/^kb_/);
    await stack.app.close();
    const restarted = buildGateway(stack.config, stack.provider, {
      surface: "combined-test",
      startCron: false,
    });
    try {
      await restarted.ready();
      const headers = { authorization: `Bearer ${stack.config.operatorToken}` };
      const search = await restarted.inject({
        method: "GET",
        url: "/api/knowledge?q=dispatchmarker",
        headers,
      });
      expect(search.statusCode).toBe(200);
      expect(search.json().documents).toContainEqual(
        expect.objectContaining({ id: publishedId, version: 2 }),
      );
      const read = await restarted.inject({
        method: "GET",
        url: `/api/knowledge/${publishedId}`,
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().document).toMatchObject({ body: "dispatchmarker revised", version: 2 });
      const history = await restarted.inject({
        method: "GET",
        url: `/api/knowledge/${publishedId}/history`,
        headers,
      });
      expect(history.json().versions.map((item: { version: number }) => item.version)).toEqual([
        2, 1,
      ]);
    } finally {
      await restarted.close();
    }
  }, 30_000);
});

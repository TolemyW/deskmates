// T1 (ADR-0045 decisions 1, 9 and 10): the Vault is a workspace resource. Every bot of the
// workspace lists the same metadata; another workspace can neither see an entry nor use it; no
// listing carries a value, the username included; existing credentials (a connector's, an
// integration's, the workspace's own secrets) never appear in it. Metric: cross-workspace
// disclosures, target 0.

import type { VaultListing, VaultUseResult } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANARY_PASSWORD,
  CANARY_TOKEN,
  CANARY_USER,
  type VaultFixture,
  toolUseOf,
  vaultFixture,
} from "../test-support/vault-fixture.js";

let f: VaultFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const canaries = [CANARY_USER, CANARY_PASSWORD, CANARY_TOKEN];
const clean = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const canary of canaries) expect(text).not.toContain(canary);
};

describe("vault scope", () => {
  it("lists the same metadata to every bot of the workspace and nothing of a value", async () => {
    f = await vaultFixture();
    const entry = await f.login(f.a);
    const listed = await f.run<VaultListing>(f.a, "GET", "/vault/entries");
    expect(listed.status).toBe(200);
    expect(listed.json.entries).toEqual([
      {
        id: entry.id,
        name: "Console",
        type: "browser_login",
        targetOrigin: "https://console.example.test",
        revision: 1,
      },
    ]);
    clean(listed.json);
    // A second run of the teammate bot sees the very same entry: no per-bot ownership.
    const ctx = f.h.app.deskmates.ctx;
    const mate = ctx.runs.transition(
      ctx.runs.create({
        botId: f.a.teammate.id,
        threadId: f.a.thread.id,
        lane: "interactive",
        triggerKind: "thread_message",
        triggerRef: "mate",
        config: ctx.runConfig(),
      }).id,
      "running",
    );
    const token = ctx.tokens.issue(mate.id).token;
    const res = await fetch(`${f.h.baseUrl}/internal/runs/${mate.id}/vault/entries`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await res.json()) as VaultListing).entries.map((e) => e.id)).toEqual([entry.id]);
    // The operator view is metadata too.
    const view = await f.h.api("GET", `/api/workspaces/${f.a.workspace.id}/vault`);
    clean(view.json);
    expect(JSON.stringify(view.json)).toContain('"hasUsername":true');
  });

  it("hides an entry from another workspace and refuses its use there", async () => {
    f = await vaultFixture();
    const entry = await f.login(f.a);
    const listed = await f.run<VaultListing>(f.b, "GET", "/vault/entries");
    expect(listed.json.entries).toEqual([]);
    expect(listed.json.note).toContain("no usable credentials");
    const facts = await f.run(f.b, "GET", `/vault/entries/${entry.id}`);
    expect(facts.status).toBe(404);
    // Even with an approval of its own for that entry's action, B cannot use A's entry.
    const { approvalId } = await f.approve(f.b, f.action(entry, "fill"));
    const used = await f.run<VaultUseResult>(f.b, "POST", "/vault/fill", {
      entryId: entry.id,
      revision: entry.revision,
      approvalId,
      toolUseId: toolUseOf(approvalId),
      tabId: "tab-1",
    });
    expect(used.json.status).toBe("not_found");
    expect(f.h.provider.execCalls).toHaveLength(0);
    const operator = await f.h.api(
      "PATCH",
      `/api/workspaces/${f.b.workspace.id}/vault/${entry.id}`,
      { expectedRevision: 1, name: "stolen" },
    );
    expect(operator.status).toBe(404);
  });

  it("never lists connector, integration or workspace secrets that are not Vault entries", async () => {
    f = await vaultFixture();
    const { secrets } = f.h.app.deskmates.ctx;
    secrets.put("connector", "con_x", "connector-credential-canary");
    secrets.put("workspace", f.a.workspace.id, "integration-token-canary");
    const listed = await f.run<VaultListing>(f.a, "GET", "/vault/entries");
    expect(listed.json.entries).toEqual([]);
    const view = await f.h.api("GET", `/api/workspaces/${f.a.workspace.id}/vault`);
    expect(JSON.stringify(view.json)).not.toContain("canary");
  });

  it("offers the vault tools only where the workspace has a usable entry", async () => {
    f = await vaultFixture();
    const { vaultToolsOffered } = await import("./offer.js");
    const ctx = f.h.app.deskmates.ctx;
    expect(vaultToolsOffered(ctx, f.a.run, f.a.workspace.id)).toBe(false);
    await f.login(f.a);
    expect(vaultToolsOffered(ctx, f.a.run, f.a.workspace.id)).toBe(true);
    expect(vaultToolsOffered(ctx, f.b.run, f.b.workspace.id)).toBe(false);
    // A Gateway job (a review, a summary) never gets them.
    expect(
      vaultToolsOffered(ctx, { config: { runType: "approval_review" } }, f.a.workspace.id),
    ).toBe(false);
    // A token without a request definition is stored but not usable (the order note).
    await f.h.api("POST", `/api/workspaces/${f.b.workspace.id}/vault`, {
      name: "Bare",
      type: "http_header_token",
      targetOrigin: "https://api.example.test",
      token: CANARY_TOKEN,
    });
    expect(vaultToolsOffered(ctx, f.b.run, f.b.workspace.id)).toBe(false);
  });
});

// T1 (ADR-0045 decisions 4, 5 and 8): a credential release needs a live run token of that run, an
// approval of that run for the exact entry, revision, operation and origin, and it spends that
// approval once. Saving a value grants nothing. Each approval mode answers as accepted on
// 2026-10-17: a human in `automatic` (never the reviewer, never a teammate bot), the thread in
// `manual`, the mode in `approve_all`; a broad Always rule never authorizes a release, an exact one
// does until the revision changes. The fill runs the fixed command with the value on stdin only,
// refuses during takeover, and reports typed outcomes; a fill is never called a sign-in.
// Metric: unapproved releases, target 0.

import {
  type Approval,
  type ApprovalId,
  VAULT_FILL_COMMAND,
  VAULT_FILL_TOOL,
  type VaultUseResult,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANARY_PASSWORD,
  CANARY_USER,
  ORIGIN,
  type VaultFixture,
  type VaultSide,
  toolUseOf,
  vaultFixture,
} from "../test-support/vault-fixture.js";

let f: VaultFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

/** Start the workspace computer and make the fake fill command answer `status`. */
async function computer(fx: VaultFixture, side: VaultSide, status = "filled") {
  await fx.h.app.deskmates.ctx.sandboxes.ensure(side.workspace);
  fx.h.provider.onRun(async () => ({ stdout: `${JSON.stringify({ status })}\n` }));
}

const fills = (fx: VaultFixture) =>
  fx.h.provider.execCalls.filter((c) => c.req.cmd.join(" ") === VAULT_FILL_COMMAND.join(" "));

async function fill(
  fx: VaultFixture,
  side: VaultSide,
  body: { entryId: string; revision: number; approvalId: string; toolUseId?: string },
) {
  return fx.run<VaultUseResult>(side, "POST", "/vault/fill", {
    toolUseId: toolUseOf(body.approvalId as ApprovalId),
    tabId: "tab-1",
    ...body,
  });
}

describe("credential release grants", () => {
  it("accepts only the run's own live token", async () => {
    f = await vaultFixture();
    await f.login(f.a);
    const crossed = await f.run(f.a, "GET", "/vault/entries", undefined, f.b.token);
    expect(crossed.status).toBe(401);
  });

  it("gives no use for a stored value without an approval", async () => {
    f = await vaultFixture();
    const entry = await f.login(f.a);
    await computer(f, f.a);
    const used = await fill(f, f.a, {
      entryId: entry.id,
      revision: 1,
      approvalId: "apr_never_asked",
    });
    expect(used.json).toMatchObject({ status: "no_grant", ok: false });
    expect(fills(f)).toHaveLength(0);
  });

  it("binds a grant to the entry's revision, operation, origin and run", async () => {
    f = await vaultFixture();
    const entry = await f.login(f.a);
    await computer(f, f.a);
    const wrongOrigin = await f.approve(f.a, {
      ...f.action(entry, "fill"),
      targetOrigin: "https://evil.example.test",
    });
    expect(
      (await fill(f, f.a, { entryId: entry.id, revision: 1, ...wrongOrigin })).json.status,
    ).toBe("no_grant");
    const wrongOp = await f.approve(f.a, f.action(entry, "request", "vrq_x"));
    expect((await fill(f, f.a, { entryId: entry.id, revision: 1, ...wrongOp })).json.status).toBe(
      "no_grant",
    );
    const denied = await f.approve(f.a, f.action(entry, "fill"), "deny");
    expect((await fill(f, f.a, { entryId: entry.id, revision: 1, ...denied })).json.status).toBe(
      "no_grant",
    );
    const good = await f.approve(f.a, f.action(entry, "fill"));
    // A changed value is a new revision: the earlier grant no longer applies.
    await f.h.api("PUT", `/api/workspaces/${f.a.workspace.id}/vault/${entry.id}/value`, {
      expectedRevision: 1,
      password: "synthetic-other",
    });
    expect((await fill(f, f.a, { entryId: entry.id, revision: 1, ...good })).json.status).toBe(
      "revision_mismatch",
    );
    expect((await fill(f, f.a, { entryId: entry.id, revision: 2, ...good })).json.status).toBe(
      "no_grant",
    );
    expect(fills(f)).toHaveLength(0);
  });

  it("spends an approval once and returns the recorded answer to a repeat", async () => {
    f = await vaultFixture();
    const entry = await f.login(f.a);
    await computer(f, f.a);
    const { approvalId } = await f.approve(f.a, f.action(entry, "fill"));
    const first = await fill(f, f.a, { entryId: entry.id, revision: 1, approvalId });
    expect(first.json).toMatchObject({ status: "filled", ok: true });
    expect(first.json.message).toContain("does not mean you are signed in");
    const again = await fill(f, f.a, { entryId: entry.id, revision: 1, approvalId });
    expect(again.json).toMatchObject({ status: "filled", recorded: true });
    expect(fills(f)).toHaveLength(1);
  });

  it("reports a use the Gateway left in flight as unknown and never runs it again", async () => {
    f = await vaultFixture();
    const entry = await f.login(f.a);
    await computer(f, f.a);
    const { approvalId } = await f.approve(f.a, f.action(entry, "fill"));
    f.h.app.deskmates.ctx.db
      .prepare(
        `INSERT INTO vault_uses (id, workspace_id, entry_id, revision, run_id, attempt, approval_id,
           tool_use_id, operation, target, state, created_at)
         VALUES ('vus_left', ?, ?, 1, ?, 1, ?, ?, 'fill', ?, 'in_flight', ?)`,
      )
      .run(
        f.a.workspace.id,
        entry.id,
        f.a.run.id,
        approvalId,
        toolUseOf(approvalId),
        ORIGIN,
        new Date().toISOString(),
      );
    const used = await fill(f, f.a, { entryId: entry.id, revision: 1, approvalId });
    expect(used.json).toMatchObject({ status: "unknown", recorded: true });
    expect(fills(f)).toHaveLength(0);
  });
});

describe("browser fill (decision 5)", () => {
  it("runs the fixed command with the value on stdin only and answers no value", async () => {
    f = await vaultFixture();
    const entry = await f.login(f.a);
    await computer(f, f.a);
    const { approvalId } = await f.approve(f.a, f.action(entry, "fill"));
    const used = await fill(f, f.a, { entryId: entry.id, revision: 1, approvalId });
    const [call] = fills(f);
    expect(call?.req.cmd).toEqual(VAULT_FILL_COMMAND);
    expect(call?.req.env).toBeUndefined();
    expect(JSON.parse(call?.req.stdin ?? "{}")).toMatchObject({
      tabId: "tab-1",
      origin: ORIGIN,
      username: CANARY_USER,
      password: CANARY_PASSWORD,
    });
    for (const canary of [CANARY_USER, CANARY_PASSWORD]) {
      expect(call?.req.cmd.join(" ")).not.toContain(canary);
      expect(JSON.stringify(used.json)).not.toContain(canary);
    }
  });

  it("refuses during a human takeover before anything is decrypted", async () => {
    f = await vaultFixture();
    const entry = await f.login(f.a);
    await computer(f, f.a);
    const { approvalId } = await f.approve(f.a, f.action(entry, "fill"));
    f.h.app.deskmates.ctx.locks.humanTake(f.a.workspace.id);
    const used = await fill(f, f.a, { entryId: entry.id, revision: 1, approvalId });
    expect(used.json.status).toBe("takeover");
    expect(fills(f)).toHaveLength(0);
  });

  it("keeps the command's typed outcomes distinct from an empty Vault (decision 8)", async () => {
    f = await vaultFixture();
    const empty = await f.run<{ entries: unknown[]; note?: string }>(f.a, "GET", "/vault/entries");
    expect(empty.json.note).toContain("no usable credentials");
    const entry = await f.login(f.a);
    for (const status of ["missing_fields", "target_mismatch", "navigated", "not_password_field"]) {
      await computer(f, f.a, status);
      const { approvalId } = await f.approve(f.a, f.action(entry, "fill"));
      const used = await fill(f, f.a, { entryId: entry.id, revision: 1, approvalId });
      expect(used.json).toMatchObject({ status, ok: false });
    }
    // Something the command did not promise is a failed fill, never a success.
    await computer(f, f.a, "signed_in");
    const { approvalId } = await f.approve(f.a, f.action(entry, "fill"));
    expect((await fill(f, f.a, { entryId: entry.id, revision: 1, approvalId })).json.status).toBe(
      "fill_failed",
    );
    const view = await f.h.api<{ vault: { entries: { lastUse?: { status: string } }[] } }>(
      "GET",
      `/api/workspaces/${f.a.workspace.id}/vault`,
    );
    expect(view.json.vault.entries[0]?.lastUse?.status).toBe("fill_failed");
  });

  it("disabling an entry stops a use that was already approved", async () => {
    f = await vaultFixture();
    const entry = await f.login(f.a);
    await computer(f, f.a);
    const { approvalId } = await f.approve(f.a, f.action(entry, "fill"));
    await f.h.api("PATCH", `/api/workspaces/${f.a.workspace.id}/vault/${entry.id}`, {
      expectedRevision: 1,
      enabled: false,
    });
    expect((await fill(f, f.a, { entryId: entry.id, revision: 1, approvalId })).json.status).toBe(
      "disabled",
    );
    expect(fills(f)).toHaveLength(0);
  });
});

describe("approval modes and rules (decision 4)", () => {
  const card = (fx: VaultFixture, id: ApprovalId): Approval =>
    fx.h.app.deskmates.ctx.approvals.mustGet(id);
  const phases = (fx: VaultFixture, side: VaultSide) =>
    fx.h.app.deskmates.ctx.events
      .list(side.run.id)
      .filter((e) => e.kind === "approval")
      .map((e) => e.payload);

  it("automatic: a person decides; the reviewer never sees it and a teammate bot may not", async () => {
    f = await vaultFixture({ mode: "automatic" });
    const entry = await f.login(f.a);
    const { approvalId } = await f.approve(f.a, f.action(entry, "fill"), false);
    expect(card(f, approvalId).messageId).toBeDefined();
    expect(phases(f, f.a)).toContainEqual(
      expect.objectContaining({ phase: "review_skipped", reason: "credential" }),
    );
    const ctx = f.h.app.deskmates.ctx;
    const mateRun = ctx.runs.transition(
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
    const mate = { ...f.a, run: mateRun, token: ctx.tokens.issue(mateRun.id).token };
    const decided = await f.run<{ details: { refusal: string } }>(
      mate,
      "POST",
      `/approvals/${approvalId}/decide`,
      { type: "approval_decide", runId: mateRun.id, approvalId, decision: "allow_once" },
    );
    expect(decided.status).toBe(403);
    expect(decided.json.details.refusal).toBe("vault_human_only");
    expect(card(f, approvalId).decision).toBeUndefined();
  });

  it("manual: the thread decides, a teammate bot included", async () => {
    f = await vaultFixture({ mode: "manual" });
    const entry = await f.login(f.a);
    const { approvalId } = await f.approve(f.a, f.action(entry, "fill"), false);
    expect(card(f, approvalId).messageId).toBeDefined();
    const ctx = f.h.app.deskmates.ctx;
    const mateRun = ctx.runs.transition(
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
    const mate = { ...f.a, run: mateRun, token: ctx.tokens.issue(mateRun.id).token };
    const decided = await f.run(mate, "POST", `/approvals/${approvalId}/decide`, {
      type: "approval_decide",
      runId: mateRun.id,
      approvalId,
      decision: "allow_once",
    });
    expect(decided.status).toBe(200);
    expect(card(f, approvalId).decidedBy).toBe(`bot:${f.a.teammate.id}`);
  });

  it("approve_all: the mode allows the release and is recorded as the decider", async () => {
    f = await vaultFixture({ mode: "approve_all" });
    const entry = await f.login(f.a);
    await computer(f, f.a);
    const { approvalId, response } = await f.approve(f.a, f.action(entry, "fill"), false);
    expect(response?.decision).toBe("allow");
    expect(card(f, approvalId).decidedBy).toBe("mode:approve_all");
    const used = await fill(f, f.a, { entryId: entry.id, revision: 1, approvalId });
    expect(used.json.status).toBe("filled");
    // The origin and revision checks are not approvals: they hold in this mode too.
    const stale = await f.approve(
      f.a,
      { ...f.action(entry, "fill"), targetOrigin: "https://x.example.test" },
      false,
    );
    expect((await fill(f, f.a, { entryId: entry.id, revision: 1, ...stale })).json.status).toBe(
      "no_grant",
    );
  });

  it("never lets a broad Always rule authorize a release; an exact one holds until the revision changes", async () => {
    f = await vaultFixture({ mode: "manual" });
    const entry = await f.login(f.a);
    const ctx = f.h.app.deskmates.ctx;
    ctx.rules.create({
      botId: f.a.bot.id,
      matcher: { toolName: VAULT_FILL_TOOL },
      decision: "allow_always",
      createdBy: "human:tester",
    });
    ctx.rules.create({
      botId: f.a.bot.id,
      matcher: { toolName: VAULT_FILL_TOOL, targetOrigin: "https://*.example.test" },
      decision: "allow_always",
      createdBy: "human:tester",
    });
    const broad = await f.approve(f.a, f.action(entry, "fill"), false);
    expect(card(f, broad.approvalId).decision).toBeUndefined();
    // A person answers Always: the stored rule binds the exact action.
    const decided = ctx.broker.decide(broad.approvalId, "allow_always", "human:tester");
    expect(decided.rule?.matcher).toEqual({
      toolName: VAULT_FILL_TOOL,
      targetOrigin: ORIGIN,
      argumentPattern: `vault:${entry.id} rev:1 op:fill`,
    });
    const exact = await f.approve(f.a, f.action(entry, "fill"), false);
    expect(card(f, exact.approvalId).decidedBy).toBe(`rule:${decided.rule?.id}`);
    // The exact rule keeps answering that same action.
    const third = await f.approve(f.a, f.action(entry, "fill"), false);
    expect(card(f, third.approvalId).decision).toBe("allow_always");
    // A replaced value is a new revision: the rule no longer applies, and a widened Always is
    // refused.
    const replaced = await f.h.api<{ entry: { revision: number } }>(
      "PUT",
      `/api/workspaces/${f.a.workspace.id}/vault/${entry.id}/value`,
      { expectedRevision: 1, password: "synthetic-next" },
    );
    const next = await f.approve(
      f.a,
      f.action({ ...entry, revision: replaced.json.entry.revision }, "fill"),
      false,
    );
    expect(card(f, next.approvalId).decision).toBeUndefined();
    expect(() =>
      ctx.broker.decide(next.approvalId, "allow_always", "human:tester", undefined, {
        matcher: {
          toolName: VAULT_FILL_TOOL,
          targetOrigin: ORIGIN,
          argumentPattern: `vault:${entry.id} *`,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "validation" }));
  });
});

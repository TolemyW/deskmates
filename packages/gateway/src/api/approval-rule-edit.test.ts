// T1: ADR-0043 decision 6. An approval rule is edited in place: same id, same oldest-first place,
// the same validation as a new rule, and an `approval_rule.update` audit row with both sides.

import type { ApprovalRule } from "@deskmates/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

it("edits a rule's decision and matcher in place and audits the change", async () => {
  const { bot } = await h.seed();
  const first = await h.api<{ rule: ApprovalRule }>("POST", `/api/bots/${bot.id}/approval-rules`, {
    matcher: { toolName: "mcp__browser__browser_click" },
    decision: "allow_always",
  });
  const second = await h.api<{ rule: ApprovalRule }>("POST", `/api/bots/${bot.id}/approval-rules`, {
    matcher: { toolName: "Bash" },
    decision: "deny",
  });
  const edited = await h.api<{ rule: ApprovalRule }>(
    "PATCH",
    `/api/approval-rules/${first.json.rule.id}`,
    { decision: "deny", matcher: { toolName: "mcp__browser__browser_type" } },
  );
  expect(edited.status).toBe(200);
  expect(edited.json.rule).toMatchObject({
    id: first.json.rule.id,
    decision: "deny",
    matcher: { toolName: "mcp__browser__browser_type" },
    createdAt: first.json.rule.createdAt,
  });
  const listed = await h.api<{ rules: ApprovalRule[] }>(
    "GET",
    `/api/bots/${bot.id}/approval-rules`,
  );
  expect(listed.json.rules.map((rule) => rule.id)).toEqual([
    first.json.rule.id,
    second.json.rule.id,
  ]);
  const audit = h.app.deskmates.ctx.audit
    .list({ targetId: first.json.rule.id })
    .find((event) => event.action === "approval_rule.update");
  expect(audit?.before).toMatchObject({ decision: "allow_always" });
  expect(audit?.after).toMatchObject({ decision: "deny" });

  for (const body of [
    {},
    { decision: "allow_once" },
    { matcher: "click" },
    { matcher: { toolName: 7 } },
  ]) {
    const bad = await h.api("PATCH", `/api/approval-rules/${first.json.rule.id}`, body);
    expect(bad.status, JSON.stringify(body)).toBe(400);
  }
});

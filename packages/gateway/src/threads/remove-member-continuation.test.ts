// T0: a parked continuation still owns its thread membership and SDK session.
import type { ApprovalId, BotId, WorkspaceId } from "@deskmates/contracts";
import { expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { RunStore } from "../ledger/runs.js";
import { ThreadStore } from "./threads.js";

it("refuses to remove a member while its run awaits continuation", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(
      "INSERT INTO workspaces (id, tenant_id,name,sandbox_provider,status,created_at) VALUES ('ws', 'tnt_default','Work','docker','ready','t')",
    ).run();
    db.prepare(
      "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('a','A','role','ws','t'),('b','B','role','ws','t')",
    ).run();
    const threads = new ThreadStore(db);
    const thread = threads.create({
      workspaceId: "ws" as WorkspaceId,
      botIds: ["a" as BotId, "b" as BotId],
    });
    const runs = new RunStore(db);
    const run = runs.create({
      botId: "a" as BotId,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "message",
    });
    runs.transition(run.id, "running");
    runs.transition(run.id, "waiting_continuation", {
      resumePayload: {
        sdkSessionId: "session",
        approvalId: "approval" as ApprovalId,
        continuation: true,
      },
    });

    expect(() => threads.removeMember(thread.id, "a" as BotId)).toThrow(/unfinished work/);
    expect(threads.members(thread.id).map((member) => member.botId)).toContain("a");

    runs.transition(run.id, "stopped");
    expect(threads.removeMember(thread.id, "a" as BotId)).toBe(true);
  } finally {
    db.close();
  }
});

// T1: the publication store (ADR-0035 decisions 1 and 8): a bot's and a person's publication are
// recorded and audited with their own actor, one active row per port, revocation is idempotent.

import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";
import { AppShareStore } from "./app-share-store.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setup() {
  h = await startHarness();
  const { ctx } = h.app.deskmates;
  const workspace = ctx.workspaces.create({ name: "w", sandboxProvider: "docker" });
  return { ctx, workspace, store: new AppShareStore(ctx.db, ctx.audit) };
}

describe("AppShareStore", () => {
  it("records who published: a bot with its run, or a person", async () => {
    const { ctx, workspace, store } = await setup();
    const byBot = store.publish({
      workspaceId: workspace.id,
      port: 3000,
      label: "Bot app",
      by: { kind: "bot", botId: "bot_1", runId: "run_1" },
    }).share;
    expect(byBot).toMatchObject({ botId: "bot_1", runId: "run_1", publishedBy: null });
    const byPerson = store.publish({
      workspaceId: workspace.id,
      port: 3001,
      label: "Preview",
      by: { kind: "person", actor: "user:usr_1" },
    }).share;
    expect(byPerson).toMatchObject({ botId: null, runId: null, publishedBy: "user:usr_1" });
    expect(store.get(byPerson.id)?.publishedBy).toBe("user:usr_1");
    const audit = ctx.audit
      .list({ workspaceId: workspace.id })
      .filter((e) => e.action === "app_share.publish")
      .map((e) => [e.actor, e.targetId]);
    expect(audit).toEqual(
      expect.arrayContaining([
        ["bot:bot_1", byBot.id],
        ["user:usr_1", byPerson.id],
      ]),
    );
  });

  it("keeps one active publication per port and revokes once", async () => {
    const { workspace, store } = await setup();
    const by = { kind: "person", actor: "user:usr_1" } as const;
    const first = store.publish({ workspaceId: workspace.id, port: 3000, label: "A", by });
    const again = store.publish({ workspaceId: workspace.id, port: 3000, label: "B", by });
    expect(again).toMatchObject({ existing: true, share: { id: first.share.id, label: "B" } });
    const revoked = store.revoke(first.share.id, "user:usr_2");
    expect(revoked.revokedBy).toBe("user:usr_2");
    expect(store.revoke(first.share.id, "user:usr_3").revokedBy).toBe("user:usr_2");
    expect(store.activeIds(workspace.id)).toEqual([]);
  });
});

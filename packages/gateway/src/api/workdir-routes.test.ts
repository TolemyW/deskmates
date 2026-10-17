// T1: the working-directory settings routes (ADR-0036 decision 1, ADR-0038 decisions 1 and 7). A
// Member reads, only an Admin changes, a change is audited, and `worktreeRepo`, no longer a
// setting, is a 400 that writes nothing.

import type { WorkdirSettingsView } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const audits = (harness: Harness) =>
  harness.app.deskmates.ctx.db
    .prepare("SELECT actor FROM audit_events WHERE action = 'workspace.workdir_set'")
    .all() as { actor: string }[];

describe("working-directory settings routes (ADR-0036)", () => {
  it("a Member reads, a Member cannot change, an Admin changes and is audited", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const people = await seedRoles(harness);
    const path = `/api/workspaces/${people.workspace.id}/workdir`;

    const read = await people.member.json<{ workdir: WorkdirSettingsView }>("GET", path);
    expect(read.status).toBe(200);
    expect(read.json.workdir).toMatchObject({
      settings: {},
      effective: { mode: "per-bot", source: "gateway", laneNotice: false },
      gatewayMode: "per-bot",
    });

    const refused = await people.member.fetch("PUT", path, { body: { mode: "shared" } });
    expect(refused.status).toBe(403);

    const bad = await people.admin.fetch("PUT", path, {
      body: { mode: "per-bot", worktreeRepo: "/work/app" },
    });
    expect(bad.status).toBe(400);
    expect(audits(harness)).toEqual([]);

    const set = await people.admin.json<{ workdir: WorkdirSettingsView }>("PUT", path, {
      body: { mode: "shared", laneNotice: true },
    });
    expect(set.status).toBe(200);
    expect(set.json.workdir.effective).toEqual({
      mode: "shared",
      source: "workspace",
      laneNotice: true,
    });
    expect(audits(harness)).toEqual([{ actor: `user:${people.ids.ada}` }]);
  });
});

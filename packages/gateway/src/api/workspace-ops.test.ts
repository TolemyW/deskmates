// T1: the M1 operations routes on a workspace — editing the human-maintained egress allowlist
// and restarting the container so the browser layer picks it up (AGENTS.md "Egress is
// deny-by-default": the list is human-maintained and the agent cannot edit it).

import { DeskmatesError } from "@deskmates/contracts";
import type {
  BotDefinition,
  EgressAllowlistResponse,
  RunEvent,
  Thread,
  Workspace,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "../events/bus.js";
import type { RunRecord } from "../ledger/runs.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, openSse, startHarness, waitFor } from "../test-support/harness.js";

interface Seeded {
  workspace: Workspace;
  bot: BotDefinition;
  thread: Thread;
}

interface WorkspaceView {
  workspace: Workspace;
}

interface PatchResult {
  workspace: Workspace;
  note: string;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SUMMARY = {
  done: "answered",
  filesChanged: [],
  sitesVisited: [],
  pendingApprovals: [],
  memorySuggestions: [],
  reply: "ok",
};

let h: Harness;

async function seedWorkspace(name: string, egressAllowlist: string[]): Promise<Seeded> {
  const ws = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    name,
    egressAllowlist,
  });
  const workspace = ws.json.workspace;
  const bot = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
    name: `${name}-bot`,
    workspaceId: workspace.id,
  });
  const thread = await h.api<{ thread: Thread }>("POST", "/api/threads", {
    workspaceId: workspace.id,
    botIds: [bot.json.bot.id],
  });
  return { workspace, bot: bot.json.bot, thread: thread.json.thread };
}

/** A run whose fake sidecar is parked inside `exec` until `release` resolves. */
interface LiveRun {
  run: RunRecord;
  gw: FakeSidecarClient;
  finish(): Promise<void>;
}

async function startLiveRun(s: Seeded): Promise<LiveRun> {
  const release = deferred();
  const running = deferred<FakeSidecarClient>();
  h.provider.onRun(async (_req, gw) => {
    running.resolve(gw);
    await release.promise;
  });
  const posted = await h.api<{ runs: RunRecord[] }>(
    "POST",
    `/api/threads/${s.thread.id}/messages`,
    { body: "hello" },
  );
  const run = posted.json.runs[0] as RunRecord;
  const gw = await running.promise;
  await waitFor(
    () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "running",
    3000,
    "run running",
  );
  return {
    run: h.app.deskmates.ctx.runs.mustGet(run.id),
    gw,
    finish: async () => {
      await gw.post("ended", {
        type: "run_ended",
        runId: run.id,
        outcome: "completed",
        summary: SUMMARY,
        usage: [],
      });
      release.resolve();
      await waitFor(
        () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
        3000,
        "run done",
      );
    },
  };
}

/** One run that starts and ends, which is what makes the provider create the container. */
async function runOnce(s: Seeded): Promise<void> {
  h.provider.onRun(async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: SUMMARY,
      usage: [],
    });
  });
  const posted = await h.api<{ runs: RunRecord[] }>(
    "POST",
    `/api/threads/${s.thread.id}/messages`,
    { body: "hi" },
  );
  const run = posted.json.runs[0] as RunRecord;
  await waitFor(
    () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
    3000,
    "first run",
  );
}

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("editable egress allowlist (PATCH /api/workspaces/:id)", () => {
  it("replaces the list, dates the change and answers with the two-layer note", async () => {
    const s = await seedWorkspace("egress", ["old.example.test"]);
    const before = s.workspace.egressUpdatedAt;
    expect(before).toBe(s.workspace.createdAt);

    const patched = await h.api<PatchResult>("PATCH", `/api/workspaces/${s.workspace.id}`, {
      egressAllowlist: ["a.example.test", "*.b.example.test"],
      authorId: "ops",
    });
    expect(patched.status).toBe(200);
    expect(patched.json.workspace.egressAllowlist).toEqual(["a.example.test", "*.b.example.test"]);
    expect(patched.json.note).toContain("next navigation");
    expect(patched.json.note).toContain("immediately");

    const view = await h.api<WorkspaceView>("GET", `/api/workspaces/${s.workspace.id}`);
    expect(view.json.workspace.egressAllowlist).toEqual(["a.example.test", "*.b.example.test"]);
    expect(Date.parse(view.json.workspace.egressUpdatedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(before as string),
    );
  });

  it("publishes a workspace frame so the UI redraws the list", async () => {
    const s = await seedWorkspace("egress-sse", ["old.example.test"]);
    const sse = await openSse(h.baseUrl);
    await h.api<PatchResult>("PATCH", `/api/workspaces/${s.workspace.id}`, {
      egressAllowlist: ["new.example.test"],
    });
    await waitFor(() => sse.events.some((e) => e.type === "workspace"), 3000, "workspace frame");
    const frame = sse.events.find((e) => e.type === "workspace") as Extract<
      GatewayEvent,
      { type: "workspace" }
    >;
    expect(frame.workspaceId).toBe(s.workspace.id);
    expect(frame.workspace.egressAllowlist).toEqual(["new.example.test"]);
    sse.close();
  });

  it("rejects a pattern that is not a hostname and changes nothing", async () => {
    const s = await seedWorkspace("egress-bad", ["old.example.test"]);
    for (const bad of ["https://evil.example.test/", "has space.test", "*.", ""]) {
      const res = await h.api<{ code: string }>("PATCH", `/api/workspaces/${s.workspace.id}`, {
        egressAllowlist: ["ok.example.test", bad],
      });
      expect(res.status, bad).toBe(400);
      expect(res.json.code).toBe("validation");
    }
    const view = await h.api<WorkspaceView>("GET", `/api/workspaces/${s.workspace.id}`);
    expect(view.json.workspace.egressAllowlist).toEqual(["old.example.test"]);
    expect(view.json.workspace.egressUpdatedAt).toBe(s.workspace.egressUpdatedAt);
  });

  it("accepts the lone '*' (open internet) and refuses it mixed with other entries (ADR-0010)", async () => {
    const s = await seedWorkspace("egress-open", ["old.example.test"]);
    const mixed = await h.api<{ code: string; message: string }>(
      "PATCH",
      `/api/workspaces/${s.workspace.id}`,
      { egressAllowlist: ["*", "ok.example.test"] },
    );
    expect(mixed.status).toBe(400);
    expect(mixed.json.code).toBe("validation");
    expect(mixed.json.message).toContain("only entry");
    const unchanged = await h.api<WorkspaceView>("GET", `/api/workspaces/${s.workspace.id}`);
    expect(unchanged.json.workspace.egressAllowlist).toEqual(["old.example.test"]);

    const open = await h.api<PatchResult>("PATCH", `/api/workspaces/${s.workspace.id}`, {
      egressAllowlist: ["*"],
    });
    expect(open.status).toBe(200);
    expect(open.json.workspace.egressAllowlist).toEqual(["*"]);

    const created = await h.api<{ workspace: { egressAllowlist: string[] } }>(
      "POST",
      "/api/workspaces",
      { name: "ws-open", egressAllowlist: ["*"] },
    );
    expect(created.status).toBe(201);
    expect(created.json.workspace.egressAllowlist).toEqual(["*"]);
    const createdMixed = await h.api<{ code: string }>("POST", "/api/workspaces", {
      name: "ws-open-mixed",
      egressAllowlist: ["*.example.test", "*"],
    });
    expect(createdMixed.status).toBe(400);
    expect(createdMixed.json.code).toBe("validation");
  });

  it("POST /api/workspaces rejects the same bad pattern", async () => {
    const res = await h.api<{ code: string }>("POST", "/api/workspaces", {
      name: "ws-bad-egress",
      egressAllowlist: ["https://evil.example.test/"],
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("validation");
  });

  it("serves the new list to a run that started before the edit, dated after its start", async () => {
    const s = await seedWorkspace("egress-live", ["old.example.test"]);
    const live = await startLiveRun(s);
    const startedAt = live.run.startedAt as string;

    const first = await live.gw.get("egress");
    expect(first.status).toBe(200);
    expect(((await first.json()) as EgressAllowlistResponse).egressAllowlist).toEqual([
      "old.example.test",
    ]);

    await new Promise((r) => setTimeout(r, 5));
    await h.api<PatchResult>("PATCH", `/api/workspaces/${s.workspace.id}`, {
      egressAllowlist: ["new.example.test"],
    });

    const res = await live.gw.get("egress");
    const body = (await res.json()) as EgressAllowlistResponse;
    expect(body.type).toBe("egress_allowlist");
    expect(body.egressAllowlist).toEqual(["new.example.test"]);
    expect(Date.parse(body.updatedAt)).toBeGreaterThan(Date.parse(startedAt));
    await live.finish();
  });

  it("rejects an unauthenticated read of the internal egress route", async () => {
    const s = await seedWorkspace("egress-auth", ["old.example.test"]);
    const live = await startLiveRun(s);
    const res = await live.gw.get("egress", "not-a-token");
    expect(res.status).toBe(401);
    await live.finish();
  });

  it("tells every live run what was added and removed", async () => {
    const s = await seedWorkspace("egress-log", ["keep.example.test", "drop.example.test"]);
    const live = await startLiveRun(s);

    await h.api<PatchResult>("PATCH", `/api/workspaces/${s.workspace.id}`, {
      egressAllowlist: ["keep.example.test", "add.example.test"],
      authorId: "ops",
    });

    const events = await h.api<{ events: RunEvent[] }>("GET", `/api/runs/${live.run.id}/events`);
    const logged = events.json.events.find(
      (e) => e.kind === "log" && e.payload.source === "egress",
    );
    expect(logged).toBeDefined();
    expect(logged?.payload).toMatchObject({
      source: "egress",
      op: "allowlist_replaced",
      by: "human:ops",
      added: ["add.example.test"],
      removed: ["drop.example.test"],
    });
    await live.finish();
  });
});

describe("POST /api/workspaces/:id/restart", () => {
  it("refuses while a run of the workspace is live and names it", async () => {
    const s = await seedWorkspace("restart-busy", ["old.example.test"]);
    const live = await startLiveRun(s);

    const res = await h.api<{ code: string; details: { liveRuns: string[] } }>(
      "POST",
      `/api/workspaces/${s.workspace.id}/restart`,
      {},
    );
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("lane_busy");
    expect(res.json.details.liveRuns).toEqual([live.run.id]);
    // Nothing was touched.
    expect(h.provider.ops).toEqual(["create"]);
    await live.finish();
  });

  it("destroys and recreates the container so the new allowlist reaches Chromium", async () => {
    h.provider.novncAddress = "127.0.0.1:34567";
    const s = await seedWorkspace("restart", ["old.example.test"]);
    await runOnce(s);
    const firstSpec = h.provider.created[0];
    expect(firstSpec?.env).toEqual({
      DESKMATES_EGRESS_ALLOWLIST: "old.example.test",
      DESKMATES_VNC_PASSWORD: expect.stringMatching(/^[a-f0-9]{8}$/),
      DESKMATES_VNC_VIEW_PASSWORD: expect.stringMatching(/^[a-f0-9]{8}$/),
      DESKMATES_DESKTOP_MODE: "shared-monitors-v1",
    });

    await h.api<PatchResult>("PATCH", `/api/workspaces/${s.workspace.id}`, {
      egressAllowlist: ["new.example.test", "*.other.example.test"],
    });

    const res = await h.api<{ handle: { providerRef: string } }>(
      "POST",
      `/api/workspaces/${s.workspace.id}/restart`,
      {},
    );
    expect(res.status).toBe(200);
    expect(res.json.handle.providerRef).toBe(`fake-${s.workspace.id}`);
    // No sidecar or noVNC address and no secrets leave the Gateway on this route (C7).
    expect(Object.keys(res.json.handle)).toEqual(["providerRef"]);

    expect(h.provider.ops).toEqual(["create", "destroy", "create"]);
    expect(h.provider.destroyed[0]?.providerRef).toBe(`fake-${s.workspace.id}`);
    const secondSpec = h.provider.created[1];
    expect(secondSpec?.env).toEqual({
      DESKMATES_EGRESS_ALLOWLIST: "new.example.test,*.other.example.test",
      DESKMATES_VNC_PASSWORD: expect.stringMatching(/^[a-f0-9]{8}$/),
      DESKMATES_VNC_VIEW_PASSWORD: expect.stringMatching(/^[a-f0-9]{8}$/),
      DESKMATES_DESKTOP_MODE: "shared-monitors-v1",
    });
    // Named volumes survive the container: the profile, the work tree and the bot homes.
    expect(secondSpec?.volumes).toEqual(firstSpec?.volumes);
  });

  it("preserves the old handle and takeover lock when compatibility preflight fails", async () => {
    const s = await seedWorkspace("restart-preflight", []);
    await runOnce(s);
    const old = await h.app.deskmates.ctx.sandboxes.peek(s.workspace.id);
    await h.api("POST", `/api/workspaces/${s.workspace.id}/takeover`, {});
    vi.spyOn(h.provider, "preflight").mockRejectedValueOnce(
      new DeskmatesError("sandbox_unavailable", "legacy volume needs audited recovery", {
        reason: "volume_ownership_mismatch",
      }),
    );
    const res = await h.api<{ code: string; details: { reason: string } }>(
      "POST",
      `/api/workspaces/${s.workspace.id}/restart`,
      {},
    );
    expect(res.json.code).toBe("sandbox_unavailable");
    expect(res.json.details.reason).toBe("volume_ownership_mismatch");
    expect(h.provider.ops).toEqual(["create"]);
    expect(await h.app.deskmates.ctx.sandboxes.peek(s.workspace.id)).toBe(old);
    expect(h.app.deskmates.ctx.locks.humanHolds(s.workspace.id)).toBe(true);
  });

  it("releases a human browser lock, because the screen it was watching is gone", async () => {
    const s = await seedWorkspace("restart-lock", ["old.example.test"]);
    await runOnce(s);
    await h.api("POST", `/api/workspaces/${s.workspace.id}/takeover`, {});
    const sse = await openSse(h.baseUrl);

    const res = await h.api("POST", `/api/workspaces/${s.workspace.id}/restart`, {});
    expect(res.status).toBe(200);

    await waitFor(
      () => sse.events.some((e) => e.type === "workspace_lock"),
      3000,
      "workspace_lock frame",
    );
    const frame = sse.events.find((e) => e.type === "workspace_lock") as Extract<
      GatewayEvent,
      { type: "workspace_lock" }
    >;
    expect(frame.browserLock).toBeNull();
    const view = await h.api<{ browserLock: unknown }>("GET", `/api/workspaces/${s.workspace.id}`);
    expect(view.json.browserLock).toBeNull();
    sse.close();
  });
});

it("previews volatile prerequisites before destruction and retains restoration evidence after recreation", async () => {
  const s = await seedWorkspace("temporary-nss", []);
  await runOnce(s);
  const other = await seedWorkspace("unrelated", []);
  const prerequisite = {
    code: "volatile_nss_database" as const,
    path: "/root/.pki/nssdb",
    sourceProviderRef: `fake-${s.workspace.id}`,
  };
  h.provider.volatilePrerequisites = [prerequisite];
  const operationsBeforePreview = [...h.provider.ops];
  const preview = await h.api<{ prerequisites: unknown[] }>(
    "GET",
    `/api/workspaces/${s.workspace.id}/restart-preflight`,
  );
  expect(preview.json.prerequisites).toEqual([prerequisite]);
  expect(h.provider.ops).toEqual(operationsBeforePreview);
  expect(
    h.app.deskmates.ctx.workspaces.mustGet(s.workspace.id).restorationRequirements,
  ).toBeUndefined();
  const restarted = await h.api<{ restorationRequirements: unknown[] }>(
    "POST",
    `/api/workspaces/${s.workspace.id}/restart`,
    {},
  );
  expect(restarted.json.restorationRequirements).toEqual([
    { ...prerequisite, status: "restoration_required" },
  ]);
  const stored = await h.api<{ workspace: Workspace }>("GET", `/api/workspaces/${s.workspace.id}`);
  expect(stored.json.workspace.restorationRequirements).toEqual(
    restarted.json.restorationRequirements,
  );
  expect(
    h.app.deskmates.ctx.workspaces.mustGet(other.workspace.id).restorationRequirements,
  ).toBeUndefined();
  // A later restart with nothing volatile reports no findings of its own; the earlier notice
  // is returned separately as outstanding, never as this restart's result.
  h.provider.volatilePrerequisites = [];
  const again = await h.api<{
    restorationRequirements: unknown[];
    outstandingRestorationRequirements: unknown[];
  }>("POST", `/api/workspaces/${s.workspace.id}/restart`, {});
  expect(again.json.restorationRequirements).toEqual([]);
  expect(again.json.outstandingRestorationRequirements).toEqual(
    restarted.json.restorationRequirements,
  );
  const unauthorized = await fetch(
    `${h.baseUrl}/api/workspaces/${s.workspace.id}/restart-preflight`,
  );
  expect(unauthorized.status).toBe(401);
});

it("retains actionable restoration evidence if replacement creation fails after runtime removal", async () => {
  const s = await seedWorkspace("temporary-nss-create-failure", []);
  await runOnce(s);
  h.provider.volatilePrerequisites = [
    {
      code: "volatile_nss_database",
      path: "/root/.pki/nssdb",
      sourceProviderRef: `fake-${s.workspace.id}`,
    },
  ];
  h.provider.createErrors.push(new DeskmatesError("sandbox_unavailable", "new image not ready"));
  const result = await h.api("POST", `/api/workspaces/${s.workspace.id}/restart`, {});
  expect(result.status).toBe(503);
  expect(
    h.app.deskmates.ctx.workspaces.mustGet(s.workspace.id).restorationRequirements?.[0]?.status,
  ).toBe("restoration_required");
});

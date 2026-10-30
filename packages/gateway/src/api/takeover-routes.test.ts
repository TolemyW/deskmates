// T1: human takeover of the shared browser (design v0.3 §3.3, ADR-0004 decision 6). The lock is
// workspace-wide: taking over marks every live run of every bot in that workspace and makes the
// browser tools in all of them wait, and handing back releases it for all of them at once.

import {
  type BotDefinition,
  type BrowserLock,
  HUMAN_HOLDS_BROWSER_MESSAGE,
  NOVNC_CONTAINER_PORT,
  type RunEvent,
  type StartRunRequest,
  type Thread,
  type Workspace,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashWebhookToken, newWebhookToken } from "../bots/webhook-token.js";
import type { GatewayEvent } from "../events/bus.js";
import type { RunRecord } from "../ledger/runs.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import {
  type Harness,
  TEST_OPERATOR_TOKEN,
  openSse,
  startHarness,
  waitFor,
} from "../test-support/harness.js";

interface Seeded {
  workspace: Workspace;
  bot: BotDefinition;
  thread: Thread;
  webhookToken: string;
}

interface WorkspaceView {
  workspace: Workspace;
  bots: BotDefinition[];
  browserLock: BrowserLock | null;
  browserLockHeldByMe: boolean;
  takeoverScreen: boolean;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function summary(reply: string) {
  return {
    done: "answered",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  };
}

let h: Harness;

async function seedWorkspace(name: string): Promise<Seeded> {
  const ws = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    name,
    defaultBot: false,
  });
  const workspace = ws.json.workspace;
  const webhookToken = newWebhookToken();
  const bot = h.app.deskmates.ctx.bots.create({
    name: `${name}-bot`,
    role: "tester",
    workspaceId: workspace.id,
    webhookTokenHash: hashWebhookToken(webhookToken),
  });
  const thread = h.app.deskmates.ctx.privateChats.resolve(bot.id);
  return {
    workspace,
    bot,
    thread,
    webhookToken,
  };
}

/** Starts a thread run for the seeded bot and waits until the fake sidecar is running it. */
async function startThreadRun(s: Seeded): Promise<RunRecord> {
  const posted = await h.api<{ runs: RunRecord[] }>(
    "POST",
    `/api/threads/${s.thread.id}/messages`,
    { body: `hello @${s.bot.name}` },
  );
  const run = posted.json.runs[0] as RunRecord;
  await waitFor(
    () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "running",
    3000,
    "thread run running",
  );
  return run;
}

async function startWebhookRun(s: Seeded): Promise<RunRecord> {
  const res = await fetch(`${h.baseUrl}/hooks/${s.bot.id}/${s.webhookToken}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "ping",
  });
  const { runId } = (await res.json()) as { runId: string };
  await waitFor(
    () => h.app.deskmates.ctx.runs.mustGet(runId as RunRecord["id"]).status === "running",
    3000,
    "webhook run running",
  );
  return h.app.deskmates.ctx.runs.mustGet(runId as RunRecord["id"]);
}

async function eventsOf(runId: string): Promise<RunEvent[]> {
  const res = await h.api<{ events: RunEvent[] }>("GET", `/api/runs/${runId}/events`);
  return res.json.events;
}

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("takeover routes (design v0.3 §3.3; ADR-0004 decision 6)", () => {
  it("takeover holds the workspace lock, handback releases it, and handback is idempotent", async () => {
    const s = await seedWorkspace("takeover");

    const take = await h.api<{ lock: BrowserLock }>(
      "POST",
      `/api/workspaces/${s.workspace.id}/takeover`,
      {},
    );
    expect(take.status).toBe(200);
    expect(take.json.lock).toMatchObject({ workspaceId: s.workspace.id, holderKind: "human" });
    expect(Date.parse(take.json.lock.expiresAt)).toBeGreaterThan(
      Date.parse(take.json.lock.acquiredAt),
    );

    const held = await h.api<WorkspaceView>("GET", `/api/workspaces/${s.workspace.id}`);
    expect(held.json.browserLock?.holderKind).toBe("human");
    expect(held.json.browserLockHeldByMe).toBe(true);

    const back = await h.api<{ released: boolean }>(
      "POST",
      `/api/workspaces/${s.workspace.id}/handback`,
      {},
    );
    expect(back.status).toBe(200);
    expect(back.json).toEqual({ released: true });

    const free = await h.api<WorkspaceView>("GET", `/api/workspaces/${s.workspace.id}`);
    expect(free.json.browserLock).toBeNull();
    expect(free.json.browserLockHeldByMe).toBe(false);

    // Nobody holds it; handing back again is still a 200 and writes nothing.
    const again = await h.api<{ released: boolean }>(
      "POST",
      `/api/workspaces/${s.workspace.id}/handback`,
      {},
    );
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ released: true });
  });

  it("marks every live run of the workspace, and no run of another workspace", async () => {
    const gate = deferred();
    h.provider.onRun(async (req, gw) => {
      await gate.promise;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("done"),
        usage: [],
      });
    });

    const mine = await seedWorkspace("busy");
    const other = await seedWorkspace("elsewhere");
    const threadRun = await startThreadRun(mine);
    const webhookRun = await startWebhookRun(mine);
    const outsider = await startThreadRun(other);

    const take = await h.api("POST", `/api/workspaces/${mine.workspace.id}/takeover`, {
      authorId: "ops",
    });
    expect(take.status).toBe(200);
    for (const id of [threadRun.id, webhookRun.id]) {
      const taken = (await eventsOf(id)).filter((e) => e.kind === "takeover");
      expect(taken.map((e) => e.payload)).toEqual([{ phase: "taken", by: "human:ops" }]);
    }
    expect((await eventsOf(outsider.id)).filter((e) => e.kind === "takeover")).toEqual([]);

    await h.api("POST", `/api/workspaces/${mine.workspace.id}/handback`, {});
    for (const id of [threadRun.id, webhookRun.id]) {
      const phases = (await eventsOf(id))
        .filter((e) => e.kind === "takeover")
        .map((e) => e.payload.phase);
      expect(phases).toEqual(["taken", "handed_back"]);
    }
    expect((await eventsOf(outsider.id)).filter((e) => e.kind === "takeover")).toEqual([]);

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(threadRun.id).status === "succeeded",
      3000,
      "runs end",
    );
  });

  it("publishes a workspace_lock frame on takeover and on handback", async () => {
    const s = await seedWorkspace("sse");
    const sse = await openSse(h.baseUrl);

    await h.api("POST", `/api/workspaces/${s.workspace.id}/takeover`, {});
    await h.api("POST", `/api/workspaces/${s.workspace.id}/handback`, {});

    const locks = (): Extract<GatewayEvent, { type: "workspace_lock" }>[] =>
      sse.events.filter(
        (e): e is Extract<GatewayEvent, { type: "workspace_lock" }> => e.type === "workspace_lock",
      );
    await waitFor(() => locks().length >= 2, 3000, "two workspace_lock frames");
    const [taken, released] = locks();
    expect(taken?.workspaceId).toBe(s.workspace.id);
    expect(taken?.browserLock?.holderKind).toBe("human");
    expect(released?.workspaceId).toBe(s.workspace.id);
    expect(released?.browserLock).toBeNull();
    sse.close();
  });

  it("reports that the workspace's container has a screen, never its address, and the registry asks for the port", async () => {
    const gate = deferred();
    h.provider.onRun(async (req, gw) => {
      await gate.promise;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("done"),
        usage: [],
      });
    });
    const s = await seedWorkspace("novnc");

    // No container yet: `peek` must not create one, so there is no screen.
    const before = await h.api<WorkspaceView>("GET", `/api/workspaces/${s.workspace.id}`);
    expect(before.json.takeoverScreen).toBe(false);
    expect(h.provider.created).toHaveLength(0);

    h.provider.novncAddress = "127.0.0.1:34567";
    h.provider.novncPassword = "memory-only-secret";
    const run = await startThreadRun(s);
    expect(h.provider.created[0]?.ports).toEqual([NOVNC_CONTAINER_PORT]);

    const view = await h.api<WorkspaceView>("GET", `/api/workspaces/${s.workspace.id}`);
    expect(view.json.takeoverScreen).toBe(true);
    const take = await h.api<Record<string, unknown>>(
      "POST",
      `/api/workspaces/${s.workspace.id}/takeover`,
      {},
    );
    // ADR-0022 amendment 1 (C7): the lease only, no address and no password.
    expect(Object.keys(take.json)).toEqual(["lock"]);
    for (const body of [JSON.stringify(view.json), JSON.stringify(take.json)]) {
      expect(body).not.toContain("34567");
      expect(body).not.toContain("memory-only-secret");
    }

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run ends",
    );
  });

  it("reopens an already-held screen with a fresh proxy ticket, never a password, without changing the lock", async () => {
    const gate = deferred();
    h.provider.onRun(async (req, gw) => {
      await gate.promise;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("done"),
        usage: [],
      });
    });
    h.provider.novncAddress = "127.0.0.1:34567";
    h.provider.novncPassword = "fresh-memory-only-secret";
    const s = await seedWorkspace("reopen-held");
    const run = await startThreadRun(s);
    const taken = await h.api<{ lock: BrowserLock }>(
      "POST",
      `/api/workspaces/${s.workspace.id}/takeover`,
      {},
    );

    const opened = await fetch(
      `${h.baseUrl}/api/workspaces/${s.workspace.id}/takeover/open-screen`,
      { method: "POST", headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` } },
    );
    expect(opened.status).toBe(200);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    const access = (await opened.json()) as Record<string, unknown>;
    expect(access).toMatchObject({ path: "/api/desktop-stream", mode: "control" });
    expect(Object.keys(access).sort()).toEqual(["accessId", "mode", "path", "protocol"]);
    expect(JSON.stringify(access)).not.toContain("fresh-memory-only-secret");
    expect(JSON.stringify(access)).not.toContain("34567");
    expect(h.app.deskmates.ctx.locks.list(s.workspace.id)).toContainEqual(taken.json.lock);
    expect(
      (await eventsOf(run.id))
        .filter((event) => event.kind === "takeover")
        .map((event) => event.payload),
    ).toEqual([{ phase: "taken", by: "human:web" }]);

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run ends",
    );
  });

  it("refuses to disclose screen credentials unless a human currently holds the browser", async () => {
    const s = await seedWorkspace("reopen-free");
    const opened = await h.api("POST", `/api/workspaces/${s.workspace.id}/takeover/open-screen`);
    expect(opened.status).toBe(409);
    expect(opened.json).toMatchObject({ code: "invalid_transition" });
    expect(h.provider.created).toHaveLength(0);
  });

  it("reports no screen when the workspace's handle publishes no noVNC address", async () => {
    const gate = deferred();
    h.provider.onRun(async (req, gw) => {
      await gate.promise;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("done"),
        usage: [],
      });
    });
    const s = await seedWorkspace("noport");
    const run = await startThreadRun(s);

    const view = await h.api<WorkspaceView>("GET", `/api/workspaces/${s.workspace.id}`);
    expect(view.json.takeoverScreen).toBe(false);

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run ends",
    );
  });

  it("makes a live run's browser tools wait until the human hands back", async () => {
    const gate = deferred();
    const client = deferred<{ gw: FakeSidecarClient; req: StartRunRequest }>();
    h.provider.onRun(async (req, gw) => {
      client.resolve({ gw, req });
      await gate.promise;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("done"),
        usage: [],
      });
    });
    const s = await seedWorkspace("wait");
    const run = await startThreadRun(s);
    const { gw, req } = await client.promise;

    await h.api("POST", `/api/workspaces/${s.workspace.id}/takeover`, { authorId: "ops" });
    const denied = await gw.post("browser-lock", {
      type: "browser_lock",
      runId: req.runId,
      op: "acquire",
      tabId: "tab-1",
    });
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({
      granted: false,
      waitMessage: HUMAN_HOLDS_BROWSER_MESSAGE,
    });

    await h.api("POST", `/api/workspaces/${s.workspace.id}/handback`, { authorId: "ops" });
    const granted = await gw.post("browser-lock", {
      type: "browser_lock",
      runId: req.runId,
      op: "acquire",
      tabId: "tab-1",
    });
    expect(await granted.json()).toMatchObject({ granted: true });

    const phases = (await eventsOf(run.id))
      .filter((e) => e.kind === "takeover")
      .map((e) => e.payload);
    expect(phases).toEqual([
      { phase: "taken", by: "human:ops" },
      { phase: "handed_back", by: "human:ops" },
    ]);

    gate.resolve();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run ends",
    );
  });
});

it("fences delayed screenshots across takeover and handback before ledger/SSE delivery", async () => {
  const gate = deferred();
  const ready = deferred<{ gw: FakeSidecarClient; req: StartRunRequest }>();
  h.provider.onRun(async (req, gw) => {
    ready.resolve({ gw, req });
    await gate.promise;
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: summary("done"),
      usage: [],
    });
  });
  const s = await seedWorkspace("capture-fence");
  const run = await startThreadRun(s);
  const { gw, req } = await ready.promise;
  const streamed: GatewayEvent[] = [];
  const unsubscribe = h.app.deskmates.ctx.bus.subscribe((event) => streamed.push(event));
  let seq = 0;
  const upload = async (browserEpoch: number) => {
    const res = await gw.post("events", {
      type: "event",
      runId: run.id,
      attempt: req.attempt,
      seq: ++seq,
      kind: "screenshot",
      payload: { browserEpoch, base64: "dGVzdA==" },
    });
    expect(res.status).toBe(200);
    return res.json();
  };
  try {
    expect(await upload(0)).toEqual({ stored: 1 });
    await h.api("POST", `/api/workspaces/${s.workspace.id}/takeover`, {});
    expect(await upload(1)).toEqual({ stored: 0 });
    await h.api("POST", `/api/workspaces/${s.workspace.id}/handback`, {});
    expect(await upload(0)).toEqual({ stored: 0 });
    expect(await upload(1)).toEqual({ stored: 1 });
    const screenshots = (await eventsOf(run.id)).filter((e) => e.kind === "screenshot");
    expect(screenshots.map((e) => e.payload.browserEpoch)).toEqual([0, 1]);
    // Each stored event has exactly one bus delivery; rejected images never reach the stream.
    expect(JSON.stringify(streamed).match(/"base64"/g)).toHaveLength(2);
  } finally {
    unsubscribe();
    gate.resolve();
  }
});

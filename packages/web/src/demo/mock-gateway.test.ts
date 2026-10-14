// The demo Gateway answers the routes the UI calls with the shapes the client unwraps, and a
// human message in a chat wakes the right bot. It is a demo, so this checks the contract the UI
// depends on, not Gateway semantics.

import type {
  Task,
  ThreadSummary,
  Workspace,
  WorkspaceFileCollectionPage,
} from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import type { GatewayEvent, RunView } from "../api/types.js";
import { MockGateway } from "./mock-gateway.js";

describe("MockGateway", () => {
  it("serves a paged Files collection with every type and an unknown source", async () => {
    const gw = new MockGateway(() => {});
    const { workspaces } = (await gw.handle("GET", "/api/workspaces", undefined)).json as {
      workspaces: Workspace[];
    };
    const path = `/api/workspaces/${workspaces[0]?.id}/assets`;
    const all = (await gw.handle("GET", path, undefined)).json as WorkspaceFileCollectionPage;
    expect(all.scope).toBe("published-results-and-inputs");
    expect(new Set(all.items.map((item) => item.kind))).toEqual(
      new Set(["documents", "images", "web", "other"]),
    );
    expect(all.items.some((item) => item.source === "unknown")).toBe(true);
    expect(new Set(all.items.map((item) => item.path)).size).toBe(all.items.length);
    const images = (await gw.handle("GET", `${path}?type=images`, undefined))
      .json as WorkspaceFileCollectionPage;
    expect(images.items.every((item) => item.kind === "images")).toBe(true);
    expect((await gw.handle("GET", `${path}?limit=500`, undefined)).status).toBe(400);
  });

  it("supports task tracking and human acceptance without starting runs", async () => {
    const events: GatewayEvent[] = [];
    const gw = new MockGateway((event) => events.push(event));
    // Historical seed events belong to the demo fixture, not to task mutations below.
    events.length = 0;
    const { workspaces } = (await gw.handle("GET", "/api/workspaces", undefined)).json as {
      workspaces: Workspace[];
    };
    const path = `/api/workspaces/${workspaces[0]?.id}/tasks`;
    const seeded = (await gw.handle("GET", path, undefined)).json as { tasks: Task[] };
    expect(seeded.tasks.map((task) => task.status)).toEqual([
      "in_progress",
      "blocked",
      "delivered",
    ]);
    expect(seeded.tasks.every((task) => task.workspaceId === workspaces[0]?.id)).toBe(true);
    const { task } = (await gw.handle("POST", path, { title: "Review the brief" })).json as {
      task: Task;
    };
    expect(task.status).toBe("planned");
    const detail = `${path}/${task.id}`;
    expect((await gw.handle("GET", detail, undefined)).json).toMatchObject({ task });
    expect((await gw.handle("POST", `${detail}/accept`, { version: 1 })).status).toBe(409);
    const { task: delivered } = (
      await gw.handle("PATCH", detail, {
        version: 1,
        status: "delivered",
        artifacts: [{ label: "Brief", path: "/work/brief.md" }],
      })
    ).json as { task: Task };
    expect(delivered.status).toBe("delivered");
    const { task: accepted } = (await gw.handle("POST", `${detail}/accept`, { version: 2 }))
      .json as { task: Task };
    expect(accepted).toMatchObject({ status: "accepted", version: 3, acceptedBy: "human:web" });
    expect((await gw.handle("PATCH", detail, { version: 2, status: "planned" })).status).toBe(409);
    const { task: reopened } = (await gw.handle("PATCH", detail, { version: 3, status: "planned" }))
      .json as { task: Task };
    expect(reopened).toMatchObject({
      status: "planned",
      deliveredAt: null,
      acceptedAt: null,
      acceptedBy: null,
    });
    expect(
      (await gw.handle("GET", `/api/workspaces/${workspaces[1]?.id}/tasks/${task.id}`, undefined))
        .status,
    ).toBe(404);
    expect(events).toEqual([]);
  });

  it("seeds three workspaces, eight bots and chats with members and previews", async () => {
    const gw = new MockGateway(() => {});
    const workspaces = (await gw.handle("GET", "/api/workspaces", undefined)).json as {
      workspaces: { id: string; name: string }[];
    };
    expect(workspaces.workspaces.map((w) => w.name)).toEqual([
      "galaxy-ops",
      "web-research",
      "research-desk",
    ]);
    const bots = (await gw.handle("GET", "/api/bots", undefined)).json as {
      bots: { name: string; workspaceId: string }[];
    };
    expect(bots.bots.map((b) => b.name)).toEqual([
      "chief",
      "researcher",
      "qa",
      "scout",
      "lead",
      "filings",
      "pricing",
      "regional_market_sentiment_watcher",
    ]);
    expect(bots.bots.filter((b) => b.workspaceId === workspaces.workspaces[1]?.id)).toHaveLength(1);
    const threads = (await gw.handle("GET", "/api/threads", undefined)).json as {
      threads: ThreadSummary[];
    };
    const group = threads.threads.find((t) => t.title === "Weekly ops brief");
    expect(group?.memberIds).toHaveLength(3);
    expect(group?.lastMessage?.authorKind).toBe("system");
    const pending = (await gw.handle("GET", "/api/approvals?status=pending", undefined)).json as {
      approvals: unknown[];
    };
    // One tool approval in the group, one egress ask in the researcher's chat (ADR-0020).
    expect(pending.approvals).toHaveLength(2);
    expect((pending.approvals as { kind?: string }[]).map((a) => a.kind).sort()).toEqual([
      "egress",
      "tool",
    ]);
  });

  it("models canonical inboxes: four bots and one group, reuse, and promotion to a group", async () => {
    const gw = new MockGateway(() => {});
    const call = async <T>(method: string, path: string, body?: unknown) =>
      (await gw.handle(method, path, body)).json as T;
    const { workspaces } = await call<{ workspaces: { id: string; name: string }[] }>(
      "GET",
      "/api/workspaces",
    );
    const desk = workspaces.find((w) => w.name === "research-desk");
    const list = async () =>
      (await call<{ threads: ThreadSummary[] }>("GET", `/api/threads?workspaceId=${desk?.id}`))
        .threads;
    const before = await list();
    expect(before).toHaveLength(1);
    expect(before[0]?.memberIds).toHaveLength(4);
    expect(before[0]?.privateChatBotId).toBeUndefined();

    const { bots } = await call<{ bots: { id: string; name: string }[] }>("GET", "/api/bots");
    const lead = bots.find((b) => b.name === "lead");
    const pricing = bots.find((b) => b.name === "pricing");
    const first = await call<{ thread: { id: string } }>(
      "POST",
      `/api/bots/${lead?.id}/private-chat`,
    );
    const again = await call<{ thread: { id: string } }>(
      "POST",
      `/api/bots/${lead?.id}/private-chat`,
    );
    expect(again.thread.id).toBe(first.thread.id);
    expect((await list()).find((t) => t.id === first.thread.id)?.privateChatBotId).toBe(lead?.id);

    await call("POST", `/api/threads/${first.thread.id}/members`, { botIds: [pricing?.id] });
    expect((await list()).find((t) => t.id === first.thread.id)?.privateChatBotId).toBeUndefined();
    const fresh = await call<{ thread: { id: string } }>(
      "POST",
      `/api/bots/${lead?.id}/private-chat`,
    );
    expect(fresh.thread.id).not.toBe(first.thread.id);
    expect((await list()).map((t) => t.id)).toContain(first.thread.id);
  });

  it("wakes the addressed bot on a human message and streams its run", async () => {
    const events: GatewayEvent[] = [];
    const gw = new MockGateway((event) => events.push(event));
    const threads = (await gw.handle("GET", "/api/threads", undefined)).json as {
      threads: ThreadSummary[];
    };
    const direct = threads.threads.find((t) => t.memberIds.length === 1 && t.kind === "chat");
    if (!direct) throw new Error("no private chat seeded");
    const posted = (
      await gw.handle("POST", `/api/threads/${direct.id}/messages`, { body: "hello there" })
    ).json as { runs: RunView[] };
    expect(posted.runs).toHaveLength(1);
    expect(posted.runs[0]?.botId).toBe(direct.memberIds[0]);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const statuses = events
      .filter((e): e is Extract<GatewayEvent, { type: "run_status" }> => e.type === "run_status")
      .filter((e) => e.run.id === posted.runs[0]?.id)
      .map((e) => e.run.status);
    expect(statuses[0]).toBe("queued");
    expect(statuses.at(-1)).toBe("succeeded");
    expect(events.some((e) => e.type === "thread_message" && e.message.authorKind === "bot")).toBe(
      true,
    );
  });

  it("cancels only the named run, keeps it cancelled and refuses a finished one (issue #76)", async () => {
    const events: GatewayEvent[] = [];
    const gw = new MockGateway((event) => events.push(event));
    const threads = (await gw.handle("GET", "/api/threads", undefined)).json as {
      threads: ThreadSummary[];
    };
    const direct = threads.threads.find((t) => t.memberIds.length === 1 && t.kind === "chat");
    if (!direct) throw new Error("no private chat seeded");
    const posted = (
      await gw.handle("POST", `/api/threads/${direct.id}/messages`, { body: "hello there" })
    ).json as { runs: RunView[] };
    const id = posted.runs[0]?.id;
    const cancelled = await gw.handle("POST", `/api/runs/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect((cancelled.json as { run: RunView }).run.status).toBe("cancelled");
    // The scripted run must not overwrite the cancel or post a reply afterwards.
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const statuses = events
      .filter((e): e is Extract<GatewayEvent, { type: "run_status" }> => e.type === "run_status")
      .filter((e) => e.run.id === id)
      .map((e) => e.run.status);
    expect(statuses.at(-1)).toBe("cancelled");
    expect(
      events.some(
        (e) =>
          e.type === "thread_message" && e.message.authorKind === "bot" && e.message.runId === id,
      ),
    ).toBe(false);
    const again = await gw.handle("POST", `/api/runs/${id}/cancel`, {});
    expect(again.status).toBe(409);
    expect((again.json as { code: string }).code).toBe("invalid_transition");
  });
});

it("serves isolated demo member fixtures and preserves the last owner", async () => {
  const gw = new MockGateway(() => {});
  expect((await gw.handle("GET", "/api/members", undefined)).status).toBe(200);
  expect((await gw.handle("GET", "/api/invitations", undefined)).json).toEqual({
    invitations: [],
    offset: 0,
    limit: 25,
    total: 0,
  });
  expect((await gw.handle("PATCH", "/api/members/usr_demo", { role: "member" })).status).toBe(400);
  expect((await gw.handle("PATCH", "/api/members/usr_demo", { status: "removed" })).status).toBe(
    400,
  );
  expect((await gw.handle("PATCH", "/api/members/usr_alex", { role: "owner" })).status).toBe(204);
  expect((await gw.handle("PATCH", "/api/members/usr_demo", { role: "member" })).status).toBe(204);
  const fresh = new MockGateway(() => {});
  expect((await fresh.handle("PATCH", "/api/members/usr_demo", { status: "removed" })).status).toBe(
    400,
  );
});

it("offers empty, populated and failing cost-alert fixtures for visual review", async () => {
  const empty = new MockGateway(() => {});
  expect((await empty.handle("GET", "/api/cost-alerts?status=open", undefined)).json).toEqual({
    alerts: [],
    total: 0,
  });

  const populated = new MockGateway(() => {}, "populated");
  const list = async () =>
    (
      (await populated.handle("GET", "/api/cost-alerts?status=open&limit=100", undefined)).json as {
        alerts: { id: string; totals: { knownCostUsd: number | null } }[];
      }
    ).alerts;
  const alerts = await list();
  expect(alerts.length).toBeGreaterThan(10);
  expect(alerts.some((alert) => alert.totals.knownCostUsd === null)).toBe(true);
  const rules = (await populated.handle("GET", "/api/cost-alert-rules", undefined)).json as {
    rules: unknown[];
  };
  expect(rules.rules).toHaveLength(3);
  const ack = await populated.handle("POST", `/api/cost-alerts/${alerts[0]?.id}/acknowledge`, {});
  expect(ack.status).toBe(200);
  expect(await list()).toHaveLength(alerts.length - 1);

  const failing = new MockGateway(() => {}, "failure");
  expect((await failing.handle("GET", "/api/cost-alerts?status=open", undefined)).status).toBe(503);
  expect((await failing.handle("GET", "/api/cost-alert-rules", undefined)).status).toBe(503);
});

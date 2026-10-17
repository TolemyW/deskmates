// T1: publishing, listing, opening and revoking workspace apps (ADR-0035 decisions 1, 3, 7, 8
// and 9). The relay is the T1 fake; the app listener has its own test.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AppPublishResponse, AppShare, AppShareOpenResponse } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { sidecarToolsFor } from "../scheduler/sidecar-tools.js";
import {
  FAKE_RELAY_KEY,
  type FakeAppRelay,
  startFakeAppRelay,
} from "../test-support/fake-app-relay.js";
import { type Harness, TEST_OPERATOR_TOKEN, startHarness } from "../test-support/harness.js";
import { type RoleFixture, seedRoles } from "../test-support/roles.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const APP_CONFIG = (operatorOrigin: string) => ({
  appShares: { baseUrl: "http://apps.localhost", operatorOrigin, port: 0, bind: "127.0.0.1" },
});

async function setup(enabled = true): Promise<{ h: Harness; r: RoleFixture }> {
  const h = await startHarness();
  cleanup.push(() => h.close());
  if (enabled) Object.assign(h.app.deskmates.ctx.config, APP_CONFIG(h.baseUrl));
  const r = await seedRoles(h);
  return { h, r };
}

function runOf(h: Harness, botId: string) {
  const { ctx } = h.app.deskmates;
  const bot = ctx.bots.mustGet(botId as never);
  const thread = ctx.threads.create({ workspaceId: bot.workspaceId, botIds: [bot.id] });
  const run = ctx.runs.create({
    botId: bot.id,
    threadId: thread.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "test",
    config: ctx.runConfig(),
  });
  return { run, token: ctx.tokens.issue(run.id).token };
}

async function publish(h: Harness, botId: string, body: unknown) {
  const { run, token } = runOf(h, botId);
  const res = await fetch(`${h.baseUrl}/internal/runs/${run.id}/app-shares`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as AppPublishResponse & { code?: string },
    run,
  };
}

const audits = (h: Harness) =>
  h.app.deskmates.ctx.db
    .prepare(
      "SELECT action, actor, target_id, run_id FROM audit_events WHERE action LIKE 'app_share.%' ORDER BY seq",
    )
    .all() as { action: string; actor: string; target_id: string; run_id: string | null }[];

async function withApp(h: Harness, workspaceId: string, port: number): Promise<FakeAppRelay> {
  const app = http.createServer((_req, res) => res.end("hello"));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => app.close(() => resolve())));
  const relay = await startFakeAppRelay(new Map([[port, (app.address() as AddressInfo).port]]));
  cleanup.push(() => relay.close());
  h.provider.existing.set(workspaceId, {
    workspaceId: workspaceId as never,
    providerRef: "fake",
    sidecarAddress: "fake://sidecar",
    appRelayAddress: relay.address,
    appRelayKey: FAKE_RELAY_KEY,
  });
  return relay;
}

describe("app_publish is offered only where app sharing is configured (decision 1)", () => {
  it("stamps the knob and the tool only with configuration", async () => {
    const { h } = await setup(false);
    expect(h.app.deskmates.ctx.runConfig().appShareVersion).toBeUndefined();
    expect(sidecarToolsFor(true, h.app.deskmates.ctx.runConfig())).not.toContain("app_publish");
    expect(sidecarToolsFor(true, { appShareVersion: 1 })).toContain("app_publish");
  });

  it("refuses to publish and lists as disabled without configuration", async () => {
    const { h, r } = await setup(false);
    const res = await publish(h, r.bot.id, { port: 3000, label: "Todo" });
    expect(res.status).toBe(409);
    const list = await r.member.json<{ enabled: boolean }>(
      "GET",
      `/api/workspaces/${r.workspace.id}/app-shares`,
    );
    expect(list.json.enabled).toBe(false);
  });
});

describe("publishing (decision 1)", () => {
  it("records, audits and returns the URL on the publication's own origin", async () => {
    const { h, r } = await setup();
    const res = await publish(h, r.bot.id, { port: 3000, label: "Todo app" });
    expect(res.status).toBe(200);
    const { share, existing } = res.json;
    expect(existing).toBe(false);
    expect(share.url).toBe(`http://${share.id.slice(4)}.apps.localhost/`);
    expect(share).toMatchObject({
      port: 3000,
      label: "Todo app",
      botId: r.bot.id,
      runId: res.run.id,
    });
    // No relay on this workspace yet: honest, not an error.
    expect(share.state).toBe("unavailable");
    expect(audits(h)).toEqual([
      {
        action: "app_share.publish",
        actor: `bot:${r.bot.id}`,
        target_id: share.id,
        run_id: res.run.id,
      },
    ]);
  });

  it("is idempotent per port and relabels the active publication", async () => {
    const { h, r } = await setup();
    const first = await publish(h, r.bot.id, { port: 3000, label: "One" });
    const again = await publish(h, r.bot.id, { port: 3000, label: "Two" });
    expect(again.json.existing).toBe(true);
    expect(again.json.share.id).toBe(first.json.share.id);
    expect(again.json.share.label).toBe("Two");
  });

  it("refuses privileged ports, screen relays and bad labels", async () => {
    const { h, r } = await setup();
    for (const body of [
      { port: 80, label: "x" },
      { port: 6080, label: "x" },
      { port: 6086, label: "x" },
      { port: 70000, label: "x" },
      { port: "3000", label: "x" },
      { port: 3000, label: "" },
      { port: 3000, label: "a\nb" },
    ]) {
      const res = await publish(h, r.bot.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(audits(h)).toEqual([]);
  });

  it("caps active publications per workspace", async () => {
    const { h, r } = await setup();
    for (let i = 0; i < 10; i += 1)
      expect((await publish(h, r.bot.id, { port: 3000 + i, label: `a${i}` })).status).toBe(200);
    expect((await publish(h, r.bot.id, { port: 4000, label: "eleventh" })).status).toBe(429);
  });
});

describe("listing and availability (decisions 3 and 7)", () => {
  it("probes the published port through the relay; Guests cannot list", async () => {
    const { h, r } = await setup();
    const relay = await withApp(h, r.workspace.id, 3000);
    await publish(h, r.bot.id, { port: 3000, label: "Running" });
    await publish(h, r.bot.id, { port: 3001, label: "Stopped" });
    const list = await r.member.json<{ enabled: boolean; shares: AppShare[] }>(
      "GET",
      `/api/workspaces/${r.workspace.id}/app-shares`,
    );
    expect(list.status).toBe(200);
    const byLabel = Object.fromEntries(list.json.shares.map((s) => [s.label, s]));
    expect(byLabel.Running?.state).toBe("available");
    expect(byLabel.Stopped).toMatchObject({ state: "unavailable", reason: "not_running" });
    expect(relay.requested).toEqual(expect.arrayContaining([3000, 3001]));
    const guest = await r.guest.fetch("GET", `/api/workspaces/${r.workspace.id}/app-shares`);
    expect(guest.status).toBe(403);
  });
});

describe("opening (decisions 3 and 9)", () => {
  it("gives a signed-in Member a one-use ticket for the app origin, never a URL credential", async () => {
    const { h, r } = await setup();
    const { share } = (await publish(h, r.bot.id, { port: 3000, label: "Todo" })).json;
    const path = `/api/workspaces/${r.workspace.id}/app-shares/${share.id}/open`;
    const opened = await r.member.json<AppShareOpenResponse>("POST", path, {
      body: { path: "/todos/1" },
    });
    expect(opened.status).toBe(200);
    expect(opened.json.enterUrl).toBe(
      `http://${share.id.slice(4)}.apps.localhost/__deskmates/enter`,
    );
    expect(opened.json.enterUrl).not.toContain(opened.json.ticket);
    expect(opened.json.expiresIn).toBe(30);
    expect((await r.guest.fetch("POST", path, { body: {} })).status).toBe(403);
    const bad = await r.member.fetch("POST", path, { body: { path: "//evil.example/" } });
    expect(bad.status).toBe(400);
  });

  it("refuses machine credentials: an app needs a person's browser session", async () => {
    const { h, r } = await setup();
    const { share } = (await publish(h, r.bot.id, { port: 3000, label: "Todo" })).json;
    const res = await fetch(
      `${h.baseUrl}/api/workspaces/${r.workspace.id}/app-shares/${share.id}/open`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_OPERATOR_TOKEN}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(res.status).toBe(403);
  });

  it("answers another workspace's publication under this workspace with the uniform 404", async () => {
    const { h, r } = await setup();
    const { ctx } = h.app.deskmates;
    const other = ctx.workspaces.create({ name: "Other", sandboxProvider: "docker" });
    const otherBot = ctx.bots.create({ workspaceId: other.id, name: "b2", role: "r" });
    const { share } = (await publish(h, otherBot.id, { port: 3000, label: "Theirs" })).json;
    for (const [method, suffix] of [
      ["POST", "/open"],
      ["DELETE", ""],
    ] as const) {
      const res = await r.owner.fetch(
        method,
        `/api/workspaces/${r.workspace.id}/app-shares/${share.id}${suffix}`,
        { body: {} },
      );
      expect(res.status, method).toBe(404);
    }
    // And the member of this workspace cannot reach the other workspace at all.
    const direct = await r.member.fetch(
      "POST",
      `/api/workspaces/${other.id}/app-shares/${share.id}/open`,
      {
        body: {},
      },
    );
    expect(direct.status).toBe(404);
  });
});

describe("a person publishes (decision 1, owner-decided 2026-10-14)", () => {
  it("lets a Member publish a port with the same rules, audited as the person", async () => {
    const { h, r } = await setup();
    const path = `/api/workspaces/${r.workspace.id}/app-shares`;
    const res = await r.member.json<AppPublishResponse>("POST", path, {
      body: { port: 5173, label: "Preview" },
    });
    expect(res.status).toBe(200);
    expect(res.json.existing).toBe(false);
    expect(res.json.share).toMatchObject({
      port: 5173,
      label: "Preview",
      botId: null,
      runId: null,
      publishedBy: `user:${r.ids.mel}`,
    });
    expect(res.json.share.url).toBe(`http://${res.json.share.id.slice(4)}.apps.localhost/`);
    expect(audits(h)).toEqual([
      {
        action: "app_share.publish",
        actor: `user:${r.ids.mel}`,
        target_id: res.json.share.id,
        run_id: null,
      },
    ]);
    // The same port again relabels it; reserved ports and bad labels are refused.
    const again = await r.otherMember.json<AppPublishResponse>("POST", path, {
      body: { port: 5173, label: "Preview 2" },
    });
    expect(again.json).toMatchObject({ existing: true, share: { label: "Preview 2" } });
    expect((await r.member.fetch("POST", path, { body: { port: 6080, label: "x" } })).status).toBe(
      400,
    );
    expect((await r.guest.fetch("POST", path, { body: { port: 5174, label: "x" } })).status).toBe(
      403,
    );
  });

  it("refuses to publish without configuration", async () => {
    const { r } = await setup(false);
    const res = await r.member.fetch("POST", `/api/workspaces/${r.workspace.id}/app-shares`, {
      body: { port: 3000, label: "Todo" },
    });
    expect(res.status).toBe(409);
  });
});

describe("revoking (decision 8)", () => {
  it("lets any Member stop sharing, audited as the person, and ends opening", async () => {
    const { h, r } = await setup();
    const { share } = (await publish(h, r.bot.id, { port: 3000, label: "Todo" })).json;
    const path = `/api/workspaces/${r.workspace.id}/app-shares/${share.id}`;
    expect((await r.guest.fetch("DELETE", path)).status).toBe(403);
    const revoked = await r.member.json<{ share: AppShare }>("DELETE", path);
    expect(revoked.status).toBe(200);
    expect(revoked.json.share.state).toBe("revoked");
    expect(audits(h).map((a) => [a.action, a.actor])).toEqual([
      ["app_share.publish", `bot:${r.bot.id}`],
      ["app_share.revoke", `user:${r.ids.mel}`],
    ]);
    expect((await r.member.fetch("POST", `${path}/open`, { body: {} })).status).toBe(404);
    // The port can be published again, as a new publication.
    const again = await publish(h, r.bot.id, { port: 3000, label: "Todo" });
    expect(again.json.share.id).not.toBe(share.id);
  });
});

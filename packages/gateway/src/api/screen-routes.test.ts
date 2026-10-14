import { once } from "node:events";
import type { BrowserLock, ScreenAccess } from "@deskmates/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type FakeVnc, rfbClientHandshake, startFakeVnc } from "../test-support/fake-vnc.js";
import { type Harness, startHarness } from "../test-support/harness.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function setup() {
  const h = await startHarness();
  cleanups.push(() => h.close());
  const { workspace, bot } = await h.seed();
  const vnc: FakeVnc = await startFakeVnc({ control: "control1", view: "viewonly" });
  cleanups.push(() => vnc.close());
  vi.spyOn(h.app.deskmates.ctx.sandboxes, "peek").mockResolvedValue({
    workspaceId: workspace.id,
    providerRef: "test",
    sidecarAddress: "test",
    novncAddress: vnc.address,
    botScreenAddresses: Array(6).fill(vnc.address),
    novncPassword: "control1",
    novncViewPassword: "viewonly",
  });
  h.app.deskmates.ctx.screens.ensure(bot.id, workspace.id);
  return { h, workspace, bot, vnc };
}
async function ticket(h: Harness, botId: string, mode: "view" | "control" = "view") {
  const r = await h.api<ScreenAccess>("POST", `/api/bots/${botId}/screen/access`, { mode });
  expect(r.status).toBe(200);
  return r.json;
}
function connect(h: Harness, access: ScreenAccess, origin = h.baseUrl) {
  return new WebSocket(`${h.baseUrl.replace("http:", "ws:")}${access.path}`, [access.protocol], {
    origin,
  });
}
it("never publishes credentials in status or tickets, and watching does not acquire a human hold", async () => {
  const { h, bot, workspace } = await setup();
  const state = await h.api("GET", `/api/bots/${bot.id}/screen`);
  expect(state.json).toMatchObject({ state: "ready", slot: 0, humanHeld: false });
  expect(JSON.stringify(state.json)).not.toContain("viewonly");
  const access = await ticket(h, bot.id);
  // The proxy authenticates upstream; the browser never gets a VNC password (C7).
  expect(access).not.toHaveProperty("password");
  expect(JSON.stringify(access)).not.toMatch(/viewonly|control1/);
  expect(h.app.deskmates.ctx.locks.humanHolds(workspace.id)).toBe(false);
  expect(
    (await h.api("POST", `/api/bots/${bot.id}/screen/access`, { mode: "control" })).status,
  ).not.toBe(200);
  const denied = await fetch(`${h.baseUrl}/api/bots/${bot.id}/screen/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"mode":"view"}',
  });
  expect(denied.status).toBe(401);
});
it("authenticates upstream with the mode's password and offers the browser no authentication", async () => {
  const { h, bot, vnc } = await setup();
  const client = connect(h, await ticket(h, bot.id, "view"));
  const reader = await rfbClientHandshake(client);
  client.send(Buffer.from("ping"));
  expect((await reader.read(4)).toString()).toBe("ping");
  // The view ticket unlocked x11vnc's server-enforced view-only password, not control.
  expect(vnc.logins).toEqual(["view"]);
  client.terminate();
});
it("bridges a one-use origin-bound control ticket and closes it on handback", async () => {
  const { h, bot, workspace, vnc } = await setup();
  await h.api("POST", `/api/workspaces/${workspace.id}/takeover`, {});
  const access = await ticket(h, bot.id, "control");
  const client = connect(h, access);
  const reader = await rfbClientHandshake(client);
  expect(vnc.logins).toEqual(["control"]);
  client.send(Buffer.from("input"));
  expect((await reader.read(5)).toString()).toBe("input");
  const closed = once(client, "close");
  await h.api("POST", `/api/workspaces/${workspace.id}/handback`, {});
  await closed;
  const replay = connect(h, access);
  expect(String((await once(replay, "error"))[0])).toContain("401");
});
it("rejects foreign origins, expiry and explicit close before redemption", async () => {
  const { h, bot } = await setup();
  for (const variant of ["origin", "expiry", "close"]) {
    const access = await ticket(h, bot.id);
    const clock =
      variant === "expiry" ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000) : undefined;
    if (variant === "close") await h.api("POST", `/api/screen-access/${access.accessId}/close`, {});
    const client = connect(h, access, variant === "origin" ? "http://other.test" : h.baseUrl);
    expect(String((await once(client, "error"))[0])).toContain("401");
    clock?.mockRestore();
  }
});

it("revokes pending control tickets across handback and a new takeover epoch", async () => {
  const { h, bot, workspace } = await setup();
  await h.api("POST", `/api/workspaces/${workspace.id}/takeover`, {});
  const access = await ticket(h, bot.id, "control");
  await h.api("POST", `/api/workspaces/${workspace.id}/handback`, {});
  await h.api("POST", `/api/workspaces/${workspace.id}/takeover`, {});
  const client = connect(h, access);
  expect(String((await once(client, "error"))[0])).toContain("401");
});

it("drops the proxied connection when the upstream refuses the password", async () => {
  const { h, bot, vnc } = await setup();
  vi.spyOn(h.app.deskmates.ctx.sandboxes, "peek").mockResolvedValue({
    workspaceId: "ws" as never,
    providerRef: "test",
    sidecarAddress: "test",
    botScreenAddresses: Array(6).fill(vnc.address),
    novncPassword: "control1",
    novncViewPassword: "wrongpwd",
  });
  const client = connect(h, await ticket(h, bot.id, "view"));
  const closed = once(client, "close");
  await closed;
  expect(vnc.logins).toEqual([]);
});

// ADR-0022 amendment 1, C7: the takeover is served through the screen proxy only.
it("takeover returns the lease and no noVNC address or password, and neither does the workspace view", async () => {
  const { h, workspace } = await setup();
  const view = await h.api<Record<string, unknown>>("GET", `/api/workspaces/${workspace.id}`);
  expect(view.json.takeoverScreen).toBe(true);
  expect(view.json).not.toHaveProperty("novncUrl");
  const take = await h.api<{ lock: BrowserLock } & Record<string, unknown>>(
    "POST",
    `/api/workspaces/${workspace.id}/takeover`,
    {},
  );
  expect(take.status).toBe(200);
  expect(Object.keys(take.json)).toEqual(["lock"]);
  const text = JSON.stringify([view.json, take.json]);
  expect(text).not.toContain("control1");
  expect(text).not.toContain("viewonly");
  expect(text).not.toMatch(/127\.0\.0\.1:\d+/);
});

it("the lease holder controls the shared screen through the proxy; the stream ends with the lease", async () => {
  const { h, workspace, vnc } = await setup();
  await h.api("POST", `/api/workspaces/${workspace.id}/takeover`, {});
  const opened = await h.api<ScreenAccess>(
    "POST",
    `/api/workspaces/${workspace.id}/takeover/open-screen`,
  );
  expect(opened.status).toBe(200);
  expect(opened.json).toMatchObject({ path: "/api/desktop-stream", mode: "control" });
  expect(JSON.stringify(opened.json)).not.toMatch(/control1|127\.0\.0\.1/);
  const client = connect(h, opened.json);
  const reader = await rfbClientHandshake(client);
  expect(vnc.logins).toEqual(["control"]);
  client.send(Buffer.from("key"));
  expect((await reader.read(3)).toString()).toBe("key");
  // Lease expiry (the TTL passing) closes the stream within the proxy's one-second check.
  const closed = once(client, "close");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
  await closed;
  vi.useRealTimers();
  expect(vnc.sockets.size).toBe(0);
});

it("the shared screen is the lease holder's only, and only while the lease is live", async () => {
  const { h, workspace } = await setup();
  // No lease: nothing to open.
  expect((await h.api("POST", `/api/workspaces/${workspace.id}/takeover/open-screen`)).status).toBe(
    409,
  );
  // Someone else's lease (here a run-less holder recorded for another session).
  h.app.deskmates.ctx.locks.humanTake(workspace.id, undefined, "session:someone-else");
  const refused = await h.api<{ details?: { reason?: string } }>(
    "POST",
    `/api/workspaces/${workspace.id}/takeover/open-screen`,
  );
  expect(refused.status).toBe(403);
  expect(refused.json.details?.reason).toBe("not_holder");
});

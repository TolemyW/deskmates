// T1: ADR-0006 amendment 5 through the Gateway with the testkit fake provider. Decision 12: the
// report classifies the provider's host against `workspaces` and is the root's alone. Decision
// 13: Remove and Re-attach act on a finding that is still present, are refused while a run is
// live, and each writes one audit row. Decision 14: the startup warning and the status field.

import type {
  HostResource,
  HostResourceActionResult,
  HostResourceReport,
  RuntimeStatus,
} from "@deskmates/contracts";
import { FakeSandboxProvider } from "@deskmates/testkit";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { reportHostResources } from "../host-resources/host-resources.js";
import { buildGateway } from "../index.js";
import { type Harness, TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start() {
  const provider = new FakeSandboxProvider();
  app = buildGateway(testConfig(), provider, { surface: "combined-test", startCron: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const gateway = app;
  const api = async <T>(method: string, path: string, body?: unknown) => {
    const res = await gateway.inject({
      method: method as "GET" | "POST",
      url: path,
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
    return { status: res.statusCode, json: res.json() as T };
  };
  const { ctx } = gateway.deskmates;
  const workspace = (name: string) => ctx.workspaces.create({ name, sandboxProvider: "docker" });
  return { provider, ctx, api, baseUrl, workspace, app: gateway };
}

const leftover = (workspaceId: string): HostResource[] => [
  {
    kind: "container",
    name: `deskmates-ws-${workspaceId}`,
    id: `${workspaceId}-c`,
    workspaceId,
    role: "workspace",
    sizeBytes: 10,
  },
  {
    kind: "container",
    name: `deskmates-egress-${workspaceId}`,
    id: `${workspaceId}-p`,
    workspaceId,
    role: "egress-proxy",
  },
  {
    kind: "network",
    name: `deskmates-net-${workspaceId}`,
    id: `${workspaceId}-n`,
    workspaceId,
    role: "workspace",
  },
  {
    kind: "volume",
    name: `deskmates-${workspaceId}-work`,
    id: `deskmates-${workspaceId}-work`,
    workspaceId,
    role: "volume",
    sizeBytes: 500,
  },
];

const legacyNetwork = (name: string, attachedContainers = 0): HostResource => ({
  kind: "network",
  name,
  id: name,
  role: "legacy",
  attachedContainers,
});

describe("GET /api/runtime/resources (decision 12)", () => {
  it("classifies the host against the database and leaves live workspaces unflagged", async () => {
    const s = await start();
    const live = s.workspace("Live");
    await s.ctx.sandboxes.ensure(live);
    const archived = s.workspace("Old");
    s.ctx.workspaces.archive(archived.id, "test");
    s.provider.host.resources.push(
      ...leftover("ws_t2gone"),
      ...leftover(archived.id),
      legacyNetwork("former-net-ws_x"),
    );
    s.provider.host.addressPools = [{ base: "10.200.0.0/16", size: 24 }];
    s.provider.host.subnets = [{ name: `deskmates-net-${live.id}`, cidr: "10.200.1.0/24" }];

    const res = await s.api<HostResourceReport>("GET", "/api/runtime/resources");
    expect(res.status).toBe(200);
    expect(res.json.checked).toBe(true);
    expect(res.json.findings.map((f) => [f.id, f.action, f.workspaceName])).toEqual([
      ["orphan:ws_t2gone", "remove", undefined],
      [`archived:${archived.id}`, "remove", "Old"],
      ["legacy_network:former-net-ws_x", "remove", undefined],
    ]);
    expect(res.json.findings[0]?.sizeBytes).toBe(510);
    // The live workspace's container, proxy, network and three volumes.
    expect(res.json.healthy).toBe(6);
    expect(res.json.pool).toMatchObject({
      status: "ok",
      source: "daemon",
      capacity: 256,
      inUse: 1,
    });
  });

  it("is the root's alone", async () => {
    const s = await start();
    const roles = await seedRoles({ app: s.app, baseUrl: s.baseUrl } as unknown as Harness);
    for (const [who, jar] of [
      ["owner", roles.owner],
      ["admin", roles.admin],
      ["member", roles.member],
    ] as const) {
      const res = await jar.json("GET", "/api/runtime/resources");
      expect(res.status, who).toBe(403);
      const post = await jar.json("POST", "/api/runtime/resources/remove", {
        body: { findingId: "orphan:ws_x" },
      });
      expect(post.status, who).toBe(403);
    }
    expect((await roles.root.json("GET", "/api/runtime/resources")).status).toBe(200);
  });

  it("reports an unchecked host when the provider cannot list it", async () => {
    const s = await start();
    Object.assign(s.provider, {
      listHostResources: async () => {
        throw new Error("daemon down");
      },
    });
    const res = await s.api<HostResourceReport>("GET", "/api/runtime/resources");
    expect(res.json).toMatchObject({ checked: false, findings: [], error: "Error: daemon down" });
  });
});

describe("Remove (decision 13)", () => {
  it("removes an orphan's resources in order and writes one audit row", async () => {
    const s = await start();
    const live = s.workspace("Live");
    await s.ctx.sandboxes.ensure(live);
    s.provider.host.resources.push(...leftover("ws_t2gone"));
    const res = await s.api<HostResourceActionResult>("POST", "/api/runtime/resources/remove", {
      findingId: "orphan:ws_t2gone",
    });
    expect(res.status).toBe(200);
    expect(res.json.removed?.map((r) => r.name)).toEqual([
      "deskmates-ws-ws_t2gone",
      "deskmates-egress-ws_t2gone",
      "deskmates-net-ws_t2gone",
      "deskmates-ws_t2gone-work",
    ]);
    expect(res.json.report.findings).toEqual([]);
    expect(s.provider.list().map((x) => x.spec.workspaceId)).toEqual([live.id]);
    const [audit, ...rest] = s.ctx.audit.list({ targetId: "orphan:ws_t2gone" });
    expect(rest).toEqual([]);
    expect(audit).toMatchObject({
      action: "host_resource.remove",
      workspaceId: null,
      targetKind: "host_resource",
      after: {
        status: "done",
        removed: expect.arrayContaining(["volume:deskmates-ws_t2gone-work"]),
      },
    });
  });

  it("keeps an archived workspace's volumes and records it under the workspace", async () => {
    const s = await start();
    const old = s.workspace("Old");
    s.ctx.workspaces.archive(old.id, "test");
    s.provider.host.resources.push(...leftover(old.id));
    const res = await s.api<HostResourceActionResult>("POST", "/api/runtime/resources/remove", {
      findingId: `archived:${old.id}`,
    });
    expect(res.json.removed?.map((r) => r.kind)).toEqual(["container", "container", "network"]);
    expect(res.json.report.findings.map((f) => [f.id, f.action])).toEqual([
      [`archived:${old.id}`, undefined],
    ]);
    expect(s.ctx.audit.list({ workspaceId: old.id })[0]?.action).toBe("host_resource.remove");
  });

  it("is refused while a run is live in the workspace, and for a finding that is gone", async () => {
    const s = await start();
    const ws = s.workspace("Busy");
    s.provider.host.resources.push(...leftover(ws.id));
    const bot = s.ctx.bots.create({ workspaceId: ws.id, name: "b", role: "r" });
    const run = s.ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "busy",
      triggerPayload: { body: "" },
    });
    s.ctx.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
    // A run whose process outlived the archive's hard stop (the stop and the run race).
    s.ctx.workspaces.archive(ws.id, "test");
    const refused = await s.api<{ code: string; details: { reason: string } }>(
      "POST",
      "/api/runtime/resources/remove",
      { findingId: `archived:${ws.id}` },
    );
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      code: "invalid_transition",
      details: { reason: "run_live" },
    });
    expect(s.provider.host.resources).toHaveLength(4);
    expect(s.ctx.audit.list({ targetId: `archived:${ws.id}` })).toEqual([]);

    const gone = await s.api<{ code: string }>("POST", "/api/runtime/resources/remove", {
      findingId: "orphan:ws_never",
    });
    expect(gone.status).toBe(404);
    const wrong = await s.api<{ code: string }>("POST", "/api/runtime/resources/reattach", {
      findingId: `archived:${ws.id}`,
    });
    expect(wrong.status).toBe(400);
  });

  it("is refused while a sidecar process runs in an orphan's container", async () => {
    const s = await start();
    const [container, ...rest] = leftover("ws_other_gateway");
    s.provider.host.resources.push(
      { ...(container as HostResource), sidecarProcesses: 1 },
      ...rest,
    );
    const res = await s.api<{ code: string }>("POST", "/api/runtime/resources/remove", {
      findingId: "orphan:ws_other_gateway",
    });
    expect(res.status).toBe(409);
    expect(s.provider.host.resources).toHaveLength(4);
  });

  it("removes a former-name network only once nothing is attached", async () => {
    const s = await start();
    s.provider.host.resources.push(legacyNetwork("former-net-ws_a", 1));
    const blocked = await s.api("POST", "/api/runtime/resources/remove", {
      findingId: "legacy_network:former-net-ws_a",
    });
    expect(blocked.status).toBe(409);
    const network = s.provider.host.resources[0];
    if (network) network.attachedContainers = 0;
    const res = await s.api<HostResourceActionResult>("POST", "/api/runtime/resources/remove", {
      findingId: "legacy_network:former-net-ws_a",
    });
    expect(res.status).toBe(200);
    expect(s.provider.host.resources).toEqual([]);
  });
});

describe("Re-attach (decision 13)", () => {
  it("repairs a mismatched workspace, refused while a run is live, audited either way", async () => {
    const s = await start();
    const ws = s.workspace("Ops");
    await s.ctx.sandboxes.ensure(ws);
    s.provider.host.topology.set(ws.id, "workspace is attached to a legacy or mismatched network");
    const findingId = `topology_mismatch:${ws.id}`;

    const bot = s.ctx.bots.create({ workspaceId: ws.id, name: "b", role: "r" });
    const run = s.ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "busy",
      triggerPayload: { body: "" },
    });
    s.ctx.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
    expect((await s.api("POST", "/api/runtime/resources/reattach", { findingId })).status).toBe(
      409,
    );
    s.ctx.db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(run.id);

    s.provider.host.reattachLeaves.set(ws.id, "workspace egress-proxy address is missing or stale");
    const partial = await s.api<HostResourceActionResult>(
      "POST",
      "/api/runtime/resources/reattach",
      { findingId },
    );
    expect(partial.json).toMatchObject({
      repaired: false,
      problem: "workspace egress-proxy address is missing or stale",
    });
    s.provider.host.reattachLeaves.delete(ws.id);
    const fixed = await s.api<HostResourceActionResult>("POST", "/api/runtime/resources/reattach", {
      findingId,
    });
    expect(fixed.json.repaired).toBe(true);
    expect(fixed.json.report.findings).toEqual([]);
    expect(
      s.ctx.audit
        .list({ workspaceId: ws.id })
        .filter((a) => a.action === "host_resource.reattach")
        .map((a) => (a.after as { status: string }).status),
    ).toEqual(["done", "not_repaired"]);
    // The sandbox is attached afresh on its next use.
    await expect(s.ctx.sandboxes.ensure(ws)).resolves.toMatchObject({ workspaceId: ws.id });
  });
});

describe("pool headroom (decision 14)", () => {
  it("warns at start when low, and GET /api/runtime carries the last check", async () => {
    const s = await start();
    expect((await s.api<RuntimeStatus>("GET", "/api/runtime")).json.addressPools).toBeUndefined();
    s.provider.host.addressPools = [{ base: "10.200.0.0/24", size: 26 }];
    s.provider.host.subnets = [
      { name: "a", cidr: "10.200.0.0/26" },
      { name: "b", cidr: "10.200.0.64/26" },
      { name: "c", cidr: "10.200.0.128/26" },
      { name: "d", cidr: "10.200.0.192/26" },
    ];
    s.provider.host.resources.push(...leftover("ws_gone"));
    const warnings: string[] = [];
    await reportHostResources(s.ctx, (m) => warnings.push(m));
    expect(warnings).toEqual([
      "Docker address pools exhausted: 0 of 4 networks free (configured: 10.200.0.0/24/26); every workspace needs one, and creating one fails when none is left. Set default-address-pools in the daemon config.",
      "Host resources: 1 finding(s) (1 orphan); the root can review them on the Network page under Host resources",
    ]);
    const runtime = await s.api<RuntimeStatus>("GET", "/api/runtime");
    expect(runtime.json.addressPools).toMatchObject({ status: "exhausted", free: 0, capacity: 4 });
  });

  it("is silent on a healthy host", async () => {
    const s = await start();
    const warnings: string[] = [];
    const report = await reportHostResources(s.ctx, (m) => warnings.push(m));
    expect(report.checked).toBe(true);
    expect(report.pool?.source).toBe("docker_default");
    expect(warnings).toEqual([]);
  });
});

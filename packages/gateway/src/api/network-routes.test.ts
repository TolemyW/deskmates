// T1: network profiles online (ADR-0027 amendment 1 decisions 6, 7, 8, 12 and 13). The fake
// provider acknowledges policy by hash like the Docker proxy, so "applied" versus "unchanged"
// and the workspaces that were never touched are observable.

import type {
  NetworkProfile,
  NetworkPublication,
  SandboxHandle,
  Workspace,
  WorkspaceNetworkView,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const LAN = {
  name: "VendorDB test environment",
  rules: [{ kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [23001] }],
};

function running(harness: Harness, workspace: Workspace): SandboxHandle {
  const handle = {
    workspaceId: workspace.id,
    providerRef: `fake-${workspace.id}`,
    sidecarAddress: "fake://sidecar",
  } as SandboxHandle;
  harness.provider.existing.set(workspace.id, handle);
  return handle;
}

async function setup() {
  h = await startHarness({ auth: FAST_AUTH });
  const { ctx } = h.app.deskmates;
  const tested = ctx.workspaces.create({
    name: "tested",
    sandboxProvider: "docker",
    egressAllowlist: ["*.example.test"],
  });
  const other = ctx.workspaces.create({
    name: "other",
    sandboxProvider: "docker",
    egressAllowlist: ["*.example.test"],
  });
  running(h, tested);
  running(h, other);
  const created = await h.api<{ profile: NetworkProfile }>("POST", "/api/network-profiles", LAN);
  expect(created.status).toBe(200);
  return { harness: h, ctx, tested, other, profile: created.json.profile };
}

type Selected = { publication: NetworkPublication; network: WorkspaceNetworkView };

describe("network profiles online (ADR-0027 amendment 1)", () => {
  it("publishes a selection to that workspace only, with its acknowledged hash", async () => {
    const { harness, ctx, tested, other, profile } = await setup();
    expect(profile.revision).toBe(1);
    const res = await harness.api<Selected>(
      "PUT",
      `/api/workspaces/${tested.id}/network-profiles`,
      { selections: [{ profileId: profile.id }] },
    );
    expect(res.status).toBe(200);
    expect(res.json.publication).toMatchObject({ workspaceId: tested.id, status: "applied" });
    expect(res.json.publication.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.json.network.trustedTest).toBe(true);
    expect(res.json.network.grants).toEqual(LAN.rules);
    const updates = harness.provider.egressUpdates;
    expect(updates.map((u) => u.handle.workspaceId)).toEqual([tested.id]);
    expect(updates[0]?.grants).toEqual(LAN.rules);
    expect(updates[0]?.allowlist).toEqual(["*.example.test"]);
    // Audit: the selection and the publication outcome (decision 7).
    const actions = ctx.audit.list({ workspaceId: tested.id }).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["workspace.network_profiles_set", "network_policy.publish"]),
    );
    expect(ctx.audit.list({ workspaceId: other.id }).map((e) => e.action)).not.toContain(
      "network_policy.publish",
    );
  });

  it("replaces a profile online, skips unchanged policy and refuses a stale revision", async () => {
    const { harness, tested, other, profile } = await setup();
    await harness.api("PUT", `/api/workspaces/${tested.id}/network-profiles`, {
      selections: [{ profileId: profile.id }],
    });
    const before = harness.provider.egressUpdates.length;
    const wider = {
      ...LAN,
      rules: [{ ...LAN.rules[0], ports: [23001, 23002] }],
      expectedRevision: 1,
    };
    const replaced = await harness.api<{
      profile: NetworkProfile;
      publications: NetworkPublication[];
    }>("PUT", `/api/network-profiles/${profile.id}`, wider);
    expect(replaced.status).toBe(200);
    expect(replaced.json.profile.revision).toBe(2);
    expect(replaced.json.publications).toEqual([
      expect.objectContaining({ workspaceId: tested.id, status: "applied" }),
    ]);
    const newUpdates = harness.provider.egressUpdates.slice(before);
    expect(newUpdates.map((u) => u.handle.workspaceId)).toEqual([tested.id]);
    expect(newUpdates.some((u) => u.handle.workspaceId === other.id)).toBe(false);

    // A rename changes no grant: the proxy keeps its policy and is not reloaded.
    const renamed = await harness.api<{ publications: NetworkPublication[] }>(
      "PUT",
      `/api/network-profiles/${profile.id}`,
      { ...wider, name: "Renamed", expectedRevision: 2 },
    );
    expect(renamed.json.publications[0]?.status).toBe("unchanged");

    // An editor holding revision 1 cannot overwrite revision 3.
    const stale = await harness.api<{ details?: { reason?: string } }>(
      "PUT",
      `/api/network-profiles/${profile.id}`,
      { ...LAN, expectedRevision: 1 },
    );
    expect(stale.status).toBe(409);
    expect(stale.json.details?.reason).toBe("stale_revision");
  });

  it("rejects invalid candidates before anything changes", async () => {
    const { harness, ctx, tested, profile } = await setup();
    const bad = await harness.api("POST", "/api/network-profiles", {
      name: "public",
      rules: [{ kind: "subnet", cidr: "8.8.8.0/24", schemes: ["http"], ports: [80] }],
    });
    expect(bad.status).toBe(400);
    const badReplace = await harness.api("PUT", `/api/network-profiles/${profile.id}`, {
      ...LAN,
      rules: [{ kind: "subnet", cidr: "169.254.0.0/16", schemes: ["http"], ports: [80] }],
    });
    expect(badReplace.status).toBe(400);
    const unknown = await harness.api("PUT", `/api/workspaces/${tested.id}/network-profiles`, {
      selections: [{ profileId: "netp_missing" }],
    });
    expect(unknown.status).toBe(404);
    const profiles = await harness.api<{ profiles: NetworkProfile[] }>(
      "GET",
      "/api/network-profiles",
    );
    expect(profiles.json.profiles).toHaveLength(1);
    expect(profiles.json.profiles[0]?.revision).toBe(1);
    expect(ctx.workspaces.mustGet(tested.id)).toBeDefined();
    expect(harness.provider.egressUpdates).toHaveLength(0);
  });

  it("keeps open-internet workspaces and LAN grants apart when the switch is off (decision 13)", async () => {
    // Owner-decided 2026-10-14: allowed by default; `network-ownership.test.ts` covers the switch.
    const { harness, ctx, tested, profile } = await setup();
    const open = ctx.workspaces.create({
      name: "open",
      sandboxProvider: "docker",
      egressAllowlist: ["*"],
    });
    for (const ws of [open, tested])
      await harness.api("PUT", `/api/workspaces/${ws.id}/network-settings`, {
        profilesOnOpenInternet: false,
      });
    const refused = await harness.api<{ details?: { reason?: string } }>(
      "PUT",
      `/api/workspaces/${open.id}/network-profiles`,
      { selections: [{ profileId: profile.id }] },
    );
    expect(refused.status).toBe(400);
    expect(refused.json.details?.reason).toBe("open_internet_with_network_profiles");
    await harness.api("PUT", `/api/workspaces/${tested.id}/network-profiles`, {
      selections: [{ profileId: profile.id }],
    });
    const star = await harness.api("PATCH", `/api/workspaces/${tested.id}`, {
      egressAllowlist: ["*"],
    });
    expect(star.status).toBe(400);
    expect(ctx.workspaces.mustGet(tested.id).egressAllowlist).toEqual(["*.example.test"]);
  });

  it("an allowlist edit republishes the grants instead of dropping them", async () => {
    const { harness, tested, profile } = await setup();
    await harness.api("PUT", `/api/workspaces/${tested.id}/network-profiles`, {
      selections: [{ profileId: profile.id }],
    });
    // Concurrent edits: both land, and the last publication carries both.
    const [patched, replaced] = await Promise.all([
      harness.api("PATCH", `/api/workspaces/${tested.id}`, {
        egressAllowlist: ["*.example.test", "docs.example.org"],
      }),
      harness.api("PUT", `/api/network-profiles/${profile.id}`, {
        ...LAN,
        rules: [{ ...LAN.rules[0], ports: [23009] }],
      }),
    ]);
    expect(patched.status).toBe(200);
    expect(replaced.status).toBe(200);
    const last = harness.provider.egressUpdates.at(-1);
    expect(last?.allowlist).toEqual(["*.example.test", "docs.example.org"]);
    expect(last?.grants).toEqual([{ ...LAN.rules[0], ports: [23009] }]);
  });

  it("reports a failed publication, fails closed and leaves other workspaces applied", async () => {
    const { harness, ctx, tested, other, profile } = await setup();
    for (const ws of [tested, other])
      await harness.api("PUT", `/api/workspaces/${ws.id}/network-profiles`, {
        selections: [{ profileId: profile.id }],
      });
    harness.provider.egressFailures.add(other.id);
    const res = await harness.api<{ publications: NetworkPublication[] }>(
      "PUT",
      `/api/network-profiles/${profile.id}`,
      { ...LAN, rules: [{ ...LAN.rules[0], ports: [8080] }] },
    );
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.json.publications.map((p) => [p.workspaceId, p]));
    expect(byId[tested.id]?.status).toBe("applied");
    expect(byId[other.id]?.status).toBe("failed");
    expect(byId[other.id]?.policyHash).toBeUndefined();
    const audit = ctx.audit
      .list({ workspaceId: other.id })
      .find((e) => e.action === "network_policy.publish"); // newest first
    expect(audit?.after).toMatchObject({ status: "failed" });
    expect(audit?.reason).toMatch(/not acknowledged/);
  });

  it("deleting a profile revokes its grants in every selecting workspace", async () => {
    const { harness, ctx, tested, profile } = await setup();
    await harness.api("PUT", `/api/workspaces/${tested.id}/network-profiles`, {
      selections: [{ profileId: profile.id }],
    });
    const res = await harness.api<{ publications: NetworkPublication[] }>(
      "DELETE",
      `/api/network-profiles/${profile.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.json.publications[0]).toMatchObject({ workspaceId: tested.id, status: "applied" });
    expect(harness.provider.egressUpdates.at(-1)?.grants).toEqual([]);
    const view = await harness.api<WorkspaceNetworkView>(
      "GET",
      `/api/workspaces/${tested.id}/network`,
    );
    expect(view.json).toMatchObject({ trustedTest: false, selections: [], grants: [] });
    expect(ctx.audit.list({ targetId: profile.id }).map((e) => e.action)).toEqual(
      expect.arrayContaining(["network_profile.create", "network_profile.delete"]),
    );
  });

  it("a workspace without a sandbox is not_running and gets its grants at next start", async () => {
    const { harness, ctx, profile } = await setup();
    const idle = ctx.workspaces.create({
      name: "idle",
      sandboxProvider: "docker",
      egressAllowlist: ["*.example.test"],
    });
    const res = await harness.api<Selected>("PUT", `/api/workspaces/${idle.id}/network-profiles`, {
      selections: [{ profileId: profile.id }],
    });
    expect(res.json.publication.status).toBe("not_running");
    expect(res.json.network.grants).toEqual(LAN.rules);
  });

  it("a workspace Admin reads and selects but defines nothing (decision 12, owner-decided)", async () => {
    const { harness, ctx, tested, profile } = await setup();
    await ctx.auth.createUser({
      loginName: "ada",
      displayName: "Ada",
      password: TEST_PASSWORD,
      role: "admin",
      workspaceId: tested.id,
    });
    const jar = new BrowserJar(harness.baseUrl);
    expect((await jar.signIn("ada")).status).toBe(200);
    expect((await jar.json("GET", `/api/workspaces/${tested.id}/network`)).status).toBe(200);
    for (const [method, path, body] of [
      ["GET", "/api/network-profiles", undefined],
      ["POST", "/api/network-profiles", LAN],
      ["PUT", `/api/network-profiles/${profile.id}`, LAN],
      ["DELETE", `/api/network-profiles/${profile.id}`, undefined],
    ] as const) {
      const res = await jar.json(method, path, { ...(body === undefined ? {} : { body }) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    const selected = await jar.json("PUT", `/api/workspaces/${tested.id}/network-profiles`, {
      body: { selections: [{ profileId: profile.id }] },
    });
    expect(selected.status).toBe(200);
  });
});

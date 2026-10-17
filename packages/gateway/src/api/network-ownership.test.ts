// T1: who defines and selects network profiles, and the open-internet switch (ADR-0027
// amendment 1 decisions 12 and 13, owner-decided 2026-10-14). Owners create profiles available
// where they are Owner; Admins select among the available ones; `*` workspaces may use profiles
// unless their switch is off.

import type {
  NetworkProfile,
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

const rules = (port: number) => [
  { kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [port] },
];

function running(harness: Harness, workspace: Workspace): void {
  harness.provider.existing.set(workspace.id, {
    workspaceId: workspace.id,
    providerRef: `fake-${workspace.id}`,
    sidecarAddress: "fake://sidecar",
  } as SandboxHandle);
}

async function setup() {
  h = await startHarness({ auth: FAST_AUTH });
  const harness = h;
  const { ctx } = harness.app.deskmates;
  const make = (name: string, egressAllowlist: string[]) =>
    ctx.workspaces.create({ name, sandboxProvider: "docker", egressAllowlist });
  const a = make("alpha", ["*.example.test"]);
  const b = make("beta", ["*.example.test"]);
  const open = make("open", ["*"]);
  for (const ws of [a, b, open]) running(harness, ws);
  const person = async (loginName: string, role: "owner" | "admin" | "member", ws: Workspace) => {
    const user = await ctx.auth.createUser({
      loginName,
      displayName: loginName,
      password: TEST_PASSWORD,
      role,
      workspaceId: ws.id,
    });
    const jar = new BrowserJar(harness.baseUrl);
    expect((await jar.signIn(loginName)).status).toBe(200);
    return { user, jar };
  };
  const owen = await person("owen", "owner", a);
  const olga = await person("olga", "owner", b);
  const ada = await person("ada", "admin", a);
  const mia = await person("mia", "member", a);
  const rootProfile = (
    await harness.api<{ profile: NetworkProfile }>("POST", "/api/network-profiles", {
      name: "Shared lab",
      rules: rules(23001),
    })
  ).json.profile;
  return { harness, ctx, a, b, open, owen, olga, ada, mia, rootProfile };
}

type ListBody = { profiles: NetworkProfile[]; manageAll: boolean };

describe("network profile ownership (decision 12)", () => {
  it("an Owner's profile is available where they are Owner and editable by them and the root", async () => {
    const { harness, ctx, a, b, owen, olga, ada, rootProfile } = await setup();
    const created = await owen.jar.json<{ profile: NetworkProfile }>(
      "POST",
      "/api/network-profiles",
      { body: { name: "Owen's service", rules: rules(23002) } },
    );
    expect(created.status).toBe(200);
    const mine = created.json.profile;
    expect(mine.ownerUserId).toBe(owen.user.id);
    expect(ctx.audit.list({ targetId: mine.id })[0]?.actor).toBe(`user:${owen.user.id}`);

    const owenList = await owen.jar.json<ListBody>("GET", "/api/network-profiles");
    expect(owenList.json.manageAll).toBe(false);
    expect(owenList.json.profiles.map((p) => [p.name, p.editable])).toEqual([
      ["Owen's service", true],
      ["Shared lab", false],
    ]);
    // Another workspace's Owner does not see it; the root sees and edits everything.
    const olgaList = await olga.jar.json<ListBody>("GET", "/api/network-profiles");
    expect(olgaList.json.profiles.map((p) => p.id)).toEqual([rootProfile.id]);
    const rootList = await harness.api<ListBody>("GET", "/api/network-profiles");
    expect(rootList.json.manageAll).toBe(true);
    expect(rootList.json.profiles.every((p) => p.editable)).toBe(true);

    // Availability follows the creator's Owner role.
    const viewA = await ada.jar.json<WorkspaceNetworkView>(
      "GET",
      `/api/workspaces/${a.id}/network`,
    );
    expect(viewA.json.available.map((p) => p.id).sort()).toEqual([mine.id, rootProfile.id].sort());
    const viewB = await olga.jar.json<WorkspaceNetworkView>(
      "GET",
      `/api/workspaces/${b.id}/network`,
    );
    expect(viewB.json.available.map((p) => p.id)).toEqual([rootProfile.id]);

    // Edit rights: the creator and the root; not another Owner, not on the root's profile.
    const byOlga = await olga.jar.json<{ details?: { reason?: string } }>(
      "PUT",
      `/api/network-profiles/${mine.id}`,
      { body: { name: "taken over", rules: rules(1) } },
    );
    expect(byOlga.status).toBe(403);
    expect(byOlga.json.details?.reason).toBe("profile_owner");
    const onRoot = await owen.jar.json("PUT", `/api/network-profiles/${rootProfile.id}`, {
      body: { name: "Shared lab", rules: rules(9) },
    });
    expect(onRoot.status).toBe(403);
    const ownEdit = await owen.jar.json("PUT", `/api/network-profiles/${mine.id}`, {
      body: { name: "Owen's service", rules: rules(23003), expectedRevision: 1 },
    });
    expect(ownEdit.status).toBe(200);
    const rootEdit = await harness.api("PUT", `/api/network-profiles/${mine.id}`, {
      name: "Owen's service",
      rules: rules(23004),
    });
    expect(rootEdit.status).toBe(200);
    expect((await olga.jar.json("DELETE", `/api/network-profiles/${mine.id}`)).status).toBe(403);
    expect((await owen.jar.json("DELETE", `/api/network-profiles/${mine.id}`)).status).toBe(200);
  });

  it("an Admin selects available profiles only; Admins and Members do not define them", async () => {
    const { harness, a, b, owen, olga, ada, mia, rootProfile } = await setup();
    const mine = (
      await owen.jar.json<{ profile: NetworkProfile }>("POST", "/api/network-profiles", {
        body: { name: "Owen's service", rules: rules(23002) },
      })
    ).json.profile;
    const selected = await ada.jar.json<{ network: WorkspaceNetworkView }>(
      "PUT",
      `/api/workspaces/${a.id}/network-profiles`,
      { body: { selections: [{ profileId: mine.id }, { profileId: rootProfile.id }] } },
    );
    expect(selected.status).toBe(200);
    expect(selected.json.network.trustedTest).toBe(true);
    expect(harness.provider.egressUpdates.at(-1)?.grants).toHaveLength(2);
    // Not available in beta: answered like a missing profile.
    const elsewhere = await olga.jar.json("PUT", `/api/workspaces/${b.id}/network-profiles`, {
      body: { selections: [{ profileId: mine.id }] },
    });
    expect(elsewhere.status).toBe(404);
    // An Admin defines nothing, and a Member reads no workspace network.
    expect(
      (
        await ada.jar.json("POST", "/api/network-profiles", {
          body: { name: "x", rules: rules(1) },
        })
      ).status,
    ).toBe(403);
    expect((await ada.jar.json("GET", "/api/network-profiles")).status).toBe(403);
    expect((await mia.jar.json("GET", `/api/workspaces/${a.id}/network`)).status).toBe(403);
    expect(
      (
        await mia.jar.json("PUT", `/api/workspaces/${a.id}/network-profiles`, {
          body: { selections: [] },
        })
      ).status,
    ).toBe(403);
  });

  it("a selection stays when its profile stops being available, but cannot be re-added", async () => {
    const { harness, ctx, a, owen, ada } = await setup();
    const mine = (
      await owen.jar.json<{ profile: NetworkProfile }>("POST", "/api/network-profiles", {
        body: { name: "Owen's service", rules: rules(23002) },
      })
    ).json.profile;
    await ada.jar.json("PUT", `/api/workspaces/${a.id}/network-profiles`, {
      body: { selections: [{ profileId: mine.id }] },
    });
    // Owen stops being an Owner of alpha; another Owner keeps the workspace owned.
    await ctx.auth.createUser({
      loginName: "otto",
      displayName: "otto",
      password: TEST_PASSWORD,
      role: "owner",
      workspaceId: a.id,
    });
    ctx.auth.memberships.change(a.id, owen.user.id, { role: "member" }, "test");
    const kept = await ada.jar.json("PUT", `/api/workspaces/${a.id}/network-profiles`, {
      body: { selections: [{ profileId: mine.id, expiresAt: "2099-01-01T00:00:00.000Z" }] },
    });
    expect(kept.status).toBe(200);
    await ada.jar.json("PUT", `/api/workspaces/${a.id}/network-profiles`, {
      body: { selections: [] },
    });
    const readd = await ada.jar.json("PUT", `/api/workspaces/${a.id}/network-profiles`, {
      body: { selections: [{ profileId: mine.id }] },
    });
    expect(readd.status).toBe(404);
    // The root may still select it.
    const byRoot = await harness.api("PUT", `/api/workspaces/${a.id}/network-profiles`, {
      selections: [{ profileId: mine.id }],
    });
    expect(byRoot.status).toBe(200);
  });
});

describe("profiles on open-internet workspaces (decision 13)", () => {
  it("are allowed by default and refused once the workspace switch is off", async () => {
    const { harness, ctx, a, open, rootProfile } = await setup();
    const view = await harness.api<WorkspaceNetworkView>(
      "GET",
      `/api/workspaces/${open.id}/network`,
    );
    expect(view.json).toMatchObject({ openInternet: true, profilesOnOpenInternet: true });
    const selected = await harness.api("PUT", `/api/workspaces/${open.id}/network-profiles`, {
      selections: [{ profileId: rootProfile.id }],
    });
    expect(selected.status).toBe(200);
    expect(harness.provider.egressUpdates.at(-1)?.allowlist).toEqual(["*"]);
    expect(harness.provider.egressUpdates.at(-1)?.grants).toEqual(rules(23001));

    // The switch cannot turn off under an active selection.
    const blocked = await harness.api<{ details?: { reason?: string } }>(
      "PUT",
      `/api/workspaces/${open.id}/network-settings`,
      { profilesOnOpenInternet: false },
    );
    expect(blocked.status).toBe(400);
    expect(blocked.json.details?.reason).toBe("open_internet_with_network_profiles");
    await harness.api("PUT", `/api/workspaces/${open.id}/network-profiles`, { selections: [] });
    const off = await harness.api<{ network: WorkspaceNetworkView }>(
      "PUT",
      `/api/workspaces/${open.id}/network-settings`,
      { profilesOnOpenInternet: false },
    );
    expect(off.status).toBe(200);
    expect(off.json.network.profilesOnOpenInternet).toBe(false);
    const audit = ctx.audit
      .list({ workspaceId: open.id })
      .find((e) => e.action === "workspace.network_settings_set");
    expect(audit?.after).toEqual({ profilesOnOpenInternet: false });

    const refused = await harness.api<{ details?: { reason?: string } }>(
      "PUT",
      `/api/workspaces/${open.id}/network-profiles`,
      { selections: [{ profileId: rootProfile.id }] },
    );
    expect(refused.status).toBe(400);
    expect(refused.json.details?.reason).toBe("open_internet_with_network_profiles");

    // A locked workspace that selects a profile may switch to `*` while its switch is on...
    await harness.api("PUT", `/api/workspaces/${a.id}/network-profiles`, {
      selections: [{ profileId: rootProfile.id }],
    });
    const star = await harness.api("PATCH", `/api/workspaces/${a.id}`, { egressAllowlist: ["*"] });
    expect(star.status).toBe(200);
    // ...and not once it is off (checked against the locked list).
    await harness.api("PATCH", `/api/workspaces/${a.id}`, { egressAllowlist: ["*.example.test"] });
    await harness.api("PUT", `/api/workspaces/${a.id}/network-settings`, {
      profilesOnOpenInternet: false,
    });
    const starAgain = await harness.api("PATCH", `/api/workspaces/${a.id}`, {
      egressAllowlist: ["*"],
    });
    expect(starAgain.status).toBe(400);
    expect(ctx.workspaces.mustGet(a.id).egressAllowlist).toEqual(["*.example.test"]);
  });

  it("an Admin sets the switch; a Member cannot", async () => {
    const { a, ada, mia } = await setup();
    const byAdmin = await ada.jar.json("PUT", `/api/workspaces/${a.id}/network-settings`, {
      body: { profilesOnOpenInternet: false },
    });
    expect(byAdmin.status).toBe(200);
    const byMember = await mia.jar.json("PUT", `/api/workspaces/${a.id}/network-settings`, {
      body: { profilesOnOpenInternet: true },
    });
    expect(byMember.status).toBe(403);
    const bad = await ada.jar.json("PUT", `/api/workspaces/${a.id}/network-settings`, {
      body: { profilesOnOpenInternet: "yes" },
    });
    expect(bad.status).toBe(400);
  });
});

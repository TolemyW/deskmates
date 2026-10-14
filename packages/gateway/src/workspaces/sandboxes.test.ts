import { DeskmatesError, type SandboxHandle, type SandboxImageDrift } from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { SandboxRegistry } from "./sandboxes.js";
import { WorkspaceStore } from "./workspaces.js";

const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

it("serializes creation, policy edits and recreation and rereads current database policy", async () => {
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(), provider, { startCron: false });
  apps.push(app);
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({
    name: "policy-race",
    sandboxProvider: "docker",
    egressAllowlist: ["old.example"],
  });
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const create = provider.create.bind(provider);
  vi.spyOn(provider, "create").mockImplementationOnce(async (spec) => {
    entered?.();
    await blocked;
    return create(spec);
  });
  const opening = ctx.sandboxes.ensure(workspace);
  await started;
  const editing = ctx.sandboxes.withPolicyUpdate(workspace.id, async (peek) => {
    const handle = await peek();
    expect(handle).toBeDefined();
    if (handle) await provider.updateEgress(handle, []);
    ctx.workspaces.setEgressAllowlist(workspace.id, [], "human:test");
  });
  expect(provider.egressUpdates).toEqual([]);
  expect(ctx.workspaces.mustGet(workspace.id).egressAllowlist).toEqual(["old.example"]);
  release?.();
  await Promise.all([opening, editing]);
  expect(provider.egressUpdates[0]?.allowlist).toEqual([]);
  await ctx.sandboxes.restart(workspace.id);
  expect(provider.created.at(-1)?.egressAllowlist).toEqual([]);
  ctx.sandboxes.forget(workspace.id);
  await ctx.sandboxes.ensure(workspace); // stale caller snapshot must never resurrect old policy
  expect(provider.created.at(-1)?.egressAllowlist).toEqual([]);
});

describe("SandboxRegistry: a cached sandbox gets its policy reapplied on every ensure", () => {
  // Testbox, 2026-09-28: the egress proxy crashed and Docker restarted it deny-all. The Gateway
  // served the cached handle and never pushed the policy again, so the workspace lost the network.
  function setup() {
    const provider = new FakeProvider();
    const app = buildGateway(testConfig(), provider, { startCron: false });
    apps.push(app);
    const ctx = app.deskmates.ctx;
    const workspace = ctx.workspaces.create({
      name: "reapply",
      sandboxProvider: "docker",
      egressAllowlist: ["*"],
    });
    return { provider, ctx, workspace };
  }

  it("pushes the current allowlist again when it serves a cached handle", async () => {
    const { provider, ctx, workspace } = setup();
    const first = await ctx.sandboxes.ensure(workspace);
    expect(provider.egressUpdates).toEqual([]);
    const second = await ctx.sandboxes.ensure(workspace);
    expect(second).toBe(first);
    expect(provider.egressUpdates).toMatchObject([{ handle: first, allowlist: ["*"], grants: [] }]);
  });

  it("reopens the sandbox when reapplying the policy fails", async () => {
    const { provider, ctx, workspace } = setup();
    await ctx.sandboxes.ensure(workspace);
    vi.spyOn(provider, "updateEgress").mockRejectedValueOnce(
      new DeskmatesError("sandbox_unavailable", "egress proxy is missing"),
    );
    const created = provider.created.length;
    await ctx.sandboxes.ensure(workspace);
    expect(provider.created.length).toBe(created + 1);
  });
});

describe("SandboxRegistry: a sandbox left running on a stale image is recreated on open", () => {
  const IMAGE = "deskmates/workspace:v2";

  function setup() {
    const provider = new FakeProvider();
    const app = buildGateway(testConfig(), provider, { startCron: false });
    apps.push(app);
    const ctx = app.deskmates.ctx;
    const workspace = ctx.workspaces.create({
      name: "upgrade",
      sandboxProvider: "docker",
      egressAllowlist: ["current.example"],
    });
    const log = vi.fn();
    const registry = new SandboxRegistry(
      provider,
      IMAGE,
      { memoryLimitBytes: 1024 * 1024 * 1024 },
      (id) => ctx.workspaces.mustGet(id),
      log,
    );
    const old: SandboxHandle = {
      workspaceId: workspace.id,
      providerRef: "old-container",
      sidecarAddress: "fake://old",
      novncPassword: "0badc0de",
    };
    provider.existing.set(workspace.id, old);
    return { provider, workspace, log, registry, old };
  }

  it("attaches a sandbox that already runs the configured images and reapplies its policy", async () => {
    const { provider, workspace, log, registry, old } = setup();
    expect(await registry.ensure(workspace)).toBe(old);
    expect(provider.staleChecks).toEqual([{ workspaceId: workspace.id, image: IMAGE }]);
    expect(provider.created).toEqual([]);
    expect(provider.egressUpdates).toMatchObject([
      { handle: old, allowlist: ["current.example"], grants: [] },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it("recreates a drifted sandbox exactly like a fresh create, on the same volumes", async () => {
    const { provider, workspace, log, registry, old } = setup();
    const drift: SandboxImageDrift[] = [
      { component: "workspace", runningImageId: "sha256:v1", configuredImageId: "sha256:v2" },
      { component: "egress-proxy", runningImageId: "sha256:p1", configuredImageId: "sha256:p2" },
    ];
    provider.drift.set(workspace.id, drift);
    const handle = await registry.ensure(workspace);
    expect(handle).not.toBe(old);
    const spec = provider.created[0];
    expect(provider.created).toHaveLength(1);
    expect(spec?.image).toBe(IMAGE);
    // Same named volumes as the container that was removed: profile, work and home survive.
    expect(spec?.volumes).toEqual({
      "/profile": `deskmates-${workspace.id}-profile`,
      "/work": `deskmates-${workspace.id}-work`,
      "/home": `deskmates-${workspace.id}-home`,
    });
    // Policy and screen credentials come from the create path, not from the old container.
    expect(spec?.egressAllowlist).toEqual(["current.example"]);
    const control = spec?.env.DESKMATES_VNC_PASSWORD;
    const view = spec?.env.DESKMATES_VNC_VIEW_PASSWORD;
    expect(control).toMatch(/^[0-9a-f]{8}$/);
    expect(view).toMatch(/^[0-9a-f]{8}$/);
    expect(view).not.toBe(control);
    expect(control).not.toBe(old.novncPassword);
    expect(spec?.env.DESKMATES_DESKTOP_MODE).toBe("shared-monitors-v1");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toEqual({ workspaceId: workspace.id, drift });
    // A second ensure is served from the cache: no second check, no second create.
    expect(await registry.ensure(workspace)).toBe(handle);
    expect(provider.staleChecks).toHaveLength(1);
    expect(provider.created).toHaveLength(1);
  });

  it("fails closed when the configured image is missing: nothing is removed or created", async () => {
    const { provider, workspace, registry } = setup();
    provider.staleCheckError = new DeskmatesError("sandbox_unavailable", "image not found", {
      reason: "image_missing",
      image: IMAGE,
    });
    await expect(registry.ensure(workspace)).rejects.toMatchObject({
      code: "sandbox_unavailable",
      details: { reason: "image_missing", image: IMAGE },
    });
    expect(provider.created).toEqual([]);
    expect(provider.destroyed).toEqual([]);
    // The failure is not cached: once the image exists, the next ensure proceeds.
    provider.staleCheckError = undefined;
    await registry.ensure(workspace);
    expect(provider.staleChecks).toHaveLength(2);
  });

  it("the read-only peek used by status and takeover lookups never recreates", async () => {
    const { provider, workspace, registry, old } = setup();
    provider.drift.set(workspace.id, [
      { component: "workspace", runningImageId: "sha256:v1", configuredImageId: "sha256:v2" },
    ]);
    expect(await registry.peek(workspace.id)).toBe(old);
    expect(provider.staleChecks).toEqual([]);
    expect(provider.created).toEqual([]);
  });
});

describe("replacement preflight failure preserves the usable environment", () => {
  it.each(["restart", "upgrade"])(
    "%s checks before attach, destroy or stale-image removal and can retry",
    async (operation) => {
      const provider = new FakeProvider();
      const app = buildGateway(testConfig(), provider, { startCron: false });
      apps.push(app);
      const ctx = app.deskmates.ctx;
      const workspace = ctx.workspaces.create({
        name: "preflight",
        sandboxProvider: "docker",
        egressAllowlist: [],
      });
      const old = await ctx.sandboxes.ensure(workspace);
      provider.existing.set(workspace.id, old);
      if (operation === "upgrade") {
        provider.drift.set(workspace.id, [
          { component: "workspace", runningImageId: "old", configuredImageId: "new" },
        ]);
        ctx.sandboxes.forget(workspace.id);
      }
      const error = new DeskmatesError("sandbox_unavailable", "legacy volume requires recovery", {
        reason: "volume_ownership_mismatch",
      });
      const preflight = vi.spyOn(provider, "preflight").mockRejectedValueOnce(error);
      const attach = vi.spyOn(provider, "attach");
      const stale = vi.spyOn(provider, "removeStaleSandbox");
      const replace = () =>
        operation === "restart"
          ? ctx.sandboxes.restart(workspace.id)
          : ctx.sandboxes.ensure(workspace);
      await expect(replace()).rejects.toBe(error);
      expect(provider.destroyed).toEqual([]);
      // Restart checks before anything; an upgrade checks inside the stale-image removal,
      // before it removes anything.
      if (operation === "restart") expect(stale).not.toHaveBeenCalled();
      expect(provider.existing.get(workspace.id)).toBe(old);
      expect(attach).not.toHaveBeenCalled();
      expect(await ctx.sandboxes.peek(workspace.id)).toBe(old);
      await replace();
      expect(preflight).toHaveBeenCalled();
    },
  );
});

it("records volatile access restoration after automatic stale-image replacement", async () => {
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(), provider, { startCron: false });
  apps.push(app);
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({
    name: "volatile-upgrade",
    sandboxProvider: "docker",
    egressAllowlist: [],
  });
  const old = await ctx.sandboxes.ensure(workspace);
  provider.existing.set(workspace.id, old);
  provider.volatilePrerequisites = [
    { code: "volatile_nss_database", path: "/root/.pki/nssdb", sourceProviderRef: old.providerRef },
  ];
  provider.drift.set(workspace.id, [
    { component: "workspace", runningImageId: "old", configuredImageId: "new" },
  ]);
  ctx.sandboxes.forget(workspace.id);
  await ctx.sandboxes.ensure(workspace);
  expect(ctx.workspaces.mustGet(workspace.id).restorationRequirements).toEqual([
    { ...provider.volatilePrerequisites[0], status: "restoration_required" },
  ]);
  const reopened = new WorkspaceStore(ctx.db);
  expect(reopened.mustGet(workspace.id).restorationRequirements).toEqual(
    ctx.workspaces.mustGet(workspace.id).restorationRequirements,
  );
});

it("rejects failed prerequisite metadata inspection before any runtime mutation", async () => {
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(), provider, { startCron: false });
  apps.push(app);
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({
    name: "volatile-read-failure",
    sandboxProvider: "docker",
    egressAllowlist: [],
  });
  const old = await ctx.sandboxes.ensure(workspace);
  vi.spyOn(provider, "inspectVolatilePrerequisites").mockRejectedValueOnce(
    new DeskmatesError("sandbox_unavailable", "metadata unavailable"),
  );
  await expect(ctx.sandboxes.restart(workspace.id)).rejects.toMatchObject({
    code: "sandbox_unavailable",
  });
  expect(provider.destroyed).toEqual([]);
  expect(await ctx.sandboxes.peek(workspace.id)).toBe(old);
  expect(ctx.workspaces.mustGet(workspace.id).restorationRequirements).toBeUndefined();
});

it("binds explicit restart prerequisite inspection to the cached handle that it destroys", async () => {
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(), provider, { startCron: false });
  apps.push(app);
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({
    name: "exact-cached-nss",
    sandboxProvider: "docker",
    egressAllowlist: [],
  });
  const old = await ctx.sandboxes.ensure(workspace);
  const inspect = vi
    .spyOn(provider, "inspectVolatilePrerequisites")
    .mockImplementationOnce(async (_spec, requiredRef) => {
      expect(requiredRef).toBe(old.providerRef);
      return [
        {
          code: "volatile_nss_database",
          path: "/root/.pki/nssdb",
          sourceProviderRef: requiredRef as string,
        },
      ];
    });
  await ctx.sandboxes.restart(workspace.id);
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(provider.destroyed).toEqual([old]);
  expect(ctx.workspaces.mustGet(workspace.id).restorationRequirements?.[0]?.sourceProviderRef).toBe(
    old.providerRef,
  );
});

it("reattaches a healthy current sandbox without the replacement preflight", async () => {
  // Legacy unlabelled volumes or slow change metadata must not block plain reattach after a
  // Gateway restart: preflight guards only replacement and creation.
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(), provider, { startCron: false });
  apps.push(app);
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({
    name: "plain-reattach",
    sandboxProvider: "docker",
    egressAllowlist: [],
  });
  const old = await ctx.sandboxes.ensure(workspace);
  provider.existing.set(workspace.id, old);
  ctx.sandboxes.forget(workspace.id);
  const preflight = vi
    .spyOn(provider, "preflight")
    .mockRejectedValue(new DeskmatesError("sandbox_unavailable", "legacy volume"));
  const inspect = vi.spyOn(provider, "inspectVolatilePrerequisites");
  expect(await ctx.sandboxes.ensure(workspace)).toBe(old);
  expect(preflight).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
});

it("preflights before creating a sandbox that does not exist", async () => {
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(), provider, { startCron: false });
  apps.push(app);
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({
    name: "fresh-create",
    sandboxProvider: "docker",
    egressAllowlist: [],
  });
  const error = new DeskmatesError("sandbox_unavailable", "legacy volume");
  vi.spyOn(provider, "preflight").mockRejectedValueOnce(error);
  await expect(ctx.sandboxes.ensure(workspace)).rejects.toBe(error);
  expect(provider.created).toEqual([]);
});

describe("restoration requirements merge by prerequisite identity", () => {
  const nss = (sourceProviderRef: string) => ({
    code: "volatile_nss_database" as const,
    path: "/root/.pki/nssdb",
    sourceProviderRef,
  });

  it("upserts by identity, keeps history and clears at-risk entries a later inspection no longer finds", () => {
    const provider = new FakeProvider();
    const app = buildGateway(testConfig(), provider, { startCron: false });
    apps.push(app);
    const store = app.deskmates.ctx.workspaces;
    const workspace = store.create({
      name: "merge",
      sandboxProvider: "docker",
      egressAllowlist: [],
    });
    store.recordRestorationRequirements(workspace.id, [{ ...nss("a"), status: "at_risk" }], {
      inspectionComplete: true,
    });
    store.recordRestorationRequirements(workspace.id, [
      { ...nss("a"), status: "restoration_required" },
    ]);
    store.recordRestorationRequirements(workspace.id, [{ ...nss("b"), status: "at_risk" }], {
      inspectionComplete: true,
    });
    expect(store.mustGet(workspace.id).restorationRequirements).toEqual([
      { ...nss("a"), status: "restoration_required" },
      { ...nss("b"), status: "at_risk" },
    ]);
    // The current runtime no longer carries b: that risk is resolved. History stays.
    store.recordRestorationRequirements(workspace.id, [], { inspectionComplete: true });
    expect(store.mustGet(workspace.id).restorationRequirements).toEqual([
      { ...nss("a"), status: "restoration_required" },
    ]);
  });

  it("restart reports only its own findings; earlier ones stay stored", async () => {
    const provider = new FakeProvider();
    const app = buildGateway(testConfig(), provider, { startCron: false });
    apps.push(app);
    const ctx = app.deskmates.ctx;
    const workspace = ctx.workspaces.create({
      name: "restart-findings",
      sandboxProvider: "docker",
      egressAllowlist: [],
    });
    await ctx.sandboxes.ensure(workspace);
    provider.volatilePrerequisites = [nss("first")];
    const first = await ctx.sandboxes.restart(workspace.id);
    expect(first.restorationRequirements).toEqual([
      { ...nss("first"), status: "restoration_required" },
    ]);
    provider.volatilePrerequisites = [];
    const second = await ctx.sandboxes.restart(workspace.id);
    expect(second.restorationRequirements).toEqual([]);
    expect(ctx.workspaces.mustGet(workspace.id).restorationRequirements).toEqual([
      { ...nss("first"), status: "restoration_required" },
    ]);
  });
});

import { DeskmatesError, type SandboxHandle } from "@deskmates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";

const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("status reads recheck cached sandbox presence", () => {
  function setup() {
    const provider = new FakeProvider();
    const isPresent = vi.fn(async (_handle: SandboxHandle) => true);
    Object.assign(provider, { isPresent });
    const app = buildGateway(testConfig(), provider, { startCron: false });
    apps.push(app);
    const ctx = app.deskmates.ctx;
    const workspace = ctx.workspaces.create({ name: "presence", sandboxProvider: "docker" });
    return { provider, isPresent, ctx, workspace };
  }

  it("evicts a missing cached handle without attach, restart or creation", async () => {
    const { provider, isPresent, ctx, workspace } = setup();
    const handle = await ctx.sandboxes.ensure(workspace);
    const attach = vi.spyOn(provider, "attach");
    attach.mockClear();
    isPresent.mockResolvedValueOnce(false);
    expect(await ctx.sandboxes.peek(workspace.id)).toBeUndefined();
    expect(isPresent).toHaveBeenCalledWith(handle);
    expect(attach).not.toHaveBeenCalled();
    expect(provider.created).toHaveLength(1);
    expect(provider.destroyed).toHaveLength(0);
    expect(provider.egressUpdates).toHaveLength(0);
    // A later intentional run can create a replacement; reading status did not.
    await ctx.sandboxes.ensure(workspace);
    expect(provider.created).toHaveLength(2);
  });

  it("preserves a present stopped sandbox without a lifecycle action", async () => {
    const { provider, ctx, workspace } = setup();
    const handle = await ctx.sandboxes.ensure(workspace);
    expect(await ctx.sandboxes.peek(workspace.id)).toBe(handle);
    expect(provider.created).toHaveLength(1);
    expect(provider.egressUpdates).toHaveLength(0);
    expect(provider.destroyed).toHaveLength(0);
  });

  it("propagates an inspection failure and retains the cache for a later retry", async () => {
    const { provider, isPresent, ctx, workspace } = setup();
    const handle = await ctx.sandboxes.ensure(workspace);
    const error = new DeskmatesError("sandbox_unavailable", "daemon inspection failed");
    isPresent.mockRejectedValueOnce(error);
    await expect(ctx.sandboxes.peek(workspace.id)).rejects.toBe(error);
    expect(await ctx.sandboxes.peek(workspace.id)).toBe(handle);
    expect(provider.created).toHaveLength(1);
    expect(provider.destroyed).toHaveLength(0);
  });
});

// T1: ADR-0027 amendment 2 decision 16. A cached sandbox handle is held to attach's topology rules
// before reuse: a mismatch drops it and reopens through attach, whose refusal stands. Issue #124:
// a hand-added Docker network worked through the cached handle until the next Gateway restart.

import { DeskmatesError, type SandboxHandle } from "@deskmates/contracts";
import { afterEach, expect, it } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";

const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function setup() {
  const provider = new FakeProvider();
  let tampered = false;
  const verified: SandboxHandle[] = [];
  Object.assign(provider, {
    async verifyTopology(handle: SandboxHandle) {
      verified.push(handle);
      if (tampered)
        throw new DeskmatesError(
          "sandbox_unavailable",
          "workspace is attached to a mismatched network",
          {
            reason: "network_mismatch",
          },
        );
    },
  });
  const app = buildGateway(testConfig(), provider, { startCron: false });
  apps.push(app);
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({
    name: "revalidate",
    sandboxProvider: "docker",
    egressAllowlist: ["docs.example.org"],
  });
  const tamper = (): void => {
    tampered = true;
  };
  return { provider, ctx, workspace, verified, tamper };
}

it("verifies a cached handle's topology before reusing it, then pushes the policy", async () => {
  const { provider, ctx, workspace, verified } = setup();
  const first = await ctx.sandboxes.ensure(workspace);
  expect(verified).toEqual([]);
  expect(await ctx.sandboxes.ensure(workspace)).toBe(first);
  expect(verified).toEqual([first]);
  expect(provider.egressUpdates).toHaveLength(1);
});

it("drops a tampered handle and lets attach's refusal stand", async () => {
  const { provider, ctx, workspace, tamper } = setup();
  const first = await ctx.sandboxes.ensure(workspace);
  provider.existing.set(workspace.id, first);
  tamper();
  // Attach on the real provider refuses the same topology; the fake mirrors that refusal.
  provider.attach = async () => {
    throw new DeskmatesError(
      "sandbox_unavailable",
      "workspace is attached to a mismatched network",
      {
        reason: "network_mismatch",
      },
    );
  };
  await expect(ctx.sandboxes.ensure(workspace)).rejects.toThrow("mismatched network");
  expect(provider.egressUpdates).toEqual([]);
  // Nothing stale stays cached: the next use goes to attach again.
  await expect(ctx.sandboxes.ensure(workspace)).rejects.toThrow("mismatched network");
});

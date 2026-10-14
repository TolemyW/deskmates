// T1: the connectivity preflight route (ADR-0027 amendment 1 decision 14): policy is decided by
// the Gateway with the same matcher as the hook, the network layers come from the provider's
// probe in the proxy, and the first failing layer is named. No model, nothing persisted.

import type {
  NetworkPreflightResult,
  NetworkProfile,
  SandboxHandle,
  Workspace,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setup(running = true) {
  h = await startHarness();
  const ws: Workspace = h.app.deskmates.ctx.workspaces.create({
    name: "tested",
    sandboxProvider: "docker",
    egressAllowlist: ["docs.example.org"],
  });
  if (running)
    h.provider.existing.set(ws.id, {
      workspaceId: ws.id,
      providerRef: `fake-${ws.id}`,
      sidecarAddress: "fake://sidecar",
    } as SandboxHandle);
  const profile = await h.api<{ profile: NetworkProfile }>("POST", "/api/network-profiles", {
    name: "lab",
    rules: [
      { kind: "subnet", cidr: "10.20.30.0/24", schemes: ["http"], ports: [23001] },
      {
        kind: "host",
        hostname: "console.lab.test",
        address: "10.20.36.35",
        schemes: ["https"],
        ports: [443],
      },
    ],
  });
  await h.api("PUT", `/api/workspaces/${ws.id}/network-profiles`, {
    selections: [{ profileId: profile.json.profile.id }],
  });
  const preflight = (url: string) =>
    (h as Harness).api<NetworkPreflightResult>(
      "POST",
      `/api/workspaces/${ws.id}/network-preflight`,
      { url },
    );
  return { harness: h, ws, preflight };
}

describe("network preflight (ADR-0027 amendment 1 decision 14)", () => {
  it("reports a policy denial without probing", async () => {
    const { harness, preflight } = await setup();
    for (const url of [
      "http://10.20.30.24:23002/",
      "https://10.20.30.24:23001/",
      "http://10.0.0.5/",
      "https://unlisted.example.org/",
      "ftp://10.20.30.24/",
    ]) {
      const res = await preflight(url);
      expect(res.status, url).toBe(200);
      expect(res.json).toMatchObject({ ok: false, failedLayer: "policy" });
    }
    expect(harness.provider.probes).toEqual([]);
  });

  it("probes a granted origin from the proxy, pinning a host rule's address", async () => {
    const { harness, preflight } = await setup();
    const lan = await preflight("http://10.20.30.24:23001/health");
    expect(lan.json).toMatchObject({ ok: true, admittedBy: "grant", status: 200 });
    expect(lan.json.layers.map((l) => l.layer)).toEqual(["policy", "tcp", "http"]);
    await preflight("https://console.lab.test/");
    await preflight("https://docs.example.org/");
    expect(harness.provider.probes).toEqual([
      { url: "http://10.20.30.24:23001/health", grant: true },
      { url: "https://console.lab.test/", grant: true, address: "10.20.36.35" },
      { url: "https://docs.example.org/", grant: false },
    ]);
  });

  it("names the failing network layer the probe reports", async () => {
    const { harness, preflight } = await setup();
    harness.provider.probeAnswer = {
      ok: false,
      layers: [{ layer: "tcp", ok: false, detail: "ECONNREFUSED" }],
    };
    const res = await preflight("http://10.20.30.24:23001/");
    expect(res.json).toMatchObject({ ok: false, failedLayer: "tcp", admittedBy: "grant" });
  });

  it("says when the workspace is not running instead of guessing", async () => {
    const { harness, preflight } = await setup(false);
    const res = await preflight("http://10.20.30.24:23001/");
    expect(res.json.ok).toBe(true);
    expect(res.json.layers[0]?.detail).toContain("not running");
    expect(harness.provider.probes).toEqual([]);
  });
});

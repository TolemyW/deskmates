// Isolated no-model T2: unique resources only; never a production volume.
import { randomUUID } from "node:crypto";
import type { SandboxHandle, SandboxSpec, WorkspaceId } from "@deskmates/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { DockerProvider, networkName } from "./docker-provider.js";

const image = "alpine:3.20";
const provider = new DockerProvider({
  egressProxyImage: process.env.EGRESS_PROXY_IMAGE ?? "deskmates/egress-proxy:dev",
  containerCommand: ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"],
});
let available = false;
try {
  available = (await provider.client.request("GET", "/_ping")).status === 200;
} catch {}

describe.skipIf(!available)("restart compatibility with real isolated volumes", () => {
  beforeAll(async () => {
    if ((await provider.client.request("GET", `/images/${image}/json`)).status === 200) return;
    const pulled = await provider.client.request(
      "POST",
      "/images/create?fromImage=alpine&tag=3.20",
    );
    expect(pulled.status).toBe(200);
  }, 120_000);

  it("leaves legacy profile and the running old process untouched, accepts current labels and recreates", async () => {
    const workspaceId = `t2-preflight-${randomUUID().slice(0, 8)}` as WorkspaceId;
    const volume = `deskmates-${workspaceId}-profile`;
    const otherVolume = `${volume}-unrelated`;
    const spec: SandboxSpec = {
      workspaceId,
      tenantId: "tnt_default",
      image,
      egressAllowlist: [],
      env: {},
      ports: [],
      volumes: { "/profile": volume },
    };
    let legacyId: string | undefined;
    let handle: SandboxHandle | undefined;
    let unrelated: SandboxHandle | undefined;
    const unrelatedVolume = `${otherVolume}-managed`;
    try {
      unrelated = await provider.create({
        ...spec,
        workspaceId: `${workspaceId}-other` as WorkspaceId,
        tenantId: "other-tenant",
        volumes: { "/profile": unrelatedVolume },
      });
      await provider.exec(unrelated, {
        cmd: ["sh", "-c", "printf unrelated-login > /profile/cookies"],
      });
      for (const name of [volume, otherVolume])
        await provider.client.expect("POST", "/volumes/create", { Name: name });
      const created = await provider.client.expect<{ Id: string }>("POST", "/containers/create", {
        Image: image,
        Cmd: ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"],
        HostConfig: { Binds: [`${volume}:/profile`] },
      });
      legacyId = created.json.Id;
      await provider.client.expect("POST", `/containers/${legacyId}/start`);
      const old: SandboxHandle = {
        workspaceId,
        providerRef: legacyId,
        sidecarAddress: `docker-exec://${legacyId}`,
      };
      await provider.exec(old, {
        cmd: [
          "sh",
          "-c",
          "printf login-sentinel > /profile/cookies; printf work-sentinel > /profile/file",
        ],
      });
      const calls: string[] = [];
      const request = provider.client.request.bind(provider.client);
      provider.client.request = async (...args) => {
        calls.push(args[0]);
        return request(...args);
      };
      await expect(provider.preflight(spec)).rejects.toMatchObject({
        details: { reason: "volume_ownership_mismatch", volume },
      });
      provider.client.request = request;
      expect(calls.every((method) => method === "GET")).toBe(true);
      const after = await provider.client.expect<{ State: { Running: boolean } }>(
        "GET",
        `/containers/${legacyId}/json`,
      );
      expect(after.json.State.Running).toBe(true);
      expect(
        (await provider.exec(old, { cmd: ["cat", "/profile/cookies", "/profile/file"] })).stdout,
      ).toBe("login-sentinelwork-sentinel");
      expect((await provider.client.request("GET", `/volumes/${otherVolume}`)).status).toBe(200);
      // Separate current-label fixture, without relabelling or adopting the legacy volume.
      const currentVolume = `${volume}-current`;
      let leftoverId: string | undefined;
      try {
        const current = { ...spec, volumes: { "/profile": currentVolume } };
        await provider.preflight(current);
        handle = await provider.create(current);
        await provider.exec(handle, {
          cmd: ["sh", "-c", "printf current-login > /profile/cookies"],
        });
        await provider.exec(handle, {
          cmd: [
            "sh",
            "-c",
            "mkdir -p /root/.pki/nssdb; printf synthetic-metadata-fixture > /root/.pki/nssdb/cert9.db",
          ],
        });
        const leftover = await provider.client.expect<{ Id: string }>(
          "POST",
          "/containers/create",
          {
            Image: image,
            Cmd: ["sleep", "infinity"],
            Labels: {
              "deskmates.workspace": workspaceId,
              "deskmates.managed": "true",
              "deskmates.role": "workspace",
              "deskmates.tenant": "tnt_default",
            },
            HostConfig: { NetworkMode: networkName(workspaceId) },
          },
        );
        leftoverId = leftover.json.Id;
        await provider.client.expect("POST", `/containers/${leftoverId}/start`);
        await provider.exec(
          { workspaceId, providerRef: leftoverId, sidecarAddress: `docker-exec://${leftoverId}` },
          { cmd: ["touch", "/tmp/nss-free-leftover-marker"] },
        );
        await provider.client.expect(
          "POST",
          `/containers/${leftoverId}/stop?t=2`,
          undefined,
          [204],
        );
        // Newer stopped, NSS-free leftover cannot shadow the actual running runtime's state.
        expect(await provider.inspectVolatilePrerequisites(current, handle.providerRef)).toEqual([
          {
            code: "volatile_nss_database",
            path: "/root/.pki/nssdb",
            sourceProviderRef: handle.providerRef,
          },
        ]);
        await provider.client.request("DELETE", `/containers/${leftoverId}?force=true`);
        leftoverId = undefined;
        await provider.preflight(current);
        await provider.destroy(handle);
        handle = await provider.create(current);
        expect((await provider.exec(handle, { cmd: ["cat", "/profile/cookies"] })).stdout).toBe(
          "current-login",
        );
        expect(
          (await provider.exec(handle, { cmd: ["test", "-f", "/root/.pki/nssdb/cert9.db"] }))
            .exitCode,
        ).not.toBe(0);
        expect((await provider.client.request("GET", `/volumes/${otherVolume}`)).status).toBe(200);
        expect((await provider.exec(unrelated, { cmd: ["cat", "/profile/cookies"] })).stdout).toBe(
          "unrelated-login",
        );
        expect((await provider.attach(unrelated.workspaceId, "other-tenant"))?.providerRef).toBe(
          unrelated.providerRef,
        );
      } finally {
        if (leftoverId)
          await provider.client.request("DELETE", `/containers/${leftoverId}?force=true`);
        if (handle) await provider.destroy(handle);
        await provider.client.request("DELETE", `/volumes/${currentVolume}`);
      }
    } finally {
      if (unrelated) await provider.destroy(unrelated);
      await provider.client.request("DELETE", `/volumes/${unrelatedVolume}`);
      if (legacyId) await provider.client.request("DELETE", `/containers/${legacyId}?force=true`);
      for (const name of [volume, otherVolume])
        await provider.client.request("DELETE", `/volumes/${name}`);
    }
  }, 60_000);
});

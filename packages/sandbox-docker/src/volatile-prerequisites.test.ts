import type { SandboxSpec, WorkspaceId } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import { DockerProvider } from "./docker-provider.js";

const spec: SandboxSpec = {
  workspaceId: "volatile-test" as WorkspaceId,
  tenantId: "tenant-a",
  image: "workspace:v2",
  env: {},
  egressAllowlist: [],
  ports: [],
  volumes: { "/home": "test-home", "/profile": "test-profile" },
};
function setup(changes: { Path: string; Kind: number }[] | null, tenant = "tenant-a") {
  const provider = new DockerProvider();
  const calls = vi.spyOn(provider.client, "expect").mockImplementation(async (method, path) => {
    expect(method).toBe("GET");
    if (path.startsWith("/containers/json"))
      return {
        status: 200,
        json: [
          {
            Id: "exact-owned-runtime",
            State: "running",
            Labels: {
              "deskmates.workspace": spec.workspaceId,
              "deskmates.managed": "true",
              "deskmates.role": "workspace",
              "deskmates.tenant": tenant,
            },
          },
        ],
      };
    expect(path).toBe("/containers/exact-owned-runtime/changes");
    return { status: 200, json: changes };
  });
  return { provider, calls };
}

describe("volatile prerequisite metadata inspection", () => {
  it("reports writable-layer NSS state without reading or copying database/certificate contents", async () => {
    const { provider, calls } = setup([{ Path: "/root/.pki/nssdb/cert9.db", Kind: 1 }]);
    expect(await provider.inspectVolatilePrerequisites(spec)).toEqual([
      {
        code: "volatile_nss_database",
        path: "/root/.pki/nssdb",
        sourceProviderRef: "exact-owned-runtime",
      },
    ]);
    expect(
      calls.mock.calls.every(
        ([method, path]) => method === "GET" && !path.includes("archive") && !path.includes("exec"),
      ),
    ).toBe(true);
  });
  it.each(
    [
      [],
      [{ Path: "/root/.pki/nssdb/cert9.db", Kind: 2 }],
      [{ Path: "/home/bot/.pki/nssdb/cert9.db", Kind: 1 }],
      [{ Path: "/root/private-key.pem", Kind: 1 }],
    ].map((changes) => ({ changes })),
  )(
    "does not classify absent/deleted or unrelated root state as temporary NSS: %j",
    async ({ changes }) => {
      expect(await setup(changes).provider.inspectVolatilePrerequisites(spec)).toEqual([]);
    },
  );
  it("accepts the Engine's successful null diff as an unchanged layer, not missing metadata", async () => {
    expect(await setup(null).provider.inspectVolatilePrerequisites(spec)).toEqual([]);
  });
  it("does not call a database volatile if the replacement spec keeps its enclosing volume", async () => {
    const { provider, calls } = setup([{ Path: "/root/.pki/nssdb/cert9.db", Kind: 1 }]);
    expect(
      await provider.inspectVolatilePrerequisites({
        ...spec,
        volumes: { "/root/.pki": "owned-nss" },
      }),
    ).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]?.[1]).toContain("/containers/json");
  });
  it("rejects another tenant before inspecting its filesystem metadata", async () => {
    const { provider, calls } = setup(
      [{ Path: "/root/.pki/nssdb/cert9.db", Kind: 1 }],
      "other-tenant",
    );
    await expect(provider.inspectVolatilePrerequisites(spec)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

it("inspects the running runtime after an NSS-free stopped leftover and all exact replacement candidates", async () => {
  const provider = new DockerProvider();
  const labels = {
    "deskmates.workspace": spec.workspaceId,
    "deskmates.managed": "true",
    "deskmates.role": "workspace",
    "deskmates.tenant": "tenant-a",
  };
  const calls = vi.spyOn(provider.client, "expect").mockImplementation(async (method, path) => {
    expect(method).toBe("GET");
    if (path.startsWith("/containers/json"))
      return {
        status: 200,
        json: [
          { Id: "stopped-leftover", State: "exited", Labels: labels },
          { Id: "actual-running-runtime", State: "running", Labels: labels },
          {
            Id: "proxy-runtime",
            State: "running",
            Labels: { ...labels, "deskmates.role": "egress-proxy" },
          },
          {
            Id: "unrelated-workspace",
            State: "running",
            Labels: { ...labels, "deskmates.workspace": "other" },
          },
        ],
      };
    return {
      status: 200,
      json:
        path === "/containers/actual-running-runtime/changes"
          ? [{ Path: "/root/.pki/nssdb/cert9.db", Kind: 1 }]
          : [],
    };
  });
  expect(await provider.inspectVolatilePrerequisites(spec, "actual-running-runtime")).toEqual([
    {
      code: "volatile_nss_database",
      path: "/root/.pki/nssdb",
      sourceProviderRef: "actual-running-runtime",
    },
  ]);
  expect(calls.mock.calls.slice(1).map(([, path]) => path)).toEqual([
    "/containers/stopped-leftover/changes",
    "/containers/actual-running-runtime/changes",
    "/containers/proxy-runtime/changes",
  ]);
});

it("fails closed if the cached handle to be destroyed exists outside the verified candidates", async () => {
  const { provider, calls } = setup([{ Path: "/root/.pki/nssdb/cert9.db", Kind: 1 }]);
  vi.spyOn(provider.client, "request").mockResolvedValue({
    status: 200,
    body: JSON.stringify({ Id: "missing-cached-target" }),
  });
  await expect(
    provider.inspectVolatilePrerequisites(spec, "missing-cached-target"),
  ).rejects.toMatchObject({ details: { reason: "replacement_target_unverified" } });
  expect(calls).toHaveBeenCalledTimes(1);
});

it("treats a cached handle whose container is gone as nothing volatile to preserve", async () => {
  // docker rm -f or a daemon restart removed the cached container: restart must still recover.
  const { provider } = setup([{ Path: "/root/.pki/nssdb/cert9.db", Kind: 1 }]);
  const request = vi
    .spyOn(provider.client, "request")
    .mockResolvedValue({ status: 404, body: "{}" });
  expect(await provider.inspectVolatilePrerequisites(spec, "vanished-cached-target")).toEqual([
    {
      code: "volatile_nss_database",
      path: "/root/.pki/nssdb",
      sourceProviderRef: "exact-owned-runtime",
    },
  ]);
  expect(request).toHaveBeenCalledWith("GET", "/containers/vanished-cached-target/json");
});

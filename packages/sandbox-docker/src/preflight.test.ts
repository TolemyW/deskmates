import type { SandboxSpec, WorkspaceId } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import { DockerProvider } from "./docker-provider.js";

const spec: SandboxSpec = {
  workspaceId: "preflight" as WorkspaceId,
  tenantId: "tenant-a",
  image: "workspace:v2",
  egressAllowlist: [],
  env: {},
  ports: [],
  volumes: { "/profile": "deskmates-preflight-profile", "/work": "deskmates-preflight-work" },
};
const labels = {
  "deskmates.managed": "true",
  "deskmates.workspace": "preflight",
  "deskmates.tenant": "tenant-a",
};

function setup(volumeLabels: Record<string, string> | undefined = labels, missingImage = false) {
  const provider = new DockerProvider();
  const request = vi.spyOn(provider.client, "request").mockImplementation(async (method, path) => {
    expect(method).toBe("GET");
    if (path.startsWith("/volumes/"))
      return {
        status: 200,
        body: JSON.stringify({ Name: decodeURIComponent(path.slice(9)), Labels: volumeLabels }),
      };
    if (path.startsWith("/images/"))
      return { status: missingImage ? 404 : 200, body: JSON.stringify({ Id: "sha256:present" }) };
    return { status: 404, body: "" };
  });
  const containers = vi
    .spyOn(provider.client, "expect")
    .mockResolvedValue({ status: 200, json: [] });
  return { provider, request, containers };
}

describe("read-only replacement preflight", () => {
  it.each([
    {},
    { ...labels, "deskmates.tenant": "foreign" },
    { ...labels, "deskmates.workspace": "other" },
  ])("rejects legacy/foreign volumes without any write: %j", async (bad) => {
    const { provider, request, containers } = setup(bad);
    await expect(provider.preflight(spec)).rejects.toMatchObject({
      code: "sandbox_unavailable",
      details: { reason: "volume_ownership_mismatch", volume: "deskmates-preflight-profile" },
    });
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    expect(containers).not.toHaveBeenCalled();
  });
  it("accepts owned volumes using inspection only, and never inspects unrelated workspace resources", async () => {
    const { provider, request, containers } = setup();
    await provider.preflight(spec);
    expect(
      request.mock.calls.filter(([, path]) => path.startsWith("/volumes/")).map(([, path]) => path),
    ).toEqual(["/volumes/deskmates-preflight-profile", "/volumes/deskmates-preflight-work"]);
    expect(decodeURIComponent(containers.mock.calls[0]?.[1] ?? "")).toContain(
      "^/?deskmates-ws-preflight$",
    );
  });
  it("rejects a foreign leftover selected for stale removal, even outside canonical names", async () => {
    const { provider, containers, request } = setup();
    containers.mockResolvedValueOnce({ status: 200, json: [] }).mockResolvedValueOnce({
      status: 200,
      json: [
        {
          Id: "leftover",
          State: "exited",
          Labels: {
            ...labels,
            "deskmates.role": "workspace",
            "deskmates.tenant": "foreign",
          },
        },
      ],
    });
    await expect(provider.preflight(spec)).rejects.toMatchObject({
      code: "sandbox_unavailable",
      details: { reason: "network_mismatch" },
    });
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });

  it("checks both image prerequisites without pulling or modifying resources", async () => {
    const { provider } = setup(labels, true);
    await expect(provider.preflight(spec)).rejects.toMatchObject({
      details: { reason: "image_missing" },
    });
  });
  it("rejects invalid configuration before reading the daemon", async () => {
    const { provider, request } = setup();
    await expect(provider.preflight({ ...spec, cpuLimit: -1 })).rejects.toMatchObject({
      code: "validation",
    });
    expect(request).not.toHaveBeenCalled();
  });
});

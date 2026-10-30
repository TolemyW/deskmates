import { DeskmatesError, type SandboxHandle, type WorkspaceId } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import { DockerProvider, MANAGED_LABEL, ROLE_LABEL, WORKSPACE_LABEL } from "./docker-provider.js";

const handle: SandboxHandle = {
  workspaceId: "presence-workspace" as WorkspaceId,
  providerRef: "exact-container",
  sidecarAddress: "docker-exec://exact-container",
};

function setup() {
  const provider = new DockerProvider({
    endpoint: { kind: "unix", socketPath: "/unused-presence-test.sock" },
  });
  const request = vi.spyOn(provider.client, "request");
  return { provider, request };
}

describe("cached Docker sandbox presence is a read-only observation", () => {
  it.each([true, false])("reports an existing container present, running=%s", async (running) => {
    const { provider, request } = setup();
    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        Id: handle.providerRef,
        State: { Running: running },
        Config: {
          Labels: {
            [MANAGED_LABEL]: "true",
            [WORKSPACE_LABEL]: handle.workspaceId,
            [ROLE_LABEL]: "workspace",
          },
        },
      }),
    });
    expect(await provider.isPresent(handle)).toBe(true);
    expect(request.mock.calls).toEqual([["GET", "/containers/exact-container/json"]]);
  });

  it("reports absence only on 404", async () => {
    const { provider, request } = setup();
    request.mockResolvedValue({ status: 404, body: "No such container" });
    expect(await provider.isPresent(handle)).toBe(false);
    expect(request.mock.calls).toEqual([["GET", "/containers/exact-container/json"]]);
  });

  it.each([403, 500, 503])("does not mistake HTTP %s for absence", async (status) => {
    const { provider, request } = setup();
    request.mockResolvedValue({ status, body: "inspection unavailable" });
    await expect(provider.isPresent(handle)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("propagates daemon transport failure without reporting absence", async () => {
    const { provider, request } = setup();
    const failure = new DeskmatesError("sandbox_unavailable", "daemon unavailable");
    request.mockRejectedValue(failure);
    await expect(provider.isPresent(handle)).rejects.toBe(failure);
  });

  it("rejects malformed inspection JSON instead of reporting absence", async () => {
    const { provider, request } = setup();
    request.mockResolvedValue({ status: 200, body: "not JSON" });
    await expect(provider.isPresent(handle)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("refuses mismatched workspace ownership without lifecycle mutations", async () => {
    const { provider, request } = setup();
    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        Config: {
          Labels: {
            [MANAGED_LABEL]: "true",
            [WORKSPACE_LABEL]: "another-workspace",
            [ROLE_LABEL]: "workspace",
          },
        },
      }),
    });
    await expect(provider.isPresent(handle)).rejects.toMatchObject({
      code: "sandbox_unavailable",
      details: { reason: "network_mismatch" },
    });
    expect(request.mock.calls).toEqual([["GET", "/containers/exact-container/json"]]);
  });
});

// T0 (ADR-0048 decision 11): the provider reads an image's labels with one inspect and never
// pulls; a missing image is `image_missing`, an image without labels has none.

import { describe, expect, it } from "vitest";
import type { DockerClient } from "./docker-client.js";
import { DockerProvider } from "./docker-provider.js";

function providerAnswering(answer: (path: string) => { status: number; body: string }) {
  const provider = new DockerProvider({
    endpoint: { kind: "unix", socketPath: "/nonexistent/docker.sock" },
  });
  const calls: string[] = [];
  const request = async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    return answer(path);
  };
  Object.assign(provider.client, { request } as unknown as Partial<DockerClient>);
  return { provider, calls };
}

describe("DockerProvider.imageLabels", () => {
  it("returns the image's labels from one inspect", async () => {
    const { provider, calls } = providerAnswering(() => ({
      status: 200,
      body: JSON.stringify({
        Id: "sha256:abc",
        Config: { Labels: { "org.deskmates.capabilities": "desktop-lcu-v1" } },
      }),
    }));
    expect(await provider.imageLabels("deskmates/workspace-desktop:amd64-0123456789ab")).toEqual({
      "org.deskmates.capabilities": "desktop-lcu-v1",
    });
    expect(calls).toEqual(["GET /images/deskmates%2Fworkspace-desktop%3Aamd64-0123456789ab/json"]);
  });

  it("has no labels for an image without any, and refuses a missing image", async () => {
    const empty = providerAnswering(() => ({
      status: 200,
      body: JSON.stringify({ Id: "x", Config: { Labels: null } }),
    }));
    expect(await empty.provider.imageLabels("deskmates/workspace:dev")).toEqual({});
    const missing = providerAnswering(() => ({ status: 404, body: "{}" }));
    await expect(missing.provider.imageLabels("nope")).rejects.toMatchObject({
      code: "sandbox_unavailable",
      details: { reason: "image_missing" },
    });
  });
});

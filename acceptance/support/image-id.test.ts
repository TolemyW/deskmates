import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DockerProvider } from "@deskmates/sandbox-docker";
import { describe, expect, it, vi } from "vitest";
import { ensureWorkspaceImage } from "./docker.js";
import { IMAGE_ID_PATTERN, isImageId, requireImageId } from "./image-id.mjs";

const VALID = `sha256:${"0123456789abcdef".repeat(4)}`;
const CLI = fileURLToPath(new URL("./image-id.mjs", import.meta.url));

describe("image ID predicate", () => {
  it("accepts a full Docker image ID", () => {
    expect(isImageId(VALID)).toBe(true);
    expect(IMAGE_ID_PATTERN.test(VALID)).toBe(true);
    expect(requireImageId(VALID, "WORKSPACE_IMAGE")).toBe(VALID);
  });

  it.each([
    ["uppercase hex", `sha256:${"0123456789ABCDEF".repeat(4)}`],
    ["short hex", "sha256:0123456789ab"],
    ["sha256 prefix on a tag", `sha256:${"a".repeat(64)}:latest`],
    ["m2-live tag", "deskmates/workspace:m2-live-x"],
    ["content-addressed tag", "deskmates/workspace:amd64-0123456789ab"],
    ["empty", ""],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isImageId(value)).toBe(false);
    expect(() => requireImageId(value, "WORKSPACE_IMAGE")).toThrow(
      /WORKSPACE_IMAGE must be pinned by Docker image ID/,
    );
  });

  it("names the variable and the offending value", () => {
    expect(() => requireImageId("deskmates/workspace:dev", "--image")).toThrow(
      '--image must be pinned by Docker image ID (sha256:<64 hex>), got "deskmates/workspace:dev"',
    );
  });

  it("CLI exits 0 silently for an ID and 2 with a message otherwise", () => {
    const ok = spawnSync(process.execPath, [CLI, VALID, "WORKSPACE_IMAGE"], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("");
    expect(ok.stderr).toBe("");

    const bad = spawnSync(
      process.execPath,
      [CLI, "deskmates/workspace:m2-live-x", "WORKSPACE_IMAGE"],
      {
        encoding: "utf8",
      },
    );
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/WORKSPACE_IMAGE must be pinned by Docker image ID/);

    const missing = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
    expect(missing.status).toBe(2);
  });
});

describe("ensureWorkspaceImage", () => {
  it("fails closed instead of building when a requested image ID is absent", async () => {
    // Only `client.request` is reached before the ID check throws; a full DockerProvider would
    // need a daemon, which a T0 test must not.
    const docker = {
      client: { request: async () => ({ status: 404 }) },
    } as unknown as DockerProvider;
    await expect(ensureWorkspaceImage(docker, VALID)).rejects.toThrow(VALID);
  });

  it("refuses to rebuild a pinned image ID even when it is present", async () => {
    const docker = {
      client: { request: async () => ({ status: 200 }) },
    } as unknown as DockerProvider;
    vi.stubEnv("DESKMATES_REBUILD_WORKSPACE_IMAGE", "1");
    try {
      await expect(ensureWorkspaceImage(docker, VALID)).rejects.toThrow(/cannot rebuild/);
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(ensureWorkspaceImage(docker, VALID)).resolves.toBeUndefined();
  });
});

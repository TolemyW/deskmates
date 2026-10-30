import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageInputs, imageTag, inputHash, normalizeArch, sourceInputs } from "./image-tag.mjs";

let root;
const put = (rel, body) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "image-tag-"));
  put(".dockerignore", "*\n");
  put("images/workspace/Dockerfile", "FROM x\nARG A=1\n");
  put("images/workspace/entry.sh", "#!/bin/sh\n");
  put("images/egress/Dockerfile", "FROM y\n");
  put("images/workspace-base/Dockerfile", "FROM playwright\nARG SDK=1\n");
  for (const pkg of ["contracts", "sidecar"]) {
    put(`packages/${pkg}/package.json`, "{}");
    put(`packages/${pkg}/dist/index.js`, `export const ${pkg} = 1;\n`);
  }
  put("packages/gateway/starter-skills/manifest.json", "{}");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("image inputs", () => {
  it("covers exactly the files the workspace build reads", () => {
    put("packages/sidecar/dist/index.test.js", "test");
    put("packages/sidecar/dist/index.js.map", "map");
    put("packages/sidecar/dist/tsconfig.tsbuildinfo", "info");
    put("packages/sidecar/src/index.ts", "source is not copied");
    put("packages/gateway/dist/index.js", "not in the image");
    expect(imageInputs(root, "workspace")).toEqual([
      ".dockerignore",
      "images/workspace/Dockerfile",
      "images/workspace/entry.sh",
      "packages/contracts/dist/index.js",
      "packages/contracts/package.json",
      "packages/gateway/starter-skills/manifest.json",
      "packages/sidecar/dist/index.js",
      "packages/sidecar/package.json",
    ]);
    expect(imageInputs(root, "egress")).toEqual(["images/egress/Dockerfile"]);
  });

  it("covers the connector image's inputs without tests or test support", () => {
    put("images/connector-postgres/Dockerfile", "FROM node\n");
    put("package.json", "{}");
    put("package-lock.json", "{}");
    for (const pkg of [
      "channels",
      "gateway",
      "golden-site",
      "observability-dashboards",
      "sandbox-docker",
      "testkit",
      "web",
    ])
      put(`packages/${pkg}/package.json`, "{}");
    put("packages/channels/deskmates-agent-mcp/package.json", "{}");
    put("packages/connector-postgres/package.json", "{}");
    put("packages/connector-postgres/dist/index.js", "main");
    put("packages/connector-postgres/dist/service.test.js", "test");
    put("packages/connector-postgres/dist/test-support/fake-sql.js", "fake");
    put("packages/connector-postgres/migrations/0001-receipts.sql", "sql");
    const inputs = imageInputs(root, "connector-postgres");
    expect(inputs).toContain("packages/connector-postgres/dist/index.js");
    expect(inputs).toContain("packages/connector-postgres/migrations/0001-receipts.sql");
    expect(inputs).toContain("packages/contracts/dist/index.js");
    expect(inputs.filter((p) => p.includes("test"))).toEqual(["packages/testkit/package.json"]);
    expect(imageInputs(root, "workspace")).not.toContain(
      "packages/connector-postgres/dist/index.js",
    );
    expect(imageTag("connector-postgres", "arm64", "0123456789ab")).toBe(
      "deskmates/connector-postgres:arm64-0123456789ab",
    );
  });

  it("fails when dist/ has not been built", () => {
    rmSync(join(root, "packages/sidecar/dist"), { recursive: true });
    expect(() => imageInputs(root, "workspace")).toThrow(/packages\/sidecar\/dist is missing/);
  });
});

describe("input hash", () => {
  it("is stable for the same tree and ignores excluded files", () => {
    const before = inputHash(root, "workspace");
    expect(before).toMatch(/^[0-9a-f]{12}$/);
    put("packages/sidecar/dist/index.test.js", "tests do not change the image");
    expect(inputHash(root, "workspace")).toBe(before);
  });

  it("changes with content, with an ARG default and with the executable bit", () => {
    const base = inputHash(root, "workspace");
    put("packages/sidecar/dist/index.js", "export const sidecar = 2;\n");
    const content = inputHash(root, "workspace");
    expect(content).not.toBe(base);
    put("images/workspace/Dockerfile", "FROM x\nARG A=2\n");
    const arg = inputHash(root, "workspace");
    expect(arg).not.toBe(content);
    chmodSync(join(root, "images/workspace/entry.sh"), 0o755);
    expect(inputHash(root, "workspace")).not.toBe(arg);
  });

  it("moves the workspace hash with the base, and the base hash only with its own files", () => {
    const base = inputHash(root, "base");
    const workspace = inputHash(root, "workspace");
    put("packages/sidecar/dist/index.js", "an app-only change");
    expect(inputHash(root, "base")).toBe(base);
    const appChanged = inputHash(root, "workspace");
    expect(appChanged).not.toBe(workspace);
    put("images/workspace-base/Dockerfile", "FROM playwright\nARG SDK=2\n");
    expect(inputHash(root, "base")).not.toBe(base);
    expect(inputHash(root, "workspace")).not.toBe(appChanged);
    expect(imageInputs(root, "base")).toEqual(["images/workspace-base/Dockerfile"]);
  });

  it("hashes the Grafana image from images/grafana alone, not the provisioning it mounts", () => {
    put("images/grafana/Dockerfile", "FROM grafana\n");
    put("observability/grafana/sqlite/dashboards/agent-runs.json", "{}");
    expect(imageInputs(root, "grafana")).toEqual(["images/grafana/Dockerfile"]);
    const grafana = inputHash(root, "grafana");
    put("observability/grafana/sqlite/dashboards/agent-runs.json", '{"changed":true}');
    put("packages/sidecar/dist/index.js", "changed");
    expect(inputHash(root, "grafana")).toBe(grafana);
    put("images/grafana/Dockerfile", "FROM grafana\nARG SQLITE_DATASOURCE_VERSION=2\n");
    expect(inputHash(root, "grafana")).not.toBe(grafana);
    expect(imageTag("grafana", "amd64", "0123456789ab")).toBe(
      "deskmates/grafana:amd64-0123456789ab",
    );
    expect(sourceInputs("grafana")).toEqual(["images/grafana"]);
  });

  it("keeps the egress hash independent of the sidecar", () => {
    const egress = inputHash(root, "egress");
    put("packages/sidecar/dist/index.js", "changed");
    expect(inputHash(root, "egress")).toBe(egress);
  });
});

describe("tag", () => {
  it("names the architecture so colima and native Linux builds never share a tag", () => {
    expect(imageTag("workspace", "x64", "0123456789ab")).toBe(
      "deskmates/workspace:amd64-0123456789ab",
    );
    expect(imageTag("egress", "aarch64", "0123456789ab")).toBe(
      "deskmates/egress-proxy:arm64-0123456789ab",
    );
    expect(() => normalizeArch("riscv64")).toThrow(/unsupported/);
  });
});

describe("source inputs", () => {
  it("names what the workspace's built inputs compile from, its base, and the toolchain", () => {
    expect(sourceInputs("workspace")).toEqual([
      ".dockerignore",
      "images/workspace",
      "images/workspace-base",
      "package-lock.json",
      "package.json",
      "packages/contracts",
      "packages/gateway/starter-skills",
      "packages/sidecar",
      "packages/testkit",
      "tsconfig.base.json",
    ]);
  });

  it("is the inputs themselves for an image built only from checked-in files", () => {
    expect(sourceInputs("base")).toEqual(["images/workspace-base"]);
    expect(sourceInputs("egress")).toEqual(["images/egress"]);
  });

  it("covers every file the workspace hash reads", () => {
    const roots = sourceInputs("workspace");
    for (const file of [...imageInputs(root, "workspace"), ...imageInputs(root, "base")])
      expect(
        roots.some((r) => file === r || file.startsWith(`${r}/`)),
        file,
      ).toBe(true);
  });
});

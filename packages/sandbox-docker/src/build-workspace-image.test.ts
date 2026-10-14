// T0: scripts/build-workspace-image.sh, the script workspace-image.container.test.ts shells out
// to. `npm` and `docker` are replaced by stubs on PATH, so this needs neither a daemon nor a real
// TypeScript build; what is under test is the script's control flow, not what it builds.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "build-workspace-image.sh");

function stubBin(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A PATH where `npm` and `docker` are stubs; `docker` records that it ran. */
function sandboxPath(npmBody: string): { dir: string; marker: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "deskmates-build-script-"));
  const marker = join(dir, "docker-ran");
  stubBin(dir, "npm", npmBody);
  stubBin(dir, "docker", `echo "$@" > "${marker}"; exit 0`);
  return {
    dir,
    marker,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      WORKSPACE_IMAGE: "deskmates/workspace:script-unit-test",
    },
  };
}

describe("scripts/build-workspace-image.sh", () => {
  it("refuses to build an image when the contracts/sidecar build fails", () => {
    // Before the fix this printed a warning and carried on, baking whatever stale dist/ happened
    // to be on disk into the image: the container then ran code nobody compiled from this tree.
    const { marker, env } = sandboxPath('echo "src/run-once.ts(1,1): error TS2322" >&2; exit 2');
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing to bake a stale dist/);
    expect(existsSync(marker), "docker build must not have run").toBe(false);
  });

  it("builds the image when the build succeeds", () => {
    const { marker, env } = sandboxPath("exit 0");
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(r.stdout).toContain("built deskmates/workspace:script-unit-test");
  });

  it("SKIP_SIDECAR_BUILD=1 still skips the build entirely", () => {
    const { marker, env } = sandboxPath('echo "npm must not run" >&2; exit 7');
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...env, SKIP_SIDECAR_BUILD: "1" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
});

describe("scripts/build-workspace-image.sh without WORKSPACE_IMAGE", () => {
  /**
   * A throwaway repo root holding the two scripts and fake build inputs, so the content-addressed
   * tags are computed without a real `tsc -b`. `docker` logs every call; `image inspect` answers
   * 0 for refs matching `present` (an ERE) and 1 otherwise.
   */
  function fakeRoot(present: string, extraEnv: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), "deskmates-build-tag-"));
    const put = (rel: string, body: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    for (const name of ["build-workspace-image.sh", "image-tag.mjs"]) {
      put(`scripts/${name}`, readFileSync(join(REPO_ROOT, "scripts", name), "utf8"));
    }
    put(".dockerignore", "*\n");
    put("images/workspace/Dockerfile", "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n");
    put("images/workspace-base/Dockerfile", "FROM scratch\n");
    for (const pkg of ["contracts", "sidecar"]) {
      put(`packages/${pkg}/package.json`, "{}");
      put(`packages/${pkg}/dist/index.js`, "");
    }
    put("packages/gateway/starter-skills/manifest.json", "{}");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "docker.log");
    stubBin(bin, "npm", "exit 0");
    stubBin(
      bin,
      "docker",
      [
        `echo "$@" >> "${log}"`,
        `if [ "$1 $2" = "image inspect" ]; then`,
        `  for a in "$@"; do :; done`,
        `  echo "$a" | grep -Eq '${present}' && exit 0 || exit 1`,
        "fi",
        "exit 0",
      ].join("\n"),
    );
    const { WORKSPACE_IMAGE: _w, BASE_IMAGE: _b, NO_BASE_BUILD: _n, ...rest } = process.env;
    const env = {
      ...rest,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      IMAGE_ARCH: "amd64",
      ...extraEnv,
    };
    const run = () =>
      spawnSync("bash", [join(root, "scripts", "build-workspace-image.sh")], {
        encoding: "utf8",
        env,
      });
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
    const builds = () => calls().filter((c) => c.startsWith("build "));
    return { run, calls, builds };
  }

  it("builds a missing base, then the app layer FROM it, and moves both dev aliases", () => {
    const { run, calls, builds } = fakeRoot("^$");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const base = /deskmates\/workspace-base:amd64-[0-9a-f]{12}/.exec(builds()[0] ?? "")?.[0];
    const tag = /built (deskmates\/workspace:amd64-[0-9a-f]{12})/.exec(r.stdout)?.[1];
    expect(base).toBeDefined();
    expect(tag).toBeDefined();
    expect(builds()).toHaveLength(2);
    expect(builds()[0]).toContain("-f images/workspace-base/Dockerfile");
    expect(builds()[0]).toMatch(/ images\/workspace-base$/);
    expect(builds()[1]).toContain(`--build-arg BASE_IMAGE=${base}`);
    expect(builds()[1]).toContain(`-t ${tag}`);
    expect(calls()).toContain(`tag ${base} deskmates/workspace-base:dev`);
    expect(calls()).toContain(`tag ${tag} deskmates/workspace:dev`);
  });

  it("with the base present, builds only the offline app layer", () => {
    const { run, builds } = fakeRoot("workspace-base");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("reusing base deskmates/workspace-base:amd64-");
    expect(builds()).toHaveLength(1);
    expect(builds()[0]).toContain("-f images/workspace/Dockerfile");
  });

  it("reuses existing tags without building anything", () => {
    const { run, builds } = fakeRoot(".");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("reusing deskmates/workspace:amd64-");
    expect(builds()).toHaveLength(0);
  });

  it("NO_BASE_BUILD=1 refuses to build a missing base, and builds nothing", () => {
    const { run, builds } = fakeRoot("^$", { NO_BASE_BUILD: "1" });
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(
      /base image deskmates\/workspace-base:amd64-[0-9a-f]{12} is not on this host/,
    );
    expect(builds()).toHaveLength(0);
  });

  it("BASE_IMAGE pins the base by reference and never builds one", () => {
    const pinned = `sha256:${"b".repeat(64)}`;
    const { run, builds } = fakeRoot(`^${pinned}$`, { BASE_IMAGE: pinned });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(builds()).toHaveLength(1);
    expect(builds()[0]).toContain(`--build-arg BASE_IMAGE=${pinned}`);
  });
});

describe(".dockerignore for the workspace build context", () => {
  it("keeps compiled tests out of the image", () => {
    // `tsc -b` emits *.test.js next to the code it tests, so packages/sidecar/dist carries the
    // whole T0 suite. The container runs none of it. The image-side proof that the patterns work
    // is in workspace-image.container.test.ts; this one pins the intent cheaply.
    const patterns = new Set(
      spawnSync("cat", [join(REPO_ROOT, ".dockerignore")], { encoding: "utf8" })
        .stdout.split("\n")
        .map((l) => l.trim()),
    );
    expect(patterns.has("**/*.test.js")).toBe(true);
    expect(patterns.has("**/*.test.d.ts")).toBe(true);
    // *.test.js.map is covered by the pre-existing **/*.map line.
    expect(patterns.has("**/*.map")).toBe(true);
  });
});

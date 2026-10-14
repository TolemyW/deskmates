// T0: scripts/stable/stable.sh control flow. systemctl, journalctl, loginctl, docker, npm and
// curl are stubs on PATH that keep their state in files, so this needs no daemon, no systemd and
// no network. What is under test is the order of operations: T2 gating, draining, the database
// backup, the switch, the health check and the rollback that restores the database.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageTag, inputHash } from "../image-tag.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let home;
let root;
let state;
let bin;

function stub(name, body) {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Paths in the real acceptance/t2-smoke.list, in its order. */
const SMOKE_FILES = readFileSync(join(REPO, "acceptance", "t2-smoke.list"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));
const FULL_ONLY_FILE = "packages/sandbox-docker/src/docker-provider.container.test.ts";

/** The base image the release workflow built; the docker stub knows it only by this ID. */
const BASE_ID = `sha256:${"b".repeat(64)}`;
const REUSED_BASE_ID = `sha256:${"a".repeat(64)}`;

/**
 * A release directory as ship.sh leaves it: source (the real scripts, fake image inputs and a
 * version-specific sidecar dist), manifest, nothing installed.
 */
function shipRelease(version, { baseTag } = {}) {
  const rel = join(root, "releases", version);
  const put = (path, body) => {
    mkdirSync(dirname(join(rel, path)), { recursive: true });
    writeFileSync(join(rel, path), body);
  };
  for (const script of [
    "stable/stable.sh",
    "image-tag.mjs",
    "build-workspace-image.sh",
    "build-egress-image.sh",
    "write-channel-plugin-manifest.mjs",
  ]) {
    mkdirSync(dirname(join(rel, "scripts", script)), { recursive: true });
    cpSync(join(REPO, "scripts", script), join(rel, "scripts", script));
  }
  cpSync(join(REPO, ".env.example"), join(rel, ".env.example"));
  // T2 scope: the real smoke list, its files as empty stand-ins, one full-only file, and a
  // container-test name under node_modules that the full list must not pick up.
  put("acceptance/t2-smoke.list", readFileSync(join(REPO, "acceptance", "t2-smoke.list"), "utf8"));
  for (const file of [...SMOKE_FILES, FULL_ONLY_FILE]) put(file, "");
  put("packages/sidecar/node_modules/dep/ignored.container.test.ts", "");
  put(".dockerignore", "*\n");
  put("images/workspace-base/Dockerfile", "FROM playwright\n");
  put("images/workspace/Dockerfile", "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n");
  put("images/egress/Dockerfile", "FROM node\n");
  for (const pkg of ["contracts", "sidecar"]) {
    put(`packages/${pkg}/package.json`, "{}");
    put(`packages/${pkg}/dist/index.js`, `export const release = "${version}";\n`);
  }
  // A shipped release is a clean git archive: channel dist and its manifest do not exist until
  // stable install runs the package build.
  put("packages/channels/package.json", '{"name":"@deskmates/channels"}\n');
  put("packages/gateway/starter-skills/manifest.json", "{}");
  const contentTag = baseTag ?? imageTag("base", "amd64", inputHash(rel, "base"));
  writeFileSync(
    join(rel, "release-manifest.json"),
    JSON.stringify({
      schema: 2,
      version,
      revision: "0".repeat(40),
      base: {
        contentTag,
        ref: `ghcr.io/owner/deskmates-workspace-base@sha256:${"c".repeat(64)}`,
        digest: `sha256:${"c".repeat(64)}`,
        imageId: BASE_ID,
      },
    }),
  );
  return rel;
}

/** Image ID the docker stub gave a tag, or undefined. */
function imageIdOf(ref) {
  const path = join(state, "images", ref.replace(/[/:@]/g, "_"));
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

function run(version, ...args) {
  const script = join(root, "releases", version, "scripts", "stable", "stable.sh");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    USER: "tester",
    DESKMATES_STABLE_ROOT: root,
    STATE: state,
    ...Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => a.split("="))),
  };
  return spawnSync("bash", [script, ...args.filter((a) => !a.includes("="))], {
    encoding: "utf8",
    env,
  });
}

const db = () => join(root, "shared", "data", "gateway.sqlite");
const current = () => readlinkSync(join(root, "current"));
const releaseEnv = () => readFileSync(join(root, "shared", "release.env"), "utf8");

function fillModelEnv() {
  const path = join(root, "shared", ".env");
  const text = readFileSync(path, "utf8")
    .replace(/^MODEL_BASE_URL=.*$/m, "MODEL_BASE_URL=http://model.invalid")
    .replace(/^MODEL_AUTH_TOKEN=.*$/m, "MODEL_AUTH_TOKEN=t")
    .replace(/^DEFAULT_MODEL=.*$/m, "DEFAULT_MODEL=m")
    .replace(/^CHEAP_MODEL=.*$/m, "CHEAP_MODEL=c");
  writeFileSync(path, text);
}

/** install + verify + activate, each asserted to succeed. */
function release(version) {
  shipRelease(version);
  for (const cmd of ["install", "verify", "activate"]) {
    const r = run(version, cmd, version);
    expect(r.status, `${cmd} ${version}\n${r.stdout}\n${r.stderr}`).toBe(0);
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "stable-sh-"));
  root = join(home, "Data", "deskmates-stable");
  state = join(home, "state");
  bin = join(home, "bin");
  mkdirSync(state, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(state, "active-runs"), "0");
  // systemd: "start" marks the unit active; a started Gateway writes to its database the way the
  // real one would, so a rollback that forgets to restore the backup is visible.
  stub(
    "systemctl",
    `args="$*"
case "$args" in
  *is-active*) [ -f "$STATE/unit-active" ] ;;
  *" stop "*) rm -f "$STATE/unit-active" ;;
  *" start "*) touch "$STATE/unit-active"; echo "$STATE" >/dev/null;
    rel=$(grep '^DESKMATES_RELEASE=' "$DESKMATES_STABLE_ROOT/shared/release.env" | cut -d= -f2)
    mkdir -p "$DESKMATES_STABLE_ROOT/shared/data"
    echo "written by $rel" >> "$DESKMATES_STABLE_ROOT/shared/data/gateway.sqlite" ;;
  *) exit 0 ;;
esac`,
  );
  stub("journalctl", "exit 0");
  stub("loginctl", "echo yes");
  stub(
    "npm",
    [
      'echo "$*" >> "$STATE/npm-args"',
      'if [ "$1" = run ] && [ "$2" = build ] && [ "$3" = -w ] && [ "$4" = packages/channels ]; then',
      "  mkdir -p packages/channels/dist/whatsapp",
      `  printf '%s\\n' 'import "./runtime.js"; export const channelPlugin = { manifest: { id: "whatsapp", version: "1.0.0", apiVersion: 1 } };' > packages/channels/dist/whatsapp/plugin.js`,
      `  printf '%s\\n' 'export const runtime = true;' > packages/channels/dist/whatsapp/runtime.js`,
      "  node scripts/write-channel-plugin-manifest.mjs packages/channels/dist",
      "  exit $?",
      "fi",
      'if [ "$1" = run ] && { [ "$2" = test:container ] || [ "$2" = test:container:smoke ]; }; then',
      '  env | grep -E "^(EGRESS_PROXY_|MODEL_)" > "$STATE/t2-env"; echo "$*" > "$STATE/t2-args"; echo "$DESKMATES_T2_PUBLIC_HOST" > "$STATE/t2-public-host"',
      '  [ ! -f "$STATE/t2-fails" ]',
      "else exit 0; fi",
    ].join("\n"),
  );
  // docker: images are files under $STATE/images named by ref (tag or ID) holding the image ID.
  // `build -t T` creates T with an ID derived from T; `tag` copies; nothing is ever pulled.
  stub(
    "docker",
    `imgs="$STATE/images"; mkdir -p "$imgs"
key() { printf '%s' "$1" | tr '/:@' '___'; }
case "$1 $2" in
  "info "*) exit 0 ;;
  "image inspect") f="$imgs/$(key "\${@: -1}")"; [ -f "$f" ] || exit 1; cat "$f" ;;
  "tag "*) f="$imgs/$(key "$2")"; [ -f "$f" ] || exit 1; cp "$f" "$imgs/$(key "$3")" ;;
  "build "*)
    t=""; prev=""; for a in "$@"; do [ "$prev" = "-t" ] && t="$a"; prev="$a"; done
    id="sha256:$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$t")"
    echo "$id" > "$imgs/$(key "$t")"; echo "$id" > "$imgs/$(key "$id")" ;;
  "pull "*|"load "*) echo "pull and load are not expected here" >&2; exit 9 ;;
  *) exit 0 ;;
esac`,
  );
  mkdirSync(join(state, "images"));
  writeFileSync(join(state, "images", BASE_ID.replace(/[/:@]/g, "_")), `${BASE_ID}\n`);
  stub(
    "curl",
    `url="\${@: -1}"
[ -f "$STATE/unit-active" ] || exit 7
rel=$(grep '^DESKMATES_RELEASE=' "$DESKMATES_STABLE_ROOT/shared/release.env" | cut -d= -f2)
case "$url" in
  */healthz) echo ok ;;
  */api/config) [ -f "$STATE/broken-$rel" ] && echo '{"release":null}' || echo "{\\"release\\":\\"$rel\\"}" ;;
  */api/runtime) echo "{\\"activeRuns\\":$(cat "$STATE/active-runs")}" ;;
  *) exit 22 ;;
esac`,
  );
  stub("openssl", 'echo "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MTI="');
  shipRelease("v0.1.0");
  const init = run("v0.1.0", "init");
  expect(init.status, init.stderr).toBe(0);
  fillModelEnv();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("stable.sh", () => {
  it("init writes a 0600 .env with stable ports and the proxy resolver, and a user unit", () => {
    const env = readFileSync(join(root, "shared", ".env"), "utf8");
    expect(env).toMatch(/^OPERATOR_BIND=0\.0\.0\.0$/m);
    expect(env).toMatch(/^EGRESS_PROXY_DOH_URL=https:\/\/223\.5\.5\.5\/resolve$/m);
    expect(env).toMatch(/^GATEWAY_SECRETS_KEY=\S+/m);
    expect(env).not.toMatch(/^WORKSPACE_IMAGE=/m);
    expect(env).not.toMatch(/^CHANNEL_PLUGIN_MANIFEST=/m);
    const unit = readFileSync(
      join(home, ".config/systemd/user/deskmates-stable-gateway.service"),
      "utf8",
    );
    expect(unit).toContain(`EnvironmentFile=${root}/shared/release.env`);
    expect(unit).toContain(`${root}/current/packages/gateway/dist/index.js`);
  });

  it("init keeps an existing .env, including its secrets key", () => {
    const before = readFileSync(join(root, "shared", ".env"), "utf8");
    expect(run("v0.1.0", "init").status).toBe(0);
    expect(readFileSync(join(root, "shared", ".env"), "utf8")).toBe(before);
  });

  it("builds the app and egress images offline on the pinned base and runs them by ID", () => {
    const cleanRelease = shipRelease("v0.1.0");
    expect(existsSync(join(cleanRelease, "packages/channels/dist"))).toBe(false);
    release("v0.1.0");
    const rel = join(root, "releases", "v0.1.0");
    const wsTag = imageTag("workspace", "amd64", inputHash(rel, "workspace"));
    const egTag = imageTag("egress", "amd64", inputHash(rel, "egress"));
    const baseTag = imageTag("base", "amd64", inputHash(rel, "base"));
    expect(current()).toBe("releases/v0.1.0");
    expect(releaseEnv()).toMatch(/^DESKMATES_RELEASE=v0\.1\.0$/m);
    expect(releaseEnv()).toContain(`WORKSPACE_IMAGE=${imageIdOf(wsTag)}\n`);
    expect(releaseEnv()).toContain(`EGRESS_PROXY_IMAGE=${imageIdOf(egTag)}\n`);
    expect(imageIdOf(wsTag)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(releaseEnv()).toContain(`WEB_DIST_DIR=${rel}/packages/web/dist`);
    const channelManifest = join(rel, "packages/channels/dist/channel-plugins.json");
    expect(releaseEnv()).toContain(`CHANNEL_PLUGIN_MANIFEST=${channelManifest}\n`);
    expect(readFileSync(join(state, "npm-args"), "utf8")).toContain(
      "run build -w packages/channels",
    );
    const channelBundle = JSON.parse(readFileSync(channelManifest, "utf8"));
    expect(channelBundle.plugins).toMatchObject([
      {
        id: "whatsapp",
        entry: "whatsapp/plugin.js",
        files: [{ path: "whatsapp/plugin.js" }, { path: "whatsapp/runtime.js" }],
      },
    ]);
    // The base got its human-readable tag; no moving :dev alias on a shared daemon.
    expect(imageIdOf(baseTag)).toBe(BASE_ID);
    expect(imageIdOf("deskmates/workspace:dev")).toBeUndefined();
    expect(imageIdOf("deskmates/egress-proxy:dev")).toBeUndefined();
    expect(readFileSync(join(rel, ".release/images.txt"), "utf8")).toContain(
      `base ${baseTag} ${BASE_ID}`,
    );
  });

  it("gives each release its own app image while the base stays the same", () => {
    release("v0.1.0");
    release("v0.2.0");
    const ws = (v) => {
      const rel = join(root, "releases", v);
      return imageIdOf(imageTag("workspace", "amd64", inputHash(rel, "workspace")));
    };
    expect(ws("v0.1.0")).not.toBe(ws("v0.2.0"));
    expect(releaseEnv()).toContain(`WORKSPACE_IMAGE=${ws("v0.2.0")}\n`);
  });

  it("install stops when the pinned base is not on the host, and builds nothing", () => {
    rmSync(join(state, "images"), { recursive: true });
    mkdirSync(join(state, "images"));
    shipRelease("v0.1.0");
    const r = run("v0.1.0", "install", "v0.1.0");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/is not on this host; ship\.sh transfers it/);
    expect(readdirSync(join(state, "images"))).toEqual([]);
  });

  it("LOCAL_BASE=1 builds the base here when it is missing, and records that it did", () => {
    rmSync(join(state, "images"), { recursive: true });
    mkdirSync(join(state, "images"));
    const rel = shipRelease("v0.1.0");
    const r = run("v0.1.0", "install", "v0.1.0", "LOCAL_BASE=1");
    expect(r.status, r.stderr).toBe(0);
    const baseTag = imageTag("base", "amd64", inputHash(rel, "base"));
    const localId = imageIdOf(baseTag);
    expect(localId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(localId).not.toBe(BASE_ID);
    const record = readFileSync(join(rel, ".release/images.txt"), "utf8");
    expect(record).toContain(`base ${baseTag} ${localId} built on this host (LOCAL_BASE=1)`);
    expect(record).toContain(BASE_ID);
  });

  it("LOCAL_BASE=1 still uses the release workflow's base when it is present", () => {
    const rel = shipRelease("v0.1.0");
    expect(run("v0.1.0", "install", "v0.1.0", "LOCAL_BASE=1").status).toBe(0);
    const record = readFileSync(join(rel, ".release/images.txt"), "utf8");
    expect(record).toMatch(/^base \S+ sha256:b{64} from the release workflow$/m);
  });

  it("reuses an existing source-derived base tag when CI rebuilt it with a new image ID", () => {
    rmSync(join(state, "images"), { recursive: true });
    mkdirSync(join(state, "images"));
    const rel = shipRelease("v0.1.0");
    const baseTag = imageTag("base", "amd64", inputHash(rel, "base"));
    writeFileSync(join(state, "images", baseTag.replace(/[/:@]/g, "_")), `${REUSED_BASE_ID}\n`);

    const r = run("v0.1.0", "install", "v0.1.0");

    expect(r.status, r.stderr).toBe(0);
    const record = readFileSync(join(rel, ".release/images.txt"), "utf8");
    expect(record).toContain(
      `base ${baseTag} ${REUSED_BASE_ID} reused existing content-addressed base; the release workflow's base is ${BASE_ID}`,
    );
  });

  it("install stops when the release source does not hash to the manifest's base", () => {
    shipRelease("v0.1.0", { baseTag: "deskmates/workspace-base:amd64-000000000000" });
    const r = run("v0.1.0", "install", "v0.1.0");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not hash to the manifest's base/);
  });

  it("runs T2 with the deployment's resolver, capped workers and no model credentials", () => {
    release("v0.1.0");
    const env = readFileSync(join(state, "t2-env"), "utf8");
    expect(env).toContain("EGRESS_PROXY_DOH_URL=https://223.5.5.5/resolve");
    expect(readFileSync(join(state, "t2-public-host"), "utf8").trim()).toBe("www.baidu.com");
    expect(env).not.toMatch(/^MODEL_/m);
    expect(readFileSync(join(state, "t2-args"), "utf8")).toContain("--maxWorkers=6");
  });

  it("runs the T2 smoke subset for a patch tag and records scope and files", () => {
    shipRelease("v0.1.3");
    expect(run("v0.1.3", "install", "v0.1.3").status).toBe(0);
    const r = run("v0.1.3", "verify", "v0.1.3");
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(state, "t2-args"), "utf8").trim()).toBe(
      "run test:container:smoke -- --maxWorkers=6",
    );
    const receipt = JSON.parse(
      readFileSync(join(root, "releases/v0.1.3/.release/t2.json"), "utf8"),
    );
    expect(receipt.scope).toBe("smoke");
    expect(receipt.files).toEqual(SMOKE_FILES);
    expect(receipt.exitCode).toBe(0);
  });

  it("runs the full T2 suite for a minor tag and lists every T2 file it covers", () => {
    shipRelease("v0.2.0");
    expect(run("v0.2.0", "install", "v0.2.0").status).toBe(0);
    expect(run("v0.2.0", "verify", "v0.2.0").status).toBe(0);
    expect(readFileSync(join(state, "t2-args"), "utf8").trim()).toBe(
      "run test:container -- --maxWorkers=6",
    );
    const receipt = JSON.parse(
      readFileSync(join(root, "releases/v0.2.0/.release/t2.json"), "utf8"),
    );
    expect(receipt.scope).toBe("full");
    expect(receipt.files).toEqual([...SMOKE_FILES, FULL_ONLY_FILE].sort());
  });

  it("T2_SCOPE overrides the tag's scope, and any other value is refused", () => {
    shipRelease("v0.1.3");
    expect(run("v0.1.3", "install", "v0.1.3").status).toBe(0);
    expect(run("v0.1.3", "verify", "v0.1.3", "T2_SCOPE=full").status).toBe(0);
    expect(readFileSync(join(state, "t2-args"), "utf8")).toMatch(/^run test:container -- /);
    shipRelease("v0.2.0");
    expect(run("v0.2.0", "install", "v0.2.0").status).toBe(0);
    expect(run("v0.2.0", "verify", "v0.2.0", "T2_SCOPE=smoke").status).toBe(0);
    expect(readFileSync(join(state, "t2-args"), "utf8")).toMatch(/^run test:container:smoke -- /);
    rmSync(join(root, "releases/v0.2.0/.release/t2.passed"));
    const bad = run("v0.2.0", "verify", "v0.2.0", "T2_SCOPE=some");
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/T2_SCOPE must be full or smoke/);
    expect(existsSync(join(root, "releases/v0.2.0/.release/t2.passed"))).toBe(false);
  });

  it("refuses to activate a release whose T2 failed, unless SKIP_T2=1 records it", () => {
    shipRelease("v0.1.0");
    expect(run("v0.1.0", "install", "v0.1.0").status).toBe(0);
    writeFileSync(join(state, "t2-fails"), "");
    expect(run("v0.1.0", "verify", "v0.1.0").status).not.toBe(0);
    const r = run("v0.1.0", "activate", "v0.1.0");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/T2 has not passed/);
    expect(existsSync(join(root, "current"))).toBe(false);
    expect(run("v0.1.0", "activate", "v0.1.0", "SKIP_T2=1").status).toBe(0);
    expect(existsSync(join(root, "releases/v0.1.0/.release/t2.skipped"))).toBe(true);
  });

  it("does not stop a Gateway that still has active runs", () => {
    release("v0.1.0");
    shipRelease("v0.2.0");
    expect(run("v0.2.0", "install", "v0.2.0").status).toBe(0);
    expect(run("v0.2.0", "verify", "v0.2.0").status).toBe(0);
    writeFileSync(join(state, "active-runs"), "2");
    const r = run("v0.2.0", "activate", "v0.2.0", "DRAIN_TIMEOUT=0");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/still active/);
    expect(current()).toBe("releases/v0.1.0");
    expect(existsSync(join(state, "unit-active"))).toBe(true);
  });

  it("rolls back by itself when the new release does not report healthy", () => {
    release("v0.1.0");
    const before = readFileSync(db(), "utf8");
    shipRelease("v0.2.0");
    writeFileSync(join(state, "broken-v0.2.0"), "");
    expect(run("v0.2.0", "install", "v0.2.0").status).toBe(0);
    expect(run("v0.2.0", "verify", "v0.2.0").status).toBe(0);
    const r = run("v0.2.0", "activate", "v0.2.0", "HEALTH_TIMEOUT=1");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/rolled back to v0\.1\.0/);
    expect(current()).toBe("releases/v0.1.0");
    expect(releaseEnv()).toMatch(/^DESKMATES_RELEASE=v0\.1\.0$/m);
    expect(releaseEnv()).toContain(
      `CHANNEL_PLUGIN_MANIFEST=${join(root, "releases/v0.1.0/packages/channels/dist/channel-plugins.json")}\n`,
    );
    // The backup taken before the switch, plus the one write of the restarted v0.1.0.
    expect(readFileSync(db(), "utf8")).toBe(`${before}written by v0.1.0\n`);
  }, 10_000);

  it("rolls back to a pre-channel release without a dangling plugin manifest", () => {
    release("v0.1.0");
    rmSync(join(root, "releases/v0.1.0/packages/channels/dist/channel-plugins.json"));
    shipRelease("v0.2.0");
    writeFileSync(join(state, "broken-v0.2.0"), "");
    expect(run("v0.2.0", "install", "v0.2.0").status).toBe(0);
    expect(run("v0.2.0", "verify", "v0.2.0").status).toBe(0);

    const r = run("v0.2.0", "activate", "v0.2.0", "HEALTH_TIMEOUT=1");
    expect(r.status).not.toBe(0);
    expect(current()).toBe("releases/v0.1.0");
    expect(releaseEnv()).not.toMatch(/^CHANNEL_PLUGIN_MANIFEST=/m);
  }, 10_000);

  it("rollback restores the previous release and the database as it was before the upgrade", () => {
    release("v0.1.0");
    const before = readFileSync(db(), "utf8");
    release("v0.2.0");
    expect(current()).toBe("releases/v0.2.0");
    expect(readFileSync(db(), "utf8")).toContain("written by v0.2.0");
    const backups = readdirSync(join(root, "backups"));
    expect(backups.some((b) => b.endsWith("-v0.1.0-to-v0.2.0"))).toBe(true);

    const r = run("v0.2.0", "rollback", "YES=1");
    expect(r.status, r.stderr).toBe(0);
    expect(current()).toBe("releases/v0.1.0");
    expect(releaseEnv()).toContain(
      `CHANNEL_PLUGIN_MANIFEST=${join(root, "releases/v0.1.0/packages/channels/dist/channel-plugins.json")}\n`,
    );
    expect(readFileSync(db(), "utf8")).toBe(`${before}written by v0.1.0\n`);
    // One level only: a second rollback has nothing to go back to.
    expect(run("v0.1.0", "rollback", "YES=1").status).not.toBe(0);
  }, 10_000);
});

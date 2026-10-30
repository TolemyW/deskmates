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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageTag, inputHash } from "../image-tag.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Every ABI-2 provider entry the release manifest lists besides WhatsApp; the npm stub writes a
// stand-in module for each so the manifest script finds every entry it pins.
const OTHER_CHANNEL_ENTRIES = [
  ...readFileSync(join(REPO, "scripts", "write-channel-plugin-manifest.mjs"), "utf8").matchAll(
    /entry: "([^"]+)"/g,
  ),
]
  .map((match) => match[1])
  .filter((entry) => entry !== "whatsapp/plugin.js");

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
    "stable/t2-status.mjs",
    "image-tag.mjs",
    "build-workspace-image.sh",
    "build-egress-image.sh",
    "build-grafana-image.sh",
    "build-searxng-image.sh",
    "write-channel-plugin-manifest.mjs",
    "wechat-release-gate.mjs",
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
  put("images/grafana/Dockerfile", "FROM grafana\n");
  put("images/searxng/Dockerfile", "FROM searxng\n");
  // Generated Grafana provisioning (packages/observability-dashboards), as the release ships it.
  for (const file of [
    "provisioning/datasources/deskmates.yaml",
    "provisioning/dashboards/deskmates.yaml",
    "dashboards/agent-runs.json",
  ])
    put(`observability/grafana/sqlite/${file}`, `${version}\n`);
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
    // Vitest cannot interrupt a synchronous child. Bound a broken fixture instead of hanging
    // the entire gate indefinitely (for example if the scripted drain sequence never moves).
    timeout: 30_000,
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
      ...OTHER_CHANNEL_ENTRIES.flatMap((entry) => [
        `  mkdir -p "$(dirname packages/channels/dist/${entry})"`,
        `  printf '%s\\n' 'export const channelPlugin = {};' > packages/channels/dist/${entry}`,
      ]),
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
  "container inspect")
    f="$STATE/containers/\${@: -1}"; [ -f "$f" ] || exit 1
    case "$*" in
      *deskmates.release*) cut -d' ' -f2 "$f" ;;
      *State.Running*) echo "true $(cut -d' ' -f1 "$f")" ;;
      *) echo "{}" ;;
    esac ;;
  "run -d")
    mkdir -p "$STATE/containers"; name=""; config=""; release=""; prev=""
    for a in "$@"; do
      [ "$prev" = "--name" ] && name="$a"
      [ "$prev" = "--label" ] && case "$a" in deskmates.config=*) config="\${a#*=}" ;; deskmates.release=*) release="\${a#*=}" ;; esac
      prev="$a"
    done
    printf '%s\n' "$@" > "$STATE/grafana-run"; echo run >> "$STATE/grafana-runs"
    echo "$config $release" > "$STATE/containers/$name" ;;
  "rm -f") rm -f "$STATE/containers/$3"; echo "$3" >> "$STATE/docker-rm" ;;
  "build "*)
    t=""; prev=""; for a in "$@"; do [ "$prev" = "-t" ] && t="$a"; prev="$a"; done
    echo "$t" >> "$STATE/docker-builds"
    id="sha256:$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$t")"
    echo "$id" > "$imgs/$(key "$t")"; echo "$id" > "$imgs/$(key "$id")" ;;
  "pull "*|"load "*) echo "pull and load are not expected here" >&2; exit 9 ;;
  *) exit 0 ;;
esac`,
  );
  mkdirSync(join(state, "images"));
  writeFileSync(join(state, "images", BASE_ID.replace(/[/:@]/g, "_")), `${BASE_ID}\n`);
  // The runtime endpoint (ADR-0029): POST/DELETE /api/runtime/drain are logged in order to
  // drain-calls; GET /api/runtime reads active-runs, or pops the next line of active-runs-seq so a
  // test can script how the count falls, and names the active runs from active-run-ids.
  stub(
    "curl",
    `url="\${@: -1}"
case "$url" in
  *:18710/healthz|*:18711/healthz) [ -f "$STATE/containers/deskmates-stable-searxng" ] && echo OK && exit 0; exit 7 ;;
  */analytics/api/health) [ -n "$(ls "$STATE/containers" 2>/dev/null)" ] && [ ! -f "$STATE/grafana-unhealthy" ] && echo ok && exit 0; exit 7 ;;
esac
[ -f "$STATE/unit-active" ] || exit 7
rel=$(grep '^DESKMATES_RELEASE=' "$DESKMATES_STABLE_ROOT/shared/release.env" | cut -d= -f2)
active() {
  if [ -s "$STATE/active-runs-seq" ]; then
    n=$(head -1 "$STATE/active-runs-seq")
    if [ "$(wc -l < "$STATE/active-runs-seq")" -gt 1 ]; then
      tail -n +2 "$STATE/active-runs-seq" > "$STATE/active-runs-next"
      mv "$STATE/active-runs-next" "$STATE/active-runs-seq"
    fi
    echo "$n"
  else cat "$STATE/active-runs"; fi
}
case "$url" in
  */healthz) echo ok ;;
  */api/config) [ -f "$STATE/broken-$rel" ] && echo '{"release":null}' || echo "{\\"release\\":\\"$rel\\"}" ;;
  */api/runtime/drain)
    [ -f "$STATE/no-drain-route" ] && exit 22
    case "$*" in *"-X DELETE"*) echo end >> "$STATE/drain-calls" ;; *) echo start >> "$STATE/drain-calls" ;; esac
    echo '{"draining":true}' ;;
  */api/runtime) ids=$(cat "$STATE/active-run-ids" 2>/dev/null || true)
    echo "{\\"activeRuns\\":$(active),\\"activeRunIds\\":[$ids]}" ;;
  *) exit 22 ;;
esac`,
  );
  stub("openssl", 'echo "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MTI="');
  shipRelease("v0.1.0");
  const init = run("v0.1.0", "init");
  expect(init.status, init.stderr).toBe(0);
  fillModelEnv();
});

afterEach(async () => {
  rmSync(home, { recursive: true, force: true });
  // Each case uses synchronous shell children. Yield between cases so Vitest can receive its
  // RPC acknowledgements even when the whole file takes longer than the worker RPC deadline.
  await new Promise((resolve) => setImmediate(resolve));
});

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
    expect(channelBundle.plugins.find((plugin) => plugin.id === "whatsapp")).toMatchObject({
      entry: "whatsapp/plugin.js",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "whatsapp/plugin.js" }),
        expect.objectContaining({ path: "whatsapp/runtime.js" }),
      ]),
    });
    expect(channelBundle.plugins.map((plugin) => plugin.entry).sort()).toEqual(
      ["whatsapp/plugin.js", ...OTHER_CHANNEL_ENTRIES].sort(),
    );
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
    const status = run("v0.1.3", "status");
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("t2       v0.1.3: passed (scope=smoke, exitCode=0;");
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
    const r = run("v0.2.0", "activate", "v0.2.0", "DRAIN_TIMEOUT=0", "UPGRADE_RETRY_BACKOFF=0");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/never reached a safe point/);
    expect(current()).toBe("releases/v0.1.0");
    expect(existsSync(join(state, "unit-active"))).toBe(true);
  });

  // Each case installs, verifies and activates two releases; on a loaded machine that passes 5 s.
  describe("drain to a safe point (ADR-0029 decisions 1 and 3)", { timeout: 30_000 }, () => {
    const drainCalls = () =>
      existsSync(join(state, "drain-calls"))
        ? readFileSync(join(state, "drain-calls"), "utf8").trim().split("\n")
        : [];
    const upgradeTo = (...env) => {
      release("v0.1.0");
      shipRelease("v0.2.0");
      expect(run("v0.2.0", "install", "v0.2.0").status).toBe(0);
      expect(run("v0.2.0", "verify", "v0.2.0").status).toBe(0);
      return run("v0.2.0", "activate", "v0.2.0", "DRAIN_POLL=0", ...env);
    };

    it("starts a drain and stops the Gateway once every active run reached a safe point", () => {
      writeFileSync(join(state, "active-runs-seq"), "2\n1\n0\n");
      const r = upgradeTo("DRAIN_BUDGET=5");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/every active run reached a safe point/);
      expect(drainCalls()).toEqual(["start"]);
      expect(current()).toBe("releases/v0.2.0");
    });

    it("ends the drain unforced past the budget, retries after the backoff, and then stops", () => {
      writeFileSync(join(state, "active-runs-seq"), "1\n0\n");
      const r = upgradeTo("DRAIN_BUDGET=0", "UPGRADE_RETRY_BACKOFF=0");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/drain ended, retrying in 0s/);
      expect(drainCalls()).toEqual(["start", "end", "start"]);
      expect(current()).toBe("releases/v0.2.0");
    });

    it("gives up after UPGRADE_ATTEMPTS drains, names the runs, and leaves the Gateway running", () => {
      writeFileSync(join(state, "active-runs"), "2");
      writeFileSync(join(state, "active-run-ids"), '"run_long_tool","run_long_turn"');
      const r = upgradeTo("DRAIN_BUDGET=0", "UPGRADE_RETRY_BACKOFF=0", "UPGRADE_ATTEMPTS=3");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/2 run\(s\) never reached a safe point in 3 drain\(s\)/);
      expect(r.stderr).toMatch(/run_long_tool run_long_turn/);
      expect(drainCalls()).toEqual(["start", "end", "start", "end", "start", "end"]);
      expect(current()).toBe("releases/v0.1.0");
      expect(existsSync(join(state, "unit-active"))).toBe(true);
    });

    it("FORCE=1 still stops, without ending the drain", () => {
      writeFileSync(join(state, "active-runs"), "2");
      const r = upgradeTo("DRAIN_BUDGET=0", "FORCE=1");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/FORCE=1: stopping with 2 active run/);
      expect(drainCalls()).toEqual(["start"]);
      expect(current()).toBe("releases/v0.2.0");
    });

    it("waits the old way for a Gateway that has no drain route", () => {
      writeFileSync(join(state, "no-drain-route"), "");
      writeFileSync(join(state, "active-runs-seq"), "1\n0\n");
      const r = upgradeTo("DRAIN_BUDGET=5");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/no drain route/);
      expect(drainCalls()).toEqual([]);
      expect(current()).toBe("releases/v0.2.0");
    });
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

describe("stable.sh grafana (ADR-0046 decision 6 and amendment 1)", () => {
  const grafanaState = () => join(root, "grafana");
  /** Decision 6's generated password; amendment 1 retires it and refuses a state that has one. */
  const password = () => join(grafanaState(), "admin-password");
  const runArgs = () => readFileSync(join(state, "grafana-run"), "utf8").split("\n");
  const runs = () =>
    existsSync(join(state, "grafana-runs"))
      ? readFileSync(join(state, "grafana-runs"), "utf8").trim().split("\n").length
      : 0;
  /** The Grafana image builds the docker stub saw (install builds the app and egress images). */
  const builds = () =>
    existsSync(join(state, "docker-builds"))
      ? readFileSync(join(state, "docker-builds"), "utf8")
          .split("\n")
          .filter((tag) => tag.startsWith("deskmates/grafana"))
      : [];
  const grafanaTag = (version) =>
    imageTag("grafana", "amd64", inputHash(join(root, "releases", version), "grafana"));

  function setEnv(key, value) {
    const path = join(root, "shared", ".env");
    const text = readFileSync(path, "utf8");
    const pattern = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    writeFileSync(path, pattern.test(text) ? text.replace(pattern, line) : `${text}${line}\n`);
  }

  /** `stable.sh grafana ...` from the current release, as an operator runs it. */
  function grafana(...args) {
    return run(current().split("/")[1], "grafana", ...args);
  }

  beforeEach(() => {
    release("v0.1.0");
    setEnv("OBSERVABILITY_SINK", "sqlite");
  });

  it("init makes a 0700 state directory without a password and builds the current release's image", () => {
    const first = grafana("init");
    expect(first.status, first.stderr).toBe(0);
    expect(statSync(grafanaState()).mode & 0o777).toBe(0o700);
    expect(existsSync(join(grafanaState(), "data"))).toBe(true);
    // Amendment 1 decision 12: no Grafana administrator, so no password to keep.
    expect(existsSync(password())).toBe(false);
    expect(imageIdOf(grafanaTag("v0.1.0"))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(builds()).toEqual([grafanaTag("v0.1.0")]);
    // No moving alias on a shared daemon.
    expect(imageIdOf("deskmates/grafana:dev")).toBeUndefined();
    // The Gateway's relay upstream is Grafana's loopback origin.
    expect(first.stderr).toMatch(/set OBSERVABILITY_GRAFANA_URL=http:\/\/127\.0\.0\.1:18700 /);

    setEnv("OBSERVABILITY_GRAFANA_URL", "http://127.0.0.1:18700");
    const again = grafana("init");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).not.toMatch(/OBSERVABILITY_GRAFANA_URL/);
    expect(builds()).toHaveLength(1);
  });

  it("start runs one host-network container from the image ID with the release's provisioning", () => {
    expect(grafana("init").status).toBe(0);
    const r = grafana("start");
    expect(r.status, r.stderr).toBe(0);
    const args = runArgs();
    const provisioning = join(root, "releases", "v0.1.0", "observability/grafana/sqlite");
    expect(args[args.indexOf("--network") + 1]).toBe("host");
    for (const env of [
      "GF_SERVER_HTTP_PORT=18700",
      "GF_AUTH_ANONYMOUS_ENABLED=false",
      "GF_ANALYTICS_REPORTING_ENABLED=false",
      "GF_ANALYTICS_CHECK_FOR_UPDATES=false",
      "GF_PLUGINS_PREINSTALL_DISABLED=true",
      "DESKMATES_OBS_FILE=obs.sqlite",
      "deskmates.release=v0.1.0",
    ])
      expect(args, env).toContain(env);
    for (const mount of [
      `${root}/shared/data:/var/lib/deskmates-obs:ro`,
      `${grafanaState()}/data:/var/lib/grafana`,
      `${provisioning}/provisioning/datasources:/etc/grafana/provisioning/datasources:ro`,
      `${provisioning}/provisioning/dashboards:/etc/grafana/provisioning/dashboards:ro`,
      `${provisioning}/dashboards:/var/lib/deskmates-dashboards:ro`,
    ])
      expect(args, mount).toContain(mount);
    expect(args.filter(Boolean).at(-1)).toBe(imageIdOf(grafanaTag("v0.1.0")));
    expect(args.some((a) => a.startsWith("GF_INSTALL_PLUGINS"))).toBe(false);
  });

  it("start binds the host loopback under /analytics/ and trusts only the relay's header", () => {
    expect(grafana("init").status).toBe(0);
    const r = grafana("start");
    expect(r.status, r.stderr).toBe(0);
    const args = runArgs();
    for (const env of [
      // Amendment 1 decision 11: loopback, the Gateway's sub path.
      "GF_SERVER_HTTP_ADDR=127.0.0.1",
      "GF_SERVER_ROOT_URL=http://127.0.0.1:18700/analytics/",
      "GF_SERVER_SERVE_FROM_SUB_PATH=true",
      // Decision 12: auth.proxy from loopback; one auto-signed-up Viewer; nothing else signs in.
      "GF_AUTH_PROXY_ENABLED=true",
      "GF_AUTH_PROXY_HEADER_NAME=X-WEBAUTH-USER",
      "GF_AUTH_PROXY_HEADER_PROPERTY=username",
      "GF_AUTH_PROXY_AUTO_SIGN_UP=true",
      "GF_AUTH_PROXY_WHITELIST=127.0.0.1, ::1",
      "GF_USERS_AUTO_ASSIGN_ORG_ROLE=Viewer",
      "GF_USERS_ALLOW_SIGN_UP=false",
      "GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION=true",
      "GF_AUTH_DISABLE_LOGIN_FORM=true",
      "GF_AUTH_DISABLE_SIGNOUT_MENU=true",
      "GF_AUTH_BASIC_ENABLED=false",
      "GF_AUTH_ANONYMOUS_ENABLED=false",
      // Decision 15: no Live.
      "GF_LIVE_MAX_CONNECTIONS=0",
    ])
      expect(args, env).toContain(env);
    for (const gone of [
      "GF_SECURITY_ADMIN_",
      "GF_AUTH_ANONYMOUS_ORG_ROLE",
      "GF_AUTH_ANONYMOUS_ENABLED=true",
    ])
      expect(
        args.some((a) => a.startsWith(gone)),
        gone,
      ).toBe(false);
    expect(args.some((a) => a.includes("admin-password"))).toBe(false);
    expect(r.stdout).toMatch(/\/analytics\//);
  });

  it("refuses OBSERVABILITY_GRAFANA_ANONYMOUS rather than ignoring it", () => {
    setEnv("OBSERVABILITY_GRAFANA_ANONYMOUS", "1");
    const init = grafana("init");
    expect(init.status).not.toBe(0);
    expect(init.stderr).toMatch(
      /OBSERVABILITY_GRAFANA_ANONYMOUS is retired \(ADR-0046 amendment 1\)/,
    );
    setEnv("OBSERVABILITY_GRAFANA_ANONYMOUS", "0");
    expect(grafana("init").status).toBe(0);
    setEnv("OBSERVABILITY_GRAFANA_ANONYMOUS", "true");
    expect(grafana("start").stderr).toMatch(/OBSERVABILITY_GRAFANA_ANONYMOUS is retired/);
    expect(runs()).toBe(0);
  });

  it("refuses a decision 6 state directory, whose admin is Grafana's server administrator", () => {
    expect(grafana("init").status).toBe(0);
    writeFileSync(password(), "old-secret");
    for (const command of ["init", "start"]) {
      const r = grafana(command);
      expect(r.status, command).not.toBe(0);
      expect(r.stderr, command).toMatch(/predates ADR-0046 amendment 1/);
    }
    expect(runs()).toBe(0);
  });

  it("start is a no-op for the same settings and recreates the container after a change", () => {
    expect(grafana("init").status).toBe(0);
    expect(grafana("start").status).toBe(0);
    const same = grafana("start");
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toMatch(/nothing to change/);
    expect(runs()).toBe(1);

    // The relay's address does not shape the container; only a warning names a mismatch.
    setEnv("OBSERVABILITY_GRAFANA_URL", "http://127.0.0.1:18700");
    expect(grafana("start").stdout).toMatch(/nothing to change/);
    expect(runs()).toBe(1);

    setEnv("OBSERVABILITY_GRAFANA_PORT", "18777");
    const moved = grafana("start");
    expect(moved.status, moved.stderr).toBe(0);
    expect(moved.stderr).toMatch(/set OBSERVABILITY_GRAFANA_URL=http:\/\/127\.0\.0\.1:18777 /);
    expect(runs()).toBe(2);
    const args = runArgs();
    for (const env of [
      "GF_SERVER_HTTP_PORT=18777",
      "GF_SERVER_ROOT_URL=http://127.0.0.1:18777/analytics/",
    ])
      expect(args, env).toContain(env);
    expect(readFileSync(join(state, "docker-rm"), "utf8")).toContain("deskmates-stable-grafana");
  });

  it("start after an upgrade mounts the new release's provisioning and image", () => {
    expect(grafana("init").status).toBe(0);
    expect(grafana("start").status).toBe(0);
    release("v0.2.0");
    expect(grafana("status").stdout).toMatch(
      /current release is v0\.2\.0; run stable\.sh grafana start/,
    );
    expect(grafana("init").status).toBe(0);
    expect(grafana("start").status).toBe(0);
    const args = runArgs();
    expect(args).toContain("deskmates.release=v0.2.0");
    expect(args).toContain(
      `${join(root, "releases/v0.2.0/observability/grafana/sqlite")}/dashboards:/var/lib/deskmates-dashboards:ro`,
    );
  }, 10_000);

  it("mounts the directory of OBSERVABILITY_SQLITE_PATH, relative to the shared directory", () => {
    setEnv("OBSERVABILITY_SQLITE_PATH", "./obs/analytics.sqlite");
    mkdirSync(join(root, "shared", "obs"));
    expect(grafana("init").status).toBe(0);
    const r = grafana("start");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/analytics\.sqlite does not exist yet/);
    expect(runArgs()).toContain(`${root}/shared/obs:/var/lib/deskmates-obs:ro`);
    expect(runArgs()).toContain("DESKMATES_OBS_FILE=analytics.sqlite");
  });

  it("refuses without the sqlite sink, before init, or with a bad port", () => {
    setEnv("OBSERVABILITY_SINK", "");
    expect(grafana("init").stderr).toMatch(/set OBSERVABILITY_SINK=sqlite/);
    setEnv("OBSERVABILITY_SINK", "sqlite");
    expect(grafana("start").stderr).toMatch(/run stable\.sh grafana init first/);
    setEnv("OBSERVABILITY_GRAFANA_PORT", "web");
    expect(grafana("init").stderr).toMatch(/OBSERVABILITY_GRAFANA_PORT must be a port number/);
    expect(runs()).toBe(0);
  });

  it("start fails, with the container's log, when Grafana does not answer /analytics/api/health", () => {
    expect(grafana("init").status).toBe(0);
    writeFileSync(join(state, "grafana-unhealthy"), "");
    const r = grafana("start", "GRAFANA_HEALTH_TIMEOUT=1");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/did not answer \/analytics\/api\/health on port 18700/);
  });

  it("stop removes the container and keeps Grafana's state; stop and status are idempotent", () => {
    expect(grafana("init").status).toBe(0);
    expect(grafana("start").status).toBe(0);
    const status = grafana("status").stdout;
    expect(status).toMatch(/running v0\.1\.0 on 127\.0\.0\.1:18700, healthy/);
    expect(status).toMatch(
      /not relayed: OBSERVABILITY_GRAFANA_URL is '', expected http:\/\/127\.0\.0\.1:18700/,
    );
    setEnv("OBSERVABILITY_GRAFANA_URL", "http://127.0.0.1:18700");
    expect(grafana("status").stdout).toMatch(/relayed by the Gateway at \/analytics\//);
    expect(grafana("stop").status).toBe(0);
    expect(existsSync(join(state, "containers", "deskmates-stable-grafana"))).toBe(false);
    expect(existsSync(join(grafanaState(), "data"))).toBe(true);
    const again = grafana("stop");
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/not running/);
    expect(grafana("status").stdout).toMatch(/not running/);
  });

  it("names its subcommands when given none", () => {
    const r = grafana();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/grafana init \| start \| stop \| status/);
  });
});

describe("stable.sh searxng (ADR-0049 decision 14)", () => {
  const searxngState = () => join(root, "searxng");
  const runArgs = () => readFileSync(join(state, "grafana-run"), "utf8").split("\n");
  const runs = () =>
    existsSync(join(state, "grafana-runs"))
      ? readFileSync(join(state, "grafana-runs"), "utf8").trim().split("\n").length
      : 0;
  const builds = () =>
    existsSync(join(state, "docker-builds"))
      ? readFileSync(join(state, "docker-builds"), "utf8")
          .split("\n")
          .filter((tag) => tag.startsWith("deskmates/searxng"))
      : [];
  const searxngTag = (version) =>
    imageTag("searxng", "amd64", inputHash(join(root, "releases", version), "searxng"));

  function setEnv(key, value) {
    const path = join(root, "shared", ".env");
    const text = readFileSync(path, "utf8");
    const pattern = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    writeFileSync(path, pattern.test(text) ? text.replace(pattern, line) : `${text}${line}\n`);
  }

  function searxng(...args) {
    return run(current().split("/")[1], "searxng", ...args);
  }

  beforeEach(() => {
    release("v0.1.0");
  });

  it("init writes a 0600 secret in a 0700 directory and builds the current release's image", () => {
    const first = searxng("init");
    expect(first.status, first.stderr).toBe(0);
    expect(statSync(searxngState()).mode & 0o777).toBe(0o700);
    expect(statSync(join(searxngState(), "env")).mode & 0o777).toBe(0o600);
    const secret = readFileSync(join(searxngState(), "env"), "utf8");
    expect(secret).toMatch(/^SEARXNG_SECRET=\S+\n$/);
    expect(existsSync(join(searxngState(), "cache"))).toBe(true);
    expect(builds()).toEqual([searxngTag("v0.1.0")]);
    expect(imageIdOf("deskmates/searxng:dev")).toBeUndefined();
    expect(first.stderr).toMatch(/set SEARCH_URL=http:\/\/127\.0\.0\.1:18710 /);

    setEnv("SEARCH_URL", "http://127.0.0.1:18710");
    const again = searxng("init");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).not.toMatch(/SEARCH_URL/);
    // The secret is kept, and the image is not built twice.
    expect(readFileSync(join(searxngState(), "env"), "utf8")).toBe(secret);
    expect(builds()).toHaveLength(1);
  });

  it("start runs one host-network container on loopback with the secret from its file", () => {
    expect(searxng("init").status).toBe(0);
    const r = searxng("start");
    expect(r.status, r.stderr).toBe(0);
    const args = runArgs();
    expect(args[args.indexOf("--network") + 1]).toBe("host");
    expect(args[args.indexOf("--env-file") + 1]).toBe(join(searxngState(), "env"));
    for (const env of [
      "SEARXNG_BIND_ADDRESS=127.0.0.1",
      "SEARXNG_PORT=18710",
      "deskmates.release=v0.1.0",
      `${searxngState()}/cache:/var/cache/searxng`,
    ])
      expect(args, env).toContain(env);
    // The secret never appears on the command line.
    expect(args.some((a) => a.startsWith("SEARXNG_SECRET"))).toBe(false);
    expect(args.filter(Boolean).at(-1)).toBe(imageIdOf(searxngTag("v0.1.0")));
    // The same configuration again is a no-op.
    const again = searxng("start");
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/nothing to change/);
    expect(runs()).toBe(1);
    // A new port recreates it.
    setEnv("SEARCH_PORT", "18711");
    expect(searxng("start").status).toBe(0);
    expect(runs()).toBe(2);
    expect(runArgs()).toContain("SEARXNG_PORT=18711");
  });

  it("start refuses before init and with a bad port", () => {
    const before = searxng("start");
    expect(before.status).not.toBe(0);
    expect(before.stderr).toMatch(/run stable.sh searxng init first/);
    setEnv("SEARCH_PORT", "not-a-port");
    expect(searxng("init").stderr).toMatch(/SEARCH_PORT must be a port number/);
    expect(runs()).toBe(0);
  });

  it("stop and status report what runs; both are idempotent", () => {
    expect(searxng("init").status).toBe(0);
    expect(searxng("start").status).toBe(0);
    const status = searxng("status").stdout;
    expect(status).toMatch(/running v0\.1\.0 on 127\.0\.0\.1:18710, healthy/);
    expect(status).toMatch(/not used: SEARCH_URL is '', expected http:\/\/127\.0\.0\.1:18710/);
    setEnv("SEARCH_URL", "http://127.0.0.1:18710");
    expect(searxng("status").stdout).toMatch(/used by the Gateway/);
    expect(searxng("stop").status).toBe(0);
    expect(existsSync(join(state, "containers", "deskmates-stable-searxng"))).toBe(false);
    expect(existsSync(join(searxngState(), "env"))).toBe(true);
    expect(searxng("stop").stdout).toMatch(/not running/);
    expect(searxng("status").stdout).toMatch(/not running/);
  });

  it("names its subcommands when given none", () => {
    const r = searxng();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/searxng init \| start \| stop \| status/);
  });
});

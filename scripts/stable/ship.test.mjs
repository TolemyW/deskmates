import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The shell running the tests may carry the release settings ship.sh passes on (the deploy
// shell does); each test sets the ones it checks, so start from an environment without them.
const { LOCAL_BASE: _lb, npm_config_registry: _reg, T2_SCOPE: _scope, ...BASE_ENV } = process.env;
const VERSION = "v0.5.4";
const COMMIT = "1".repeat(40);
const TAG_OBJECT = "2".repeat(40);
const RELEASE_BASE_ID = `sha256:${"b".repeat(64)}`;
const REUSED_BASE_ID = `sha256:${"a".repeat(64)}`;
const BASE_TAG = "deskmates/workspace-base:amd64-0123456789ab";

let temp;
let bin;
let manifest;
let dockerLog;

function stub(name, body) {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ship-sh-"));
  bin = join(temp, "bin");
  manifest = join(temp, "release-manifest.json");
  dockerLog = join(temp, "docker.log");
  mkdirSync(bin);
  writeFileSync(dockerLog, "");
  writeFileSync(
    manifest,
    JSON.stringify({
      schema: 2,
      version: VERSION,
      revision: COMMIT,
      base: {
        contentTag: BASE_TAG,
        ref: `ghcr.io/owner/deskmates-workspace-base@sha256:${"c".repeat(64)}`,
        imageId: RELEASE_BASE_ID,
      },
    }),
  );

  stub(
    "git",
    `case "$1" in
  cat-file) echo tag ;;
  rev-parse) case "$2" in *'^{commit}') echo "$COMMIT" ;; *) echo "$TAG_OBJECT" ;; esac ;;
  ls-remote) printf '%s\\trefs/tags/%s\\n' "$TAG_OBJECT" "$VERSION" ;;
  archive) printf archive ;;
  *) echo "unexpected git command: $*" >&2; exit 9 ;;
esac`,
  );
  stub(
    "gh",
    `if [ "$1 $2" != "release download" ]; then exit 9; fi
dest=""
prev=""
for arg in "$@"; do [ "$prev" = "-D" ] && dest="$arg"; prev="$arg"; done
cp "$MANIFEST" "$dest/release-manifest.json"`,
  );
  stub(
    "ssh",
    `cmd="$2"
if [[ "$cmd" == test\\ -f*source.sha256* ]]; then
  exit 0
elif [[ "$cmd" == cat*source.sha256* ]]; then
  echo "$SOURCE_SHA"
elif [[ "$cmd" == *"docker image inspect --format"* ]]; then
  echo "$REUSED_BASE_ID"
elif [[ "$cmd" == *"docker image inspect '$RELEASE_BASE_ID'"* ]]; then
  exit 1
else
  echo "unexpected ssh command: $cmd" >&2
  exit 9
fi`,
  );
  stub("docker", `echo "$*" >> "$DOCKER_LOG"; exit 9`);
  stub("scp", 'echo "scp must not run" >&2; exit 9');
});

afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe("stable release shipping", () => {
  it("does not pull when the host has the same source-derived base tag", () => {
    const sourceSha = createHash("sha256").update("archive").digest("hex");
    const result = spawnSync("bash", [join(REPO, "scripts/stable/ship.sh"), VERSION], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...BASE_ENV,
        PATH: `${bin}:${process.env.PATH}`,
        MANIFEST: manifest,
        SOURCE_SHA: sourceSha,
        DOCKER_LOG: dockerLog,
        COMMIT,
        TAG_OBJECT,
        VERSION,
        RELEASE_BASE_ID,
        REUSED_BASE_ID,
        STABLE_HOST: "test-host",
        STABLE_ROOT: "stable",
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      `base ${BASE_TAG} already on test-host as ${REUSED_BASE_ID} (same content tag; release workflow ID ${RELEASE_BASE_ID})`,
    );
    expect(readFileSync(dockerLog, "utf8")).toBe("");
  });

  it("--run carries LOCAL_BASE and the npm registry to install over ssh, and nothing else", () => {
    const sourceSha = createHash("sha256").update("archive").digest("hex");
    const sshLog = join(temp, "ssh.log");
    stub(
      "ssh",
      `cmd="$2"
if [[ "$cmd" == test\\ -f*source.sha256* ]]; then exit 0
elif [[ "$cmd" == cat*source.sha256* ]]; then echo "$SOURCE_SHA"
elif [[ "$cmd" == *"docker image inspect '$RELEASE_BASE_ID'"* ]]; then exit 0
elif [[ "$cmd" == *"stable.sh' install"* ]]; then echo "$cmd" >> "$SSH_LOG"
else echo "unexpected ssh command: $cmd" >&2; exit 9
fi`,
    );
    const ship = (extra) =>
      spawnSync("bash", [join(REPO, "scripts/stable/ship.sh"), VERSION, "--run"], {
        cwd: REPO,
        encoding: "utf8",
        env: {
          ...BASE_ENV,
          PATH: `${bin}:${process.env.PATH}`,
          MANIFEST: manifest,
          SOURCE_SHA: sourceSha,
          DOCKER_LOG: dockerLog,
          SSH_LOG: sshLog,
          COMMIT,
          TAG_OBJECT,
          VERSION,
          RELEASE_BASE_ID,
          STABLE_HOST: "test-host",
          STABLE_ROOT: "stable",
          npm_config_registry: "",
          ...extra,
        },
      });

    let result = ship({ LOCAL_BASE: "1", npm_config_registry: "https://registry.npmmirror.com" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    result = ship({});
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const [withMirror, plain] = readFileSync(sshLog, "utf8").trim().split("\n");
    expect(withMirror).toMatch(
      /^LOCAL_BASE=1 npm_config_registry=https:\/\/registry\.npmmirror\.com bash '.*stable\.sh' install v0\.5\.4 && /,
    );
    expect(withMirror).toContain(`stable.sh' activate ${VERSION}`);
    // An unset registry is not sent as an empty one, which npm would try to use.
    expect(plain).toMatch(/^LOCAL_BASE= bash '/);
    expect(plain).not.toContain("npm_config_registry");
  });

  it("keeps an existing registry manifest instead of rebuilding the same content tag", () => {
    const workflow = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("Resolve existing content-addressed base");
    expect(workflow).toContain('docker buildx imagetools inspect --raw "$IMAGE_TAG"');
    expect(workflow).toContain("if: steps.existing.outputs.exists != 'true'");
    expect(workflow).toContain("digest: ${{ steps.config.outputs.digest }}");
  });
});

// T0 (ADR-0048 decisions 9, 11 and 12): what the desktop variant promises, checked without Docker.
// It builds FROM the workspace image passed in, verifies both upstream inputs by SHA-256 before
// installing anything, leaves no apt indexes, adds no privilege, declares the capability by label
// and environment, chains to the base entry point, keeps the upstream inputs out of git, and is
// never built or published by the release workflow, the stable scripts or the image tag list.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("./Dockerfile");
const entry = read("./desktop-entry.sh");
const pins = read("./pins.env");
const build = read("../../scripts/build-workspace-desktop-image.sh");
const instructions = dockerfile
  .replace(/\\\n/g, " ")
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

describe("images/workspace-desktop/Dockerfile", () => {
  it("builds FROM the base passed in and verifies both inputs before installing", () => {
    expect(instructions.filter((l) => /^FROM /.test(l))).toEqual(["FROM ${BASE_IMAGE}"]);
    const run = instructions.find((l) => l.startsWith("RUN ")) ?? "";
    const lcuCheck = run.indexOf(
      '${LCU_SHA256}  /tmp/desktop-inputs/${LCU_ARCHIVE}" | sha256sum -c -',
    );
    const appCheck = run.indexOf(
      '${APP_SHA256}  /tmp/desktop-inputs/${APP_PACKAGE}" | sha256sum -c -',
    );
    expect(lcuCheck).toBeGreaterThan(0);
    expect(appCheck).toBeGreaterThan(0);
    expect(run.indexOf("apt-get install")).toBeGreaterThan(Math.max(lcuCheck, appCheck));
    expect(run).toContain('test -n "${LCU_SHA256}" && test -n "${APP_SHA256}"');
    expect(run).toContain("rm -rf /var/lib/apt/lists/* /tmp/desktop-inputs");
  });

  it("downloads nothing itself and copies only the local inputs and the entry script", () => {
    expect(dockerfile).not.toMatch(/\b(curl|wget|git clone)\b|https?:\/\//);
    expect(instructions.filter((l) => /^(COPY|ADD) /.test(l))).toEqual([
      "COPY inputs/${LCU_ARCHIVE} inputs/${APP_PACKAGE} /tmp/desktop-inputs/",
      "COPY desktop-entry.sh /usr/local/bin/deskmates-desktop-entry",
    ]);
  });

  it("adds no privilege, user or device (decision 9)", () => {
    for (const text of [dockerfile, build, entry]) {
      expect(text).not.toMatch(
        /--privileged|--cap-add|--device|--security-opt|userns|setcap|\bsudo\b/,
      );
    }
    expect(instructions.some((l) => /^USER\s/.test(l))).toBe(false);
  });

  it("declares the capability by label and environment, with the pinned versions", () => {
    expect(dockerfile).toContain('org.deskmates.capabilities="desktop-lcu-v1"');
    expect(dockerfile).toContain("DESKMATES_IMAGE_CAPABILITIES=desktop-lcu-v1");
    expect(dockerfile).toContain("DESKMATES_DESKTOP_LCU_COMMAND=/opt/lcu/current/bin/lcu");
    expect(dockerfile).toContain('DESKMATES_DESKTOP_LCU_ARGS=""');
    expect(dockerfile).toContain('org.deskmates.desktop.lcu-version="${LCU_VERSION}"');
    expect(dockerfile).toContain("LCU_NO_UPDATE_CHECK=1");
    // Amendment 1, A5: the reader of raw input events the proxy counts per call.
    expect(instructions.find((l) => l.startsWith("RUN ")) ?? "").toMatch(
      /apt-get install .*\bxinput\b/,
    );
    expect(dockerfile).toContain('DESKMATES_DESKTOP_INPUT_RECORDER="stdbuf -oL xinput test-xi2"');
    expect(pins).toMatch(/^LCU_VERSION=\d+\.\d+\.\d+$/m);
    expect(pins).toMatch(/^APP_VERSION=\d+\.\d+\.\d+$/m);
    expect(pins).toMatch(/^LCU_SHA256=([0-9a-f]{64})?$/m);
    expect(pins).toMatch(/^APP_SHA256=([0-9a-f]{64})?$/m);
  });

  it("starts the session bus, then the base image's own entry point", () => {
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/deskmates-desktop-entry"]');
    expect(entry).toMatch(/dbus-daemon --session --address="\$DBUS_SESSION_BUS_ADDRESS"/);
    expect(entry.trim().split("\n").at(-1)).toBe('exec /usr/local/bin/deskmates-entry "$@"');
  });

  it("keeps the upstream inputs out of git", () => {
    expect(read("./.gitignore")).toMatch(/^inputs\/$/m);
    expect(readdirSync(new URL("./", import.meta.url))).not.toContain("inputs.tar");
  });
});

describe("the variant is local only (decision 12)", () => {
  it("is named by no release workflow, stable script or image tag list", () => {
    const sources = [
      "../../.github/workflows/release.yml",
      "../../.github/workflows/ci.yml",
      "../../scripts/stable/stable.sh",
      "../../scripts/image-tag.mjs",
    ];
    for (const path of sources) expect(read(path), path).not.toMatch(/workspace-desktop/);
  });

  it("is never pushed by its build script", () => {
    expect(build).not.toMatch(/docker (push|buildx .*--push)|imagetools create/);
    expect(build).toContain("local only; do not push");
  });
});

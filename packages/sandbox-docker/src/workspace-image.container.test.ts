// T2 (slow): build images/workspace and prove the container is a usable shared desktop:
// deskmates-healthz passes, noVNC answers, the one Chromium is reachable over CDP, the preinstalled
// Playwright MCP attaches and snapshots, the CLI attaches, the pinned versions agree with
// AGENTS.md, and the tools a bot needs are on PATH. Uses DockerProvider end to end.
//
// Building the image from scratch pulls the ~3 GB Playwright base and installs npm globals
// (about 5 minutes on this machine); cached rebuilds take seconds. Set WORKSPACE_IMAGE to test
// a prebuilt tag, or DESKMATES_SKIP_IMAGE_BUILD=1 to skip the build step entirely.

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxHandle, WorkspaceId } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_EGRESS_PROXY_IMAGE, DockerProvider } from "./docker-provider.js";
import { requireEgressImage } from "./testing/image-preflight.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const IMAGE = process.env.WORKSPACE_IMAGE ?? "deskmates/workspace:dev";
const EGRESS_IMAGE = process.env.EGRESS_PROXY_IMAGE?.trim() || DEFAULT_EGRESS_PROXY_IMAGE;

/** Must match AGENTS.md "Stack" and images/workspace/Dockerfile ARGs. */
const PINS = {
  playwright: "1.58.2",
  "@playwright/mcp": "0.0.82",
  "@playwright/cli": "0.1.21",
  "@anthropic-ai/claude-agent-sdk": "0.3.278",
};

const provider = new DockerProvider({
  egressProxyImage: EGRESS_IMAGE,
});
let available = false;
try {
  available =
    (await provider.client.request("GET", "/_ping", undefined, { timeoutMs: 3000 })).status === 200;
} catch {
  available = false;
}
if (!available) {
  console.warn("[workspace-image.container.test] Docker daemon unreachable; skipping T2 tests.");
}

interface Inspect {
  RestartCount: number;
  State: { Running: boolean; StartedAt: string; Health?: { Status: string } };
  HostConfig: {
    CapDrop?: string[] | null;
    CapAdd?: string[] | null;
    SecurityOpt?: string[] | null;
    PidsLimit?: number | null;
  };
}

async function inspect(id: string): Promise<Inspect> {
  const { json } = await provider.client.expect<Inspect>("GET", `/containers/${id}/json`);
  return json;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Between two reads of a state being waited for; each wait keeps its own upper bound. */
const POLL_MS = 200;

describe.skipIf(!available)("workspace image (T2, slow: real Chromium, MCP, noVNC)", () => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = `t2-img-${suffix}` as WorkspaceId;
  const volumes = {
    "/profile": `deskmates-t2-${suffix}-profile`,
    "/work": `deskmates-t2-${suffix}-work`,
    "/home": `deskmates-t2-${suffix}-home`,
  };
  let handle: SandboxHandle | undefined;

  afterAll(async () => {
    if (handle) await provider.destroy(handle).catch(() => undefined);
    for (const v of Object.values(volumes)) {
      await provider.client.request("DELETE", `/volumes/${v}?force=true`);
    }
  });

  beforeAll(async () => {
    await requireEgressImage(provider, EGRESS_IMAGE);
    if (process.env.DESKMATES_SKIP_IMAGE_BUILD === "1") return;
    const started = Date.now();
    const r = spawnSync("bash", [join(REPO_ROOT, "scripts", "build-workspace-image.sh")], {
      env: { ...process.env, WORKSPACE_IMAGE: IMAGE },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    console.log(
      `[workspace-image] build of ${IMAGE} took ${Math.round((Date.now() - started) / 1000)}s`,
    );
    if (r.status !== 0) console.error(r.stderr.slice(-4000));
    expect(r.status).toBe(0);
  }, 20 * 60_000);

  beforeAll(async () => {
    // No polling loop here on purpose: `create` must not hand back a handle until the image's
    // HEALTHCHECK says healthy. Before that wait existed the first deskmates-healthz raced Chromium's
    // startup and the first run's MCP attach failed against a port nothing was listening on yet.
    handle = await provider.create({
      workspaceId,
      image: IMAGE,
      // What the Gateway sets from the workspace allowlist; checked against Chromium's flags below.
      env: {
        DESKMATES_EGRESS_ALLOWLIST: "*.example.com, plain.test",
        DESKMATES_VNC_PASSWORD: "deadbeef",
        DESKMATES_VNC_VIEW_PASSWORD: "cafe1234",
        DESKMATES_DESKTOP_MODE: "shared-monitors-v1",
      },
      volumes,
      ports: [6080],
      egressAllowlist: ["*.example.com", "plain.test"],
    });
    const state = await inspect(handle.providerRef);
    expect(state.State.Health?.Status).toBe("healthy");
    const hz = await provider.exec(handle, { cmd: ["deskmates-healthz"], timeoutMs: 10_000 });
    expect(hz.exitCode, hz.stderr).toBe(0);
  }, 180_000);

  it("runs with no Linux capabilities, no-new-privileges and a PID cap, and still works", async () => {
    // The healthz above already proves Xvfb, x11vnc, websockify and Chromium (--no-sandbox) all
    // came up under these restrictions; this pins the settings themselves.
    const hc = (await inspect((handle as SandboxHandle).providerRef)).HostConfig;
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd ?? []).toEqual([]);
    expect(hc.SecurityOpt).toContain("no-new-privileges");
    expect(hc.PidsLimit).toBe(4096);
    // no-new-privileges in effect: bit 2 of NoNewPrivs in /proc/self/status.
    const nnp = await provider.exec(handle as SandboxHandle, {
      cmd: ["sh", "-c", "grep NoNewPrivs /proc/self/status"],
    });
    expect(nnp.stdout.trim()).toBe("NoNewPrivs:\t1");
  }, 60_000);

  it("turns the allowlist into Chromium resolver rules with the same meaning as egressAllows", async () => {
    // `*.example.com` allows example.com itself and its subdomains in the hook (contracts), so
    // the browser must resolve both; `plain.test` is exact. Everything else fails to resolve.
    // Read the browser process's own cmdline. Scanning all of /proc/[0-9]* instead matched
    // whichever process the shell glob reached first, which could be this exec's own shell (its
    // argv contains the flag name) or a Chromium helper whose argv makes grep declare a binary
    // match; both depend on how PIDs happen to fall. `pgrep -o` is the oldest match, the browser.
    const r = await provider.exec(handle as SandboxHandle, {
      cmd: [
        "sh",
        "-c",
        'tr "\\0" "\\n" < /proc/$(pgrep -o -f -- "--remote-debugging-port=9222")/cmdline | grep -a "^--host-resolver-rules="',
      ],
      timeoutMs: 10_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    const rules = r.stdout.trim();
    expect(rules).toContain("MAP * ~NOTFOUND");
    expect(rules).toContain("EXCLUDE localhost");
    expect(rules).toContain("EXCLUDE *.example.com");
    expect(rules).toContain("EXCLUDE example.com");
    expect(rules).toContain("EXCLUDE plain.test");
  });

  it("publishes noVNC to the Gateway host and serves vnc.html", async () => {
    expect(handle?.novncAddress).toMatch(/^127\.0\.0\.1:\d+$/);
    // colima sets up host port forwarding a few seconds after the container starts.
    let res: Response | undefined;
    const deadline = Date.now() + 30_000;
    while (res === undefined && Date.now() < deadline) {
      res = await fetch(`http://${handle?.novncAddress}/vnc.html`).catch(() => undefined);
      if (res === undefined) await sleep(POLL_MS);
    }
    expect(res?.status).toBe(200);
    expect(await res?.text()).toContain("noVNC");
    const inside = await provider.exec(handle as SandboxHandle, {
      cmd: ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:6080/"],
    });
    expect(inside.stdout).toBe("200");
  });

  it("runs exactly one Chromium, with CDP bound to loopback and the profile in /profile", async () => {
    const r = await provider.exec(handle as SandboxHandle, {
      cmd: [
        "sh",
        "-c",
        // Chromium helpers (zygote, renderers) inherit the flag; only the browser process lacks --type=.
        "ps -eo args | grep '[-]-remote-debugging-port=9222' | grep -vc -- '--type='; curl -s http://127.0.0.1:9222/json/version",
      ],
    });
    expect(r.exitCode).toBe(0);
    const [count, ...rest] = r.stdout.split("\n");
    expect(count).toBe("1");
    const version = JSON.parse(rest.join("\n")) as {
      Browser: string;
      webSocketDebuggerUrl: string;
    };
    expect(version.Browser).toMatch(/Chrome/);
    expect(version.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:9222\//);
    const profile = await provider.exec(handle as SandboxHandle, {
      cmd: [
        "sh",
        "-c",
        // -a: a Chromium argv can carry bytes that make grep treat the stream as binary.
        "tr '\\0' '\\n' < /proc/$(pgrep -o -f remote-debugging-port=9222)/cmdline | grep -a '^--user-data-dir='",
      ],
    });
    expect(profile.stdout.trim()).toBe("--user-data-dir=/profile");
  });

  it("Playwright MCP attaches over CDP with --caps vision and takes a snapshot; no npx involved", async () => {
    const script = readFileSync(join(HERE, "fixtures", "mcp-attach-check.mjs"), "utf8");
    const r = await provider.exec(handle as SandboxHandle, {
      cmd: ["node", "--input-type=module", "-"],
      stdin: script,
      cwd: "/opt/deskmates",
      timeoutMs: 90_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
      toolCount: number;
      vision: boolean;
      snapshotHasText: boolean;
    };
    expect(out.toolCount).toBeGreaterThanOrEqual(30);
    expect(out.vision).toBe(true);
    expect(out.snapshotHasText).toBe(true);
  }, 120_000);

  it("routes concurrent MCP windows and new tabs to separate screens while sharing login", async () => {
    expect(handle?.botScreenAddresses).toHaveLength(6);
    const script = readFileSync(
      join(REPO_ROOT, "spikes/shared-screen-desktops/runtime-probe.mjs"),
      "utf8",
    );
    const result = await provider.exec(handle as SandboxHandle, {
      cmd: ["node", "--input-type=module", "-"],
      stdin: script,
      env: { SCREEN_PROBE_ONESHOT: "1" },
      cwd: "/opt/deskmates",
      timeoutMs: 240_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("SCREEN_PROBE_PASSED");
  }, 270_000);

  it("playwright-cli attaches to the same browser", async () => {
    const r = await provider.exec(handle as SandboxHandle, {
      cmd: ["playwright-cli", "attach", "--cdp=http://127.0.0.1:9222"],
      cwd: "/work",
      timeoutMs: 60_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Page URL/);
  }, 90_000);

  it("pins the global tools and records MCP/CLI's actual transitive Playwright drivers", async () => {
    const r = await provider.exec(handle as SandboxHandle, {
      cmd: ["npm", "ls", "-g", "--depth=0", "--json"],
      timeoutMs: 60_000,
    });
    const deps = (JSON.parse(r.stdout) as { dependencies: Record<string, { version: string }> })
      .dependencies;
    expect(r.exitCode, r.stderr).toBe(0);
    for (const [name, version] of Object.entries(PINS)) {
      expect(deps[name]?.version, name).toBe(version);
    }
    // The sidecar resolves these through /opt/deskmates/node_modules (ESM ignores NODE_PATH).
    const link = await provider.exec(handle as SandboxHandle, {
      cmd: [
        "node",
        "-e",
        "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(typeof m.query))",
      ],
      cwd: "/opt/deskmates",
      timeoutMs: 60_000,
    });
    expect(link.stdout.trim(), link.stderr).toBe("function");
    // Every runtime dependency of the sidecar must resolve the same way, from the sidecar's own
    // directory (v0.7.0 shipped without `openai`, and no sidecar could start).
    const sidecarDeps = Object.keys(
      (
        JSON.parse(
          readFileSync(new URL("../../sidecar/package.json", import.meta.url), "utf8"),
        ) as { dependencies: Record<string, string> }
      ).dependencies,
    );
    const resolved = await provider.exec(handle as SandboxHandle, {
      cmd: [
        "node",
        "-e",
        "const {existsSync}=require('node:fs');const missing=process.argv.slice(1).filter(n=>!existsSync('/opt/deskmates/node_modules/'+n+'/package.json'));console.log(JSON.stringify(missing))",
        ...sidecarDeps,
      ],
      cwd: "/opt/deskmates/sidecar",
      timeoutMs: 60_000,
    });
    expect(JSON.parse(resolved.stdout), resolved.stderr).toEqual([]);
    // MCP 0.0.82 / CLI 0.1.21 each ship their own alpha driver. The global 1.58.2
    // package launches Chromium; its version alone does not identify the tool runtime.
    const runtime = await provider.exec(handle as SandboxHandle, {
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        readFileSync(new URL("./fixtures/browser-runtime-versions.mjs", import.meta.url), "utf8"),
      ],
      timeoutMs: 15_000,
    });
    expect(runtime.exitCode, runtime.stderr).toBe(0);
    const driverEvidence = JSON.parse(runtime.stdout) as {
      tools: Record<
        string,
        { version: string; drivers: Record<string, { declared: string; installed: string }> }
      >;
    };
    for (const name of ["@playwright/mcp", "@playwright/cli"] as const) {
      expect(driverEvidence.tools[name]?.version, name).toBe(PINS[name]);
      for (const dependency of ["playwright", "playwright-core"]) {
        const driver = driverEvidence.tools[name]?.drivers[dependency];
        expect(driver, `${name} / ${dependency}`).toEqual({
          declared: "1.64.0-alpha-1789764292000",
          installed: "1.64.0-alpha-1789764292000",
        });
      }
    }
    console.log(JSON.stringify({ browserRuntimeVersions: driverEvidence }));
  }, 90_000);

  it("resolves and starts the SDK native CLI without downloading at run time", async () => {
    const result = await provider.exec(handle as SandboxHandle, {
      cmd: [
        "node",
        "-e",
        'const {createRequire}=require("node:module"); const {execFileSync}=require("node:child_process"); const sdk=createRequire(require.resolve("@anthropic-ai/claude-agent-sdk")); const cli=sdk.resolve("@anthropic-ai/claude-agent-sdk-linux-"+process.arch+"/claude"); process.stdout.write(execFileSync(cli,["--version"],{encoding:"utf8",timeout:30000}));',
      ],
      cwd: "/opt/deskmates",
      timeoutMs: 40_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Claude Code/);
  }, 45_000);

  it("has node, psql, git, gh, python3, xdotool, import (imagemagick) and the sidecar shim", async () => {
    const r = await provider.exec(handle as SandboxHandle, {
      cmd: [
        "sh",
        "-c",
        "for t in node psql git gh python3 xdotool import deskmates-sidecar deskmates-healthz; do command -v $t >/dev/null || echo missing:$t; done; test -f /opt/deskmates/sidecar/package.json || echo missing:sidecar-package",
      ],
    });
    expect(r.stdout).toBe("");
    const home = await provider.exec(handle as SandboxHandle, {
      cmd: ["sh", "-c", "test -d /home && test -d /work && test -d /profile && echo ok"],
    });
    expect(home.stdout.trim()).toBe("ok");
  });

  it("ships no compiled tests: the build context excludes *.test.js and *.test.d.ts", async () => {
    // `tsc -b` emits the sidecar's T0 suite into dist/ next to the code it tests. None of it runs
    // in the container; .dockerignore keeps it, and the fixtures it drags in, out of the image.
    const r = await provider.exec(handle as SandboxHandle, {
      cmd: [
        "sh",
        "-c",
        "find /opt/deskmates -name '*.test.js' -o -name '*.test.d.ts' -o -name '*.test.js.map' | grep -v node_modules; exit 0",
      ],
      timeoutMs: 30_000,
    });
    expect(r.stdout.trim()).toBe("");
  }, 60_000);

  it("restarts itself when the shared Chromium dies, instead of sitting unhealthy forever", async () => {
    // entry.sh used to `wait` on every child, so killing Chromium left PID 1 alive: the container
    // stayed "running", deskmates-healthz failed forever and the restart policy never fired, leaving
    // every bot in the workspace without a browser and nothing to recover it.
    const id = (handle as SandboxHandle).providerRef;
    const before = await inspect(id);
    expect(before.State.Health?.Status).toBe("healthy");
    // -o picks the oldest match, the browser process, not this exec's own shell.
    await provider
      .exec(handle as SandboxHandle, {
        cmd: ["sh", "-c", 'kill -9 "$(pgrep -o -f -- "--remote-debugging-port=9222")"'],
        timeoutMs: 15_000,
      })
      // The container dies under the exec, so the stream may break; that is the point.
      .catch(() => undefined);

    const deadline = Date.now() + 60_000;
    let after = before;
    while (Date.now() < deadline) {
      after = await inspect(id);
      if (
        after.RestartCount > before.RestartCount &&
        after.State.Running &&
        after.State.Health?.Status === "healthy"
      ) {
        break;
      }
      await sleep(POLL_MS);
    }
    expect(after.RestartCount, "container should have been restarted").toBeGreaterThan(
      before.RestartCount,
    );
    // A new boot, not the health status left over from the old one.
    expect(after.State.StartedAt).not.toBe(before.State.StartedAt);
    expect(after.State.Health?.Status).toBe("healthy");
    // The desktop is genuinely back: healthz needs CDP on 9222 and noVNC on 6080, and both come
    // from the second run of entry.sh, which has to cope with the first run's leftovers in /tmp.
    const hz = await provider.exec(handle as SandboxHandle, {
      cmd: ["deskmates-healthz"],
      timeoutMs: 10_000,
    });
    expect(hz.exitCode, hz.stderr).toBe(0);
    const chromium = await provider.exec(handle as SandboxHandle, {
      cmd: ["sh", "-c", "pgrep -c -f -- '--remote-debugging-port=9222' >/dev/null && echo up"],
      timeoutMs: 10_000,
    });
    expect(chromium.stdout.trim()).toBe("up");
  }, 120_000);

  it("starts Chromium over a profile lock left by another container", async () => {
    // Testbox, 2026-09-29: an image upgrade removed a workspace container without a clean
    // Chromium exit. The next container (another hostname) found /profile/SingletonLock naming
    // the old one; Chromium exited 21 ("profile in use on another computer") on every boot and the
    // container never became healthy. Plant such a lock, then kill Chromium so entry.sh reboots.
    const id = (handle as SandboxHandle).providerRef;
    const before = await inspect(id);
    await provider
      .exec(handle as SandboxHandle, {
        cmd: [
          "sh",
          "-c",
          "ln -sfn gone-host-4242 /profile/SingletonLock && " +
            'kill -9 "$(pgrep -o -f -- "--remote-debugging-port=9222")"',
        ],
        timeoutMs: 15_000,
      })
      .catch(() => undefined);
    const deadline = Date.now() + 60_000;
    let after = before;
    while (Date.now() < deadline) {
      after = await inspect(id);
      if (
        after.RestartCount > before.RestartCount &&
        after.State.Running &&
        after.State.Health?.Status === "healthy"
      ) {
        break;
      }
      await sleep(POLL_MS);
    }
    expect(after.RestartCount).toBeGreaterThan(before.RestartCount);
    expect(after.State.Health?.Status, "Chromium must start over the stale lock").toBe("healthy");
    const lock = await provider.exec(handle as SandboxHandle, {
      cmd: ["sh", "-c", "readlink /profile/SingletonLock"],
      timeoutMs: 10_000,
    });
    expect(lock.stdout.trim()).not.toBe("gone-host-4242");
  }, 120_000);

  it("bounds shutdown when Chromium cannot respond to graceful close or SIGTERM", async () => {
    const paused = await provider.exec(handle as SandboxHandle, {
      cmd: ["sh", "-c", 'kill -STOP "$(pgrep -o -f -- "--remote-debugging-port=9222")"'],
      timeoutMs: 10_000,
    });
    expect(paused.exitCode, paused.stderr).toBe(0);
    const started = Date.now();
    await provider.destroy(handle as SandboxHandle);
    handle = undefined;
    expect(Date.now() - started).toBeLessThan(9_000);
    handle = await provider.create({
      workspaceId,
      image: IMAGE,
      volumes,
      ports: [6080],
      egressAllowlist: [],
      env: { DESKMATES_VNC_PASSWORD: "deadbeef", DESKMATES_VNC_VIEW_PASSWORD: "cafe1234" },
    });
  }, 150_000);

  it("flushes immediately acknowledged cookies/localStorage on destroy and keeps them after recreation", async () => {
    const h = handle as SandboxHandle;
    const nonce = randomBytes(8).toString("hex");
    const script = readFileSync(join(HERE, "fixtures", "browser-persistence-check.mjs"), "utf8");
    const written = await provider.exec(h, {
      cmd: ["node", "--input-type=module", "-", "write", nonce],
      stdin: script,
      timeoutMs: 15_000,
    });
    expect(written.exitCode, written.stderr).toBe(0);
    expect(JSON.parse(written.stdout)).toEqual({
      operation: "write",
      cookie: nonce,
      localStorage: nonce,
    });
    const started = Date.now();
    await provider.destroy(h);
    handle = undefined;
    expect(Date.now() - started).toBeLessThan(9_000);
    // The named volumes survive: a new container for this workspace keeps the login state.
    const vol = await provider.client.request("GET", `/volumes/${volumes["/profile"]}`);
    expect(vol.status).toBe(200);
    handle = await provider.create({
      workspaceId,
      image: IMAGE,
      volumes,
      ports: [6080],
      egressAllowlist: [],
      env: { DESKMATES_VNC_PASSWORD: "deadbeef", DESKMATES_VNC_VIEW_PASSWORD: "cafe1234" },
    });
    const restored = await provider.exec(handle, {
      cmd: ["node", "--input-type=module", "-", "read", nonce],
      stdin: script,
      timeoutMs: 15_000,
    });
    expect(restored.exitCode, restored.stderr).toBe(0);
    expect(
      JSON.parse(restored.stdout),
      `persisted browser result: ${restored.stdout.trim()}`,
    ).toEqual({
      operation: "read",
      cookie: nonce,
      localStorage: nonce,
    });
  }, 150_000);
});

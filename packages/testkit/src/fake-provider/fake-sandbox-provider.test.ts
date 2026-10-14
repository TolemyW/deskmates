import { type SandboxSpec, type WorkspaceId, isDeskmatesError } from "@deskmates/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox-provider.js";

const WS = "ws-1" as WorkspaceId;

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    workspaceId: WS,
    image: "deskmates/workspace:test",
    egressAllowlist: [],
    env: { DISPLAY: ":99" },
    volumes: { profile: "/profile", work: "/work", home: "/home" },
    ports: [6080],
    ...overrides,
  };
}

async function expectSandboxUnavailable(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isDeskmatesError(err) && err.code === "sandbox_unavailable").toBe(true);
}

describe("FakeSandboxProvider", () => {
  it("has kind fake and hands out distinct handles it can re-attach", async () => {
    const p = new FakeSandboxProvider();
    expect(p.kind).toBe("fake");
    const a = await p.create(spec());
    const b = await p.create(spec({ workspaceId: "ws-2" as WorkspaceId }));
    expect(a.providerRef).not.toBe(b.providerRef);
    expect(a.novncAddress).toBeDefined();
    expect(await p.attach(WS)).toEqual(a);
    expect(await p.attach("ws-nope" as WorkspaceId)).toBeUndefined();
    expect(p.list()).toHaveLength(2);
  });

  it("runs the registered handler for a command and records the exec", async () => {
    const p = new FakeSandboxProvider();
    p.onCommand("sidecar", (req) => ({ stdout: `ran ${req.cmd.slice(1).join(" ")}` }));
    const h = await p.create(spec());
    const r = await p.exec(h, { cmd: ["sidecar", "start", "run-1"] });
    expect(r).toEqual({ exitCode: 0, stdout: "ran start run-1", stderr: "", timedOut: false });
    expect(p.execLog()).toHaveLength(1);
    expect(p.execLog()[0]?.req.cmd).toEqual(["sidecar", "start", "run-1"]);
  });

  it("returns exit 127 for an unregistered command", async () => {
    const p = new FakeSandboxProvider();
    const h = await p.create(spec());
    const r = await p.exec(h, { cmd: ["nope"] });
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toContain("command not found");
  });

  it("delivers injected env to handlers without touching the create spec", async () => {
    const p = new FakeSandboxProvider();
    let seen: Readonly<Record<string, string>> = {};
    p.onCommand("sidecar", (_req, ctx) => {
      seen = ctx.env;
      return "";
    });
    const h = await p.create(spec());
    await p.injectEnv(h, {
      ANTHROPIC_AUTH_TOKEN: "tok-short-lived",
      ANTHROPIC_BASE_URL: "http://gw",
    });
    await p.exec(h, { cmd: ["sidecar"], env: { RUN_ID: "run-1" } });

    expect(seen.ANTHROPIC_AUTH_TOKEN).toBe("tok-short-lived");
    expect(seen.DISPLAY).toBe(":99");
    expect(seen.RUN_ID).toBe("run-1");
    expect(p.injectedEnvFor(h).ANTHROPIC_AUTH_TOKEN).toBe("tok-short-lived");
    // The token must never be visible via the create spec (docker inspect).
    expect(JSON.stringify(p.specFor(h))).not.toContain("tok-short-lived");
  });

  it("fault: create fails once, then recovers", async () => {
    const p = new FakeSandboxProvider();
    p.faults.failCreate();
    await expectSandboxUnavailable(p.create(spec()));
    await expect(p.create(spec())).resolves.toBeDefined();
  });

  it("fault: injected exec timeout skips the handler and reports timedOut", async () => {
    const p = new FakeSandboxProvider();
    let calls = 0;
    p.onCommand("sidecar", () => {
      calls += 1;
      return "";
    });
    const h = await p.create(spec());
    p.faults.timeoutExec();
    const r = await p.exec(h, { cmd: ["sidecar"] });
    expect(r.timedOut).toBe(true);
    expect(calls).toBe(0);
    expect(p.execLog()[0]?.result.timedOut).toBe(true);
    expect((await p.exec(h, { cmd: ["sidecar"] })).timedOut).toBe(false);
  });

  it("honours req.timeoutMs against a hanging handler", async () => {
    const p = new FakeSandboxProvider();
    p.onCommand("hang", () => new Promise(() => {}));
    const h = await p.create(spec());
    const r = await p.exec(h, { cmd: ["hang"], timeoutMs: 20 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it("applies no timeout when the request carries none, like DockerProvider", async () => {
    vi.useFakeTimers();
    try {
      const p = new FakeSandboxProvider();
      p.onCommand("slow", () => new Promise<string>((r) => setTimeout(() => r("late"), 30_000)));
      const h = await p.create(spec());
      const pending = p.exec(h, { cmd: ["slow"] });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toEqual({
        exitCode: 0,
        stdout: "late",
        stderr: "",
        timedOut: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns what the handler produced before the deadline, like DockerProvider", async () => {
    const p = new FakeSandboxProvider();
    p.onCommand("chatty", (_req, ctx) => {
      ctx.writeStdout("first line\n");
      ctx.writeStderr("warning\n");
      return new Promise<string>(() => {});
    });
    const h = await p.create(spec());
    const r = await p.exec(h, { cmd: ["chatty"], timeoutMs: 20 });
    expect(r).toEqual({
      exitCode: -1,
      stdout: "first line\n",
      stderr: "warning\n",
      timedOut: true,
    });
    expect(p.execLog()[0]?.result.stdout).toBe("first line\n");
  });

  it("injectEnv replaces the whole env file, like DockerProvider", async () => {
    const p = new FakeSandboxProvider();
    let seen: Readonly<Record<string, string>> = {};
    p.onCommand("sidecar", (_req, ctx) => {
      seen = ctx.env;
      return "";
    });
    const h = await p.create(spec());
    await p.injectEnv(h, { ANTHROPIC_AUTH_TOKEN: "tok-run-1", RUN: "1" });
    await p.injectEnv(h, { ANTHROPIC_AUTH_TOKEN: "tok-run-2" });
    await p.exec(h, { cmd: ["sidecar"] });

    expect(p.injectedEnvFor(h)).toEqual({ ANTHROPIC_AUTH_TOKEN: "tok-run-2" });
    expect(seen.RUN).toBeUndefined();
  });

  it("rejects an empty cmd with a validation error, like DockerProvider", async () => {
    const p = new FakeSandboxProvider();
    const h = await p.create(spec());
    const err = await p.exec(h, { cmd: [] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isDeskmatesError(err) && err.code).toBe("validation");
    expect(p.execLog()).toHaveLength(0);
  });

  it("create for a workspace that already has a sandbox reports already_exists", async () => {
    const p = new FakeSandboxProvider();
    await p.create(spec());
    const err = await p.create(spec()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isDeskmatesError(err) && err.code).toBe("sandbox_unavailable");
    expect(isDeskmatesError(err) && err.details.reason).toBe("already_exists");
    // Destroying the container frees the name again, as `docker rm` does.
    const h = await p.attach(WS);
    if (!h) throw new Error("unreachable");
    await p.destroy(h);
    await expect(p.create(spec())).resolves.toBeDefined();
  });

  it("fault: a vanished sandbox fails exec, injectEnv, snapshot and misses attach", async () => {
    const p = new FakeSandboxProvider();
    p.onCommand("sidecar", () => "");
    const h = await p.create(spec());
    p.vanish(h);
    expect(await p.attach(WS)).toBeUndefined();
    expect(p.inspect(h)).toBeUndefined();
    await expectSandboxUnavailable(p.exec(h, { cmd: ["sidecar"] }));
    await expectSandboxUnavailable(p.injectEnv(h, { X: "1" }));
    await expectSandboxUnavailable(p.snapshot(h));
    await expect(p.destroy(h)).resolves.toBeUndefined();
  });

  it("snapshot and destroy: destroyed sandboxes are gone but still inspectable", async () => {
    const p = new FakeSandboxProvider();
    const h = await p.create(spec());
    const s = await p.snapshot(h);
    expect(s.ref).toMatch(/^fake-snapshot-/);
    await p.destroy(h);
    await p.destroy(h);
    expect(p.list()).toHaveLength(0);
    expect(await p.attach(WS)).toBeUndefined();
    expect(p.inspect(h)?.destroyed).toBe(true);
    expect(p.inspect(h)?.snapshots).toHaveLength(1);
    await expectSandboxUnavailable(p.exec(h, { cmd: ["sidecar"] }));
  });

  it("removeStaleSandbox removes only a sandbox created from another image", async () => {
    const p = new FakeSandboxProvider();
    const h = await p.create(spec());
    expect(await p.removeStaleSandbox(WS, "deskmates/workspace:test")).toEqual([]);
    expect(await p.attach(WS)).toBe(h);
    p.missingImages.add("deskmates/workspace:v2");
    await expectSandboxUnavailable(p.removeStaleSandbox(WS, "deskmates/workspace:v2"));
    expect(await p.attach(WS)).toBe(h);
    p.missingImages.clear();
    expect(await p.removeStaleSandbox(WS, "deskmates/workspace:v2")).toEqual([
      {
        component: "workspace",
        runningImageId: "deskmates/workspace:test",
        configuredImageId: "deskmates/workspace:v2",
      },
    ]);
    expect(await p.attach(WS)).toBeUndefined();
    await expect(p.create(spec({ image: "deskmates/workspace:v2" }))).resolves.toBeDefined();
  });
});

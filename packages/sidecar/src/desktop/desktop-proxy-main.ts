// `deskmates-sidecar desktop-proxy -- <lcu command> [args...]` (ADR-0048 decision 3): the process
// the SDK launches for the `desktop` server. It starts the image's LCU binary as a child, with the
// child's stderr inherited, and proxies JSON-RPC between it and this process's stdin and stdout
// (`desktop-proxy.ts`). The run token stays in this process: the child gets the desktop session's
// environment and the managed egress proxy, never the coordination variable or a model token.
// The shared-screen lease is the Gateway's `desktop-lock` route (amendment 1, A3). When the image
// names an input reader (`DESKMATES_DESKTOP_INPUT_RECORDER`, A5) the proxy runs it for its
// lifetime and posts each call's input counts as a `desktop`/`input_record` log event.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RunId, SidecarEvent } from "@deskmates/contracts";
import { GatewayClient } from "../gateway-client.js";
import { browserChildEnvironment, installManagedFetchProxy } from "../managed-proxy.js";
import { VISION_POLICY_ENV } from "../vision-withhold.js";
import {
  type DesktopChild,
  type DesktopInputRecord,
  type DesktopLock,
  runDesktopProxy,
} from "./desktop-proxy.js";
import {
  DESKTOP_COORDINATION_ENV,
  type DesktopCoordinationConfig,
  INPUT_RECORDER_ENV,
} from "./desktop-server.js";
import { InputRecorder } from "./x-input-record.js";

function parseCoordination(raw: string | undefined): DesktopCoordinationConfig | undefined {
  if (!raw) return undefined;
  const config = JSON.parse(raw) as DesktopCoordinationConfig;
  if (
    ![config.runId, config.gatewayBaseUrl, config.token].every(
      (v) => typeof v === "string" && v.length > 0,
    ) ||
    !Number.isInteger(config.attempt)
  )
    throw new Error("Invalid desktop coordination configuration");
  return config;
}

export async function runDesktopProxyCommand(argv: readonly string[]): Promise<number> {
  installManagedFetchProxy(process.env);
  const rest = argv[1] === "--" ? argv.slice(2) : argv.slice(1);
  const command = rest[0];
  if (command === undefined) {
    process.stderr.write("usage: deskmates-sidecar desktop-proxy -- <command> [args...]\n");
    return 2;
  }
  const config = parseCoordination(process.env[DESKTOP_COORDINATION_ENV]);
  const client = config
    ? new GatewayClient(
        globalThis.fetch,
        config.gatewayBaseUrl,
        config.runId as RunId,
        config.token,
      )
    : undefined;
  const runId = config?.runId as RunId;
  const lock: DesktopLock | undefined =
    client && config
      ? {
          acquire: (callId, mode) =>
            client.desktopLock({ type: "desktop_lock", runId, op: "acquire", callId, mode }),
          renew: (callId) =>
            client.desktopLock({ type: "desktop_lock", runId, op: "renew", callId }),
          release: (callId) =>
            client.desktopLock({ type: "desktop_lock", runId, op: "release", callId }),
        }
      : undefined;
  const { [DESKTOP_COORDINATION_ENV]: _coordination, ...rawChildEnv } = process.env;
  const childEnv = browserChildEnvironment(rawChildEnv);
  let failed = false;
  /** Every LCU process group this proxy started; killed if the proxy itself is stopped. */
  const groups = new Set<number>();
  const killGroups = () => {
    for (const pid of groups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };
  // The group is detached, so a signal to this process would not reach it on its own.
  const onSignal = () => {
    stopReader?.();
    killGroups();
    process.exit(1);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const spawnChild = (): DesktopChild => {
    const child = spawn(command, rest.slice(1), {
      stdio: ["pipe", "pipe", "inherit"],
      env: childEnv,
      // Its own process group, so the kill after a cancelled call takes the kernel with it.
      detached: true,
    });
    child.on("error", (err) => {
      failed = true;
      process.stderr.write(`desktop-proxy: cannot run ${command}: ${String(err)}\n`);
    });
    if (child.pid !== undefined) groups.add(child.pid);
    child.on("exit", () => {
      if (child.pid !== undefined) groups.delete(child.pid);
    });
    if (child.stdin === null || child.stdout === null) throw new Error("no stdio pipes");
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      kill: () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      },
    };
  };
  // A5: the image's reader of raw input events, run for this proxy's lifetime; absent, nothing
  // is recorded. Its lines are only counted, never kept.
  const reader = (process.env[INPUT_RECORDER_ENV] ?? "").split(/\s+/).filter((w) => w !== "");
  let recorder: InputRecorder | undefined;
  let stopReader: (() => void) | undefined;
  if (reader[0] !== undefined) {
    const proc = spawn(reader[0], reader.slice(1), {
      stdio: ["ignore", "pipe", "ignore"],
      env: childEnv,
    });
    proc.on("error", (err) => {
      process.stderr.write(`desktop-proxy: input reader unavailable: ${String(err)}\n`);
    });
    const active = new InputRecorder();
    recorder = active;
    if (proc.stdout)
      createInterface({ input: proc.stdout }).on("line", (line) => active.line(line));
    stopReader = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
  }
  const onInputRecord = (record: DesktopInputRecord) => {
    if (!client || !config) return;
    // Posted without a sidecar `seq`: the Gateway stores such an event as it comes and never
    // deduplicates it against the run loop's own counter, which this process does not share.
    const event = {
      type: "event",
      runId,
      attempt: config.attempt,
      kind: "log",
      payload: { source: "desktop", op: "input_record", ...record },
      ts: new Date().toISOString(),
    } as unknown as SidecarEvent;
    void client.postEvents([event]).catch(() => undefined);
  };
  await runDesktopProxy(
    { input: process.stdin, output: process.stdout },
    {
      spawn: spawnChild,
      ...(lock ? { lock } : {}),
      ...(recorder ? { recorder, onInputRecord } : {}),
      runId: config?.runId ?? "standalone",
      attempt: config?.attempt ?? 1,
      ...(config?.resumed ? { resumed: true } : {}),
      ...(process.env[VISION_POLICY_ENV] === "withhold" ? { withholdImages: true } : {}),
    },
  );
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
  stopReader?.();
  killGroups();
  return failed ? 1 : 0;
}

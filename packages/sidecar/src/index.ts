#!/usr/bin/env node
// @deskmates/sidecar CLI. Subcommands: run, mcp-proxy, memory, diary, bot-rename, file-read,
// file-write, vault-fill.
//
// `deskmates-sidecar run` reads one `StartRunRequest` as JSON from stdin, loads `/run/deskmates/env`
// (KEY=VALUE, injected by the sandbox provider) into the environment and runs the SDK loop once.
// One process per run. Exit codes:
//
//   0  the run completed or deferred and the Gateway has its RunEnded
//   1  the run failed (the Gateway has the RunEnded, with the error)
//   2  the request on stdin is not a usable StartRunRequest; nothing ran
//   3  the run finished but RunEnded could not be delivered; it is the last line of stdout,
//      prefixed `RUN_ENDED `, for the supervisor to post instead
//
// `deskmates-sidecar file-read` reads `{path, botNames, maxBytes}` as JSON from stdin and prints
// `{base64, size}` for one workspace file, or `{error, message}` with exit 1 (ADR-0014,
// `file-read.ts`). The Gateway's operator download route is its only caller.
//
// `deskmates-sidecar diary` reads `{op: list | read | delete-line, botName, ...}` and answers for
// one bot's `/home/<bot>/memory/YYYY-MM-DD.md` files only (`diary-file.ts`, ADR-0043 decision 4).
// `deskmates-sidecar bot-rename` reads `{from, to}` and moves `/home/<from>` and
// `/work/bots/<from>` to the new name (`bot-rename.ts`, ADR-0043 decision 1). The Gateway's
// operator routes are their only callers.
//
// `deskmates-sidecar file-write` reads one upload operation (begin, append, commit, abort, remove) as JSON
// from stdin and writes only under /work/uploads/ (ADR-0014 amendment A5, `file-write.ts`). The
// Gateway's upload routes are its only caller.
//
// `deskmates-sidecar vault-fill` reads one fill request, a Vault value included, from stdin and
// prints only `{status}` (ADR-0045 decision 5, `vault-fill.ts`). The Gateway's credential use is
// its only caller.
//
// `deskmates-sidecar mcp-proxy -- <command> [args...]` runs that command as a child MCP server and
// proxies JSON-RPC between it and this process's stdin/stdout, wrapping page text as untrusted
// and capturing screenshots (`mcp-proxy/proxy.ts`). The SDK launches this, not the browser MCP
// server directly (`browser-mcp.ts`); it exits with the child's code.
//
// `deskmates-sidecar desktop-proxy -- <command> [args...]` does the same for the opt-in LCU desktop
// server (ADR-0048, `desktop/desktop-proxy.ts`): host-only tools hidden, the workspace lock and
// takeover epoch, untrusted wrapping, interruption and restart.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { egressAllows } from "@deskmates/contracts";
import { BOT_RENAME_ROOTS, renameBotDirectories } from "./bot-rename.js";
import { BROWSER_COORDINATION_ENV, type BrowserCoordinationConfig } from "./browser-state.js";
import { runDesktopProxyCommand } from "./desktop/desktop-proxy-main.js";
import { manageDiary } from "./diary-file.js";
import { RUNTIME_ENV_FILE, parseEnvFile } from "./env-file.js";
import { fileReadCommand } from "./file-read.js";
import { fileWriteCommand } from "./file-write.js";
import { GatewayClient } from "./gateway-client.js";
import { browserChildEnvironment, installManagedFetchProxy } from "./managed-proxy.js";
import { BrowserCoordinator } from "./mcp-proxy/browser-coordinator.js";
import { runMcpProxy } from "./mcp-proxy/proxy.js";
import { guardProxyPipes } from "./mcp-proxy/stdio-lifecycle.js";
import { PhaseTimer, TimingBuffer } from "./mcp-proxy/timing.js";
import { manageMemory } from "./memory-file.js";
import { createRealDeps } from "./real-deps.js";
import { runOnce } from "./run-once.js";
import { SCREENSHOT_DIR_ENV } from "./screenshots.js";
import { parseStartRunRequest } from "./start-run-request.js";
import { fileVaultCaptureGuard, vaultCapturePath } from "./vault-capture.js";
import { DEFAULT_VAULT_CDP_ENDPOINT, cdpFillDeps, vaultFillCommand } from "./vault-fill.js";
import { VISION_POLICY_ENV } from "./vision-withhold.js";

export { runOnce } from "./run-once.js";
export { parseStartRunRequest, startRunRequestSchema } from "./start-run-request.js";
export type { SidecarDeps, SidecarFs } from "./deps.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function loadRuntimeEnv(): Promise<void> {
  let text: string;
  try {
    text = await readFile(RUNTIME_ENV_FILE, "utf8");
  } catch {
    return;
  }
  for (const [k, v] of Object.entries(parseEnvFile(text))) process.env[k] = v;
}

function usage(): never {
  process.stderr.write(
    "usage: deskmates-sidecar run < start-run-request.json\n" +
      "       deskmates-sidecar mcp-proxy -- <command> [args...]\n" +
      "       deskmates-sidecar desktop-proxy -- <command> [args...]\n" +
      "       deskmates-sidecar memory < memory-request.json\n" +
      "       deskmates-sidecar diary < diary-request.json\n" +
      "       deskmates-sidecar bot-rename < bot-rename-request.json\n" +
      "       deskmates-sidecar file-read < file-read-request.json\n" +
      "       deskmates-sidecar file-write < file-write-request.json\n" +
      "       deskmates-sidecar vault-fill < vault-fill-request.json\n",
  );
  process.exit(2);
}

/**
 * Launch the MCP server and proxy its stdio. The child's stderr is inherited so its diagnostics
 * land where the run's do; only stdin and stdout are pipes, because they carry the JSON-RPC.
 */
async function runProxy(argv: readonly string[]): Promise<number> {
  installManagedFetchProxy(process.env);
  const rest = argv[1] === "--" ? argv.slice(2) : argv.slice(1);
  const command = rest[0];
  if (command === undefined) usage();
  const rawCoordination = process.env[BROWSER_COORDINATION_ENV];
  const config = rawCoordination
    ? (JSON.parse(rawCoordination) as BrowserCoordinationConfig)
    : undefined;
  if (
    config &&
    ![config.runId, config.gatewayBaseUrl, config.token, config.statePath].every(
      (v) => typeof v === "string" && v.length > 0,
    )
  )
    throw new Error("Invalid browser coordination configuration");
  if (
    config?.mode === "origin-v2" &&
    (typeof config.deadlineAt !== "string" || !Number.isFinite(Date.parse(config.deadlineAt)))
  )
    throw new Error("Invalid browser origin coordination deadline");
  if (config?.snapshotMode !== undefined && config.snapshotMode !== "inline-v2")
    throw new Error("Invalid browser snapshot configuration");
  const coordinationAbort = new AbortController();
  const gatewayClient = config
    ? new GatewayClient(globalThis.fetch, config.gatewayBaseUrl, config.runId, config.token)
    : undefined;
  const timingBuffer =
    config && gatewayClient && Number.isInteger(config.attempt) && (config.attempt ?? 0) > 0
      ? new TimingBuffer({
          deliver: (samples) => gatewayClient.postTimings(samples, config.attempt as number),
          log: (message) => void process.stderr.write(`${message}\n`),
        })
      : undefined;
  const timing = timingBuffer ? new PhaseTimer({ emit: timingBuffer.emit }) : undefined;
  const inlineSnapshot =
    config?.snapshotMode === "inline-v2" && gatewayClient
      ? {
          allowed: async (url: string): Promise<boolean> => {
            let refreshedAllowlist: string[];
            try {
              refreshedAllowlist = [...(await gatewayClient.getEgressAllowlist()).egressAllowlist];
            } catch {
              // A stale list could contain an origin the operator just revoked. This optional
              // extra read is denied unless its own live refresh succeeds.
              return false;
            }
            try {
              const parsed = new URL(url);
              return (
                (parsed.protocol === "http:" || parsed.protocol === "https:") &&
                egressAllows(parsed.hostname, refreshedAllowlist)
              );
            } catch {
              return false;
            }
          },
        }
      : undefined;
  const retention =
    config && gatewayClient
      ? {
          candidates: async (): Promise<readonly string[]> =>
            (await gatewayClient.getBrowserRetention()).targetIds,
          acquire: async (tabId: string) =>
            await gatewayClient.browserLock({
              type: "browser_lock",
              runId: config.runId,
              op: "acquire",
              tabId,
            }),
          closed: async (targetIds: readonly string[]) =>
            await gatewayClient.browserRetentionClosed([...targetIds]),
        }
      : undefined;
  const coordination = config
    ? new BrowserCoordinator(config, {
        client: gatewayClient as GatewayClient,
        read: () => readFile(config.statePath, "utf8").catch(() => undefined),
        write: async (state) => {
          await mkdir(dirname(config.statePath), { recursive: true });
          const temp = `${config.statePath}.tmp`;
          await writeFile(temp, JSON.stringify(state));
          await rename(temp, config.statePath);
        },
        signal: coordinationAbort.signal,
        ...(timing ? { timing } : {}),
      })
    : undefined;
  // The MCP server needs the browser endpoint, not the proxy's run token/configuration.
  const { [BROWSER_COORDINATION_ENV]: _coordination, ...rawChildEnv } = process.env;
  const childEnv = browserChildEnvironment(rawChildEnv);
  const child = spawn(command, rest.slice(1), {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv,
  });
  const terminate = () => {
    coordinationAbort.abort();
    coordination?.cancel?.();
    child.kill("SIGTERM");
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  const exited = new Promise<number>((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`mcp-proxy: cannot run ${command}: ${String(err)}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal === null ? 0 : 1)));
  });
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) return await exited;
  const pipes = guardProxyPipes(process.stdout, stdin, () => {
    process.stderr.write("mcp-proxy: stdio connection closed\n");
    terminate();
  });
  const screenshotDir = process.env[SCREENSHOT_DIR_ENV];
  let code: number;
  try {
    await runMcpProxy({
      upstream: { input: process.stdin, output: process.stdout },
      child: { stdin, stdout },
      options: {
        ...(screenshotDir ? { screenshotDir } : {}),
        ...(coordination ? { coordination } : {}),
        ...(timing ? { timing } : {}),
        ...(inlineSnapshot ? { inlineSnapshot } : {}),
        ...(config?.browserExecutionMode === "vision-cli-v2" ? { visionFallback: true } : {}),
        ...(retention ? { retention } : {}),
        ...(process.env[VISION_POLICY_ENV] === "withhold" ? { withholdImages: true } : {}),
        // ADR-0045 decision 7: masked captures while a Vault fill is on the run's page.
        ...(config
          ? { vaultGuard: fileVaultCaptureGuard(vaultCapturePath(config.statePath)) }
          : {}),
      },
    });
    await timingBuffer?.flush(1_000);
    code = await exited;
  } finally {
    await pipes.close();
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  }
  return pipes.failed() ? 1 : code;
}

/** A JSON-in, JSON-out maintenance subcommand; a thrown error is `{error}` with exit 1. */
async function jsonCommand(name: string, operation: (input: unknown) => unknown): Promise<number> {
  try {
    process.stdout.write(`${JSON.stringify(operation(JSON.parse(await readStdin())))}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : `${name} failed` })}\n`,
    );
    return 1;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === "bot-rename")
    return jsonCommand("bot-rename", (input) => renameBotDirectories(BOT_RENAME_ROOTS, input));
  if (argv[0] === "diary") return jsonCommand("diary", (input) => manageDiary("/home", input));
  if (argv[0] === "memory") {
    try {
      process.stdout.write(
        `${JSON.stringify(manageMemory("/home", JSON.parse(await readStdin())))}\n`,
      );
      return 0;
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ error: error instanceof Error ? error.message : "Memory operation failed" })}\n`,
      );
      return 1;
    }
  }
  if (argv[0] === "file-read") {
    const { stdout, exitCode } = fileReadCommand(await readStdin());
    // Up to 1.4 MB of base64: let it reach the pipe before `process.exit` discards the buffer.
    await new Promise<void>((resolve) => void process.stdout.write(stdout, () => resolve()));
    return exitCode;
  }
  if (argv[0] === "file-write") {
    const { stdout, exitCode } = fileWriteCommand(await readStdin());
    await new Promise<void>((resolve) => void process.stdout.write(stdout, () => resolve()));
    return exitCode;
  }
  // ADR-0045 decision 5: the value arrives on stdin and only a status line leaves.
  if (argv[0] === "vault-fill") {
    const out = await vaultFillCommand(await readStdin(), cdpFillDeps(DEFAULT_VAULT_CDP_ENDPOINT));
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }
  if (argv[0] === "mcp-proxy") return await runProxy(argv);
  if (argv[0] === "desktop-proxy") return await runDesktopProxyCommand(argv);
  if (argv[0] !== "run") usage();
  await loadRuntimeEnv();
  installManagedFetchProxy(process.env);
  const raw = await readStdin();
  const parsed = parseStartRunRequest(raw);
  if (!parsed.ok) {
    process.stderr.write("invalid StartRunRequest on stdin:\n");
    for (const issue of parsed.issues) process.stderr.write(`  ${issue}\n`);
    return 2;
  }
  let undeliverable = false;
  const ended = await runOnce(parsed.value, createRealDeps(), {
    onEndedUndeliverable: () => {
      undeliverable = true;
    },
  });
  if (undeliverable) return 3;
  return ended.outcome === "failed" ? 1 : 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(1);
    },
  );
}

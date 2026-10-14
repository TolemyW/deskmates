// T2 opt-in real-process regression (issues #65/#66): pinned MCP 0.0.82 with the image's
// tab-identity shim applied, a disposable controlled Chromium and a loopback fixture page. No
// SDK, no model, fake Gateway lock/origin answers. Skips unless DESKMATES_CHOOSER_MCP_ROOT names a
// patched @playwright/mcp package directory; CHROMIUM_PATH defaults to /usr/bin/chromium.
// The original receipts live outside the repository; this test does not
// read or write them.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Interface, createInterface } from "node:readline";
import type { RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import type { BrowserState } from "../browser-state.js";
import { ledgerToolResult } from "../tool-evidence.js";
import { type BrowserCall, BrowserCoordinator, type BrowserRpc } from "./browser-coordinator.js";

const mcpRoot = process.env.DESKMATES_CHOOSER_MCP_ROOT;

const PAGE =
  '<title>Same title</title><p>FINAL_PAGE_CANARY</p><a href="/source">Source</a>' +
  '<input type="file" onchange="window.uploads=(window.uploads||0)+1;' +
  "document.querySelector('output').textContent=window.uploads\"><output>0</output>";

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

async function scenario(root: string, mode: "tab-v1" | "origin-v2"): Promise<string[]> {
  const checks: string[] = [];
  const server: Server = createServer((_req, res) => res.end(PAGE));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), "deskmates-chooser-profile-"));
  // MCP accepts uploads only inside its client workspace (its cwd); keep the fixture there.
  const workspace = await mkdtemp(join(tmpdir(), "deskmates-chooser-workspace-"));
  const fixture = join(workspace, "synthetic.txt");
  await writeFile(fixture, "synthetic upload fixture\n");
  const chromium = spawn(
    process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    [
      "--headless",
      "--no-sandbox",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore", env: { ...process.env, HOME: tmpdir() } },
  );
  const clients: { child: ChildProcess; lines: Interface }[] = [];
  const audit: { runId: string; tool: string }[] = [];
  let human = false;
  let epoch = 0;

  async function connect(runId: string) {
    const child = spawn(
      process.execPath,
      [
        join(root, "cli.js"),
        "--cdp-endpoint",
        `http://127.0.0.1:${port}`,
        "--snapshot-mode",
        "none",
      ],
      {
        cwd: workspace,
        env: { ...process.env, HOME: tmpdir() },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    const pending = new Map<number, (value: unknown) => void>();
    let seq = 0;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const msg = JSON.parse(line) as { id?: number; result?: unknown };
      if (msg.id === undefined) return;
      pending.get(msg.id)?.(msg.result ?? msg);
      pending.delete(msg.id);
    });
    clients.push({ child, lines });
    const send = (method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => reject(new Error(`RPC deadline ${method}`)), 15_000);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: runId, version: "1" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const rpc: BrowserRpc = async (call) => {
      audit.push({ runId, tool: call.name });
      return send("tools/call", call);
    };
    let state: string | undefined;
    const coordinator = new BrowserCoordinator(
      {
        runId: runId as RunId,
        statePath: "/unused",
        token: "fixture",
        gatewayBaseUrl: "http://fixture",
        ...(mode === "origin-v2"
          ? { mode: "origin-v2" as const, deadlineAt: new Date(Date.now() + 120_000).toISOString() }
          : {}),
      },
      {
        read: async () => state,
        write: async (s: BrowserState) => {
          state = JSON.stringify(s);
        },
        client: {
          browserLock: async () => ({
            type: "browser_lock_result",
            runId: runId as RunId,
            granted: !human,
            epoch,
            waitMessage: "human holds browser",
          }),
          browserOrigin: async () => ({
            type: "browser_origin_result",
            runId: runId as RunId,
            granted: true,
          }),
        },
      },
    );
    const execute = async (name: string, args: Record<string, unknown> = {}) => {
      const call: BrowserCall = { name, arguments: args };
      try {
        const dispatched = await coordinator.before(call, rpc);
        const result = (await rpc(dispatched)) as ToolResult;
        await coordinator.after(dispatched, rpc, result);
        return result;
      } catch (error) {
        await coordinator.onError();
        throw error;
      }
    };
    return { rpc, execute, coordinator };
  }

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    const a = await connect("run-a");
    const b = await connect("run-b");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await Promise.all([
      a.execute("browser_navigate", { url }),
      b.execute("browser_navigate", { url }),
    ]);
    expect(a.coordinator.tabId()).not.toBe(b.coordinator.tabId());
    checks.push("two MCP sessions: distinct CDP targets, identical URL and title");

    if (mode === "tab-v1") {
      await a.execute("browser_run_code_unsafe", {
        code: `async(page)=>{for(let i=0;i<24;i++){const p=await page.context().newPage();await p.goto(${JSON.stringify(url)}+'/?token=syntheticSecret&next='+('old'.repeat(150))+i)}}`,
      });
      const snapshot = await a.execute("browser_snapshot");
      const text = (snapshot.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      expect(text.length).toBeGreaterThan(4000);
      let artifact = "";
      const projected = await ledgerToolResult(text, true, [], async (full) => {
        artifact = full;
        return {
          path: "/work/browser-evidence/synthetic.txt",
          bytes: Buffer.byteLength(full),
          sha256: "fixture",
          truncated: false,
          expiresAt: "fixture",
        };
      });
      const content = String(projected.content);
      expect(content).toMatch(/FINAL_PAGE_CANARY/);
      expect(content).toMatch(/Source/);
      expect(content.length).toBeLessThanOrEqual(4000);
      expect(artifact).not.toContain("syntheticSecret");
      checks.push("24 retained long-URL tabs: current page/source survive ledger budget");
    }

    const noModal = await a.execute("browser_file_upload");
    expect(noModal.isError).toBe(true);
    checks.push("no chooser upload denied by original MCP guard");
    const open = (c: Awaited<ReturnType<typeof connect>>) =>
      c.execute("browser_run_code_unsafe", {
        code: "async(page)=>{await page.locator('input').click()}",
      });
    await Promise.all([open(a), open(b)]);
    const list = await a.execute("browser_tabs", { action: "list" });
    expect(list.isError).not.toBe(true);
    expect(JSON.stringify(list)).toMatch(/file chooser/i);
    await expect(a.execute("browser_snapshot")).rejects.toThrow(/file chooser is pending/);
    checks.push("ordinary inspection reports actionable chooser recovery without dispatch");

    human = true;
    epoch++;
    const count = audit.length;
    await expect(a.execute("browser_file_upload")).rejects.toThrow(/human/);
    expect(audit.length).toBe(count);
    human = false;
    epoch++;
    checks.push("human takeover denies before any RPC, handback requires fresh admission");

    const cancelled = await a.execute("browser_file_upload");
    expect(cancelled.isError).not.toBe(true);
    const countUploads = (c: Awaited<ReturnType<typeof connect>>) =>
      c.execute("browser_run_code_unsafe", {
        code: "async(page)=>({uploads:await page.evaluate(()=>window.uploads||0)})",
      });
    expect(JSON.stringify(await countUploads(a))).toMatch(/uploads.*0/);
    checks.push("cancel clears modal without selecting files");

    const upload = await b.execute("browser_file_upload", { paths: [fixture] });
    expect(upload.isError).not.toBe(true);
    expect(JSON.stringify(await countUploads(b))).toMatch(/uploads.*1/);
    const duplicate = await b.execute("browser_file_upload", { paths: [fixture] });
    expect(duplicate.isError).toBe(true);
    checks.push(
      "peer chooser remains independent; one upload; repeat denied without duplicate change",
    );

    await open(a);
    await b.rpc({
      name: "browser_run_code_unsafe",
      arguments: {
        code: `async(page)=>{for(const p of page.context().pages()){const s=await page.context().newCDPSession(p);const t=await s.send('Target.getTargetInfo');await s.detach();if(t.targetInfo.targetId===${JSON.stringify(a.coordinator.tabId())})await p.close()}}`,
      },
    });
    const uploadsBefore = audit.filter((x) => x.tool === "browser_file_upload").length;
    await expect(a.execute("browser_file_upload", { paths: [fixture] })).rejects.toThrow(
      /tab was closed/,
    );
    expect(audit.filter((x) => x.tool === "browser_file_upload").length).toBe(uploadsBefore);
    checks.push("closed chooser target never falls back to peer upload");
    return checks;
  } finally {
    for (const c of clients) {
      c.lines.close();
      c.child.kill();
    }
    chromium.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

describe.skipIf(!mcpRoot)("real MCP chooser identity", () => {
  for (const mode of ["tab-v1", "origin-v2"] as const) {
    it(`retains modal recovery and wrong-target fences in ${mode}`, async () => {
      const root = mcpRoot as string;
      const version = (
        JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
          version?: string;
        }
      ).version;
      expect(version).toBe("0.0.82");
      const checks = await scenario(root, mode);
      expect(checks).toContain("closed chooser target never falls back to peer upload");
      expect(checks).toContain(
        "peer chooser remains independent; one upload; repeat denied without duplicate change",
      );
    }, 100_000);
  }
});

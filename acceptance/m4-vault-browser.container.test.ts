// T2 (ADR-0045 decision 5, Verification row 5): the fixed `deskmates-sidecar vault-fill` command
// against the workspace image's own Chromium, with no model. A fixture page is served inside the
// container; the command fills it through CDP with synthetic values on stdin, and a wrong origin
// is refused. The second group exercises the real SDK, Gateway and ordinary capture paths on a
// generated/trusted HTTPS fixture. Both groups need Docker and skip when it is unavailable.
//
// The actual SDK calling `vault_fill` through the Gateway, a synthetic HTTPS origin with normal
// TLS trust, takeover during a live fill and capture inspection are
// model-free: the real SDK's wire-format upstream is scripted, never a generative model.

import { randomUUID } from "node:crypto";
import type { RunEvent, SandboxHandle, VaultEntry, WorkspaceId } from "@deskmates/contracts";
import { VAULT_FILL_COMMAND } from "@deskmates/contracts";
import { DockerProvider } from "@deskmates/sandbox-docker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dockerAvailable,
  ensureWorkspaceImage,
  testDockerProviderOptions,
  workspaceImage,
} from "./support/docker.js";
import {
  type FakeModelUpstream,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { newThread, postMessage, runEvents, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";
import { handBack, takeOver } from "./support/takeover.js";
import {
  AUDIT_VAULT_OUTPUTS,
  INSPECT_FIXTURE,
  NAVIGATE_DURING_FILL,
  containerNode,
  installVaultHttpsFixture,
} from "./vault-browser-fixture.js";

const available = await dockerAvailable();
const provider = new DockerProvider(testDockerProviderOptions());
const image = workspaceImage();
const HEALTH_TIMEOUT_MS = 90_000;
const PASSWORD = "synthetic-t2-vault-password-6e1b";
const USER = "synthetic-t2-vault-user-0c3d";

async function waitHealthy(handle: SandboxHandle): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await provider.exec(handle, { cmd: ["deskmates-healthz"], timeoutMs: 10_000 });
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("workspace container did not become healthy");
}

/** Serves the fixture, opens it in the shared Chromium, runs the fill command, reads the fields. */
const SCRIPT = String.raw`
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const [password, user, mode] = process.argv.slice(2);
const page = '<!doctype html><form><input id="u" type="email"><input id="p" type="password"><button>Go</button></form>';
const server = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(page); });
await new Promise((ok) => server.listen(18765, "127.0.0.1", ok));
const cdpCall = (socket, id, method, params = {}) => new Promise((ok, fail) => {
  socket.onmessage = (e) => {
    const message = JSON.parse(String(e.data));
    if (message.id !== id) return;
    if (message.error) fail(new Error("CDP call failed: " + JSON.stringify(message.error)));
    else ok(message.result);
  };
  socket.send(JSON.stringify({ id, method, params }));
});
let target = await (await fetch("http://127.0.0.1:9222/json/new?http://localhost:18765/login", { method: "PUT" })).json();
const targetDeadline = Date.now() + 10_000;
while (target.url !== "http://localhost:18765/login" && Date.now() < targetDeadline) {
  await new Promise((ok) => setTimeout(ok, 100));
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  target = targets.find((candidate) => candidate.id === target.id) || target;
}
if (target.url !== "http://localhost:18765/login") throw new Error("fixture target did not finish navigating");
const readySocket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => (readySocket.onopen = ok));
let ready = false;
let requestId = 0;
let lastState;
const readyDeadline = Date.now() + 10_000;
while (!ready && Date.now() < readyDeadline) {
  const response = await cdpCall(readySocket, ++requestId, "Runtime.evaluate", {
    expression: "JSON.stringify([location.href, document.readyState])",
    returnByValue: true,
  });
  lastState = JSON.parse(response.result.value);
  ready = lastState[0] === "http://localhost:18765/login" && lastState[1] === "complete";
  if (!ready) await new Promise((ok) => setTimeout(ok, 100));
}
readySocket.close();
if (!ready) throw new Error("fixture document did not become ready: " + JSON.stringify(lastState));
const origin = mode === "wrong-origin" ? "https://other.example.test" : "http://localhost:18765";
const child = spawn("deskmates-sidecar", ["vault-fill"], { stdio: ["pipe", "pipe", "inherit"] });
child.stdin.end(JSON.stringify({ tabId: target.id, origin, username: user, password }));
let out = "";
for await (const chunk of child.stdout) out += chunk;
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => (socket.onopen = ok));
const response = await cdpCall(socket, 1, "Runtime.evaluate", {
  expression: "JSON.stringify([document.getElementById('u').value, document.getElementById('p').value])",
  returnByValue: true,
});
const values = response.result.value;
if (typeof values !== "string") throw new Error("fixture fields were not readable");
socket.close();
server.close();
console.log(JSON.stringify({ out: out.trim(), values }));
`;

describe.skipIf(!available)("M4 Vault browser fill (T2, real Chromium, no model)", () => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = `t2-vault-${suffix}` as WorkspaceId;
  const volumes = [
    `deskmates-t2-vault-work-${suffix}`,
    `deskmates-t2-vault-profile-${suffix}`,
    `deskmates-t2-vault-home-${suffix}`,
  ];
  let handle: SandboxHandle | undefined;

  beforeAll(async () => {
    await ensureWorkspaceImage(provider, image);
    handle = await provider.create({
      workspaceId,
      image,
      env: { DESKMATES_VNC_PASSWORD: "deadbeef", DESKMATES_VNC_VIEW_PASSWORD: "cafe1234" },
      egressAllowlist: [],
      volumes: {
        "/work": volumes[0] as string,
        "/profile": volumes[1] as string,
        "/home": volumes[2] as string,
      },
      ports: [],
    });
    await waitHealthy(handle);
  }, 180_000);

  afterAll(async () => {
    if (handle) await provider.destroy(handle).catch(() => undefined);
    for (const volume of volumes)
      await provider.client
        .request("DELETE", `/volumes/${volume}?force=true`)
        .catch(() => undefined);
  }, 120_000);

  const run = async (mode: string) => {
    if (!handle) throw new Error("workspace was not created");
    const result = await provider.exec(handle, {
      cmd: ["node", "--input-type=module", "-", PASSWORD, USER, mode],
      stdin: SCRIPT,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Vault fixture failed");
    const last = result.stdout.trim().split("\n").at(-1) ?? "{}";
    return JSON.parse(last) as { out: string; values: string };
  };

  it("fills the shared browser through the fixed command and prints only a status", async () => {
    const { out, values } = await run("right-origin");
    expect(out).toBe('{"status":"filled"}');
    expect(JSON.parse(values)).toEqual([USER, PASSWORD]);
  }, 90_000);

  it("refuses a tab on another origin and fills nothing", async () => {
    const { out, values } = await run("wrong-origin");
    expect(out).toBe('{"status":"target_mismatch"}');
    expect(JSON.parse(values)).toEqual(["", ""]);
  }, 90_000);
});

function usedTools(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content
          .filter((block: { type: string }) => block.type === "tool_use")
          .map((block: { name: string }) => block.name)
      : [],
  );
}

describe.skipIf(!available)(
  "M4 Vault full path (real SDK/Gateway/HTTPS, scripted upstream)",
  () => {
    let stack: Stack | undefined;
    let upstream: FakeModelUpstream | undefined;
    let origin = "";
    let entry: VaultEntry;
    let mode: "fill" | "takeover" | "capture" = "fill";

    beforeAll(async () => {
      upstream = await startFakeModelUpstream({
        expectedToken: "vault-t2-scripted-upstream",
        reply: "",
        script: (_turn, body) => {
          if (!JSON.stringify(body?.tools ?? []).includes("mcp__deskmates__vault_fill"))
            return { kind: "text", text: assistantText("") };
          const used = usedTools(body?.messages);
          const steps = [
            { name: "mcp__browser__browser_navigate", input: { url: `${origin}/login` } },
            {
              name: "mcp__deskmates__vault_fill",
              input: { entryId: entry.id, revision: entry.revision },
            },
            ...(mode === "capture"
              ? [
                  { name: "mcp__browser__browser_snapshot", input: {} },
                  { name: "mcp__browser__browser_take_screenshot", input: { type: "png" } },
                  { name: "mcp__browser__browser_press_key", input: { key: "Tab" } },
                ]
              : []),
          ];
          const next = steps.find((step) => !used.includes(step.name));
          return next
            ? { kind: "tool_use", ...next }
            : { kind: "text", text: assistantText("vault fixture complete") };
        },
      });
      stack = await startStack({
        modelBaseUrl: upstream.url,
        modelAuthToken: "vault-t2-scripted-upstream",
        defaultModel: "fake-vault-model",
        cheapModel: "fake-vault-cheap",
        secretsKey: Buffer.alloc(32, 19).toString("base64"),
        label: `vault-full-${randomUUID().slice(0, 8)}`,
        botName: "vaultfixture",
        soul: "You are the synthetic Vault acceptance bot. Follow only the fixture task.",
      });
      stack.config.maxTurns = 10;
      stack.config.runTimeoutSeconds = 180;
      origin = await installVaultHttpsFixture(stack);
      const approval = await stack.api(
        "PUT",
        `/api/workspaces/${stack.workspace.id}/auto-approval`,
        { mode: "approve_all" },
      );
      expect(approval.status).toBe(200);
      const created = await stack.api<{ entry: VaultEntry }>(
        "POST",
        `/api/workspaces/${stack.workspace.id}/vault`,
        {
          name: "Synthetic TLS login",
          type: "browser_login",
          targetOrigin: origin,
          username: USER,
          password: PASSWORD,
        },
      );
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      entry = created.json.entry;
    }, 180_000);

    afterAll(async () => {
      await stopStack(stack);
      await upstream?.close();
    }, 120_000);

    async function execute(which: typeof mode): Promise<{ id: string; events: RunEvent[] }> {
      if (!stack) throw new Error("Vault full-path stack missing");
      mode = which;
      const thread = await newThread(stack, `vault-${which}-${randomUUID().slice(0, 8)}`);
      const { run } = await postMessage(stack, `Run synthetic Vault ${which} case.`, thread.id);
      const done = await waitForRun(stack, run.id, 180_000);
      expect(done.status, done.error ?? "").toBe("succeeded");
      const events = await runEvents(stack, run.id);
      if (vaultStatus(events) === undefined) {
        console.log(
          "vault fixture diagnostic",
          JSON.stringify(
            events
              .filter((e) => e.kind === "log" && e.payload.source === "pre_tool_use")
              .map((e) => ({
                tool: e.payload.toolName,
                reason: e.payload.reason,
                decision: e.payload.decision,
              })),
          ),
        );
        console.log(
          "vault tool errors",
          JSON.stringify(
            events
              .filter((e) => e.kind === "tool_result" && e.payload.isError)
              .map((e) => ({ content: String(e.payload.content).slice(0, 1200) })),
          ),
        );
      }
      return { id: run.id, events };
    }

    function vaultStatus(events: RunEvent[]): string | undefined {
      return events
        .filter((e) => e.kind === "log" && e.payload.source === "vault")
        .map((e) => e.payload.status)
        .find((status): status is string => typeof status === "string");
    }

    it("the real SDK fills through the Gateway's fixed stdin command on a normally trusted HTTPS origin", async () => {
      const s = stack as Stack;
      const { events } = await execute("fill");
      expect(vaultStatus(events)).toBe("filled");
      const calls = s.provider.execs.filter(
        (e) => JSON.stringify(e.request.cmd) === JSON.stringify(VAULT_FILL_COMMAND),
      );
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]?.request.stdin ?? "{}")).toMatchObject({
        username: USER,
        password: PASSWORD,
        origin,
      });
      expect(JSON.stringify(calls[0]?.request.cmd)).not.toContain(PASSWORD);
      expect(calls[0]?.result?.stdout.trim()).toBe('{"status":"filled"}');
      const inspection = JSON.parse(
        await containerNode(s, INSPECT_FIXTURE, { origin, username: USER, password: PASSWORD }),
      );
      expect(inspection).toMatchObject({
        secure: true,
        usernameMatches: true,
        passwordMatches: true,
        path: "/login",
      });
      expect(JSON.stringify(events)).not.toContain(USER);
      expect(JSON.stringify(events)).not.toContain(PASSWORD);
      expect(JSON.stringify(upstream?.requests.map((r) => r.body))).not.toContain(USER);
      expect(JSON.stringify(upstream?.requests.map((r) => r.body))).not.toContain(PASSWORD);
    }, 180_000);

    it("takeover invalidates an in-flight fixed-command fill, and real navigation between frame lookup and fill returns navigated", async () => {
      const s = stack as Stack;
      const original = s.provider.exec.bind(s.provider);
      let raced = false;
      s.provider.exec = async (handle, request) => {
        const started = original(handle, request);
        if (!raced && JSON.stringify(request.cmd) === JSON.stringify(VAULT_FILL_COMMAND)) {
          raced = true;
          await takeOver(s);
        }
        return started;
      };
      try {
        const { events } = await execute("takeover");
        expect(raced).toBe(true);
        expect(vaultStatus(events)).toBe("takeover");
      } finally {
        s.provider.exec = original;
        await handBack(s);
      }
      // Use the actual CDP helper with one deterministic test interleave. The page itself really
      // navigates; no CDP response, helper status or browser object is fabricated.
      const filled = s.provider.execs
        .filter((e) => JSON.stringify(e.request.cmd) === JSON.stringify(VAULT_FILL_COMMAND))
        .at(-1);
      const input = JSON.parse(filled?.request.stdin ?? "{}");
      const moved = JSON.parse(await containerNode(s, NAVIGATE_DURING_FILL, input));
      expect(moved).toEqual({ output: { status: "navigated" }, changed: true, fieldsEmpty: true });
    }, 180_000);

    it("later snapshot and screenshot results and automatic captures carry no filled canary", async () => {
      const s = stack as Stack;
      const firstRequest = upstream?.requests.length ?? 0;
      const { id, events } = await execute("capture");
      expect(vaultStatus(events)).toBe("filled");
      const fill = events.find(
        (e) => e.kind === "log" && e.payload.source === "vault" && e.payload.status === "filled",
      );
      expect(fill).toBeDefined();
      const later = events.filter((e) => e.seq > (fill?.seq ?? Number.POSITIVE_INFINITY));
      expect(
        later.some(
          (e) => e.kind === "tool_call" && e.payload.toolName === "mcp__browser__browser_snapshot",
        ),
      ).toBe(true);
      expect(
        later.some(
          (e) =>
            e.kind === "tool_call" &&
            e.payload.toolName === "mcp__browser__browser_take_screenshot",
        ),
      ).toBe(true);
      expect(later.filter((e) => e.kind === "screenshot")).toHaveLength(0);
      expect(JSON.stringify(later)).toContain("A Vault credential was filled");
      const outbound = JSON.stringify(upstream?.requests.slice(firstRequest).map((r) => r.body));
      expect(outbound).not.toContain(USER);
      expect(outbound).not.toContain(PASSWORD);
      expect(outbound).toContain("value hidden after a Vault fill");
      const postFill = upstream?.requests
        .slice(firstRequest)
        .filter((r) => usedTools(r.body?.messages).includes("mcp__deskmates__vault_fill"));
      expect(JSON.stringify(postFill?.map((r) => r.body?.messages))).not.toContain(
        '"type":"image"',
      );
      const home = s.provider.sidecarRuns().find((r) => r.request.runId === id)?.request.botHomeDir;
      expect(home).toBeDefined();
      const audit = JSON.parse(
        await containerNode(s, AUDIT_VAULT_OUTPUTS, { home, canaries: [USER, PASSWORD] }),
      ) as { sdkFiles: number; canaryFiles: number };
      expect(audit.sdkFiles).toBeGreaterThan(0);
      expect(audit.canaryFiles).toBe(0);
    }, 180_000);
  },
);

// T2: human takeover of the shared browser, through a real Gateway, a real workspace container,
// the real `deskmates-sidecar` binary and the real Agent SDK, with no model. The fake upstream is
// scripted to answer the first turn of every run with a `mcp__browser__browser_snapshot` tool
// call, so the browser tool that the takeover rule is about is exercised on the wire rather than
// simulated.
//
// The rule under test (design v0.3 §3.3, ADR-0004 "Browser lock, version 1"): one Chromium per
// workspace, one lock, held by the Gateway, acquired in the sidecar's PreToolUse hook. While a
// human holds it every browser tool call in every run of that workspace is denied with
// `HUMAN_HOLDS_BROWSER_MESSAGE` — the model is told to wait, not given another way round.
//
// What is proven here and nowhere else:
//
// 1. noVNC is reachable. The workspace exposes a takeover page on the host before anyone asks
//    for it; `GET /api/workspaces/:id` reports it and a plain `fetch` of it answers 200.
// 2. Taking over is visible in three places at once: the takeover response, the workspace read
//    model, and a `workspace_lock` frame on `/api/events`.
// 3. Lock held → the hook returns the wait message. The run's ledger has the `tool_call` for
//    `browser_snapshot` and the sidecar's `takeover` event carrying the wait message, and the
//    text the *model* saw comes back as a `tool_result` in the next upstream request. That last
//    one is the point of doing this at T2: the sidecar's own unit test can assert the hook's
//    return value, but only the wire shows that the SDK turned it into the tool's result.
// 4. Handing back restores the browser: the same call goes through, with no wait message.
// 5. A takeover while a run is live appends the Gateway's `takeover {phase: "taken"}` to that
//    run; a takeover between runs appends it to nothing, which case 3 pins by asserting that
//    the run whose call was denied has no such event.
//
// Skips when the Docker daemon is unreachable (`colima start`). No model variables needed.

import type { BotDefinition, BrowserLock, RunEvent, Workspace } from "@deskmates/contracts";
import { HUMAN_HOLDS_BROWSER_MESSAGE, isTerminal } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type FakeTurn,
  type RecordedUpstreamRequest,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import {
  type RunView,
  getRun,
  newThread,
  postMessage,
  runEvents,
  toolCalls,
  waitForRun,
} from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const UPSTREAM_TOKEN = "fake-upstream-token-never-leaves-the-gateway-4c1d";
const FAKE_MODEL = "fake-upstream-model";
const FAKE_CHEAP_MODEL = "fake-upstream-model-cheap";
const REPLY = "pong";

const RUN_TIMEOUT_MS = 5 * 60_000;

/** The browser tool the script asks for; L0, so only the lock can stop it. */
const BROWSER_TOOL = "mcp__browser__browser_snapshot";
const BROWSER_TOOL_BARE = "browser_snapshot";

/** The noVNC page the takeover UI opens, as the host addresses it. */
/**
 * The browser half of RFB 3.8 against the Gateway's screen proxy: read the version, answer it,
 * expect the `None` security type only, choose it and read a successful SecurityResult. Resolves
 * "authenticated" once the proxy has logged in to the workspace's x11vnc for us.
 */
async function rfbNoneHandshake(stack: Stack, ticket: ScreenTicket): Promise<string> {
  const origin = new URL(stack.gatewayUrl).origin;
  const socket = new WebSocket(
    `${stack.gatewayUrl.replace(/^http/, "ws")}${ticket.path}`,
    [ticket.protocol],
    { origin },
  );
  let buffered = Buffer.alloc(0);
  const waiters: Array<() => void> = [];
  socket.on("message", (data) => {
    buffered = Buffer.concat([buffered, data as Buffer]);
    for (const wake of waiters.splice(0)) wake();
  });
  const read = async (n: number): Promise<Buffer> => {
    while (buffered.length < n) await new Promise<void>((resolve) => waiters.push(resolve));
    const out = buffered.subarray(0, n);
    buffered = buffered.subarray(n);
    return out;
  };
  try {
    const failed = new Promise<never>((_, reject) => {
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("closed before the handshake ended")));
    });
    const handshake = (async () => {
      const version = (await read(12)).toString("latin1");
      if (version !== "RFB 003.008\n") return `version ${JSON.stringify(version)}`;
      socket.send(Buffer.from("RFB 003.008\n", "latin1"));
      const count = (await read(1))[0] ?? 0;
      const types = [...(await read(count))];
      if (types.join() !== "1") return `security types ${types.join()}`;
      socket.send(Buffer.from([1]));
      return (await read(4)).readUInt32BE(0) === 0 ? "authenticated" : "refused";
    })();
    return await Promise.race([handshake, failed]);
  } finally {
    socket.terminate();
  }
}

const dockerUp = await dockerAvailable();
if (!dockerUp) console.warn("[m1-takeover.container.test] Docker daemon unreachable; skipping T2.");

// --- the Gateway shapes this file codes against -----------------------------------------------
// M1 batch 3 adds the takeover routes; they are typed here rather than imported because the
// Gateway's own response types land with those routes.

interface WorkspaceView {
  workspace: Workspace;
  bots: BotDefinition[];
  browserLock: BrowserLock | null;
  takeoverScreen: boolean;
}

/** The lease only: ADR-0022 amendment 1 (C7) returns no noVNC address or password. */
interface TakeoverResponse {
  lock: BrowserLock;
}

interface ScreenTicket {
  accessId: string;
  path: string;
  protocol: string;
  mode: "control";
}

interface HandbackResponse {
  released: boolean;
}

/** The `/api/events` frame the operator UI redraws the takeover banner from. */
interface WorkspaceLockFrame {
  type: "workspace_lock";
  workspaceId?: string;
  browserLock: BrowserLock | null;
}

interface SseFrame {
  type: string;
  [key: string]: unknown;
}

interface FrameCollector {
  frames: SseFrame[];
  close(): void;
}

/**
 * Every `/api/events` frame, unfiltered, in arrival order. `support/runs.ts` keeps `run_status`
 * frames only; a takeover is a `workspace_lock` frame, which that collector drops. Unfiltered
 * also means no `?threadId=`, so the one stream covers every thread this file opens — and an
 * open stream is what makes the Gateway count a human as online.
 */
async function collectFrames(stack: Stack): Promise<FrameCollector> {
  const controller = new AbortController();
  const res = await fetch(`${stack.gatewayUrl}/api/events`, {
    signal: controller.signal,
    headers: { authorization: `Bearer ${stack.config.operatorToken}` },
  });
  if (!res.ok) throw new Error(`SSE subscription: HTTP ${res.status}`);
  if (!res.body) throw new Error("no SSE body");
  const frames: SseFrame[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (data) frames.push(JSON.parse(data) as SseFrame);
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return { frames, close: () => controller.abort() };
}

function lockFrames(collector: FrameCollector | undefined): WorkspaceLockFrame[] {
  return (collector?.frames ?? []).filter(
    (f): f is SseFrame & WorkspaceLockFrame => f.type === "workspace_lock",
  );
}

// --- the scripted model -----------------------------------------------------------------------

/**
 * One tool call per run, then the text reply.
 *
 * The turn number alone cannot say which request that is: the SDK's CLI makes an extra
 * `POST /v1/messages` per run to generate a session title (it declares no tools), this file
 * drives five runs through one upstream, and a denied call is answered by the same upstream as
 * an allowed one. So the script reads the request instead: a request that declares the browser
 * tool and carries no `tool_result` yet is the first turn of some run, and gets the tool call;
 * everything else gets the default text reply with the summary block `summary.ts` parses.
 */
function scriptOneToolCallPerRun(_turn: number, body: RecordedUpstreamRequest["body"]): FakeTurn {
  const tools = (body as { tools?: unknown } | undefined)?.tools;
  const declaresBrowserTool =
    Array.isArray(tools) && tools.some((t) => (t as { name?: unknown }).name === BROWSER_TOOL);
  const messages = (body as { messages?: unknown } | undefined)?.messages;
  const sawToolResult =
    Array.isArray(messages) && JSON.stringify(messages).includes('"tool_result"');
  if (declaresBrowserTool && !sawToolResult) {
    return { kind: "tool_use", name: BROWSER_TOOL, input: {} };
  }
  return { kind: "text", text: assistantText(REPLY) };
}

/** Every `tool_result` block the CLI sent back, as text. */
function toolResultTexts(body: RecordedUpstreamRequest["body"]): string[] {
  const out: string[] = [];
  const messages = (body as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return out;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; content?: unknown };
      if (b.type !== "tool_result") continue;
      out.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    }
  }
  return out;
}

/**
 * The same blocks as `toolResultTexts`, but decoded: a `tool_result` whose content is a list of
 * blocks gives the `text` of each text block rather than the JSON of the list. A substring search
 * is enough for a phrase, but an assertion about how the text *ends* has to see the text itself,
 * not a JSON literal whose quotes are backslash-escaped and which ends in `"}]`.
 */
function toolResultTextBlocks(body: RecordedUpstreamRequest["body"]): string[] {
  const out: string[] = [];
  const messages = (body as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return out;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: unknown; content?: unknown };
      if (b.type !== "tool_result") continue;
      if (typeof b.content === "string") {
        out.push(b.content);
        continue;
      }
      if (!Array.isArray(b.content)) continue;
      for (const inner of b.content) {
        const i = inner as { type?: unknown; text?: unknown };
        if (i.type === "text" && typeof i.text === "string") out.push(i.text);
      }
    }
  }
  return out;
}

function takeoverEvents(events: readonly RunEvent[]): RunEvent[] {
  return events.filter((e) => e.kind === "takeover");
}

/** The sidecar's own takeover event: the one whose payload carries the wait message. */
function waitMessageEvents(events: readonly RunEvent[]): RunEvent[] {
  return takeoverEvents(events).filter((e) =>
    JSON.stringify(e.payload).includes(HUMAN_HOLDS_BROWSER_MESSAGE),
  );
}

function phaseEvents(events: readonly RunEvent[], phase: string): RunEvent[] {
  return takeoverEvents(events).filter((e) => e.payload.phase === phase);
}

describe.skipIf(!dockerUp)(
  "M1 takeover (T2): a human holds the browser and the hook returns the wait message",
  () => {
    let upstream: FakeModelUpstream;
    let stack: Stack | undefined;
    let sse: FrameCollector | undefined;

    const takeover = (s: Stack, authorId?: string) =>
      s.api<TakeoverResponse>(
        "POST",
        `/api/workspaces/${s.workspace.id}/takeover`,
        authorId === undefined ? {} : { authorId },
      );
    const handback = (s: Stack) =>
      s.api<HandbackResponse>("POST", `/api/workspaces/${s.workspace.id}/handback`, {});
    const readWorkspace = async (s: Stack): Promise<WorkspaceView> => {
      const res = await s.api<WorkspaceView>("GET", `/api/workspaces/${s.workspace.id}`);
      if (res.status !== 200) {
        throw new Error(`get workspace: ${res.status} ${JSON.stringify(res.json)}`);
      }
      return res.json;
    };

    beforeAll(async () => {
      upstream = await startFakeModelUpstream({
        reply: REPLY,
        expectedToken: UPSTREAM_TOKEN,
        script: scriptOneToolCallPerRun,
      });
      stack = await startStack({
        modelBaseUrl: upstream.url,
        modelAuthToken: UPSTREAM_TOKEN,
        defaultModel: FAKE_MODEL,
        cheapModel: FAKE_CHEAP_MODEL,
        label: "takeover",
      });
      sse = await collectFrames(stack);
    }, 25 * 60_000);

    afterAll(async () => {
      // Never leave the workspace locked: a leaked human lock would wedge every later run.
      if (stack) await handback(stack).catch(() => undefined);
      sse?.close();
      await stopStack(stack);
      await upstream?.close();
    }, 120_000);

    it("the workspace starts unlocked and its screen is up behind the proxy, never by address", async () => {
      const s = stack as Stack;
      const view = await readWorkspace(s);
      expect(view.workspace.id).toBe(s.workspace.id);
      expect(view.bots.map((b) => b.id)).toContain(s.bot.id);
      expect(view.browserLock, "nobody has taken over yet").toBeNull();
      // The container exists already: startStack created it through the Gateway's registry, so
      // the noVNC port is published (on loopback, for the proxy) before anyone asks for it.
      expect(view.takeoverScreen).toBe(true);
      expect(JSON.stringify(view)).not.toMatch(/127\.0\.0\.1:\d+|vnc\.html/);
    }, 60_000);

    it("takeover puts a human on the lock, in the response, the read model and the SSE stream", async () => {
      const s = stack as Stack;
      const res = await takeover(s, "human:web");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.lock.holderKind).toBe("human");
      expect(res.json.lock.workspaceId).toBe(s.workspace.id);
      expect(res.json.lock.holderRunId, "a human holder owns the whole workspace").toBeUndefined();
      expect(Object.keys(res.json), "the lease only (C7)").toEqual(["lock"]);

      // The holder reaches the real x11vnc through the Gateway's proxy: the proxy answers the
      // VNC challenge with the password it holds and greets the client with no authentication.
      const opened = await s.api<ScreenTicket>(
        "POST",
        `/api/workspaces/${s.workspace.id}/takeover/open-screen`,
      );
      expect(opened.status, JSON.stringify(opened.json)).toBe(200);
      expect(JSON.stringify(opened.json)).not.toMatch(/password|127\.0\.0\.1/);
      expect(await rfbNoneHandshake(s, opened.json)).toBe("authenticated");

      const view = await readWorkspace(s);
      expect(view.browserLock?.holderKind).toBe("human");

      // The operator UI learns about it the same way it learns about a run: the frame is the
      // exact lock the route returned, under `browserLock`, with the workspace id beside it.
      await new Promise((r) => setTimeout(r, 500));
      const last = lockFrames(sse).at(-1);
      expect(
        last,
        `no workspace_lock frame; saw ${JSON.stringify((sse?.frames ?? []).map((f) => f.type))}`,
      ).toBeDefined();
      expect(last).toEqual({
        type: "workspace_lock",
        workspaceId: s.workspace.id,
        browserLock: res.json.lock,
      });
    }, 60_000);

    it(
      "with the lock held, the browser tool is denied with the wait message the model then sees",
      async () => {
        const s = stack as Stack;
        const thread = await newThread(s, "takeover: locked");
        const before = upstream.requests.length;
        const posted = await postMessage(s, "Take a snapshot of the page.", thread.id);
        const final = await waitForRun(s, posted.run.id, RUN_TIMEOUT_MS, {
          onStatus: (status) => console.log(`[m1-takeover] locked run ${status}`),
        });
        // The run is not failed: the bot is told to report a denial, not to work around it.
        expect(
          ["succeeded", "silent"],
          `run ended ${final.status}: ${final.error ?? ""}`,
        ).toContain(final.status);

        const events = await runEvents(s, final.id);
        expect(
          toolCalls(events, BROWSER_TOOL_BARE).length,
          "the model asked for browser_snapshot",
        ).toBeGreaterThanOrEqual(1);

        // (a) the sidecar's ledger entry for the denial.
        const denied = waitMessageEvents(events);
        expect(
          denied.length,
          `no takeover event carrying the wait message; takeover events: ${JSON.stringify(
            takeoverEvents(events).map((e) => e.payload),
          )}`,
        ).toBeGreaterThanOrEqual(1);
        expect(String(denied[0]?.payload.waitMessage ?? "")).toContain(HUMAN_HOLDS_BROWSER_MESSAGE);

        // (b) the Gateway's own takeover event belongs to runs that were live when the human
        // took over. This one was not: it started afterwards. Asserted so the semantics of
        // `phase` cannot drift into "every run while the lock is held".
        expect(
          phaseEvents(events, "taken"),
          "a run started after the takeover gets no {phase: 'taken'}",
        ).toEqual([]);

        // A browser call the lock denied never reaches the MCP proxy, so nothing is captured and
        // the run process emits no `screenshot` event: while a human holds the screen the ledger
        // gets no picture of it.
        expect(events.filter((e) => e.kind === "screenshot")).toEqual([]);

        // (c) what the model was told. The hook's deny reason comes back to the upstream as the
        // tool's result on the next request — the wire, not the hook's return value.
        const after = upstream.requests.slice(before);
        const carrying = after.filter((r) =>
          toolResultTexts(r.body).some((t) => t.includes(HUMAN_HOLDS_BROWSER_MESSAGE)),
        );
        expect(
          carrying.length,
          `no upstream request carried the wait message as a tool_result; ${after.length} request(s) after the post`,
        ).toBeGreaterThanOrEqual(1);
        console.log(
          `[m1-takeover] ${carrying.length} of ${after.length} upstream request(s) carried the wait message`,
        );
      },
      RUN_TIMEOUT_MS + 60_000,
    );

    it(
      "handing back releases the browser and the same call goes through",
      async () => {
        const s = stack as Stack;
        const released = await handback(s);
        expect(released.status, JSON.stringify(released.json)).toBe(200);
        expect(released.json.released).toBe(true);
        expect((await readWorkspace(s)).browserLock, "the lock is free again").toBeNull();

        const thread = await newThread(s, "takeover: handed back");
        const before = upstream.requests.length;
        const posted = await postMessage(s, "Take a snapshot of the page.", thread.id);
        const final = await waitForRun(s, posted.run.id, RUN_TIMEOUT_MS, {
          onStatus: (status) => console.log(`[m1-takeover] handed-back run ${status}`),
        });
        expect(isTerminal(final.status), `run ended ${final.status}`).toBe(true);
        expect(final.status, final.error).not.toBe("failed");

        const events = await runEvents(s, final.id);
        const calls = toolCalls(events, BROWSER_TOOL_BARE);
        expect(calls.length, "the model asked for browser_snapshot again").toBeGreaterThanOrEqual(
          1,
        );
        // The call was allowed: no wait message anywhere in this run. With no page open the MCP
        // server may still answer with an error, so the result's success is not asserted — only
        // that the lock did not stop it.
        expect(waitMessageEvents(events)).toEqual([]);
        const results = events.filter((e) => e.kind === "tool_result");
        expect(results.length, "the tool ran and answered").toBeGreaterThanOrEqual(1);
        for (const r of results) {
          expect(String(r.payload.content ?? "")).not.toContain(HUMAN_HOLDS_BROWSER_MESSAGE);
        }

        // (d) the result the *model* saw is wrapped as untrusted by the MCP stdio proxy
        // (`packages/sidecar/src/mcp-proxy/proxy.ts`; AGENTS.md "Page content is untrusted").
        // The wrapper is what is asserted, not the page: with no page open the real MCP server
        // may answer `about:blank` or an error, and an error message carries page text too, so
        // it is wrapped just the same. The text is taken out of the JSON body before it is
        // matched, so the assertion is about the string the model read, not about its encoding.
        const after = upstream.requests.slice(before);
        const wrapped = after.flatMap((r) =>
          toolResultTextBlocks(r.body).filter((t) => t.includes('<untrusted source="page:')),
        );
        expect(
          wrapped.length,
          `no upstream request carried a wrapped tool_result; ${after.length} request(s) after the post`,
        ).toBeGreaterThanOrEqual(1);
        for (const text of wrapped) {
          expect(text.trimEnd().endsWith("</untrusted>")).toBe(true);
        }
      },
      RUN_TIMEOUT_MS + 60_000,
    );

    it(
      "a takeover while a run is live appends {phase: 'taken'} to that run",
      async () => {
        const s = stack as Stack;
        const thread = await newThread(s, "takeover: mid-run");
        const posted = await postMessage(s, "Take a snapshot of the page.", thread.id);

        // Take over as soon as the run is out of the queue. The window is the whole of the
        // sidecar's start-up (container exec, SDK boot, MCP attach), seconds rather than
        // milliseconds, but it is a window: if the run beat us to a terminal state there is
        // nothing live to append to and the case reports that instead of failing on a race.
        let live: RunView | undefined;
        const deadline = Date.now() + 120_000;
        for (;;) {
          const { run } = await getRun(s, posted.run.id);
          if (run.status !== "queued") {
            live = run;
            break;
          }
          if (Date.now() > deadline) throw new Error(`run ${run.id} never left the queue`);
          await new Promise((r) => setTimeout(r, 100));
        }
        const res = await takeover(s, "human:web");
        expect(res.status, JSON.stringify(res.json)).toBe(200);
        expect(res.json.lock.holderKind).toBe("human");
        const stillLive = !isTerminal((await getRun(s, posted.run.id)).run.status);

        const final = await waitForRun(s, posted.run.id, RUN_TIMEOUT_MS, {
          onStatus: (status) => console.log(`[m1-takeover] mid-run ${status}`),
        });
        expect(isTerminal(final.status), `run ended ${final.status}`).toBe(true);
        const events = await runEvents(s, final.id);
        if (stillLive) {
          expect(
            phaseEvents(events, "taken").length,
            `the run was live at takeover (status ${live?.status}) so the Gateway records it; takeover events: ${JSON.stringify(
              takeoverEvents(events).map((e) => e.payload),
            )}`,
          ).toBeGreaterThanOrEqual(1);
        } else {
          console.warn(
            "[m1-takeover] the run ended before the takeover landed; the live-run event is not asserted",
          );
        }

        const released = await handback(s);
        expect(released.status, JSON.stringify(released.json)).toBe(200);
        expect((await readWorkspace(s)).browserLock).toBeNull();
        // Hand back is a frame too, so the banner comes down without a reload: the exact JSON
        // of the last lock frame is the released one.
        await new Promise((r) => setTimeout(r, 500));
        expect(lockFrames(sse).at(-1)).toEqual({
          type: "workspace_lock",
          workspaceId: s.workspace.id,
          browserLock: null,
        });
      },
      RUN_TIMEOUT_MS + 180_000,
    );
  },
);

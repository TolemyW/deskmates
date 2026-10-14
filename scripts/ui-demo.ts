// A Gateway for working on the operator UI without Docker or a model: in-memory database, the
// fake sandbox provider, and a scripted sidecar that plays a three-bot team (a coordinator that
// delegates, a researcher that browses and writes a file, a tester that asks for an L2 approval
// and parks). Nothing here touches a real workspace, model or deployment.
//
//   npm run typecheck          # builds packages/*/dist once
//   npm run dev:ui-demo        # Gateway on 127.0.0.1:8099, prints the demo sign-in
//   OPERATOR_PORT=8099 npm run dev:web
//
// Then open the Vite URL and sign in with the printed login name and password. Sessions use the
// explicit plain-HTTP development cookie mode (ADR-0022 P1). UI_DEMO_PORT overrides the port.

import type { RunSummary, StartRunRequest } from "@deskmates/contracts";
import { buildGateway } from "../packages/gateway/src/index.js";
import {
  FakeProvider,
  type FakeSidecarClient,
} from "../packages/gateway/src/test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../packages/gateway/src/test-support/harness.js";

const PORT = Number(process.env.UI_DEMO_PORT ?? 8099);
/** Demo-only account on the in-memory database; never a deployment credential. */
export const DEMO_LOGIN = "demo";
export const DEMO_PASSWORD = "demo-password-not-secret";
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function summary(reply: string, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    done: "answered",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
    ...extra,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function events(
  gw: FakeSidecarClient,
  req: StartRunRequest,
  list: { kind: string; payload: unknown }[],
): Promise<void> {
  let seq = 0;
  for (const event of list) {
    seq += 1;
    await gw.post("events", [
      {
        type: "event",
        runId: req.runId,
        attempt: req.attempt,
        seq,
        kind: event.kind,
        payload: event.payload,
        ts: new Date().toISOString(),
      },
    ]);
    await sleep(120);
  }
}

const usage = (input: number, output: number) => [
  {
    model: "demo-large",
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: Math.round(input * 0.6),
    cacheCreateTokens: 0,
  },
];

async function main(): Promise<void> {
  const provider = new FakeProvider("docker");
  provider.novncAddress = "127.0.0.1:6080";
  const app = buildGateway(
    testConfig({
      auth: { cookieMode: "insecure-dev" },
      defaultModel: "demo-large",
      cheapModel: "demo-small",
      shortWaitSeconds: 2,
      modelPrices: [
        {
          model: "demo-large",
          inputPerM: 3,
          outputPerM: 15,
          cacheReadPerM: 0.3,
          cacheCreatePerM: 3.75,
          effectiveFrom: "2026-01-01T00:00:00.000Z",
        },
        {
          model: "demo-small",
          inputPerM: 0.8,
          outputPerM: 4,
          cacheReadPerM: 0.08,
          cacheCreatePerM: 1,
          effectiveFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    provider,
    { surface: "combined-test", sseHeartbeatMs: 15000, startCron: false },
  );

  const chatThreads = new Set<string>();
  const seen = new Map<string, number>();

  provider.onRun(async (req, gw) => {
    const key = `${req.botName}:${req.threadId}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    await sleep(400);
    if (req.botName === "chief") {
      await events(gw, req, [
        {
          kind: "thinking",
          payload: {
            text: "The brief needs two inputs: KPI deltas and open P1 tickets. Delegate both in parallel, then assemble.",
          },
        },
        {
          kind: "tool_call",
          payload: { tool: "Read", input: { path: "/work/brief-template.md" } },
        },
        {
          kind: "tool_result",
          payload: {
            tool: "Read",
            output: "# Weekly ops brief\n\n- KPIs\n- Open tickets\n- Risks",
          },
        },
      ]);
      await gw.post("messages", {
        type: "post_message",
        runId: req.runId,
        tool: "thread_post",
        body: "@researcher pull this week's KPI deltas from the Galaxy Ops console (revenue, active fleets, churn). @qa count the open P1 tickets and export the list to /work/p1-tickets.csv.",
        attachments: [],
      });
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary(
          "Delegated: researcher takes KPIs, qa takes tickets. I will assemble `/work/ops-brief.md` once both report back.",
        ),
        usage: usage(5400, 220),
      });
      return;
    }
    if (req.botName === "researcher" && !chatThreads.has(req.threadId ?? "")) {
      await events(gw, req, [
        {
          kind: "tool_call",
          payload: {
            tool: "mcp__browser__browser_navigate",
            input: { url: "https://ops.example.test/dashboard" },
          },
        },
        {
          kind: "tool_result",
          payload: {
            tool: "mcp__browser__browser_navigate",
            output: "Navigated to Galaxy Ops Console - Dashboard",
          },
        },
        { kind: "tool_call", payload: { tool: "mcp__browser__browser_snapshot", input: {} } },
        {
          kind: "tool_result",
          payload: {
            tool: "mcp__browser__browser_snapshot",
            output:
              "- heading 'Dashboard'\n- table 'KPIs' [revenue 1.24M (+4.2%), active fleets 318 (+11), churn 2.1% (-0.3)]",
          },
        },
        { kind: "screenshot", payload: { base64: TINY_PNG, mimeType: "image/png" } },
        { kind: "tool_call", payload: { tool: "Write", input: { path: "/work/kpis.md" } } },
        { kind: "tool_result", payload: { tool: "Write", output: "wrote 412 bytes" } },
        {
          kind: "turn_usage",
          payload: {
            model: "demo-large",
            turn: 1,
            inputTokens: 8200,
            outputTokens: 540,
            cacheReadTokens: 6000,
            cacheCreateTokens: 0,
          },
        },
      ]);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary(
          "KPI deltas for the week (from the console dashboard):\n\n- Revenue: $1.24M, +4.2% week over week\n- Active fleets: 318, up 11\n- Churn: 2.1%, down 0.3 points\n\nWritten to /work/kpis.md with the source rows. @chief ready for assembly.",
          { filesChanged: ["/work/kpis.md"], sitesVisited: ["https://ops.example.test"] },
        ),
        usage: usage(8200, 540),
      });
      return;
    }
    if (req.botName === "qa") {
      await events(gw, req, [
        {
          kind: "tool_call",
          payload: {
            tool: "mcp__browser__browser_navigate",
            input: { url: "https://ops.example.test/tickets?priority=P1&status=open" },
          },
        },
        {
          kind: "tool_result",
          payload: { tool: "mcp__browser__browser_navigate", output: "Navigated to Tickets" },
        },
        { kind: "tool_call", payload: { tool: "mcp__browser__browser_snapshot", input: {} } },
        {
          kind: "tool_result",
          payload: {
            tool: "mcp__browser__browser_snapshot",
            output: "- heading 'Open P1 tickets (7)'\n- button 'Export CSV' [ref=e12]",
          },
        },
      ]);
      const approvalId = `apr_demo_${req.runId.slice(-6)}`;
      await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId,
        action: {
          toolName: "mcp__browser__browser_click",
          input: { element: "Export CSV", ref: "e12" },
          targetOrigin: "https://ops.example.test",
          argumentSummary: "click 'Export CSV' on /tickets",
          argumentPattern: "*Export CSV*",
        },
        riskLevel: "L2",
        toolUseId: "toolu_export",
      });
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: `sess-${req.runId}`,
        usage: usage(4100, 180),
        pendingApprovalId: approvalId,
        pendingToolUseId: "toolu_export",
      });
      return;
    }
    // The researcher in its direct chat: the first message is answered, the second fails.
    if (seen.get(key) === 2) {
      await events(gw, req, [
        {
          kind: "tool_call",
          payload: { tool: "Bash", input: { command: "npm run test:regression" } },
        },
        { kind: "log", payload: { text: "sidecar: process exited with code 137 (out of memory)" } },
      ]);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "failed",
        error: "The workspace ran out of memory while running the regression suite (exit 137).",
        usage: usage(1200, 40),
      });
      return;
    }
    await events(gw, req, [
      { kind: "tool_call", payload: { tool: "Bash", input: { command: "cat /work/notes.md" } } },
      {
        kind: "tool_result",
        payload: { tool: "Bash", output: "allowlist: ops.example.test, *.galaxy.example" },
      },
    ]);
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: summary(
        "This workspace can reach **ops.example.test** and **\\*.galaxy.example**. Anything else is blocked at the proxy. I keep the current list in /work/notes.md.\n\nWant me to request an addition?",
      ),
      usage: usage(2100, 160),
    });
  });

  await app.listen({ port: PORT, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${PORT}`;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_TOKEN}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as T;
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  };

  const { workspace } = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
    name: "galaxy-ops",
    egressAllowlist: ["ops.example.test", "*.galaxy.example"],
  });
  const bot = async (name: string, role: string) =>
    (
      await api<{ bot: { id: string } }>("POST", "/api/bots", {
        name,
        role,
        workspaceId: workspace.id,
      })
    ).bot;
  const chief = await bot("chief", "Coordinates the ops team and writes the weekly brief");
  const researcher = await bot("researcher", "Reads dashboards and reports KPI changes");
  const qa = await bot("qa", "Tracks tickets and runs regression checks");
  await api("PATCH", `/api/bots/${qa.id}`, {
    cron: [
      {
        schedule: "0 7 * * 1-5",
        prompt: "Count open P1 tickets and post the number to the Nightly QA thread.",
      },
    ],
  }).catch(() => {});

  const thread = async (title: string, botIds: string[]) =>
    (
      await api<{ thread: { id: string } }>("POST", "/api/threads", {
        workspaceId: workspace.id,
        botIds,
        title,
      })
    ).thread;
  const group = await thread("Weekly ops brief", [chief.id, researcher.id, qa.id]);
  const direct = await thread("Chat with researcher", [researcher.id]);
  chatThreads.add(direct.id);
  await thread("Nightly QA", [qa.id]);

  await api("POST", `/api/threads/${direct.id}/messages`, {
    body: "What is our current egress allowlist?",
  });
  await sleep(2500);
  await api("POST", `/api/threads/${direct.id}/messages`, {
    body: "Run the full regression suite and tell me what breaks.",
  });
  await sleep(2500);
  await api("POST", `/api/threads/${group.id}/messages`, {
    body: "@chief put together this week's ops brief: KPI changes and open P1 tickets. Keep it to one page.",
  });

  await app.deskmates.ctx.auth.bootstrapOwner({
    loginName: DEMO_LOGIN,
    displayName: "Demo operator",
    password: DEMO_PASSWORD,
  });
  console.log(`UI demo Gateway ready on ${base}`);
  console.log(`Sign in as ${DEMO_LOGIN} / ${DEMO_PASSWORD}`);
  console.log(`Run the UI with: OPERATOR_PORT=${PORT} npm run dev:web`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

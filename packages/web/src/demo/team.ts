// The scripted three-bot team: who a message wakes, and what each woken run does. The chief
// delegates in the group, the researcher reads the console, qa asks to click Export CSV and
// waits for the approval; a bot in a private chat gives a short, grounded reply. Timing is
// `setTimeout` plus a little randomness, so the demo looks live.

import {
  APPROVAL_ATTACHMENT_MIME,
  type Approval,
  type ApprovalId,
  type BotDefinition,
  type BotId,
  type RunEvent,
  type RunStatus,
  type RunSummary,
  type Thread,
  type ThreadMessage,
} from "@deskmates/contracts";
import type { GatewayEvent, RunView } from "../api/types.js";
import { type DemoState, TINY_PNG, id, ignoreCancelled, sleep, summary } from "./state.js";

/** Who a message wakes: everyone, the mentioned members, or for a human the owner first. */
export function recipients(
  s: DemoState,
  thread: Thread,
  body: string,
  from: BotId | undefined,
): BotDefinition[] {
  const members = (s.members.get(thread.id) ?? [])
    .map((botId) => s.bots.find((b) => b.id === botId))
    .filter((b): b is BotDefinition => b !== undefined && b.id !== from);
  if (/(?<![\w@])@everyone\b/.test(body)) return members;
  const mentioned = members.filter((b) => new RegExp(`(?<![\\w@])@${b.name}\\b`).test(body));
  if (mentioned.length > 0) return mentioned;
  if (from !== undefined) return [];
  const owner = members.find((b) => b.id === thread.ownerBotId);
  return members.length === 0 ? [] : [owner ?? (members[0] as BotDefinition)];
}

/** Starts one scripted run per woken bot; a lone bot a human addressed becomes the owner. */
export function wake(
  s: DemoState,
  thread: Thread,
  message: ThreadMessage,
  bots: BotDefinition[],
  relay: number,
): RunView[] {
  const runs: RunView[] = [];
  for (const bot of bots) {
    const run = s.newRun(
      bot,
      thread.id,
      "thread_message",
      message.id,
      thread.kind === "bus" ? "background" : "interactive",
    );
    runs.push(run);
    if (!thread.ownerBotId && bots.length === 1 && message.authorKind === "human")
      thread.ownerBotId = bot.id;
    void simulate(s, run, bot, thread, message, relay).catch(ignoreCancelled);
  }
  return runs;
}

async function simulate(
  s: DemoState,
  run: RunView,
  bot: BotDefinition,
  thread: Thread,
  trigger: ThreadMessage,
  relay: number,
): Promise<void> {
  await sleep(400 + Math.random() * 400);
  s.setStatus(run, "running");
  const text = trigger.body.toLocaleLowerCase();
  const groupSize = (s.members.get(thread.id) ?? []).length;
  const step = async (kind: RunEvent["kind"], payload: Record<string, unknown>, wait = 450) => {
    s.addEvent(run, kind, payload);
    await sleep(wait);
  };

  if (bot.name === "chief" && groupSize > 1 && relay === 0 && !s.files.has("/work/ops-brief.md")) {
    await step("thinking", {
      text: "Two inputs are needed: KPI deltas and the open P1 tickets. Delegate both in parallel, then assemble.",
    });
    await step("tool_call", { tool: "Read", input: { path: "/work/brief-template.md" } });
    await step("tool_result", {
      tool: "Read",
      output: "# Weekly ops brief\n\n- KPIs\n- Open tickets\n- Risks",
    });
    const post = s.post(
      thread,
      "bot",
      bot.id,
      "@researcher pull this week's KPI deltas from the Galaxy Ops console (revenue, active fleets, churn). @qa count the open P1 tickets and export the list to /work/p1-tickets.csv.",
      { runId: run.id, relayCount: 1 },
    );
    wake(s, thread, post, recipients(s, thread, post.body, bot.id), relay + 1);
    s.recordUsage(run, 5400, 220);
    s.setStatus(run, "succeeded", {
      summary: summary(
        "Delegated: researcher takes KPIs, qa takes tickets. I will assemble `/work/ops-brief.md` once both report back.",
      ),
    });
    s.post(
      thread,
      "bot",
      bot.id,
      "Delegated: researcher takes KPIs, qa takes tickets. I will assemble `/work/ops-brief.md` once both report back.",
      { runId: run.id, relayCount: 1 },
    );
    return;
  }
  if (bot.name === "chief" && groupSize > 1) {
    // The chief hears a report back and assembles the brief.
    await step("tool_call", { tool: "Read", input: { path: "/work/kpis.md" } });
    await step("tool_result", {
      tool: "Read",
      output: "revenue 1.24M (+4.2%), active fleets 318 (+11), churn 2.1% (-0.3)",
    });
    await step("tool_call", { tool: "Write", input: { path: "/work/ops-brief.md" } });
    s.files.set(
      "/work/ops-brief.md",
      "# Weekly ops brief\n\n## KPIs\n- Revenue $1.24M (+4.2%)\n- Active fleets 318 (+11)\n- Churn 2.1% (-0.3 pt)\n\n## Open P1 tickets\n7 open, list in /work/p1-tickets.csv\n\n## Risks\nChurn improved but two P1s are older than a week.\n",
    );
    await step("tool_result", { tool: "Write", output: "wrote 318 bytes" });
    s.recordUsage(run, 7100, 410);
    const reply =
      "The brief is ready at /work/ops-brief.md.\n\n**KPIs**: revenue $1.24M (+4.2%), active fleets 318 (+11), churn 2.1% (-0.3 pt).\n**Tickets**: 7 open P1s, two older than a week.\n\nWant me to send it anywhere?";
    s.setStatus(run, "succeeded", {
      summary: summary(reply, { filesChanged: ["/work/ops-brief.md"] }),
    });
    s.post(thread, "bot", bot.id, reply, { runId: run.id, relayCount: relay + 1 });
    s.addMemory({
      scope: "task",
      kind: "note",
      threadId: thread.id,
      body: "The weekly brief template lives at /work/brief-template.md; the assembled brief goes to /work/ops-brief.md.",
      authority: "fact",
      trust: "trusted",
      sourceKind: "tool",
      sourceRunId: run.id,
      derivedFrom: [],
      learnedBy: bot.name,
    });
    return;
  }
  if (bot.name === "researcher" && groupSize > 1) {
    await step("tool_call", {
      tool: "mcp__browser__browser_navigate",
      input: { url: "https://ops.example.test/dashboard" },
    });
    await step("tool_result", {
      tool: "mcp__browser__browser_navigate",
      output: "Navigated to Galaxy Ops Console - Dashboard",
    });
    await step("tool_call", { tool: "mcp__browser__browser_snapshot", input: {} });
    await step("tool_result", {
      tool: "mcp__browser__browser_snapshot",
      output:
        "- heading 'Dashboard'\n- table 'KPIs' [revenue 1.24M (+4.2%), active fleets 318 (+11), churn 2.1% (-0.3)]",
    });
    await step("screenshot", {
      base64: TINY_PNG,
      mimeType: "image/png",
      caption: "Dashboard KPI table",
    });
    await step("tool_call", { tool: "Write", input: { path: "/work/kpis.md" } });
    s.files.set(
      "/work/kpis.md",
      "# KPIs this week\n\n| KPI | Value | Change |\n|---|---|---|\n| Revenue | $1.24M | +4.2% |\n| Active fleets | 318 | +11 |\n| Churn | 2.1% | -0.3 pt |\n",
    );
    await step("tool_result", { tool: "Write", output: "wrote 412 bytes" });
    s.recordUsage(run, 8200, 540);
    const reply =
      "KPI deltas for the week (from the console dashboard):\n\n- Revenue: $1.24M, +4.2% week over week\n- Active fleets: 318, up 11\n- Churn: 2.1%, down 0.3 points\n\nWritten to /work/kpis.md with the source rows. @chief ready for assembly.";
    s.setStatus(run, "succeeded", {
      summary: summary(reply, {
        filesChanged: ["/work/kpis.md"],
        sitesVisited: ["https://ops.example.test"],
      }),
    });
    const post = s.post(thread, "bot", bot.id, reply, {
      runId: run.id,
      relayCount: relay + 1,
    });
    s.addMemory({
      scope: "workspace",
      kind: "note",
      body: "The Galaxy Ops console shows the weekly KPI table on /dashboard; figures are week over week.",
      authority: "fact",
      trust: "trusted",
      sourceKind: "tool",
      sourceRunId: run.id,
      derivedFrom: [],
      learnedBy: bot.name,
    });
    if (relay + 1 < 5) wake(s, thread, post, recipients(s, thread, post.body, bot.id), relay + 1);
    return;
  }
  if (bot.name === "qa" && groupSize > 1) {
    await step("tool_call", {
      tool: "mcp__browser__browser_navigate",
      input: { url: "https://ops.example.test/tickets?priority=P1&status=open" },
    });
    await step("tool_result", {
      tool: "mcp__browser__browser_navigate",
      output: "Navigated to Tickets",
    });
    await step("tool_call", { tool: "mcp__browser__browser_snapshot", input: {} });
    await step("tool_result", {
      tool: "mcp__browser__browser_snapshot",
      output: "- heading 'Open P1 tickets (7)'\n- button 'Export CSV' [ref=e12]",
    });
    const action = {
      toolName: "mcp__browser__browser_click",
      input: { element: "Export CSV", ref: "e12" },
      targetOrigin: "https://ops.example.test",
      argumentSummary: "click 'Export CSV' on /tickets",
      argumentPattern: "*Export CSV*",
    };
    const rule = s.rules.find(
      (r) =>
        r.botId === bot.id &&
        r.matcher.toolName === action.toolName &&
        (!r.matcher.targetOrigin || r.matcher.targetOrigin === action.targetOrigin),
    );
    if (rule) {
      s.addEvent(run, "approval", {
        phase: "rule",
        toolName: action.toolName,
        decision: rule.decision,
        ruleId: rule.id,
      });
      if (rule.decision === "allow_always") {
        await finishQaExport(s, run, bot, thread, relay);
        return;
      }
    }
    const approval: Approval = {
      id: id("apr") as ApprovalId,
      kind: "tool",
      runId: run.id,
      botId: bot.id,
      threadId: thread.id,
      action,
      riskLevel: "L2",
      toolUseId: "toolu_export",
      instruction: trigger.body,
      waitMode: "live",
      createdAt: new Date().toISOString(),
    };
    s.approvals.set(approval.id, approval);
    const request = s.post(
      thread,
      "system",
      "",
      `Approval needed: ${action.toolName} on ${action.targetOrigin}\nArguments: ${action.argumentSummary}\nInstruction: ${trigger.body}`,
      {
        attachments: [{ name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: approval.id }],
      },
    );
    approval.messageId = request.id;
    s.addEvent(run, "approval", {
      phase: "requested",
      toolName: action.toolName,
      riskLevel: "L2",
      approvalId: approval.id,
    });
    s.emit({ type: "approval", threadId: thread.id, approval } as GatewayEvent);
    s.recordUsage(run, 4100, 180);
    s.setStatus(run, "waiting_approval_live");
    await sleep(6000);
    if (!approval.decision) {
      approval.waitMode = "deferred";
      s.setStatus(run, "waiting_approval", {
        resumePayload: {
          sdkSessionId: `sess-${run.id}`,
          approvalId: approval.id,
          toolUseId: "toolu_export",
        },
      });
    }
    return;
  }

  // Any bot in a private chat (or a bus thread): a short, grounded reply.
  if (text.includes("regression")) {
    await step("tool_call", { tool: "Bash", input: { command: "npm run test:regression" } });
    await step("log", { text: "sidecar: process exited with code 137 (out of memory)" });
    s.recordUsage(run, 1200, 40);
    s.setStatus(run, "failed", {
      error: "The workspace ran out of memory while running the regression suite (exit 137).",
    });
    return;
  }
  if (text.includes("allowlist") || text.includes("egress")) {
    await step("tool_call", { tool: "Bash", input: { command: "cat /work/notes.md" } });
    await step("tool_result", {
      tool: "Bash",
      output: "allowlist: ops.example.test, *.galaxy.example",
    });
    s.recordUsage(run, 2100, 160);
    const reply =
      "This workspace can reach **ops.example.test** and **\\*.galaxy.example**. Anything else is blocked at the proxy. I keep the current list in /work/notes.md.\n\nWant me to request an addition?";
    s.setStatus(run, "succeeded", { summary: summary(reply) });
    s.post(thread, "bot", bot.id, reply, { runId: run.id, relayCount: relay + 1 });
    return;
  }
  await step("thinking", {
    text: `Reading the request from the operator and checking what ${bot.name} already knows.`,
  });
  await step("tool_call", { tool: "memory_search", input: { q: trigger.body.slice(0, 40) } });
  await step("tool_result", { tool: "memory_search", output: "2 entries" });
  s.recordUsage(run, 1800 + Math.round(Math.random() * 600), 120 + Math.round(Math.random() * 80));
  const reply = cannedReply(bot, trigger.body);
  s.setStatus(run, "succeeded", { summary: summary(reply) });
  s.post(thread, "bot", bot.id, reply, { runId: run.id, relayCount: relay + 1 });
}

function cannedReply(bot: BotDefinition, request: string): string {
  const short = request.length > 60 ? `${request.slice(0, 60)}…` : request;
  switch (bot.name) {
    case "chief":
      return `On it. For "${short}" I would split the work like this:\n\n1. **researcher** gathers the numbers\n2. **qa** verifies the current state\n3. I assemble the result in \`/work/\`\n\nSay the word in the group chat and I will delegate.`;
    case "researcher":
      return `Here is what I can tell you about "${short}":\n\n- The console is the source of truth for KPIs; I read it rather than guess.\n- I keep working notes in /work/notes.md.\n\nAsk me in the group if you want the full brief assembled.`;
    default:
      return `Checked. For "${short}" the current state is clean: 7 open P1 tickets, none new today. I can export the list if you approve the click on **Export CSV**.`;
  }
}

async function finishQaExport(
  s: DemoState,
  run: RunView,
  bot: BotDefinition,
  thread: Thread,
  relay: number,
): Promise<void> {
  s.setStatus(run, "running");
  s.addEvent(run, "tool_call", {
    tool: "mcp__browser__browser_click",
    input: { element: "Export CSV", ref: "e12" },
  });
  await sleep(500);
  s.addEvent(run, "tool_result", {
    tool: "mcp__browser__browser_click",
    output: "Download started: p1-tickets.csv",
  });
  s.files.set(
    "/work/p1-tickets.csv",
    "id,title,age_days\nP1-1041,Fleet sync stalls,9\nP1-1044,Invoice export 500,8\nP1-1052,Login loop on SSO,3\nP1-1055,Map tiles missing,2\nP1-1058,Webhook retries,2\nP1-1060,Slow dashboard,1\nP1-1061,Alert flood,0\n",
  );
  await sleep(400);
  s.addEvent(run, "tool_call", { tool: "Write", input: { path: "/work/p1-tickets.csv" } });
  s.addEvent(run, "tool_result", { tool: "Write", output: "wrote 212 bytes" });
  const reply =
    "7 open P1 tickets; two are older than a week (P1-1041, P1-1044). The list is in /work/p1-tickets.csv. @chief ready for assembly.";
  s.recordUsage(run, 5200, 260);
  s.setStatus(run, "succeeded", {
    summary: summary(reply, { filesChanged: ["/work/p1-tickets.csv"] }),
  });
  const post = s.post(thread, "bot", bot.id, reply, { runId: run.id, relayCount: relay + 1 });
  if (relay + 1 < 5) wake(s, thread, post, recipients(s, thread, post.body, bot.id), relay + 1);
}

/** Resumes the run an approval parked: a denial ends it, an allow finishes the export. */
export async function resumeAfterApproval(
  s: DemoState,
  run: RunView,
  approval: Approval,
): Promise<void> {
  const bot = s.bots.find((b) => b.id === run.botId);
  const thread = run.threadId ? s.thread(run.threadId) : undefined;
  if (!bot || !thread) return;
  await sleep(500);
  run.attempt += 1;
  s.addEvent(run, "approval", {
    phase: "decided",
    toolName: approval.action.toolName,
    decision: approval.decision,
  });
  if (approval.decision === "deny") {
    s.setStatus(run, "running");
    await sleep(600);
    const reply = `Understood, I did not click Export CSV${approval.reason ? ` (${approval.reason})` : ""}. The count stands at 7 open P1 tickets; tell me if you want them another way.`;
    s.setStatus(run, "succeeded", { summary: summary(reply) });
    s.post(thread, "bot", bot.id, reply, { runId: run.id, relayCount: 1 });
    return;
  }
  await finishQaExport(s, run, bot, thread, 1);
}

/** Takes a run with no script from queued through running to `status` in `ms`. */
export async function finishLater(
  s: DemoState,
  run: RunView,
  ms: number,
  result: RunSummary,
  status: RunStatus,
): Promise<void> {
  await sleep(ms / 2);
  s.setStatus(run, "running");
  await sleep(ms / 2);
  s.recordUsage(run, 900, 60);
  s.setStatus(run, status, { summary: result });
}

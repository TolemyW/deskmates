// The core seed: what many features reference. `seedTeam` creates the `galaxy-ops` workspace and
// its three bots; `seedHistory` the chats, runs and pending approvals they produced, and the two
// other workspaces. Feature data (knowledge, skills, tasks, integrations...) is seeded by each
// feature's own demo.ts between and after these two steps (seed.ts).

import {
  APPROVAL_ATTACHMENT_MIME,
  type Approval,
  type ApprovalId,
  type BotDefinition,
  type MessageId,
  type RunEvent,
  type RunStatus,
  type Thread,
  type ThreadMessage,
} from "@deskmates/contracts";
import type { RunView } from "../api/types.js";
import type { DemoSeedContext } from "./feature.js";
import { type DemoState, TINY_PNG, id, minutesAgo, priced, summary } from "./state.js";

/** `galaxy-ops` and its three bots, which every feature seed attaches to. */
export function seedTeam(s: DemoState, now: number): DemoSeedContext {
  const ws = s.addWorkspace(
    "galaxy-ops",
    ["ops.example.test", "*.galaxy.example"],
    minutesAgo(60 * 24 * 9, now),
  );
  const chief = s.addBot(
    "chief",
    "Coordinates the ops team and writes the weekly brief",
    ws.id,
    "# chief\n\nYou coordinate the ops team. Split work between researcher (numbers) and qa (verification), then assemble results in /work. Never guess a figure; cite the file it came from.",
    minutesAgo(60 * 24 * 9, now),
  );
  const researcher = s.addBot(
    "researcher",
    "Reads dashboards and reports KPI changes",
    ws.id,
    "# researcher\n\nYou read the Galaxy Ops console and report numbers with their source. Write findings to /work and keep /work/notes.md current.",
    minutesAgo(60 * 24 * 8, now),
  );
  const qa = s.addBot(
    "qa",
    "Tracks tickets and runs regression checks",
    ws.id,
    "# qa\n\nYou verify the state of tickets and tests. Exporting or changing anything outside the workspace needs an approval; ask, do not work around it.",
    minutesAgo(60 * 24 * 8, now),
  );
  // ADR-0051: the bot people talk to first in this workspace.
  ws.defaultBotId = chief.id;
  chief.avatar = { emoji: "🧭", color: "indigo" };
  researcher.avatar = { emoji: "🔭", color: "teal" };
  qa.avatar = { emoji: "🧪", color: "amber" };
  qa.cron = [
    {
      schedule: "0 7 * * 1-5",
      prompt: "Count open P1 tickets and post the number to the Nightly QA chat.",
    },
  ];
  s.notes.set(chief.id, {
    body: "- Keep briefs to one page.\n- The owner reads them on Monday mornings.\n",
    version: "n1",
  });
  return { now, ws, chief, researcher, qa };
}

/**
 * The chats, runs and approvals the team produced, two weeks of cost history, and the
 * `web-research` and `research-desk` workspaces.
 */
export function seedHistory(s: DemoState, ctx: DemoSeedContext): void {
  const { now, ws, chief, researcher, qa } = ctx;
  // A direct chat with the researcher from earlier today, with one failed run.
  const direct = s.addThread(ws.id, [researcher.id], "", "chat", minutesAgo(190, now));
  direct.ownerBotId = researcher.id;
  const seedRun = (
    bot: BotDefinition,
    thread: Thread | undefined,
    status: RunStatus,
    at: number,
    extra: Partial<RunView>,
    events: [RunEvent["kind"], Record<string, unknown>][],
    tokens: [number, number],
    model = "demo-large",
  ) => {
    const run = s.newRun(
      bot,
      thread?.id,
      thread ? "thread_message" : "cron",
      thread ? "msg_seed" : "0",
      thread?.kind === "bus" || !thread ? "background" : "interactive",
      minutesAgo(at, now),
    );
    run.startedAt = minutesAgo(at - 0.1, now);
    run.finishedAt = minutesAgo(at - 1, now);
    Object.assign(run, { status, ...extra });
    for (const [kind, payload] of events) s.addEvent(run, kind, payload, minutesAgo(at - 0.5, now));
    s.usage.set(run.id, [
      priced({
        runId: run.id,
        model,
        inputTokens: tokens[0],
        outputTokens: tokens[1],
        cacheReadTokens: Math.round(tokens[0] * 0.6),
        cacheCreateTokens: 0,
      }),
    ]);
    return run;
  };
  const seedMessage = (
    thread: Thread,
    kind: ThreadMessage["authorKind"],
    author: string,
    body: string,
    at: number,
    extra: Partial<ThreadMessage> = {},
  ) => {
    const list = s.messages.get(thread.id) ?? [];
    const message: ThreadMessage = {
      id: id("msg") as MessageId,
      threadId: thread.id,
      seq: list.length + 1,
      authorKind: kind,
      authorId: author,
      body,
      attachments: [],
      mentions: [],
      relayCount: 0,
      ts: minutesAgo(at, now),
      ...extra,
    };
    list.push(message);
    thread.updatedAt = message.ts;
    return message;
  };
  seedMessage(direct, "human", "operator", "What is our current egress allowlist?", 188);
  const r1 = seedRun(
    researcher,
    direct,
    "succeeded",
    188,
    {
      summary: summary("This workspace can reach **ops.example.test** and **\\*.galaxy.example**."),
    },
    [
      ["tool_call", { tool: "Bash", input: { command: "cat /work/notes.md" } }],
      ["tool_result", { tool: "Bash", output: "allowlist: ops.example.test, *.galaxy.example" }],
    ],
    [2100, 160],
  );
  seedMessage(
    direct,
    "bot",
    researcher.id,
    "This workspace can reach **ops.example.test** and **\\*.galaxy.example**. Anything else is blocked at the proxy. I keep the current list in /work/notes.md.\n\nWant me to request an addition?",
    187,
    { runId: r1.id },
  );
  seedMessage(
    direct,
    "human",
    "operator",
    "Run the full regression suite and tell me what breaks.",
    120,
  );
  seedRun(
    researcher,
    direct,
    "failed",
    120,
    { error: "The workspace ran out of memory while running the regression suite (exit 137)." },
    [
      ["tool_call", { tool: "Bash", input: { command: "npm run test:regression" } }],
      ["log", { text: "sidecar: process exited with code 137 (out of memory)" }],
    ],
    [1200, 40],
  );
  s.files.set("/work/notes.md", "allowlist: ops.example.test, *.galaxy.example\n");

  // Nightly QA: a scheduled run posted yesterday.
  const nightly = s.addThread(ws.id, [qa.id], "Nightly QA", "chat", minutesAgo(60 * 24 * 6, now));
  nightly.ownerBotId = qa.id;
  const cronRun = seedRun(
    qa,
    undefined,
    "succeeded",
    60 * 14,
    { summary: summary("7 open P1 tickets this morning, none new since yesterday.") },
    [
      [
        "tool_call",
        {
          tool: "mcp__browser__browser_navigate",
          input: { url: "https://ops.example.test/tickets?priority=P1&status=open" },
        },
      ],
      [
        "tool_result",
        { tool: "mcp__browser__browser_snapshot", output: "- heading 'Open P1 tickets (7)'" },
      ],
    ],
    [3100, 90],
  );
  seedMessage(
    nightly,
    "bot",
    qa.id,
    "7 open P1 tickets this morning, none new since yesterday.",
    60 * 14,
    { runId: cronRun.id },
  );

  // Bots talking: a bus thread between qa and researcher.
  const bus = s.addThread(
    ws.id,
    [qa.id, researcher.id],
    "qa ↔ researcher",
    "bus",
    minutesAgo(60 * 20, now),
  );
  seedMessage(
    bus,
    "bot",
    qa.id,
    "@researcher does the dashboard refresh before 07:00 UTC? My count at 06:40 looked stale.",
    60 * 20,
    { relayCount: 1 },
  );
  seedMessage(
    bus,
    "bot",
    researcher.id,
    "@qa it refreshes at 07:00 UTC; read after that. I noted it in my experience.",
    60 * 20 - 3,
    { relayCount: 2 },
  );

  // The group: the operator asked for the brief a few minutes ago; the team is mid-way.
  const group = s.addThread(
    ws.id,
    [chief.id, researcher.id, qa.id],
    "Weekly ops brief",
    "chat",
    minutesAgo(60 * 24 * 7, now),
  );
  group.ownerBotId = chief.id;
  seedMessage(
    group,
    "human",
    "operator",
    "@chief put together this week's ops brief: KPI changes and open P1 tickets. Keep it to one page.",
    6,
  );
  const c1 = seedRun(
    chief,
    group,
    "succeeded",
    6,
    { summary: summary("Delegated: researcher takes KPIs, qa takes tickets.") },
    [
      [
        "thinking",
        {
          text: "Two inputs are needed: KPI deltas and the open P1 tickets. Delegate both, then assemble.",
        },
      ],
      ["tool_call", { tool: "Read", input: { path: "/work/brief-template.md" } }],
      [
        "tool_result",
        { tool: "Read", output: "# Weekly ops brief\n\n- KPIs\n- Open tickets\n- Risks" },
      ],
    ],
    [5400, 220],
  );
  seedMessage(
    group,
    "bot",
    chief.id,
    "@researcher pull this week's KPI deltas from the Galaxy Ops console (revenue, active fleets, churn). @qa count the open P1 tickets and export the list to /work/p1-tickets.csv.",
    5.5,
    { runId: c1.id, relayCount: 1 },
  );
  const r2 = seedRun(
    researcher,
    group,
    "succeeded",
    5,
    {
      summary: summary("KPI deltas written to /work/kpis.md", {
        filesChanged: ["/work/kpis.md"],
        sitesVisited: ["https://ops.example.test"],
      }),
    },
    [
      [
        "tool_call",
        {
          tool: "mcp__browser__browser_navigate",
          input: { url: "https://ops.example.test/dashboard" },
        },
      ],
      [
        "tool_result",
        {
          tool: "mcp__browser__browser_snapshot",
          output:
            "- table 'KPIs' [revenue 1.24M (+4.2%), active fleets 318 (+11), churn 2.1% (-0.3)]",
        },
      ],
      ["screenshot", { base64: TINY_PNG, mimeType: "image/png", caption: "Dashboard KPI table" }],
      ["tool_call", { tool: "Write", input: { path: "/work/kpis.md" } }],
      ["tool_result", { tool: "Write", output: "wrote 412 bytes" }],
    ],
    [8200, 540],
  );
  seedMessage(
    group,
    "bot",
    researcher.id,
    "KPI deltas for the week (from the console dashboard):\n\n- Revenue: $1.24M, +4.2% week over week\n- Active fleets: 318, up 11\n- Churn: 2.1%, down 0.3 points\n\nWritten to /work/kpis.md with the source rows. @chief ready for assembly.",
    4,
    { runId: r2.id, relayCount: 2 },
  );
  s.files.set(
    "/work/kpis.md",
    "# KPIs this week\n\n| KPI | Value | Change |\n|---|---|---|\n| Revenue | $1.24M | +4.2% |\n| Active fleets | 318 | +11 |\n| Churn | 2.1% | -0.3 pt |\n",
  );
  s.addMemory({
    scope: "task",
    kind: "note",
    threadId: group.id,
    body: "This week's KPI source rows are in /work/kpis.md (dashboard read at 07:12 UTC).",
    authority: "fact",
    trust: "trusted",
    sourceKind: "tool",
    sourceRunId: r2.id,
    derivedFrom: [],
    learnedBy: "researcher",
    observedAt: minutesAgo(4, now),
  });
  const q1 = seedRun(
    qa,
    group,
    "waiting_approval",
    5,
    {
      resumePayload: {
        sdkSessionId: "sess-seed",
        approvalId: "apr_seed",
        toolUseId: "toolu_export",
      },
    },
    [
      [
        "tool_call",
        {
          tool: "mcp__browser__browser_navigate",
          input: { url: "https://ops.example.test/tickets?priority=P1&status=open" },
        },
      ],
      [
        "tool_result",
        {
          tool: "mcp__browser__browser_snapshot",
          output: "- heading 'Open P1 tickets (7)'\n- button 'Export CSV' [ref=e12]",
        },
      ],
      [
        "approval",
        { phase: "requested", toolName: "mcp__browser__browser_click", riskLevel: "L2" },
      ],
    ],
    [4100, 180],
  );
  (q1 as { finishedAt?: string | undefined }).finishedAt = undefined;
  const action = {
    toolName: "mcp__browser__browser_click",
    input: { element: "Export CSV", ref: "e12" },
    targetOrigin: "https://ops.example.test",
    argumentSummary: "click 'Export CSV' on /tickets",
    argumentPattern: "*Export CSV*",
  };
  const approval: Approval = {
    id: id("apr") as ApprovalId,
    kind: "tool",
    runId: q1.id,
    botId: qa.id,
    threadId: group.id,
    action,
    riskLevel: "L2",
    toolUseId: "toolu_export",
    instruction: "@qa count the open P1 tickets and export the list to /work/p1-tickets.csv.",
    waitMode: "deferred",
    createdAt: minutesAgo(4.5, now),
  };
  if (q1.resumePayload) q1.resumePayload.approvalId = approval.id;
  s.approvals.set(approval.id, approval);
  const request = seedMessage(
    group,
    "system",
    "",
    `Approval needed: ${action.toolName} on ${action.targetOrigin}\nArguments: ${action.argumentSummary}\nInstruction: ${approval.instruction}`,
    4.5,
    { attachments: [{ name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: approval.id }] },
  );
  approval.messageId = request.id;

  // An egress ask in the researcher's chat (ADR-0020): galaxy-ops is locked to two hosts, and
  // the researcher was sent to read a page elsewhere.
  seedMessage(
    direct,
    "human",
    "operator",
    "Compare our KPI definitions with the Databricks docs on lakehouse metrics.",
    3,
  );
  const e1 = seedRun(
    researcher,
    direct,
    "waiting_approval",
    3,
    {
      resumePayload: { sdkSessionId: "sess-egress", approvalId: "apr_pending" as ApprovalId },
    },
    [
      [
        "tool_call",
        {
          tool: "mcp__browser__browser_navigate",
          input: { url: "https://docs.databricks.com/lakehouse/metrics" },
        },
      ],
      [
        "approval",
        { phase: "requested", toolName: "mcp__browser__browser_navigate", riskLevel: "L2" },
      ],
    ],
    [1800, 60],
  );
  (e1 as { finishedAt?: string | undefined }).finishedAt = undefined;
  const egressAction = {
    toolName: "mcp__browser__browser_navigate",
    input: { url: "https://docs.databricks.com/lakehouse/metrics" },
    targetOrigin: "https://docs.databricks.com",
    argumentSummary: "open https://docs.databricks.com/lakehouse/metrics",
    argumentPattern: "docs.databricks.com",
  };
  const egressAsk: Approval = {
    id: id("apr") as ApprovalId,
    kind: "egress",
    runId: e1.id,
    botId: researcher.id,
    threadId: direct.id,
    action: egressAction,
    riskLevel: "L2",
    toolUseId: "toolu_egress",
    instruction: "Compare our KPI definitions with the Databricks docs on lakehouse metrics.",
    waitMode: "deferred",
    createdAt: minutesAgo(2.5, now),
  };
  if (e1.resumePayload) e1.resumePayload.approvalId = egressAsk.id;
  s.approvals.set(egressAsk.id, egressAsk);
  const egressRequest = seedMessage(
    direct,
    "system",
    "",
    `Approval needed: ${egressAction.toolName} on ${egressAction.targetOrigin}\nArguments: ${egressAction.argumentSummary}\nInstruction: ${egressAsk.instruction}`,
    2.5,
    {
      attachments: [{ name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: egressAsk.id }],
    },
  );
  egressAsk.messageId = egressRequest.id;

  // Two weeks of history for the cost page: the nightly count on the cheap model, a daily
  // KPI read on the main one.
  for (let day = 2; day <= 14; day += 1) {
    seedRun(
      qa,
      undefined,
      "succeeded",
      60 * 24 * day - 7 * 60,
      { summary: summary(`${5 + (day % 4)} open P1 tickets.`) },
      [],
      [3200 + (day % 3) * 400, 120 + (day % 5) * 20],
      "demo-small",
    );
    if (day % 2 === 0) {
      seedRun(
        researcher,
        undefined,
        "succeeded",
        60 * 24 * day - 8 * 60,
        { summary: summary("KPI table read and written to /work/kpis.md.") },
        [],
        [9800 + (day % 4) * 900, 640 + (day % 3) * 80],
      );
    }
  }

  // A second workspace: an untrusted-browsing computer with one bot, kept apart from the ops
  // team so it never shares their logins. It shows what the sidebar switcher is for.
  const research = s.addWorkspace("web-research", ["*"], minutesAgo(60 * 24 * 2, now));
  const scout = s.addBot(
    "scout",
    "Reads public sites and summarises what changed",
    research.id,
    "# scout\n\nYou browse the public internet on an untrusted computer. Never enter credentials; report what you read with the URL it came from.",
    minutesAgo(60 * 24 * 2, now),
  );
  scout.avatar = { emoji: "🛰️", color: "violet" };
  const scouting = s.addThread(research.id, [scout.id], "", "chat", minutesAgo(60 * 20, now));
  scouting.ownerBotId = scout.id;
  seedMessage(
    scouting,
    "human",
    "operator",
    "Check the three competitor pricing pages and tell me if anything changed this week.",
    60 * 20,
  );
  const s1 = seedRun(
    scout,
    scouting,
    "succeeded",
    60 * 20,
    {
      summary: summary(
        "Two of three pricing pages changed: one added a usage tier, one raised its entry plan.",
      ),
    },
    [
      [
        "tool_call",
        { tool: "mcp__browser__browser_navigate", input: { url: "https://a.example/pricing" } },
      ],
      ["tool_result", { tool: "mcp__browser__browser_navigate", output: "Pricing - A" }],
    ],
    [5400, 320],
  );
  seedMessage(
    scouting,
    "bot",
    scout.id,
    "Two of the three changed this week:\n\n- **a.example** added a usage-based tier between Starter and Team.\n- **b.example** raised the entry plan from $19 to $24 a month.\n- **c.example** is unchanged.\n\nSources are in /work/pricing-2026-10-02.md with the URLs.",
    60 * 20 - 1,
    { runId: s1.id },
  );
  // The researcher's and scout's chats are already their canonical inboxes; chief and qa have
  // none yet and appear as unopened entries.
  s.privateChats.set(researcher.id, direct.id);
  s.privateChats.set(scout.id, scouting.id);

  // A third workspace for the Chats rail (issue #29): four bots and only one group chat, no
  // private chat resolved yet, so the rail draws four unopened inboxes from the bot rows. One
  // handle and role are long on purpose to show truncation.
  const desk = s.addWorkspace("research-desk", ["*"], minutesAgo(60 * 24, now));
  const deskBots = [
    s.addBot("lead", "Coordinates the market study", desk.id, "", minutesAgo(60 * 24, now)),
    s.addBot("filings", "Reads annual reports", desk.id, "", minutesAgo(60 * 24, now)),
    s.addBot("pricing", "Tracks list prices", desk.id, "", minutesAgo(60 * 24, now)),
    s.addBot(
      "regional_market_sentiment_watcher",
      "Summarises regional news, forum threads and analyst notes into a weekly sentiment score",
      desk.id,
      "",
      minutesAgo(60 * 24, now),
    ),
  ];
  const [lead] = deskBots;
  if (lead) lead.avatar = { emoji: "📚", color: "indigo" };
  const study = s.addThread(
    desk.id,
    deskBots.map((b) => b.id),
    "Quarterly market research: competitor pricing, filings and regional sentiment",
    "chat",
    minutesAgo(90, now),
  );
  if (lead) {
    study.ownerBotId = lead.id;
    seedMessage(
      study,
      "human",
      "operator",
      "@lead compare the three competitors' pricing, filings and regional sentiment.",
      90,
    );
    seedMessage(
      study,
      "bot",
      lead.id,
      "Split the work: @filings reads the reports, @pricing checks list prices, @regional_market_sentiment_watcher scores sentiment. Draft in /work/market-study.md.",
      88,
    );
  }
  // ADR-0051: chief is the workspace's default bot; its notice of a change it made to a teammate.
  // A fixed id, so the ids of every later seed stay as they were.
  const notices = s.messages.get(group.id) ?? [];
  notices.push({
    id: "msg_default_bot_notice" as MessageId,
    threadId: group.id,
    seq: notices.length + 1,
    authorKind: "system",
    authorId: "",
    body: `@${chief.name} updated @${qa.name}: schedules.`,
    attachments: [],
    mentions: [],
    relayCount: 0,
    ts: minutesAgo(1, now),
  });
  s.messages.set(group.id, notices);
  group.updatedAt = minutesAgo(1, now);
  // Keep chats ordered by recency in the rail.
  s.threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

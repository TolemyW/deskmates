// @vitest-environment node
// (jsdom's Blob has no text(); `npm test -w packages/web` runs with --environment jsdom.)
//
// Golden record of the demo Gateway: every list and detail route the UI reads, for each cost-alert
// fixture, then a scripted session through every feature (chat with the scripted team, approvals,
// tasks, skills, members, knowledge, integrations, costs, the computer) and the events it
// emitted. Time, timers and randomness are fixed, so a refactor of the demo that changes no
// behaviour leaves the record unchanged.
//
// Each response is filed under the feature that answers it, in
// `src/features/<feature>/__snapshots__/demo.golden.jsonl` (core routes and misses in
// `src/demo/__snapshots__/core.golden.jsonl`), so a feature's deliberate demo change rewrites only
// its own file. The event order, which catches seed-order and scripted-team changes, is in
// `src/demo/__snapshots__/events.golden.jsonl`. Update with `-u`.

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "../api/types.js";
import { DEMO_FEATURES, DEMO_FEATURE_NAMES } from "./features.js";
import type { CostAlertFixture } from "./mock-gateway.js";
import { demoRequest } from "./router.js";
import { DemoState } from "./state.js";

interface Entry {
  request: string;
  body?: unknown;
  status: number;
  json?: unknown;
  text?: string;
}

type Json = Record<string, unknown>;

/** One JSON line per record keeps the snapshot compact and its diffs readable. */
const lines = (records: unknown[]): string => records.map((r) => JSON.stringify(r)).join("\n");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A fresh module instance, so the demo's id counter starts at zero for every scenario. */
async function start(fixture: CostAlertFixture) {
  vi.resetModules();
  const { MockGateway } = await import("./mock-gateway.js");
  const events: GatewayEvent[] = [];
  const gw = new MockGateway((event) => events.push(clone(event)), fixture);
  const log: Entry[] = [];
  const call = async (method: string, path: string, body?: unknown): Promise<Json> => {
    const result = await gw.handle(method, path, body);
    const entry: Entry = { request: `${method} ${path}`, status: result.status };
    if (body !== undefined) entry.body = clone(body);
    if (result.json !== undefined) entry.json = clone(result.json);
    if (result.blob) entry.text = await result.blob.text();
    log.push(entry);
    return (entry.json ?? {}) as Json;
  };
  return { events, log, call };
}

type Call = Awaited<ReturnType<typeof start>>["call"];

const ids = (list: unknown, key = "id"): string[] =>
  ((list ?? []) as Json[]).map((item) => String(item[key]));

/** GET every list and detail route the UI uses; `deep` adds every run and approval detail. */
async function sweep(call: Call, deep: boolean): Promise<void> {
  const workspaces = ids((await call("GET", "/api/workspaces")).workspaces);
  for (const path of [
    "/api/config",
    "/api/members",
    "/api/invitations",
    "/api/bots",
    "/api/threads",
    "/api/approvals?status=pending",
    "/api/approvals?status=decided",
    "/api/costs",
    "/api/cost-alert-rules",
    "/api/cost-alerts?status=open",
    "/api/knowledge",
    "/api/knowledge?q=brief",
    "/api/knowledge/proposals",
    "/api/knowledge/proposals?status=pending",
    "/api/memory-suggestions",
    "/api/memory-suggestions?status=applied",
    "/api/integrations",
    "/api/integrations/catalog",
    "/api/connectors",
    "/api/network-profiles",
    "/api/prices",
  ])
    await call("GET", path);
  const bots = ids((await call("GET", "/api/bots")).bots);
  const threads = ids((await call("GET", "/api/threads")).threads);
  const runs = ids((await call("GET", "/api/runs")).runs);
  const approvals = ids((await call("GET", "/api/approvals?status=all")).approvals);
  const documents = ids((await call("GET", "/api/knowledge")).documents);
  for (const ws of workspaces) {
    await call("GET", `/api/workspaces/${ws}`);
    await call("GET", `/api/bots?workspaceId=${ws}`);
    await call("GET", `/api/threads?workspaceId=${ws}`);
    await call("GET", `/api/connectors?workspaceId=${ws}`);
    const tasks = ids((await call("GET", `/api/workspaces/${ws}/tasks`)).tasks);
    for (const task of tasks) await call("GET", `/api/workspaces/${ws}/tasks/${task}`);
    await call("GET", `/api/workspaces/${ws}/assets`);
    await call("GET", `/api/workspaces/${ws}/assets?type=images&source=bot`);
    await call("GET", `/api/workspaces/${ws}/assets?q=report&limit=2&offset=1`);
    const skills = ids((await call("GET", `/api/workspaces/${ws}/skills`)).skills);
    for (const skill of skills) await call("GET", `/api/skills/${skill}/versions`);
    const entries = ids(
      (await call("GET", `/api/workspaces/${ws}/memory?includeForgotten=1`)).entries,
    );
    for (const entry of entries) await call("GET", `/api/memory/entries/${entry}/versions`);
    await call("GET", `/api/workspaces/${ws}/memory?scope=workspace`);
    await call("GET", `/api/workspaces/${ws}/memory/search?q=the`);
    await call("GET", `/api/integrations/workspaces/${ws}/connections`);
    await call("GET", `/api/workspaces/${ws}/app-shares`);
    await call("GET", `/api/workspaces/${ws}/board`);
    await call("GET", `/api/workspaces/${ws}/limits`);
    await call("GET", `/api/workspaces/${ws}/network`);
    await call("GET", `/api/workspaces/${ws}/workdir`);
    for (const file of ["/work/notes.md", "/work/kpis.md", "/work/ops-brief.md", "/nope"])
      await call("GET", `/api/workspaces/${ws}/files?path=${encodeURIComponent(file)}`);
  }
  for (const bot of bots)
    for (const leaf of ["soul", "memory", "screen", "approval-rules"])
      await call("GET", `/api/bots/${bot}/${leaf}`);
  await call("GET", `/api/runs?botId=${bots[1]}`);
  for (const thread of threads) {
    await call("GET", `/api/threads/${thread}`);
    await call("GET", `/api/threads/${thread}/messages`);
    await call("GET", `/api/threads/${thread}/activity`);
  }
  await call("GET", `/api/threads/${threads[0]}/messages?afterSeq=2`);
  await call("GET", `/api/runs?threadId=${threads[0]}`);
  await call("GET", `/api/approvals?status=all&threadId=${threads[0]}`);
  for (const document of documents) {
    await call("GET", `/api/knowledge/${document}`);
    await call("GET", `/api/knowledge/${document}/history`);
  }
  if (!deep) return;
  for (const run of runs) {
    await call("GET", `/api/runs/${run}`);
    await call("GET", `/api/runs/${run}/events`);
    await call("GET", `/api/runs/${run}/context`);
  }
  await call("GET", `/api/runs/${runs[0]}/events?afterSeq=1`);
  for (const approval of approvals) await call("GET", `/api/approvals/${approval}`);
}

/** Routes that are absent, or present for another method, answer as before. */
async function misses(call: Call): Promise<void> {
  const ws = ids((await call("GET", "/api/workspaces")).workspaces)[0];
  const bot = ids((await call("GET", "/api/bots")).bots)[0];
  for (const [method, path] of [
    ["GET", "/api/nothing-here"],
    ["PUT", "/api/bots"],
    ["GET", `/api/bots/${bot}`],
    ["GET", "/api/bots/bot_missing/soul"],
    ["DELETE", "/api/threads"],
    ["POST", `/api/workspaces/${ws}/assets`],
    ["PUT", `/api/workspaces/${ws}/tasks`],
    ["GET", "/api/workspaces/ws_missing/tasks"],
    ["GET", "/api/threads/thr_missing"],
    ["GET", "/api/runs/run_missing"],
    ["POST", "/api/runs/run_missing/cancel"],
    ["GET", "/api/approvals/apr_missing"],
    ["GET", "/api/approval-rules/rul_missing"],
    ["PATCH", "/api/knowledge/proposals"],
    ["GET", "/api/knowledge/doc_missing/history"],
    ["GET", "/api/memory/entries/mem_missing"],
    ["POST", "/api/memory-suggestions/sug_missing/review"],
    ["GET", "/api/skills/skill_missing"],
    ["GET", "/api/integrations/providers/github"],
    ["PATCH", "/api/members/usr_missing"],
    ["DELETE", "/api/invitations/inv_missing"],
    ["POST", "/api/cost-alerts/cal_missing/acknowledge"],
    ["GET", "/api/threads/thr_missing/activity"],
    ["POST", "/api/threads/thr_missing/activity"],
  ] as const)
    await call(method, path, method === "GET" ? undefined : {});
}

async function scriptedSession(call: Call, advance: (ms: number) => Promise<void>): Promise<void> {
  const workspaces = (await call("GET", "/api/workspaces")).workspaces as Json[];
  const ws = String(workspaces[0]?.id);
  const other = String(workspaces[1]?.id);
  const bots = (await call("GET", "/api/bots")).bots as Json[];
  const bot = (name: string) => String(bots.find((b) => b.name === name)?.id);
  const threads = (await call("GET", "/api/threads")).threads as Json[];
  const thread = (pick: (t: Json) => boolean) => String(threads.find(pick)?.id);
  const direct = thread(
    (t) => (t.memberIds as string[]).join() === bot("researcher") && t.kind === "chat",
  );
  const group = thread((t) => t.title === "Weekly ops brief");
  const nightly = thread((t) => t.title === "Nightly QA");
  const pendingIds = async () =>
    ids((await call("GET", "/api/approvals?status=pending")).approvals);
  const seededApprovals = await pendingIds();

  // Chat: a private reply, then the group delegation with its live approval wait.
  await call("POST", `/api/threads/${direct}/messages`, { body: "hello there" });
  await advance(5000);
  await call("POST", `/api/threads/${nightly}/messages`, { body: "run the regression suite" });
  await advance(5000);
  await call("POST", `/api/threads/${nightly}/messages`, { body: "what is the egress allowlist?" });
  await advance(5000);
  await call("POST", `/api/threads/${group}/messages`, {
    body: "@chief put the brief together again please",
  });
  await advance(30_000);
  const fresh = (await pendingIds()).filter((id) => !seededApprovals.includes(id));
  for (const id of fresh)
    await call("POST", `/api/approvals/${id}/decide`, { decision: "allow_always" });
  await advance(30_000);
  // The seeded asks: deny the tool click, allow the egress site; egress refuses allow_once.
  const [toolAsk, egressAsk] = seededApprovals;
  await call("POST", `/api/approvals/${egressAsk}/decide`, { decision: "allow_once" });
  await call("POST", `/api/approvals/${toolAsk}/decide`, {
    decision: "deny",
    reason: "not this week",
  });
  await call("POST", `/api/approvals/${toolAsk}/decide`, { decision: "deny" });
  await call("POST", `/api/approvals/${egressAsk}/decide`, { decision: "allow_always" });
  await advance(10_000);
  await call("POST", `/api/threads/${group}/messages`, { body: "@qa export again" });
  await advance(30_000);
  await call("POST", `/api/threads/${group}/close-task`, {});
  await call("POST", `/api/threads/${direct}/close-task`, {});

  // Runs: cancel a fresh run, continue and stop.
  const posted = await call("POST", `/api/threads/${direct}/messages`, { body: "cancel me" });
  const runId = String((posted.runs as Json[])[0]?.id);
  await call("POST", `/api/runs/${runId}/cancel`, {});
  await advance(5000);
  await call("POST", `/api/runs/${runId}/cancel`, {});
  const second = await call("POST", `/api/threads/${direct}/messages`, { body: "keep going" });
  const secondId = String((second.runs as Json[])[0]?.id);
  await call("POST", `/api/runs/${secondId}/continuation/decide`, { decision: "continue" });
  await advance(5000);
  await call("POST", `/api/runs/${secondId}/continuation/decide`, { decision: "stop" });

  // Threads: create, membership, canonical private chats.
  const made = await call("POST", "/api/threads", {
    workspaceId: ws,
    botIds: [bot("chief")],
    title: "Scratch",
  });
  const madeId = String((made.thread as Json).id);
  await call("POST", `/api/threads/${madeId}/members`, { botIds: [bot("qa")] });
  await call("DELETE", `/api/threads/${madeId}/members/${bot("qa")}`);
  await call("POST", `/api/bots/${bot("chief")}/private-chat`);
  await call("POST", `/api/bots/${bot("researcher")}/private-chat`);
  await call("POST", `/api/threads/${madeId}/members`, { botIds: [bot("researcher")] });
  await call("POST", `/api/bots/${bot("chief")}/private-chat`);
  await call("POST", "/api/bots/bot_missing/private-chat");

  // Tasks.
  const tasks = `/api/workspaces/${ws}/tasks`;
  await call("POST", tasks, { title: "  " });
  const createdTask = await call("POST", tasks, {
    title: "Review the brief",
    ownerBotId: bot("chief"),
  });
  const task = `${tasks}/${String((createdTask.task as Json).id)}`;
  await call("PATCH", task, { version: 1, status: "blocked" });
  await call("PATCH", task, { version: 1, status: "accepted" });
  await call("PATCH", task, { version: 1, status: "delivered" });
  await call("PATCH", task, {
    version: 1,
    status: "delivered",
    artifacts: [{ label: "Brief", path: "/work/ops-brief.md" }],
  });
  await call("POST", `${task}/accept`, { version: 2 });
  await call("PATCH", task, { version: 3, title: "edited" });
  await call("PATCH", task, { version: 3, status: "in_progress" });
  await call("POST", `${task}/accept`, { version: 4 });
  await call("GET", `/api/workspaces/${other}/tasks`);

  // Skills.
  const skills = `/api/workspaces/${ws}/skills`;
  await call("POST", skills, {
    files: [
      {
        path: "SKILL.md",
        content: "---\nname: triage\ndescription: Sort the inbox\n---\n\nSteps.\n",
      },
    ],
    botIds: [bot("qa")],
    sha256: "abc",
    provenance: "demo",
  });
  await call("POST", "/api/skills/skill_fetch_rates/versions/1/confirm");
  await call("POST", "/api/skills/skill_ticket_export/versions/9/reject");
  await call("POST", "/api/skills/skill_ticket_export/assign", { botIds: [bot("qa")] });
  await call("POST", "/api/skills/skill_weekly_brief/undo");
  await call("PATCH", "/api/skills/skill_weekly_brief", { stage: "retired", pinned: false });
  await call("GET", "/api/skills/skill_weekly_brief");

  // Members.
  await call("POST", "/api/invitations", { role: "owner" });
  const invite = await call("POST", "/api/invitations", { role: "member" });
  await call("POST", "/api/invitations", {
    role: "admin",
    target: { kind: "oidc_email", providerId: "idp", email: "a@example.test" },
  });
  await call("DELETE", `/api/invitations/${String((invite.invitation as Json).id)}`);
  await call("DELETE", `/api/invitations/${String((invite.invitation as Json).id)}`);
  await call("POST", "/api/accounts", { loginName: "Bad Name", role: "member" });
  await call("POST", "/api/accounts", { loginName: "jo", role: "owner" });
  await call("POST", "/api/accounts", { loginName: "Jo.Doe", displayName: " Jo ", role: "admin" });
  await call("POST", "/api/accounts", { loginName: "jo.doe", role: "member" });
  await call("PATCH", "/api/members/usr_maya", { role: "boss" });
  await call("PATCH", "/api/members/usr_maya", { status: "active" });
  await call("PATCH", "/api/members/usr_maya", { role: "admin" });
  await call("PATCH", "/api/members/usr_maya", { status: "removed" });

  // Contacts: bots, SOUL, MEMORY.md, consolidation; approvals: rules.
  const createdBot = await call("POST", "/api/bots", {
    name: "helper",
    role: "Helps",
    workspaceId: ws,
    model: "demo-small",
    avatar: { emoji: "🙂", color: "teal" },
  });
  const helper = String((createdBot.bot as Json).id);
  await call("PATCH", `/api/bots/${helper}`, {
    model: "",
    cheapModel: "demo-small",
    cron: [{ schedule: "0 9 * * *", prompt: "hi" }],
    role: "Helps more",
    avatar: null,
  });
  await call("PATCH", `/api/bots/${helper}`, { model: "demo-large", cheapModel: null });
  await call("PATCH", "/api/bots/bot_missing", {});
  await call("PATCH", `/api/bots/${helper}/soul`, { expectedVersion: "v9", body: "x" });
  await call("PATCH", `/api/bots/${helper}/soul`, { expectedVersion: "v0", body: "# helper" });
  await call("PATCH", `/api/bots/${helper}/memory`, { expectedVersion: "n9", body: "x" });
  await call("PATCH", `/api/bots/${helper}/memory`, { expectedVersion: "n0", body: "- note" });
  await call("POST", `/api/bots/${helper}/memory/consolidate`);
  await advance(5000);
  const rule = await call("POST", `/api/bots/${helper}/approval-rules`, {
    matcher: { toolName: "Bash" },
    decision: "allow_always",
  });
  await call("GET", `/api/bots/${helper}/approval-rules`);
  await call("DELETE", `/api/approval-rules/${String((rule.rule as Json).id)}`);

  // Knowledge and learned memory.
  const proposal = await call("POST", "/api/knowledge/proposals", { title: "T", body: "B" });
  await call("POST", `/api/knowledge/proposals/${String((proposal.proposal as Json).id)}/review`, {
    decision: "approve",
  });
  const rejected = await call("POST", "/api/knowledge/proposals", { title: "R", body: "no" });
  await call("POST", `/api/knowledge/proposals/${String((rejected.proposal as Json).id)}/review`, {
    decision: "reject",
  });
  const documents = ids((await call("GET", "/api/knowledge")).documents);
  await call("PATCH", `/api/knowledge/${documents[0]}`, { body: "edited body" });
  await call("POST", "/api/knowledge/versions/cleanup", {});
  const suggestions = ids((await call("GET", "/api/memory-suggestions")).suggestions);
  for (const id of suggestions)
    await call("POST", `/api/memory-suggestions/${id}/review`, { decision: "apply" });
  const entries = ids((await call("GET", `/api/workspaces/${ws}/memory`)).entries);
  await call("PATCH", `/api/memory/entries/${entries[0]}`, { body: "changed", expectedVersion: 9 });
  await call("PATCH", `/api/memory/entries/${entries[0]}`, { body: "changed", expectedVersion: 1 });
  await call("POST", `/api/memory/entries/${entries[0]}/undo`);
  await call("POST", `/api/memory/entries/${entries[1]}/confirm`);
  await call("POST", `/api/memory/entries/${entries[2]}/forget`);

  // Integrations.
  await call("POST", "/api/integrations/providers", { service: "notion" });
  await call("POST", "/api/integrations/providers", { service: "nope" });
  await call("DELETE", "/api/integrations/providers/slack");
  const connection = await call("POST", `/api/integrations/workspaces/${ws}/connections/api-key`, {
    service: "notion",
    connectionName: "team",
  });
  await call("POST", `/api/integrations/workspaces/${ws}/connections/oauth/start`, {
    service: "github",
  });
  await call(
    "DELETE",
    `/api/integrations/workspaces/${ws}/connections/${String((connection.connection as Json).id)}`,
  );
  await call("DELETE", `/api/integrations/workspaces/${ws}/connections/icn_missing`);
  await call("POST", "/api/connectors", { workspaceId: ws, name: "warehouse", publicUrl: true });

  // Costs.
  await call("GET", `/api/costs?botId=${bot("qa")}`);
  await call("GET", "/api/costs?model=demo-small");
  const costRule = await call("POST", "/api/cost-alert-rules", {
    kind: "known_cost",
    window: "day",
    botId: bot("qa"),
    thresholdUsd: 5,
  });
  await call("POST", "/api/cost-alert-rules", { kind: "unpriced_usage", window: "month" });
  await call("DELETE", `/api/cost-alert-rules/${String((costRule.rule as Json)?.id)}`);
  const alerts = ids((await call("GET", "/api/cost-alerts?status=open")).alerts);
  if (alerts[0]) await call("POST", `/api/cost-alerts/${alerts[0]}/acknowledge`, {});

  // Computer and workspaces.
  await call("POST", `/api/workspaces/${ws}/takeover`, {});
  await call("GET", `/api/workspaces/${ws}`);
  await call("GET", `/api/bots/${bot("chief")}/screen`);
  await call("POST", `/api/bots/${bot("chief")}/screen/start`, {});
  await call("POST", `/api/bots/${bot("chief")}/screen/access`, {});
  await call("POST", "/api/screen-access/acc_1/close", {});
  await call("POST", `/api/workspaces/${ws}/takeover/open-screen`, {});
  await call("POST", `/api/workspaces/${ws}/handback`, {});
  const workspace = await call("POST", "/api/workspaces", { name: "sandbox" });
  await call("POST", "/api/workspaces", {});
  await call("PATCH", `/api/workspaces/${String((workspace.workspace as Json).id)}`, {
    egressAllowlist: ["example.test"],
  });
  await call("GET", "/api/workspaces/ws_missing");
  await advance(60_000);
}

// ---------- the record, one file per owner ----------

interface Scenario {
  fixture: CostAlertFixture;
  section: string;
  log: Entry[];
}

/**
 * The demo feature that answers a request, `core` for core routes and misses. It asks the
 * features of this checkout on a scratch state, so the record of the pre-split class is split
 * the same way.
 */
function ownerOf(fixture: CostAlertFixture, request: string): string {
  const [method = "", path = ""] = request.split(" ");
  const state = new DemoState(() => {}, fixture);
  const index = DEMO_FEATURES.findIndex((feature) => {
    try {
      return feature.route?.(demoRequest(method, path, {}), state) !== undefined;
    } catch {
      return true;
    }
  });
  return index <= 0 ? "core" : (DEMO_FEATURE_NAMES[index - 1] ?? "core");
}

/** Where an owner's record lives: next to the feature's demo.ts, or in src/demo for core. */
function snapshotPath(owner: string): string {
  return owner === "core"
    ? "./__snapshots__/core.golden.jsonl"
    : `../features/${owner}/__snapshots__/demo.golden.jsonl`;
}

/** An emitted event without its payload: ids, kinds and states, in order. */
function eventLine(event: GatewayEvent): string {
  const e = event as unknown as Json;
  const run = e.run as Json | undefined;
  const runEvent = e.event as Json | undefined;
  const message = e.message as Json | undefined;
  const approval = e.approval as Json | undefined;
  const parts = [String(e.type)];
  if (run) parts.push(`${run.id} ${run.status}`);
  if (runEvent) parts.push(`${runEvent.runId} #${runEvent.seq} ${runEvent.kind}`);
  if (message) parts.push(`${message.id} #${message.seq} ${message.authorKind}`);
  if (approval) parts.push(`${approval.id} ${approval.decision ?? "pending"}`);
  if (e.workspaceId) parts.push(String(e.workspaceId));
  if (e.threadId) parts.push(`in ${e.threadId}`);
  return parts.join(" ");
}

const costAlert = (entry: Entry) => entry.request.includes("/api/cost-alert");

describe("MockGateway golden record", () => {
  const scenarios: Scenario[] = [];
  const events: Record<string, string[]> = {};
  const fixtureDiffs: Record<string, { responses: boolean; events: boolean }> = {};

  beforeAll(async () => {
    vi.useFakeTimers({ now: new Date("2026-10-12T09:00:00.000Z") });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const base = await start("empty");
      await sweep(base.call, true);
      const plain = base.log.filter((entry) => !costAlert(entry));
      const plainEvents = [...base.events];
      await misses(base.call);
      scenarios.push({ fixture: "empty", section: "seed", log: base.log });
      events.seed = base.events.map(eventLine);

      for (const fixture of ["populated", "failure"] as const) {
        const run = await start(fixture);
        await sweep(run.call, true);
        fixtureDiffs[fixture] = {
          responses:
            JSON.stringify(run.log.filter((entry) => !costAlert(entry))) !== JSON.stringify(plain),
          events: JSON.stringify(run.events) !== JSON.stringify(plainEvents),
        };
        const alerts = ids((await run.call("GET", "/api/cost-alerts?status=open")).alerts);
        await run.call("POST", `/api/cost-alerts/${alerts[0]}/acknowledge`, {});
        await run.call("GET", "/api/cost-alerts?status=open");
        scenarios.push({ fixture, section: `fixture ${fixture}`, log: run.log.filter(costAlert) });
      }

      const session = await start("populated");
      session.events.length = 0;
      await scriptedSession(session.call, (ms) =>
        vi.advanceTimersByTimeAsync(ms).then(() => undefined),
      );
      scenarios.push({ fixture: "populated", section: "session", log: [...session.log] });
      events.session = session.events.map(eventLine);
      session.log.length = 0;
      await sweep(session.call, true);
      scenarios.push({ fixture: "populated", section: "after session", log: session.log });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("differs between cost-alert fixtures only in cost alerts", () => {
    expect(fixtureDiffs).toEqual({
      populated: { responses: false, events: false },
      failure: { responses: false, events: false },
    });
  });

  it("emits the same events in the same order", async () => {
    const text = Object.entries(events)
      .flatMap(([section, list]) => list.map((event) => JSON.stringify({ section, event })))
      .join("\n");
    await expect(`${text}\n`).toMatchFileSnapshot("./__snapshots__/events.golden.jsonl");
  });

  for (const owner of ["core", ...DEMO_FEATURE_NAMES]) {
    it(`answers the ${owner} routes as recorded`, async () => {
      const records = scenarios.flatMap(({ fixture, section, log }) =>
        log
          .filter((entry) => ownerOf(fixture, entry.request) === owner)
          .map((entry) => JSON.stringify({ section, ...entry })),
      );
      expect(records.length).toBeGreaterThan(0);
      await expect(`${records.join("\n")}\n`).toMatchFileSnapshot(snapshotPath(owner));
    });
  }
});

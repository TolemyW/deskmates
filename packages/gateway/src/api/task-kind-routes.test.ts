// T1 (ADR-0021 amendment 4): task templates are task kinds. Admins manage templates (audited,
// versioned, built-ins read-only); a create from a template stamps the kind, stores the fields
// and appends the labelled criteria to the description, and changes nothing for a task without
// one; the kind view counts, times, judges the target and names stalls from Gateway rows; related
// tasks come from equal field values and text similarity, lexical or through a fake embedding
// service, recorded in `retrieval_calls`. Members read the views, Guests do not, and a private
// chat's delivery summary never reaches them.

import type {
  RelatedTaskList,
  RunId,
  Task,
  TaskDetailResponse,
  TaskKindList,
  TaskKindStats,
  TaskSubmitResponse,
  TaskTemplate,
  TaskTemplateList,
  WorkspaceId,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RETRIEVAL_DEFAULTS } from "../config/retrieval.js";
import { HybridRetrieval } from "../retrieval/hybrid-retrieval.js";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { FAKE_EMBEDDING, FakeRetrievalService } from "../test-support/fake-retrieval.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const custom = {
  kind: "invoice-check",
  name: "Invoice check",
  description: "Check one supplier invoice.",
  stages: [
    { key: "check", name: "Check", criteria: ["Totals match the order"], checkpointRequired: true },
    { key: "report", name: "Report", criteria: ["Mismatches are listed"] },
  ],
  review: "human",
  slaMinutes: 120,
  fields: [{ key: "supplier", label: "Supplier", required: true, relates: true }],
};

async function start() {
  h = await startHarness({ auth: FAST_AUTH });
  const harness = h;
  harness.app.deskmates.scheduler.stop();
  const { workspace, bot, thread } = await harness.seed();
  const base = `/api/workspaces/${workspace.id}`;
  return { harness, ctx: harness.app.deskmates.ctx, workspace, bot, thread, base };
}

const count = (harness: Harness, sql: string, ...params: unknown[]) =>
  (harness.app.deskmates.ctx.db.prepare(sql).get(...params) as { n: number }).n;

describe("task templates (A4a)", () => {
  it("manages templates: built-ins read-only, custom ones versioned, archived and audited", async () => {
    const { harness, base } = await start();
    const listed = await harness.api<TaskTemplateList>("GET", `${base}/task-templates`);
    expect(listed.json.templates.map((t) => t.id)).toEqual([
      "builtin:support-ticket",
      "builtin:research-report",
      "builtin:coding-task",
      "builtin:functional-test",
    ]);
    const created = await harness.api<{ template: TaskTemplate }>(
      "POST",
      `${base}/task-templates`,
      custom,
    );
    expect(created.status).toBe(201);
    const template = created.json.template;
    expect(template).toMatchObject({ kind: "invoice-check", builtIn: false, version: 1 });
    expect(template.stages[0]?.criteria[0]?.label).toBe("check.1");
    // A kind key is unique per workspace and never a built-in's.
    expect(
      (await harness.api("POST", `${base}/task-templates`, { ...custom, name: "again" })).status,
    ).toBe(409);
    expect(
      (await harness.api("POST", `${base}/task-templates`, { ...custom, kind: "coding-task" }))
        .status,
    ).toBe(409);
    expect(
      (await harness.api("POST", `${base}/task-templates`, { ...custom, unknown: true })).status,
    ).toBe(400);
    // Built-ins are read-only.
    expect(
      (
        await harness.api("PATCH", `${base}/task-templates/builtin:support-ticket`, {
          version: 1,
          name: "Mine",
        })
      ).status,
    ).toBe(403);
    // Edits carry the version; the kind key never changes.
    const url = `${base}/task-templates/${template.id}`;
    expect((await harness.api("PATCH", url, { version: 9, name: "x" })).status).toBe(409);
    expect((await harness.api("PATCH", url, { version: 1, kind: "other" })).status).toBe(400);
    const edited = await harness.api<{ template: TaskTemplate }>("PATCH", url, {
      version: 1,
      slaMinutes: 240,
    });
    expect(edited.json.template).toMatchObject({
      version: 2,
      slaMinutes: 240,
      name: "Invoice check",
    });
    const archived = await harness.api<{ template: TaskTemplate }>("DELETE", url, { version: 2 });
    expect(archived.json.template.archivedAt).not.toBeNull();
    const after = await harness.api<TaskTemplateList>("GET", `${base}/task-templates`);
    expect(after.json.templates.map((t) => t.id)).not.toContain(template.id);
    const all = await harness.api<TaskTemplateList>("GET", `${base}/task-templates?archived=1`);
    expect(all.json.templates.map((t) => t.id)).toContain(template.id);
    // An archived template creates no task.
    const refused = await harness.api("POST", `${base}/tasks`, {
      title: "Invoice 7",
      templateId: template.id,
      fields: { supplier: "Acme" },
    });
    expect(refused.status).toBe(409);
    expect(
      count(
        harness,
        `SELECT count(*) AS n FROM audit_events WHERE target_id = ? AND action IN
          ('task_template.create', 'task_template.update', 'task_template.archive')`,
        template.id,
      ),
    ).toBe(3);
  });
});

describe("create from a template (A4c, A4d)", () => {
  it("stamps the kind, stores the fields, appends the criteria and seeds no checkpoint", async () => {
    const { harness, ctx, base, workspace } = await start();
    const response = await harness.api<TaskSubmitResponse>("POST", `${base}/tasks`, {
      title: "ACME cannot log in",
      description: "Customer reports a login loop on Safari.",
      templateId: "builtin:support-ticket",
      fields: { customer: "ACME", priority: "P1" },
    });
    expect(response.status).toBe(201);
    const task = response.json.task;
    expect(task.kind).toMatchObject({
      key: "support-ticket",
      templateId: "builtin:support-ticket",
      templateVersion: 1,
      slaMinutes: 1440,
      review: "human",
      fields: { customer: "ACME", channel: "web", priority: "P1" },
    });
    expect(
      task.description.startsWith("Customer reports a login loop on Safari.\n\n--- Template:"),
    ).toBe(true);
    expect(task.description).toContain("[resolve.2]");
    expect(
      count(harness, "SELECT count(*) AS n FROM task_checkpoints WHERE task_id = ?", task.id),
    ).toBe(0);
    const detail = await harness.api<TaskDetailResponse>("GET", `${base}/tasks/${task.id}`);
    expect(detail.json.kindProgress).toMatchObject({
      currentStage: "triage",
      missingCheckpoints: ["triage", "resolve"],
      discrepancies: [],
    });
    expect(detail.json.kindProgress?.criteria).toHaveLength(6);

    // Field values can be corrected; a required one cannot be emptied; the description stays.
    const fixed = await harness.api<{ task: Task }>("PATCH", `${base}/tasks/${task.id}`, {
      version: task.version,
      fields: { customer: "ACME Corp" },
    });
    expect(fixed.status).toBe(200);
    expect(fixed.json.task.kind?.fields.customer).toBe("ACME Corp");
    expect(fixed.json.task.description).toBe(task.description);
    expect(
      (
        await harness.api("PATCH", `${base}/tasks/${task.id}`, {
          version: fixed.json.task.version,
          fields: { customer: " " },
        })
      ).status,
    ).toBe(400);

    // Refusals write nothing.
    const before = count(
      harness,
      "SELECT count(*) AS n FROM tasks WHERE workspace_id = ?",
      workspace.id,
    );
    const bad = [
      { title: "x", templateId: "builtin:support-ticket" },
      { title: "x", templateId: "builtin:support-ticket", fields: { customer: "a", plan: "b" } },
      { title: "x", fields: { customer: "a" } },
      { title: "x", templateId: "builtin:missing" },
    ];
    const statuses = [];
    for (const body of bad)
      statuses.push((await harness.api("POST", `${base}/tasks`, body)).status);
    expect(statuses).toEqual([400, 400, 400, 404]);
    expect(
      count(harness, "SELECT count(*) AS n FROM tasks WHERE workspace_id = ?", workspace.id),
    ).toBe(before);
    // A plain task cannot take fields.
    const plain = ctx.tasks.create(workspace.id as WorkspaceId, { title: "plain" });
    expect(
      (await harness.api("PATCH", `${base}/tasks/${plain.id}`, { version: 1, fields: { a: "b" } }))
        .status,
    ).toBe(400);
  });

  it("keeps a stamped task as it was when its template changes, and another workspace's template is not found", async () => {
    const { harness, ctx, base } = await start();
    const template = (
      await harness.api<{ template: TaskTemplate }>("POST", `${base}/task-templates`, custom)
    ).json.template;
    const task = (
      await harness.api<TaskSubmitResponse>("POST", `${base}/tasks`, {
        title: "Invoice 7",
        templateId: template.id,
        fields: { supplier: "Acme" },
      })
    ).json.task;
    await harness.api("PATCH", `${base}/task-templates/${template.id}`, {
      version: 1,
      slaMinutes: 999,
      stages: [{ key: "only", name: "Only", criteria: ["Something else"] }],
    });
    const reread = (await harness.api<TaskDetailResponse>("GET", `${base}/tasks/${task.id}`)).json
      .task;
    expect(reread.kind?.slaMinutes).toBe(120);
    expect(reread.kind?.stages.map((s) => s.key)).toEqual(["check", "report"]);
    const other = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" });
    expect(
      (
        await harness.api("POST", `/api/workspaces/${other.id}/tasks`, {
          title: "x",
          templateId: template.id,
          fields: { supplier: "a" },
        })
      ).status,
    ).toBe(404);
  });

  it("changes no default: a plain task and its dispatch message are as before", async () => {
    const { harness, ctx, base, bot } = await start();
    const plain = await harness.api<TaskSubmitResponse>("POST", `${base}/tasks`, {
      title: "Plain work",
      description: "Do the thing.",
      ownerBotId: bot.id,
      trigger: "immediate",
    });
    expect(plain.json.task.description).toBe("Do the thing.");
    expect(plain.json.task.kind).toBeUndefined();
    const detail = await harness.api<TaskDetailResponse>(
      "GET",
      `${base}/tasks/${plain.json.task.id}`,
    );
    expect(detail.json.kindProgress).toBeUndefined();
    const body = (id: string | null | undefined) =>
      (ctx.db.prepare("SELECT body FROM thread_messages WHERE id = ?").get(id) as { body: string })
        .body;
    expect(body(plain.json.submission?.messageId)).not.toContain("Template");
    // A templated task's text reaches the bot only as its description, in the same message shape.
    const templated = await harness.api<TaskSubmitResponse>("POST", `${base}/tasks`, {
      title: "Ticket",
      ownerBotId: bot.id,
      trigger: "immediate",
      templateId: "builtin:support-ticket",
      fields: { customer: "ACME" },
    });
    const message = body(templated.json.submission?.messageId);
    expect(message).toContain(templated.json.task.description);
    expect(message).toContain("When it is done, deliver it with task_deliver");
  });
});

describe("kind view (A4f, A4g)", () => {
  it("counts, completes, times against the target and names each stall reason", async () => {
    const { harness, ctx, base, workspace, bot, thread } = await start();
    const second = ctx.bots.create({ workspaceId: workspace.id, name: "bob", role: "r" });
    const ticket = async (title: string, customer: string) =>
      (
        await harness.api<TaskSubmitResponse>("POST", `${base}/tasks`, {
          title,
          ownerBotId: bot.id,
          templateId: "builtin:support-ticket",
          fields: { customer },
        })
      ).json.task;
    const patch = async (task: Task, body: Record<string, unknown>) => {
      const r = await harness.api<{ task: Task }>("PATCH", `${base}/tasks/${task.id}`, {
        version: task.version,
        ...body,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json.task;
    };
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const setTimes = (task: Task, created: number, delivered?: number) =>
      ctx.db
        .prepare(
          "UPDATE tasks SET created_at = ?, delivered_at = coalesce(?, delivered_at) WHERE id = ?",
        )
        .run(ago(created), delivered === undefined ? null : ago(delivered), task.id);
    const artifacts = [{ label: "Reply", path: "/work/reply.md" }];

    // Accepted, delivered 2 h after creation: within the 24 h target.
    let t1 = await ticket("Login loop", "A");
    t1 = await patch(t1, { status: "delivered", artifacts });
    await harness.api("POST", `${base}/tasks/${t1.id}/accept`, { version: t1.version });
    setTimes(t1, 300, 180);
    // Open for 30 h with no activity: overdue and stalled.
    const t2 = await ticket("Invoice missing", "B");
    setTimes(t2, 30 * 60);
    // Escalated (blocked) and reassigned: waiting on a human.
    let t3 = await ticket("Refund request", "C");
    t3 = await patch(t3, {
      status: "blocked",
      blockedReason: "Refund policy",
      nextAction: "Decide",
    });
    t3 = await patch(t3, { ownerBotId: second.id });
    // Cancelled.
    const t4 = await ticket("Spam", "D");
    await patch(t4, { status: "cancelled" });
    // A linked run waits on an approval.
    const run = ctx.runs.create({
      botId: bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
      config: ctx.runConfig(),
    });
    ctx.db.prepare("UPDATE runs SET status = 'waiting_approval' WHERE id = ?").run(run.id);
    const t5 = await ticket("Export data", "E");
    await patch(t5, { runIds: [run.id] });
    // Delivered 30 h after creation, 2 h ago, not accepted: breached and awaiting acceptance.
    let t6 = await ticket("Slow page", "F");
    t6 = await patch(t6, { status: "delivered", artifacts });
    setTimes(t6, 32 * 60, 120);
    // Neither a deleted task nor another kind counts.
    const gone = await ticket("Deleted", "G");
    await harness.api("DELETE", `${base}/tasks/${gone.id}`, { version: gone.version });
    ctx.tasks.create(workspace.id as WorkspaceId, { title: "plain" });

    const stats = (await harness.api<TaskKindStats>("GET", `${base}/task-kinds/support-ticket`))
      .json;
    expect(stats).toMatchObject({
      kind: "support-ticket",
      name: "Customer support ticket",
      windowDays: 30,
      stalledMinutes: 60,
      slaMinutes: 1440,
      total: 6,
      counts: { planned: 2, in_progress: 0, blocked: 1, delivered: 1, accepted: 1, cancelled: 1 },
      completion: { done: 2, considered: 5, rate: 0.4, acceptedRate: 0.2 },
      timeToDone: { count: 2, p50Minutes: 120, p90Minutes: 1800, withinSla: 1, breachedSla: 1 },
      overdue: 1,
      stalled: { waiting_approval: 1, waiting_human: 1, awaiting_acceptance: 1, no_activity: 1 },
      escalations: 1,
      reassignments: 1,
      cost: { knownUsd: 0, estimatedUsd: 0, perTaskUsd: null, coveredTasks: 6 },
      truncated: false,
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(stats.series).toHaveLength(30);
    expect(stats.series.at(-1)).toMatchObject({
      day: today,
      delivered: 2,
      accepted: 1,
      cancelled: 1,
      escalated: 1,
    });
    const row = (id: string) => stats.tasks.find((r) => r.id === id);
    expect(row(t1.id)).toMatchObject({ sla: "within", timeToDoneMinutes: 120, stall: null });
    expect(row(t2.id)).toMatchObject({
      sla: "overdue",
      stall: "no_activity",
      currentStage: "triage",
    });
    expect(row(t3.id)).toMatchObject({
      stall: "waiting_human",
      escalations: 1,
      reassignments: 1,
      ownerBotId: second.id,
      fields: { customer: "C", channel: "web", priority: "P3" },
    });
    expect(row(t5.id)).toMatchObject({ stall: "waiting_approval", runCount: 1, sla: "on_track" });
    expect(row(t6.id)).toMatchObject({ sla: "breached", stall: "awaiting_acceptance" });
    expect(row(t4.id)).toMatchObject({ sla: "none", stall: null });

    // Transitions name the actor and the change.
    const transitions = ctx.db
      .prepare(
        "SELECT field, from_value, to_value, changed_by FROM task_transitions WHERE task_id = ? ORDER BY seq",
      )
      .all(t3.id);
    expect(transitions).toEqual([
      { field: "status", from_value: "planned", to_value: "blocked", changed_by: "human:web" },
      { field: "owner", from_value: bot.id, to_value: second.id, changed_by: "human:web" },
    ]);

    // A shorter stall window and a bad query value.
    const quick = (
      await harness.api<TaskKindStats>(
        "GET",
        `${base}/task-kinds/support-ticket?stalledMinutes=500&days=7`,
      )
    ).json;
    expect(quick.series).toHaveLength(7);
    expect(quick.stalled.awaiting_acceptance).toBe(0);
    expect((await harness.api("GET", `${base}/task-kinds/support-ticket?days=91`)).status).toBe(
      400,
    );

    const kinds = (await harness.api<TaskKindList>("GET", `${base}/task-kinds`)).json.kinds;
    expect(kinds.find((k) => k.kind === "support-ticket")).toMatchObject({
      builtIn: true,
      total: 6,
      open: 3,
    });
    expect(kinds.map((k) => k.kind)).toEqual([
      "support-ticket",
      "research-report",
      "coding-task",
      "functional-test",
    ]);
  });
});

describe("related tasks (A4h)", () => {
  it("relates by equal field values and lexical similarity, flags duplicates and merges nothing", async () => {
    const { harness, base, ctx } = await start();
    const ticket = async (title: string, customer: string, templateId = "builtin:support-ticket") =>
      (
        await harness.api<TaskSubmitResponse>("POST", `${base}/tasks`, {
          title,
          templateId,
          fields: templateId === "builtin:support-ticket" ? { customer } : {},
        })
      ).json.task;
    const a = await ticket("Login fails on Safari after the update", "ACME");
    const sameCustomer = await ticket("Refund for order 42", " acme ");
    const sameText = await ticket("Login fails on Safari after the update", "Globex");
    const unrelated = await ticket("Change the invoice address", "Initech");
    const research = await ticket(
      "Login fails on Safari after the update",
      "",
      "builtin:research-report",
    );
    const result = (await harness.api<RelatedTaskList>("GET", `${base}/tasks/${a.id}/related`))
      .json;
    expect(result).toMatchObject({ taskId: a.id, kind: "support-ticket", method: "lexical" });
    const ids = result.related.map((r) => r.id);
    expect(ids).toContain(sameCustomer.id);
    expect(ids).toContain(sameText.id);
    expect(ids).not.toContain(unrelated.id);
    expect(ids).not.toContain(research.id);
    const byId = new Map(result.related.map((r) => [r.id, r]));
    expect(byId.get(sameCustomer.id)?.reasons).toEqual([
      { kind: "field", field: "customer", label: "Customer", value: "ACME" },
    ]);
    expect(byId.get(sameText.id)).toMatchObject({
      possibleDuplicate: true,
      reasons: [{ kind: "text", score: 1 }],
    });
    // Nothing was merged or changed.
    expect(
      (await harness.api<TaskDetailResponse>("GET", `${base}/tasks/${sameText.id}`)).json.task
        .version,
    ).toBe(1);
    // A task without a kind has no related list; no retrieval call was made.
    const plain = ctx.tasks.create(a.workspaceId, { title: "Login fails on Safari" });
    expect(
      (await harness.api<RelatedTaskList>("GET", `${base}/tasks/${plain.id}/related`)).json,
    ).toMatchObject({ kind: null, related: [] });
    expect(count(harness, "SELECT count(*) AS n FROM retrieval_calls")).toBe(0);
  });

  it("uses the embedding service when configured, reuses vectors by text hash and falls back on failure", async () => {
    const { harness, base, ctx } = await start();
    const fake = new FakeRetrievalService();
    ctx.retrieval = new HybridRetrieval({
      db: ctx.db,
      knowledge: ctx.knowledge,
      settings: { embedding: FAKE_EMBEDDING, ...RETRIEVAL_DEFAULTS },
      fetch: fake.fetch,
    });
    const ticket = async (title: string, customer: string) =>
      (
        await harness.api<TaskSubmitResponse>("POST", `${base}/tasks`, {
          title,
          templateId: "builtin:support-ticket",
          fields: { customer },
        })
      ).json.task;
    const backup = await ticket("Nightly backup failed", "A");
    const snapshot = await ticket("pg_dump snapshot missing", "B");
    const lunch = await ticket("Lunch menu wrong", "C");
    const related = async () =>
      (await harness.api<RelatedTaskList>("GET", `${base}/tasks/${backup.id}/related`)).json;
    const first = await related();
    expect(first.method).toBe("embedding");
    expect(first.related.map((r) => r.id)).toEqual([snapshot.id]);
    expect(first.related[0]?.possibleDuplicate).toBe(true);
    expect(first.related[0]?.reasons[0]).toMatchObject({ kind: "text" });
    expect(first.related.map((r) => r.id)).not.toContain(lunch.id);
    // The template section is not part of the compared text.
    expect(String(fake.embedCalls()[0]?.body.input)).not.toContain("--- Template");
    const calls = () =>
      ctx.db
        .prepare(
          "SELECT corpus, purpose, service, inputs, outcome FROM retrieval_calls ORDER BY rowid",
        )
        .all();
    expect(calls()).toEqual([
      { corpus: "task", purpose: "index", service: "embedding", inputs: 3, outcome: "ok" },
    ]);
    // Unchanged texts reuse their vectors; a changed title re-embeds that task alone.
    await related();
    expect(fake.embedCalls()).toHaveLength(1);
    await harness.api("PATCH", `${base}/tasks/${lunch.id}`, {
      version: lunch.version,
      title: "Lunch menu typo",
    });
    await related();
    expect(fake.embedCalls()).toHaveLength(2);
    expect(fake.embedCalls()[1]?.body.input).toEqual(["Lunch menu typo"]);
    // A failing service falls back to the lexical path and records the failed call.
    fake.failEmbed = "error";
    await harness.api("PATCH", `${base}/tasks/${snapshot.id}`, {
      version: snapshot.version,
      title: "Nightly backup failed again",
    });
    const fallback = await related();
    expect(fallback.method).toBe("lexical_fallback");
    expect(fallback.related.map((r) => r.id)).toEqual([snapshot.id]);
    expect(calls().at(-1)).toMatchObject({ corpus: "task", outcome: "error" });
  });
});

describe("roles and private chats (A4g, ADR-0022 amendment 6)", () => {
  it("lets Members read the views, Admins manage templates, Guests neither, and leaks no private summary", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const { ctx } = harness.app.deskmates;
    const people = await seedRoles(harness);
    const base = `/api/workspaces/${people.workspace.id}`;
    const created = await people.admin.json<TaskSubmitResponse>("POST", `${base}/tasks`, {
      body: {
        title: "Login fails on Safari",
        templateId: "builtin:support-ticket",
        fields: { customer: "ACME" },
      },
    });
    expect(created.status).toBe(201);
    const task = created.json.task;
    const twin = (
      await people.admin.json<TaskSubmitResponse>("POST", `${base}/tasks`, {
        body: {
          title: "Checkout broken",
          templateId: "builtin:support-ticket",
          fields: { customer: "Other" },
        },
      })
    ).json.task;

    // A delivery from a run in another person's private chat; its summary is private text.
    const thread = ctx.threads.create({
      workspaceId: people.workspace.id,
      botIds: [people.bot.id],
    });
    ctx.db
      .prepare("UPDATE threads SET private_to_user_id = ? WHERE id = ?")
      .run(people.ids.max, thread.id);
    const run = ctx.runs.create({
      botId: people.bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
      config: ctx.runConfig(),
    });
    ctx.db
      .prepare(`INSERT INTO task_deliveries (id, workspace_id, task_id, run_id, attempt, delivered_by,
        scope_version, kind, summary, outstanding_json, created_at)
        VALUES ('tdl_private', ?, ?, ?, 1, ?, 1, 'partial', ?, '[]', ?)`)
      .run(
        people.workspace.id,
        twin.id,
        run.id as RunId,
        `bot:${people.bot.id}`,
        "PRIVATE-SUMMARY login fails on Safari",
        new Date().toISOString(),
      );

    for (const [who, jar] of [
      ["owner", people.owner],
      ["admin", people.admin],
      ["member", people.member],
    ] as const) {
      for (const path of [
        `${base}/task-kinds`,
        `${base}/task-kinds/support-ticket`,
        `${base}/task-templates`,
        `${base}/tasks/${task.id}/related`,
      ]) {
        const response = await jar.fetch("GET", path);
        const text = await response.text();
        expect(response.status, `${who} ${path}`).toBe(200);
        expect(text).not.toContain("PRIVATE-SUMMARY");
      }
    }
    // The private summary does not relate the two tasks either.
    const related = await people.member.json<RelatedTaskList>(
      "GET",
      `${base}/tasks/${task.id}/related`,
    );
    expect(related.json.related.map((r) => r.id)).not.toContain(twin.id);

    for (const path of [
      `${base}/task-kinds`,
      `${base}/task-kinds/support-ticket`,
      `${base}/task-templates`,
      `${base}/tasks/${task.id}/related`,
    ])
      expect((await people.guest.fetch("GET", path)).status, `guest ${path}`).toBe(403);

    // Only Owners and Admins write templates.
    expect(
      (await people.member.fetch("POST", `${base}/task-templates`, { body: custom })).status,
    ).toBe(403);
    expect(
      (await people.owner.fetch("POST", `${base}/task-templates`, { body: custom })).status,
    ).toBe(201);
    // Another workspace's kind view is not reachable for a member of this one.
    const other = ctx.workspaces.create({ name: "elsewhere", sandboxProvider: "docker" });
    expect(
      (await people.member.fetch("GET", `/api/workspaces/${other.id}/task-kinds/support-ticket`))
        .status,
    ).not.toBe(200);
  });
});

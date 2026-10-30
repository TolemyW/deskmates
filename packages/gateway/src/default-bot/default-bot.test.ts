// T1 (ADR-0051): the workspace default bot. A new workspace comes with `assistant` (decision 2);
// an Owner or Admin picks another, one at a time, and Trash clears it (decision 1); only a run of
// the default bot that froze `assistant-v1` creates, edits and groups bots, audited and noted in
// its thread (decisions 3 to 5); the default bot leads the rail (decision 7); a channel connection
// naming no bot is bound to it (decision 8); its welcome shows the creator around in their
// language (decision 11).

import {
  type BotDefinition,
  type BotId,
  DEFAULT_BOT_NAME,
  DEFAULT_BOT_TOOL_NAMES,
  NOT_DEFAULT_BOT,
  type RunId,
  type StartRunRequest,
  type Thread,
  type ThreadId,
  type Workspace,
  type WorkspaceId,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { sidecarToolsFor } from "../scheduler/sidecar-tools.js";
import {
  type Harness,
  TEST_OPERATOR_TOKEN,
  startHarness,
  waitFor,
} from "../test-support/harness.js";
import { assistantCreationReport } from "./creation-report.js";
import { withDefaultChannelBot } from "./default-bot-channel.js";
import { DEFAULT_BOT_ROLE, DEFAULT_BOT_SOUL } from "./default-bot-soul.js";
import { defaultBots } from "./default-bot-store.js";
import { ASSISTANT_WELCOME_VERSION } from "./default-bot-welcome.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const ctx = () => h.app.deskmates.ctx;

const ended = (runId: string) => ({
  type: "run_ended",
  runId,
  outcome: "completed",
  summary: {
    done: "ok",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply: "ok",
  },
  usage: [],
});

async function createWorkspace(name = "Team") {
  const created = await h.api<{
    workspace: Workspace;
    defaultBot?: BotDefinition;
    privateChat?: Thread;
  }>("POST", "/api/workspaces", { name });
  expect(created.status).toBe(201);
  return created.json;
}

/**
 * A run of `botId` in `threadId`, started by a person's message, with the frozen config. Queued
 * unless `held` is false: a queued run would be started and finished by the fake provider, whose
 * end revokes the token; the routes judge the frozen mode, not the status.
 */
function runOf(botId: BotId, threadId: ThreadId, config: Record<string, unknown>, held = true) {
  const message = ctx().messages.append({
    threadId,
    authorKind: "human",
    authorId: "user:usr_owner",
    body: "please set up a teammate",
  });
  const run = ctx().runs.create({
    botId,
    threadId,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: message.id,
    config,
  });
  if (!held) return run;
  ctx().db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(run.id);
  return ctx().runs.mustGet(run.id);
}

async function internal<T>(runId: RunId, path: string, body: unknown, token?: string) {
  const res = await fetch(`${h.baseUrl}/internal/runs/${runId}/assistant/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token ?? ctx().tokens.issue(runId).token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T & { code?: string } };
}

/** A workspace with its default bot, the default bot's private chat and a run of it there. */
async function assistantWorld() {
  const { workspace, defaultBot, privateChat } = await createWorkspace();
  const assistant = defaultBot as BotDefinition;
  const chat = privateChat as Thread;
  const run = runOf(assistant.id, chat.id, { workspaceAssistant: "assistant-v1" });
  return { workspace, assistant, chat, run };
}

describe("a new workspace (decision 2)", () => {
  it("comes with the assistant: template SOUL, inherited model, private chat and a welcome", async () => {
    const { workspace, defaultBot, privateChat } = await createWorkspace();
    const bot = defaultBot as BotDefinition;
    expect(bot).toMatchObject({ name: DEFAULT_BOT_NAME, role: DEFAULT_BOT_ROLE });
    expect(bot.model).toBeUndefined();
    expect(bot.runtime).toBeUndefined();
    expect(workspace.defaultBotId).toBe(bot.id);
    expect(ctx().bots.canonicalSoul(bot.id)?.body).toBe(DEFAULT_BOT_SOUL);
    expect(ctx().bots.versions.list(bot.id, "soul")).toHaveLength(1);
    expect(privateChat?.id).toBe(ctx().privateChats.resolve(bot.id).id);
    expect(ctx().runs.latestOfTrigger(bot.id, "welcome")?.threadId).toBe(privateChat?.id);
    const audit = ctx().audit.list({ targetId: bot.id });
    expect(audit.map((row) => row.action)).toContain("bot.create");
  });

  it("comes without one when the creator asks for none", async () => {
    const created = await h.api<{ workspace: Workspace; defaultBot?: unknown }>(
      "POST",
      "/api/workspaces",
      { name: "Scripted", defaultBot: false },
    );
    expect(created.json.defaultBot).toBeUndefined();
    expect(created.json.workspace.defaultBotId).toBeUndefined();
    expect(ctx().bots.list(created.json.workspace.id)).toEqual([]);
  });
});

describe("the default bot's welcome (decision 11)", () => {
  it("shows the creator around in their browser's language and invites a first teammate", async () => {
    const res = await fetch(`${h.baseUrl}/api/workspaces`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_TOKEN}`,
        "content-type": "application/json",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      body: JSON.stringify({ name: "Chinese" }),
    });
    const { defaultBot } = (await res.json()) as { defaultBot: BotDefinition };
    const welcome = ctx().runs.latestOfTrigger(defaultBot.id, "welcome") as RunRecord;
    const prompt = (welcome.triggerPayload as { prompt: string }).prompt;
    expect(prompt).toContain("Write it in Simplified Chinese");
    expect(prompt).toContain("Deskmates");
    expect(prompt).toContain("first teammate");
    expect(welcome.config.welcomeVersion).toBe(ASSISTANT_WELCOME_VERSION);
  });

  it("is in English when nothing names a language, and other bots keep the generic welcome", async () => {
    const { workspace, defaultBot } = await createWorkspace();
    const welcome = ctx().runs.latestOfTrigger((defaultBot as BotDefinition).id, "welcome");
    expect((welcome?.triggerPayload as { prompt: string }).prompt).toContain("Write it in English");
    const peer = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "researcher",
      workspaceId: workspace.id,
    });
    const peerWelcome = ctx().runs.latestOfTrigger(peer.json.bot.id, "welcome");
    expect((peerWelcome?.triggerPayload as { prompt: string }).prompt).toContain(
      "You have just joined this workspace as researcher",
    );
    expect(peerWelcome?.config.welcomeVersion).toBe(1);
  });
});

describe("choosing the default bot (decision 1)", () => {
  it("is one bot at a time, audited, and only a bot of the same workspace", async () => {
    const { workspace, defaultBot } = await createWorkspace();
    const other = ctx().bots.create({ name: "writer", role: "", workspaceId: workspace.id });
    const set = await h.api<{ workspace: Workspace }>(
      "PUT",
      `/api/workspaces/${workspace.id}/default-bot`,
      { botId: other.id },
    );
    expect(set.status).toBe(200);
    expect(set.json.workspace.defaultBotId).toBe(other.id);
    expect(defaultBots(ctx()).get(workspace.id)).toBe(other.id);
    const rows = ctx()
      .audit.list({ targetId: workspace.id })
      .filter((row) => row.action === "workspace.default_bot_set");
    expect(rows[0]).toMatchObject({
      before: { defaultBotId: defaultBot?.id },
      after: { defaultBotId: other.id },
    });

    const elsewhere = await createWorkspace("Elsewhere");
    const refused = await h.api<{ code: string }>(
      "PUT",
      `/api/workspaces/${workspace.id}/default-bot`,
      { botId: elsewhere.defaultBot?.id },
    );
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe("validation");
    const extra = await h.api<{ code: string }>(
      "PUT",
      `/api/workspaces/${workspace.id}/default-bot`,
      { botId: other.id, model: "x" },
    );
    expect(extra.status).toBe(400);
  });

  it("is cleared when the bot goes to Trash, and not restored with it", async () => {
    const { workspace, defaultBot } = await createWorkspace();
    const bot = defaultBot as BotDefinition;
    const archived = await h.api("POST", `/api/bots/${bot.id}/archive`, {});
    expect(archived.status).toBeLessThan(300);
    expect(ctx().workspaces.mustGet(workspace.id).defaultBotId).toBeUndefined();
    await h.api("POST", `/api/bots/${bot.id}/restore`, {});
    expect(ctx().workspaces.mustGet(workspace.id).defaultBotId).toBeUndefined();
  });
});

describe("what a run of the default bot may do (decision 3)", () => {
  it("starts the created teammate's welcome with its initial SOUL and delivers it to its canonical chat", async () => {
    const { run, chat } = await assistantWorld();
    const soul = "You research API gateways. Introduce yourself briefly in Chinese.";
    const seen: StartRunRequest[] = [];
    h.provider.onRun(async (request, gateway) => {
      if (request.botName === "researcher") seen.push(request);
      await gateway.post("ended", {
        ...ended(request.runId),
        summary: { ...ended(request.runId).summary, reply: "Hi from the new teammate" },
      });
    });
    const res = await internal<{ bot: { id: BotId } }>(run.id, "bots", {
      name: "researcher",
      role: "Research",
      soul,
    });
    expect(res.status).toBe(201);
    await waitFor(() => seen.length === 1, 3000, "created teammate welcome start");
    const welcome = ctx().runs.latestOfTrigger(res.json.bot.id, "welcome");
    if (!welcome) throw new Error("no welcome run");
    await waitFor(
      () => ctx().runs.mustGet(welcome.id).status === "succeeded",
      3000,
      "created teammate welcome end",
    );
    expect(seen[0]).toMatchObject({
      trigger: { kind: "welcome" },
      researchGuidance: "verify-v1",
      canonicalFiles: { soul: { body: soul } },
    });
    const inbox = ctx().privateChats.resolve(res.json.bot.id);
    expect(welcome.threadId).toBe(inbox.id);
    expect(
      ctx()
        .messages.list(inbox.id)
        .filter((m) => m.authorKind === "bot"),
    ).toHaveLength(1);
    expect(
      ctx()
        .messages.list(chat.id)
        .some((m) => m.body === "Hi from the new teammate" && m.authorId === res.json.bot.id),
    ).toBe(false);
    expect(
      ctx()
        .runs.list({ botId: res.json.bot.id })
        .filter((r) => r.triggerKind === "welcome"),
    ).toHaveLength(1);
  });
  it("creates a bot at once, audited with the run and the requester, noted in its thread", async () => {
    const { workspace, assistant, chat, run } = await assistantWorld();
    const res = await internal<{ bot: { id: BotId; name: string }; soulChanged: boolean }>(
      run.id,
      "bots",
      { name: "reporter", role: "Daily AI news digest", soul: "You write a daily digest." },
    );
    expect(res.status).toBe(201);
    expect(res.json.soulChanged).toBe(true);
    const created = ctx().bots.mustGet(res.json.bot.id);
    expect(created).toMatchObject({ workspaceId: workspace.id, role: "Daily AI news digest" });
    expect(created.model).toBeUndefined();
    expect(ctx().bots.canonicalSoul(created.id)?.body).toBe("You write a daily digest.");
    const audit = ctx()
      .audit.list({ targetId: created.id })
      .find((row) => row.action === "bot.create");
    expect(audit).toMatchObject({
      actor: `bot:${assistant.id}`,
      runId: run.id,
      reason: "requested by human:user:usr_owner",
    });
    const notice = ctx().messages.list(chat.id).at(-1);
    expect(notice).toMatchObject({ authorKind: "system" });
    expect(notice?.body).toContain(`@${assistant.name} created @reporter`);
  });

  it("keeps the operator create's name rules", async () => {
    const { run } = await assistantWorld();
    const bad = await internal(run.id, "bots", { name: "bad name", role: "" });
    expect(bad.status).toBe(400);
    const taken = await internal(run.id, "bots", { name: DEFAULT_BOT_NAME, role: "" });
    expect(taken.status).toBeGreaterThanOrEqual(400);
    const widened = await internal(run.id, "bots", { name: "x1", role: "", model: "big" });
    expect(widened.status).toBe(400);
  });

  it("updates another bot's role, SOUL and schedules, never itself or its model", async () => {
    const { workspace, assistant, run } = await assistantWorld();
    const writer = ctx().bots.create({ name: "writer", role: "", workspaceId: workspace.id });
    const res = await internal<{ bot: { role: string; cron: unknown[] }; soulChanged: boolean }>(
      run.id,
      "bots/writer",
      {
        role: "Writes the weekly report",
        soul: "You write the weekly report every Friday.",
        cron: [{ schedule: "0 9 * * 5", prompt: "Write this week's report." }],
      },
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      bot: { role: "Writes the weekly report" },
      soulChanged: true,
    });
    expect(ctx().bots.mustGet(writer.id).cron).toHaveLength(1);
    const audit = ctx()
      .audit.list({ targetId: writer.id })
      .find((row) => row.action === "bot.update");
    expect(audit).toMatchObject({ actor: `bot:${assistant.id}`, runId: run.id });
    expect(JSON.stringify(audit?.after)).not.toContain("every Friday");

    const self = await internal(run.id, `bots/${assistant.name}`, { role: "boss" });
    expect(self.status).toBe(403);
    const model = await internal(run.id, "bots/writer", { model: "big" });
    expect(model.status).toBe(400);
    const badCron = await internal(run.id, "bots/writer", {
      cron: [{ schedule: "not cron", prompt: "x" }],
    });
    expect(badCron.status).toBe(400);
  });

  it("opens a group chat with itself and the named bots", async () => {
    const { workspace, assistant, run } = await assistantWorld();
    const writer = ctx().bots.create({ name: "writer", role: "", workspaceId: workspace.id });
    const res = await internal<{ thread: { id: ThreadId; title: string }; members: string[] }>(
      run.id,
      "groups",
      { bots: ["writer"], title: "Weekly report" },
    );
    expect(res.status).toBe(201);
    expect(res.json.members).toEqual([assistant.name, "writer"]);
    const members = ctx()
      .threads.members(res.json.thread.id)
      .map((member) => member.botId);
    expect(members.sort()).toEqual([assistant.id, writer.id].sort());
    expect(ctx().threads.mustGet(res.json.thread.id).title).toBe("Weekly report");
    expect(ctx().audit.list({ targetId: res.json.thread.id })).toEqual([
      expect.objectContaining({
        action: "thread.create",
        actor: `bot:${assistant.id}`,
        runId: run.id,
      }),
    ]);
    const alone = await internal(run.id, "groups", { bots: [assistant.name] });
    expect(alone.status).toBe(400);
  });

  it("creates and starts a private collaboration once without widening the assistant allowlist", async () => {
    const { workspace, assistant, chat, run } = await assistantWorld();
    h.app.deskmates.scheduler.stop();
    const teammate = await internal<{ bot: { id: BotId } }>(run.id, "bots", {
      name: "reviewer",
      role: "Review reports",
    });
    const now = new Date().toISOString();
    ctx()
      .db.prepare(
        "INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('usr_source', 'Source person', ?, ?)",
      )
      .run(now, now);
    ctx()
      .db.prepare("UPDATE threads SET private_to_user_id = 'usr_source' WHERE id = ?")
      .run(chat.id);
    const input = {
      bots: ["reviewer"],
      title: "Report review",
      message: "Review the report and state any limitations.",
    };
    const first = await internal<{ thread: { id: ThreadId }; messageId: string }>(
      run.id,
      "groups",
      input,
    );
    expect(first.status).toBe(201);
    const group = ctx().threads.mustGet(first.json.thread.id);
    expect(group.privateToUserId).toBe("usr_source");
    const messages = ctx().messages.list(group.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      authorKind: "bot",
      authorId: assistant.id,
      runId: run.id,
      body: "@reviewer\nReview the report and state any limitations.",
    });
    const wakes = ctx().runs.list({ threadId: group.id });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.botId).toBe(teammate.json.bot.id);
    expect(ctx().bots.mustGet(assistant.id).messageAllowlist).toEqual([]);
    const notices = ctx().messages.list(chat.id).length;
    const duplicate = await internal(run.id, "groups", input);
    expect(duplicate.json).toEqual(first.json);
    expect(ctx().messages.list(group.id)).toHaveLength(1);
    expect(ctx().runs.list({ threadId: group.id })).toHaveLength(1);
    expect(ctx().messages.list(chat.id)).toHaveLength(notices);
    expect(ctx().audit.list({ targetId: group.id })).toHaveLength(1);
    expect(ctx().audit.list({ targetId: group.id })[0]?.after).not.toHaveProperty("title");
  });

  it("starts only the explicitly selected worker, retaining the reviewer for a later handoff", async () => {
    const { workspace, run } = await assistantWorld();
    const analyst = ctx().bots.create({
      workspaceId: workspace.id,
      name: "analyst",
      role: "Calculate",
    });
    const reviewer = ctx().bots.create({
      workspaceId: workspace.id,
      name: "reviewer",
      role: "Review",
    });
    const message = "@analyst calculate, then hand the result to @reviewer for checking.";
    const input = {
      bots: [analyst.name, reviewer.name],
      title: "Sequential review",
      message,
      startWith: ["analyst"],
    };
    const response = await internal<{ thread: { id: ThreadId } }>(run.id, "groups", input);
    expect(response.status).toBe(201);
    const groupId = response.json.thread.id;
    expect(ctx().messages.first(groupId)?.body).toBe(message);
    expect(
      ctx()
        .threads.members(groupId)
        .map((member) => member.botId),
    ).toContain(reviewer.id);
    expect(
      ctx()
        .runs.list({ threadId: groupId })
        .filter((queued) => queued.triggerRef === ctx().messages.first(groupId)?.id)
        .map((queued) => queued.botId),
    ).toEqual([analyst.id]);
    await internal(run.id, "groups", input);
    expect(
      ctx()
        .runs.list({ threadId: groupId })
        .filter((queued) => queued.triggerRef === ctx().messages.first(groupId)?.id),
    ).toHaveLength(1);
    const plain = await internal<{ thread: { id: ThreadId } }>(run.id, "groups", {
      ...input,
      message: "Calculate first, then ask reviewer to check.",
    });
    expect(ctx().messages.first(plain.json.thread.id)?.body).toBe(
      "@analyst\nCalculate first, then ask reviewer to check.",
    );
    expect(
      assistantCreationReport(ctx(), run, "Created @analyst and @reviewer; mail a@analyst.test."),
    ).toBe("Created analyst and reviewer; mail a@analyst.test.");
    ctx().bots.update(run.botId, { messageAllowlist: ["reviewer"] });
    expect(assistantCreationReport(ctx(), run, "Created @analyst and @reviewer.")).toBe(
      "Created analyst and @reviewer.",
    );
  });

  it("refuses a kickoff recipient outside the group without creating a thread", async () => {
    const { workspace, run } = await assistantWorld();
    ctx().bots.create({ workspaceId: workspace.id, name: "analyst", role: "Calculate" });
    ctx().bots.create({ workspaceId: workspace.id, name: "outsider", role: "Other" });
    const before = ctx().threads.list(workspace.id).length;
    const refused = await internal(run.id, "groups", {
      bots: ["analyst"],
      message: "Work",
      startWith: ["outsider"],
    });
    expect(refused.status).toBe(400);
    expect(ctx().threads.list(workspace.id)).toHaveLength(before);
  });

  it("refuses any other bot's run, a run that froze off, and a run whose bot is no longer the default", async () => {
    const { workspace, assistant, chat, run } = await assistantWorld();
    const other = ctx().bots.create({ name: "other", role: "", workspaceId: workspace.id });
    const otherChat = ctx().privateChats.resolve(other.id);
    const theirs = runOf(other.id, otherChat.id, { workspaceAssistant: "assistant-v1" });
    for (const id of [
      theirs.id,
      runOf(assistant.id, chat.id, { workspaceAssistant: "off" }).id,
      runOf(assistant.id, chat.id, {}).id,
    ]) {
      const refused = await internal<{ details?: { reason?: string } }>(id, "bots", {
        name: "sneaky",
        role: "",
      });
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe("forbidden");
      expect(refused.json.details?.reason).toBe(NOT_DEFAULT_BOT);
    }
    defaultBots(ctx()).set(workspace.id as WorkspaceId, other.id, "human:test");
    const demoted = await internal(run.id, "bots", { name: "sneaky", role: "" });
    expect(demoted.status).toBe(403);
    const anotherToken = await internal(run.id, "bots", { name: "x", role: "" }, "nope");
    expect(anotherToken.status).toBe(401);
    expect(
      ctx()
        .bots.list(workspace.id)
        .map((bot) => bot.name),
    ).not.toContain("sneaky");
  });
});

describe("offering the tools (decisions 4 and 5)", () => {
  it("starts the default bot's runs with the three tools and the route answering, a peer's without", async () => {
    const { workspace, bot, thread } = await h.seed();
    const peer = ctx().bots.create({ name: "bob", role: "peer", workspaceId: workspace.id });
    const peerThread = ctx().threads.create({ workspaceId: workspace.id, botIds: [peer.id] });
    await h.api("PUT", `/api/workspaces/${workspace.id}/default-bot`, { botId: bot.id });

    const starts: StartRunRequest[] = [];
    const answers = new Map<string, number>();
    h.provider.onRun(async (req, gw) => {
      starts.push(req);
      const created = await gw.post("assistant/bots", { name: `made-by-${req.runId}`, role: "" });
      answers.set(req.runId, created.status);
      await gw.post("ended", ended(req.runId));
    });
    const runs: RunRecord[] = [];
    for (const t of [thread, peerThread]) {
      const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${t.id}/messages`, {
        body: "set up a teammate",
      });
      runs.push(posted.json.runs[0] as RunRecord);
    }
    await waitFor(
      () => runs.every((r) => ctx().runs.mustGet(r.id).status === "succeeded"),
      3000,
      "runs",
    );
    const [mine, theirs] = runs.map((r) => ctx().runs.mustGet(r.id)) as [RunRecord, RunRecord];
    expect(mine.config.workspaceAssistant).toBe("assistant-v1");
    expect(theirs.config.workspaceAssistant).toBe("off");
    const toolsOf = (id: RunId) => starts.find((s) => s.runId === id)?.tools ?? [];
    for (const name of DEFAULT_BOT_TOOL_NAMES) {
      expect(toolsOf(mine.id)).toContain(name);
      expect(toolsOf(theirs.id)).not.toContain(name);
    }
    expect(answers.get(mine.id)).toBe(201);
    expect(answers.get(theirs.id)).toBe(403);
  });

  it("freezes assistant-v1 on attempt 1 of the default bot's run only, and keeps it", async () => {
    const { workspace, assistant, chat } = await assistantWorld();
    const store = defaultBots(ctx());
    const fresh = runOf(assistant.id, chat.id, {}, false);
    expect(store.startMode(ctx().runs, fresh, workspace.id)).toBe("assistant-v1");
    expect(ctx().runs.mustGet(fresh.id).config.workspaceAssistant).toBe("assistant-v1");
    const other = ctx().bots.create({ name: "other", role: "", workspaceId: workspace.id });
    store.set(workspace.id, other.id, "human:test");
    // A resume reads the frozen value back, whatever the default is now.
    expect(store.startMode(ctx().runs, ctx().runs.mustGet(fresh.id), workspace.id)).toBe(
      "assistant-v1",
    );
    const job = runOf(other.id, chat.id, { runType: "activity_summary" }, false);
    expect(store.startMode(ctx().runs, job, workspace.id)).toBe("off");
  });

  it("puts the three tools in the start request only with a thread and the frozen mode", () => {
    expect(sidecarToolsFor(true, {}, false, false, false, false, false, true)).toEqual(
      expect.arrayContaining([...DEFAULT_BOT_TOOL_NAMES]),
    );
    for (const tools of [
      sidecarToolsFor(true, {}, false, false, false, false, false, false),
      sidecarToolsFor(false, {}, false, false, false, false, false, true),
    ])
      for (const name of DEFAULT_BOT_TOOL_NAMES) expect(tools).not.toContain(name);
  });
});

describe("the rail and chat channels (decisions 7 and 8)", () => {
  it("lists the default bot first in its workspace's rail", async () => {
    const { workspace, defaultBot } = await createWorkspace();
    ctx().bots.create({ name: "aaron", role: "", workspaceId: workspace.id });
    const page = await h.api<{ bots: BotDefinition[] }>(
      "GET",
      `/api/bots?workspaceId=${workspace.id}&offset=0&limit=50`,
    );
    expect(page.json.bots.map((bot) => bot.id)[0]).toBe(defaultBot?.id);
  });

  it("binds a connection that names no bot to the default bot", async () => {
    const { workspace, defaultBot } = await createWorkspace();
    expect(withDefaultChannelBot(ctx(), workspace.id, { method: "qr" })).toEqual({
      method: "qr",
      botId: defaultBot?.id,
    });
    expect(withDefaultChannelBot(ctx(), workspace.id, { botId: "bot_x" })).toEqual({
      botId: "bot_x",
    });
    const bare = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: "Bare",
      defaultBot: false,
    });
    expect(() => withDefaultChannelBot(ctx(), bare.json.workspace.id, {})).toThrow(/no default/);
  });
});

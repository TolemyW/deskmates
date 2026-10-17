// T1: ADR-0043 decisions 2, 3, 4 and 6. SOUL and MEMORY saves are numbered versions with diff and
// restore (a restore is a new version), a run records the version it started with, an edit under
// a live run is saved for the next run, the diary is read and edited line by line through the
// container, and "Run now" starts a cron entry as a `manual` background run.

import { createHash } from "node:crypto";
import type {
  BotDiaryDay,
  BotRuleVersionList,
  SoulDiffLine,
  StartRunRequest,
  Thread,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function endRun(
  req: StartRunRequest,
  gw: FakeSidecarClient,
  sdkSessionId?: string,
): Promise<void> {
  await gw.post("ended", {
    type: "run_ended",
    runId: req.runId,
    outcome: "completed",
    ...(sdkSessionId ? { sdkSessionId } : {}),
    summary: {
      done: "answered",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      reply: "ok",
    },
    usage: [],
  });
}

async function saveSoul(botId: string, body: string): Promise<{ status: number; json: unknown }> {
  const current = await h.api<{ soul: { version: string } }>("GET", `/api/bots/${botId}/soul`);
  return h.api("PATCH", `/api/bots/${botId}/soul`, {
    body,
    expectedVersion: current.json.soul.version,
  });
}

async function post(thread: Thread): Promise<RunRecord> {
  const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body: "go",
  });
  return posted.json.runs[0] as RunRecord;
}

const requestOf = (runId: string) =>
  h.provider.execCalls.find((call) => call.request.runId === runId)?.request as StartRunRequest;

describe("rule-file versions (ADR-0043 decision 2)", () => {
  it("numbers saves, diffs two, restores as a new version, and the next run records it", async () => {
    const { bot, thread } = await h.seed();
    h.provider.onRun(async (req, gw) => endRun(req, gw));
    expect((await saveSoul(bot.id, "You are terse.\nAnswer in English.")).status).toBe(200);
    expect((await saveSoul(bot.id, "You are warm.\nAnswer in English.")).status).toBe(200);
    const listed = await h.api<BotRuleVersionList>("GET", `/api/bots/${bot.id}/rule-versions/soul`);
    expect(listed.json.versions.map((v) => [v.version, v.createdBy])).toEqual([
      [2, "human:web"],
      [1, "human:web"],
    ]);
    expect(listed.json.lastRun).toBeUndefined();
    const diff = await h.api<{ lines: SoulDiffLine[] }>(
      "GET",
      `/api/bots/${bot.id}/rule-versions/soul/diff?from=1&to=2`,
    );
    expect(diff.json.lines).toEqual([
      { kind: "removed", text: "You are terse." },
      { kind: "added", text: "You are warm." },
      { kind: "same", text: "Answer in English." },
    ]);
    const restored = await h.api<{ version: number; appliesFromNextRun: boolean }>(
      "POST",
      `/api/bots/${bot.id}/rule-versions/soul/1/restore`,
      {},
    );
    expect(restored.status).toBe(200);
    expect(restored.json).toMatchObject({ version: 3, appliesFromNextRun: false });
    const third = await h.api<{ version: { body: string; restoredFrom: number } }>(
      "GET",
      `/api/bots/${bot.id}/rule-versions/soul/3`,
    );
    expect(third.json.version).toMatchObject({
      body: "You are terse.\nAnswer in English.",
      restoredFrom: 1,
    });
    // History is never rewritten: versions 1 and 2 are as they were, and rows refuse UPDATE.
    expect(h.app.deskmates.ctx.bots.versions.list(bot.id, "soul")).toHaveLength(3);
    expect(() =>
      h.app.deskmates.ctx.db.prepare("UPDATE bot_rule_versions SET body = 'x'").run(),
    ).toThrow("append-only");

    const run = await post(thread);
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded");
    const config = h.app.deskmates.ctx.runs.mustGet(run.id).config;
    expect(config.canonicalSoulRevision).toBe(3);
    expect(config.canonicalSoulVersion).toBe(sha("You are terse.\nAnswer in English."));
    expect(requestOf(run.id).canonicalFiles?.soul?.body).toBe("You are terse.\nAnswer in English.");
    const after = await h.api<BotRuleVersionList>("GET", `/api/bots/${bot.id}/rule-versions/soul`);
    expect(after.json.lastRun).toEqual({ runId: run.id, version: 3 });
  });

  it("versions MEMORY too and refuses a restore against a stale version", async () => {
    const { bot } = await h.seed();
    const memory = await h.api<{ memory: { version: string } }>(
      "GET",
      `/api/bots/${bot.id}/memory`,
    );
    await h.api("PATCH", `/api/bots/${bot.id}/memory`, {
      body: "Invoices go to finance.",
      expectedVersion: memory.json.memory.version,
    });
    const stale = await h.api<{ code: string }>(
      "POST",
      `/api/bots/${bot.id}/rule-versions/memory/1/restore`,
      { expectedVersion: sha("") },
    );
    expect(stale.status).toBe(409);
    const missing = await h.api<{ code: string }>(
      "GET",
      `/api/bots/${bot.id}/rule-versions/memory/9`,
    );
    expect(missing.status).toBe(404);
    const badFile = await h.api<{ code: string }>("GET", `/api/bots/${bot.id}/rule-versions/tools`);
    expect(badFile.status).toBe(400);
  });
});

describe("editing while busy (ADR-0043 decision 3)", () => {
  it("saves SOUL under a live run, leaves that attempt alone, and the next run uses the new body", async () => {
    const { bot, thread } = await h.seed();
    await saveSoul(bot.id, "Old rules.");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    h.provider.onRun(async (req, gw) => {
      if (first) {
        first = false;
        await gate;
      }
      await endRun(req, gw, `session-${req.runId}`);
    });
    const live = await post(thread);
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(live.id).status === "running");
    await waitFor(() => requestOf(live.id) !== undefined);
    const saved = await saveSoul(bot.id, "New rules.");
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ soul: { body: "New rules." }, appliesFromNextRun: true });
    expect(h.app.deskmates.ctx.runs.mustGet(live.id).status).toBe("running");
    expect(requestOf(live.id).canonicalFiles?.soul?.body).toBe("Old rules.");
    release();
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(live.id).status === "succeeded");
    expect(h.app.deskmates.ctx.runs.mustGet(live.id).config.canonicalSoulRevision).toBe(1);
    // The run that started under the old SOUL does not hand its session to the next one.
    expect(h.app.deskmates.ctx.sessions.get(bot.id, thread.id)).toBeUndefined();
    const next = await post(thread);
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(next.id).status === "succeeded");
    expect(requestOf(next.id).canonicalFiles?.soul?.body).toBe("New rules.");
    expect(requestOf(next.id).sdkSessionId).toBeUndefined();
    expect(h.app.deskmates.ctx.runs.mustGet(next.id).config.canonicalSoulRevision).toBe(2);
    expect(h.app.deskmates.ctx.sessions.get(bot.id, thread.id)).toBe(`session-${next.id}`);
  });
});

describe("diary (ADR-0043 decision 4)", () => {
  it("reads days and deletes one line through the container, audited without its text", async () => {
    const { bot, workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const stopped = await h.api<{ code: string }>("GET", `/api/bots/${bot.id}/diary`);
    expect(stopped.json.code).toBe("sandbox_unavailable");
    await ctx.sandboxes.ensure(ctx.workspaces.mustGet(workspace.id));
    let lines = ["- 09:00 run one: secret-ish", "- 10:00 run two"];
    const seen: Record<string, unknown>[] = [];
    h.provider.onRun(async (raw) => {
      const req = raw as unknown as Record<string, unknown>;
      seen.push(req);
      const body = lines.length ? `${lines.join("\n")}\n` : "";
      if (req.op === "list")
        return { stdout: JSON.stringify({ days: [{ day: "2026-10-15", bytes: body.length }] }) };
      if (req.op === "delete-line") lines = lines.filter((_, i) => i !== req.line);
      const now = lines.length ? `${lines.join("\n")}\n` : "";
      return { stdout: JSON.stringify({ day: req.day, lines, version: sha(now) }) };
    });
    const days = await h.api<{ days: unknown[] }>("GET", `/api/bots/${bot.id}/diary`);
    expect(days.json.days).toEqual([{ day: "2026-10-15", bytes: 44 }]);
    const day = await h.api<{ day: BotDiaryDay }>("GET", `/api/bots/${bot.id}/diary/2026-10-15`);
    expect(day.json.day.lines).toHaveLength(2);
    expect((await h.api("GET", `/api/bots/${bot.id}/diary/yesterday`)).status).toBe(400);
    const deleted = await h.api<{ day: BotDiaryDay }>(
      "POST",
      `/api/bots/${bot.id}/diary/2026-10-15/delete-line`,
      { line: 0, text: "- 09:00 run one: secret-ish", version: day.json.day.version },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.json.day.lines).toEqual(["- 10:00 run two"]);
    expect(seen.at(-1)).toMatchObject({ op: "delete-line", botName: "alice", line: 0 });
    const audit = ctx.audit.list({ targetId: bot.id }).find((e) => e.action === "bot.diary_edit");
    expect(audit?.before).toMatchObject({ day: "2026-10-15", line: 0 });
    expect(JSON.stringify(audit)).not.toContain("secret-ish");
  });
});

describe("Run now (ADR-0043 decision 6)", () => {
  it("starts a cron entry as a manual background run with the entry's prompt", async () => {
    const { bot } = await h.seed();
    h.provider.onRun(async (req, gw) => endRun(req, gw));
    await h.api("PATCH", `/api/bots/${bot.id}`, {
      cron: [{ schedule: "0 9 * * 1", prompt: "weekly sweep" }],
    });
    const res = await h.api<{ run: RunRecord }>("POST", `/api/bots/${bot.id}/cron/0/run`, {});
    expect(res.status).toBe(202);
    expect(res.json.run).toMatchObject({
      triggerKind: "manual",
      lane: "background",
      triggerPayload: { prompt: "weekly sweep", schedule: "0 9 * * 1", entry: 0 },
    });
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(res.json.run.id).status === "succeeded");
    expect(requestOf(res.json.run.id).trigger).toEqual({ kind: "cron", prompt: "weekly sweep" });
    expect((await h.api("POST", `/api/bots/${bot.id}/cron/3/run`, {})).status).toBe(404);
  });
});

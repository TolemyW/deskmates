// T1: ADR-0033 decisions 4, 5 and 7 — which runs queue an Activity summary job, that it is
// queued once per source version, and what a card is given to show.

import type { RunId, RunStatus } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { BotStore } from "../bots/bots.js";
import { openDatabase } from "../db/open.js";
import { EventBus } from "../events/bus.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { ACTIVITY_SUMMARY, createActivitySummaries } from "./activity-summaries.js";
import { type RunRecord, RunStore } from "./runs.js";

const LONG = "The bot compared every supplier quote, ".repeat(6);

function setup() {
  const db = openDatabase(":memory:");
  const runs = new RunStore(db);
  const bus = new EventBus();
  const store = createActivitySummaries({
    db,
    bus,
    runs,
    runConfig: () => ({ groupRouting: "owner-v1" }),
    cheapModel: () => "cheap-1",
    messageBody: () => undefined,
  });
  const ws = new WorkspaceStore(db).create({ name: "w", sandboxProvider: "docker" });
  const bot = new BotStore(db).create({ name: "ann", role: "r", workspaceId: ws.id });
  const jobs = () => runs.list({}).filter((r) => r.config.runType === ACTIVITY_SUMMARY);
  /** A cron run ended with `status`, its reply set, its status change published. */
  const ended = (status: RunStatus, reply: string, error?: string): RunRecord => {
    const run = runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "c",
      triggerPayload: { prompt: "check suppliers" },
      config: {},
    });
    runs.transition(run.id, "running");
    const done = runs.transition(run.id, status, {
      summary: {
        done: "checked",
        reply,
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
      },
      ...(error ? { error } : {}),
    });
    bus.publish({ type: "run_status", run: done });
    return done;
  };
  return { db, runs, bus, store, jobs, ended };
}

describe("eligibility (decision 4)", () => {
  it("a long succeeded run queues one cheap-model, one-turn background job with a bounded source", () => {
    const s = setup();
    const run = s.ended("succeeded", LONG);
    const [job] = s.jobs();
    expect(s.jobs()).toHaveLength(1);
    expect(job).toMatchObject({
      lane: "background",
      triggerKind: "model_job",
      botId: run.botId,
      status: "queued",
    });
    expect(job?.config).toMatchObject({
      runType: ACTIVITY_SUMMARY,
      sourceRunId: run.id,
      sourceVersion: "a1-succeeded",
      model: "cheap-1",
      maxTurns: 1,
      groupRouting: "owner-v1",
    });
    const prompt = String(job?.triggerPayload?.prompt);
    expect(prompt).toContain("status: succeeded");
    expect(prompt).toContain("request: check suppliers");
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(s.store.forRuns([run]).get(run.id)).toMatchObject({ status: "pending" });
  });

  it("a short outcome is shown verbatim and queues nothing", () => {
    const s = setup();
    const run = s.ended("succeeded", "报价已发出。");
    expect(s.jobs()).toEqual([]);
    expect(s.store.forRuns([run]).get(run.id)).toMatchObject({
      status: "ready",
      verbatim: true,
      text: "报价已发出。",
    });
  });

  it("silent and cancelled runs, live runs and summary jobs themselves queue nothing", () => {
    const s = setup();
    s.ended("silent", "");
    s.ended("cancelled", LONG);
    s.ended("succeeded", LONG);
    const [job] = s.jobs();
    if (!job) throw new Error("expected a job");
    s.runs.transition(job.id, "running");
    const done = s.runs.transition(job.id, "succeeded", {
      summary: {
        done: "Activity summary",
        reply: LONG,
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
      },
    });
    s.bus.publish({ type: "run_status", run: done });
    expect(s.jobs()).toHaveLength(1);
  });

  it("a long failure is summarized from its error", () => {
    const s = setup();
    s.ended("failed", "", `upstream 529 overloaded ${"retrying ".repeat(40)}`);
    expect(String(s.jobs()[0]?.triggerPayload?.prompt)).toContain("error: upstream 529");
  });
});

describe("cached by source version (decision 5)", () => {
  it("a repeated status event and repeated reads queue nothing more", () => {
    const s = setup();
    const run = s.ended("succeeded", LONG);
    s.bus.publish({ type: "run_status", run });
    s.store.forRuns([run]);
    s.store.forRuns([run]);
    expect(s.jobs()).toHaveLength(1);
  });

  it("a new attempt is a new version, at most three versions per run, and stale rows are not shown", () => {
    const s = setup();
    const run = s.ended("failed", "", `boom ${"x ".repeat(60)}`);
    const again = (attempt: number): RunRecord => {
      s.db.prepare("UPDATE runs SET attempt = ? WHERE id = ?").run(attempt, run.id);
      const current = s.runs.mustGet(run.id);
      s.bus.publish({ type: "run_status", run: current });
      return current;
    };
    again(2);
    expect(s.jobs()).toHaveLength(2);
    again(3);
    again(4);
    expect(s.jobs()).toHaveLength(3);
    const latest = s.runs.mustGet(run.id);
    // Attempt 4 has no row of its own: the card gets no summary rather than attempt 3's.
    expect(s.store.forRuns([latest]).get(run.id)).toBeUndefined();
  });
});

describe("completion changes only the summary (decision 7)", () => {
  it("stores the bounded text of the matching job, and a failed job leaves a failed row", () => {
    const s = setup();
    const run = s.ended("succeeded", LONG);
    const job = s.jobs()[0] as RunRecord;
    s.store.complete(job, `${"word ".repeat(50)}`);
    const summary = s.store.forRuns([s.runs.mustGet(run.id)]).get(run.id);
    expect(summary?.status).toBe("ready");
    expect(summary?.text?.split(/\s+/)).toHaveLength(30);
    expect(summary?.summaryRunId).toBe(job.id);
    expect(s.runs.mustGet(run.id).status).toBe("succeeded");

    const other = s.ended("succeeded", `${LONG} again`);
    const otherJob = s.jobs().find((j) => j.config.sourceRunId === other.id) as RunRecord;
    s.store.complete(otherJob, undefined);
    expect(s.store.forRuns([other]).get(other.id as RunId)).toMatchObject({ status: "failed" });
  });
});

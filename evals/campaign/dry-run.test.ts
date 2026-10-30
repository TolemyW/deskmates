// T1: the scripted dry run of the 2026-10-17 protocol (amendment 1 A4), model-free half. The
// scripts the dry run's upstream answers with meet every oracle; the dry run passes the
// known-zero gate with no ceiling; and a whole campaign of both comparisons runs through the
// executors' own path (gate and pin, first-batch order, stop rules before every task, one file
// per observation, rows, decision) with no model, no network and no Docker. The Docker half (the
// Gateway, the sidecar and the real tool calls) is `EVAL_DRY_RUN=scripted` on the executors.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RecordedUpstreamRequest } from "../../acceptance/support/fake-model-upstream.js";
import { main as cheapMain } from "../cheap-model-eval.js";
import { CHEAP_ARMS } from "../cheap-model/arms.js";
import { type CheapObservation, cheapChecks } from "../cheap-model/grade.js";
import { referenceObservation } from "../cheap-model/reference.js";
import { type CheapTask, cheapTasks, loadCheapTaskSet } from "../cheap-model/task-set.js";
import { main as retrievalMain } from "../retrieval-eval.js";
import { RETRIEVAL_ARMS } from "../retrieval/arms.js";
import { type RetrievalObservation, gradeRetrieval } from "../retrieval/grade.js";
import {
  type RetrievalItem,
  activeItems,
  loadRetrievalTaskSet,
  requiredTool,
} from "../retrieval/task-set.js";
import { CheapDryScript, RetrievalDryScript } from "./dry-run-script.js";
import { DRY_RUN_VECTOR_DIMS, hashedVector, overlapScore } from "./dry-run-services.js";
import {
  DRY_RUN_MODELS,
  DRY_RUN_TOKEN,
  dryRunEnvironment,
  dryRunPrices,
  dryRunRequested,
} from "./dry-run.js";
import { CAMPAIGN_PIN_FILE, authoriseCampaign, firstBatchFirst } from "./gate.js";
import { guard, taskOrder, writeObservation } from "./report-dir.js";
import { seeded } from "./text.js";

type Body = RecordedUpstreamRequest["body"];

const retrieval = loadRetrievalTaskSet();
const cheap = loadCheapTaskSet();
const items = activeItems(retrieval);
const tasks = cheapTasks(cheap);

const TOOLS = ["knowledge_search", "knowledge_read", "memory_search"].map((t) => ({
  name: `mcp__deskmates__${t}`,
}));

/** The bot's first request, then the request after the tool answered, as the CLI sends them. */
function botBody(prompt: string, toolUse?: { id: string; name: string }): Body {
  const messages: unknown[] = [{ role: "user", content: prompt }];
  if (toolUse) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", ...toolUse, input: {} }] });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "[]" }],
    });
  }
  return { model: DRY_RUN_MODELS.default, system: "# retrieval_eval", tools: TOOLS, messages };
}

const jobBody = (prompt: string): Body => ({
  model: DRY_RUN_MODELS.cheap,
  messages: [{ role: "user", content: prompt }],
});

/** `summary.reply` of an assistant text with the sidecar's summary block. */
function summaryOf(text: string): { reply: string; learned?: { body: string }[] } {
  const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (!json) throw new Error(`no summary block in ${text}`);
  return JSON.parse(json) as { reply: string; learned?: { body: string }[] };
}

/** What the retrieval executor records for one run the scripted upstream answered. */
function retrievalDryObservation(
  item: RetrievalItem,
  arm: string,
  repeat: number,
): RetrievalObservation {
  const script = new RetrievalDryScript();
  script.current = item;
  const first = script.turn(botBody(item.question));
  if (first.kind !== "tool_use") throw new Error(`${item.id}: expected a tool call`);
  const second = script.turn(botBody(item.question, { id: "toolu_1", name: first.name }));
  if (second.kind !== "text") throw new Error(`${item.id}: expected the answer`);
  return {
    taskId: item.id,
    arm,
    repeat,
    runId: `run-${item.id}-${arm}-${repeat}`,
    status: "succeeded",
    finalReply: summaryOf(second.text).reply,
    toolCalls: { [first.name.replace(/^mcp__deskmates__/, "")]: 1 },
    hits: [],
    canarySeen: false,
    memoryWrites: 0,
    costUsd: 0,
    leakUsd: 0,
    config: { taskSet: `${retrieval.name}@${retrieval.version}`, dryRun: "scripted" },
  };
}

/** The ids a Gateway would give the seeded notes: anything but the fixture keys. */
function fakeIds(task: CheapTask): Record<string, string> {
  const c = task.case;
  const keys =
    c.kind === "memory_organize" || c.kind === "memory_recheck"
      ? c.input.notes.map((n) => n.key)
      : [];
  return Object.fromEntries(keys.map((k, i) => [k, `mem_${i}_${k.length}x`]));
}

/** What the cheap-model executor records for one job the scripted upstream answered. */
function cheapDryObservation(task: CheapTask, arm: string, repeat: number): CheapObservation {
  const script = new CheapDryScript();
  script.task = task;
  script.ids = fakeIds(task);
  const base = referenceObservation(task, arm, repeat);
  const config = { taskSet: `${cheap.name}@${cheap.version}`, dryRun: "scripted" };
  if (task.case.kind === "memory_consolidation") {
    const turn = script.turn(botBody("consolidate"));
    if (turn.kind !== "text") throw new Error(`${task.taskId}: expected text`);
    const learned = (summaryOf(turn.text).learned ?? []).map((l) => l.body);
    return { ...base, learned, ids: script.ids, leakUsd: 0, config };
  }
  const turn = script.turn(jobBody("job"));
  if (turn.kind !== "text") throw new Error(`${task.taskId}: expected text`);
  // A one-turn job relays the model's text verbatim as `summary.reply` (ADR-0023 amendment 1).
  return { ...base, reply: turn.text, ids: script.ids, leakUsd: 0, config };
}

describe("the dry-run switch and environment", () => {
  it("is EVAL_DRY_RUN=scripted or nothing", () => {
    expect(dryRunRequested({})).toBe(false);
    expect(dryRunRequested({ EVAL_DRY_RUN: " scripted " })).toBe(true);
    expect(() => dryRunRequested({ EVAL_DRY_RUN: "yes" })).toThrow(/scripted or unset/);
  });

  it("points every model variable at the scripted upstream and clears the ceiling and upstreams", () => {
    const env = dryRunEnvironment({ modelBaseUrl: "http://127.0.0.1:1" });
    expect(env.MODEL_AUTH_TOKEN).toBe(DRY_RUN_TOKEN);
    expect(env.MODEL_UPSTREAMS).toBe("");
    expect(env.EVAL_CEILING_USD).toBe("");
    expect(env.EMBEDDING_URL).toBe("");
    expect(JSON.parse(env.MODEL_PRICES ?? "[]")).toEqual(dryRunPrices());
    const withServices = dryRunEnvironment({
      modelBaseUrl: "http://127.0.0.1:1",
      embeddingUrl: "http://127.0.0.1:2/v1/embeddings",
      rerankUrl: "http://127.0.0.1:2/rerank",
    });
    expect(withServices.EMBEDDING_MODEL).not.toBe("");
    expect(withServices.RERANK_MODEL).not.toBe("");
  });
});

describe("the dry run's scripts", () => {
  it("make every retrieval run call its corpus's search tool and give the task's answer", () => {
    for (const item of items) {
      const obs = retrievalDryObservation(item, "fts5", 1);
      expect(obs.toolCalls?.[requiredTool(item)], item.id).toBe(1);
      expect(gradeRetrieval(item, obs), item.id).toMatchObject({ success: true });
    }
  });

  it("answer a retrieval run that lacks the search tool anyway, so the grader shows it", () => {
    const item = items[0] as RetrievalItem;
    const script = new RetrievalDryScript();
    script.current = item;
    const turn = script.turn({ ...botBody(item.question), tools: [{ name: "Bash" }] });
    expect(turn.kind).toBe("text");
    expect(new RetrievalDryScript().turn(botBody("x"))).toEqual({ kind: "text", text: "dry run" });
  });

  it("pass every check of every cheap-model task, with the Gateway's ids in the reply", () => {
    for (const task of tasks) {
      const obs = cheapDryObservation(task, "incumbent", 1);
      const failed = cheapChecks(task, obs).filter((c) => !c.pass);
      expect(failed, task.taskId).toEqual([]);
      for (const [key, id] of Object.entries(obs.ids ?? {})) {
        expect(obs.reply, task.taskId).toContain(id);
        expect(obs.reply, task.taskId).not.toContain(`"${key}"`);
      }
    }
  });

  it("keep triage workers and other runs with tools silent", () => {
    const script = new CheapDryScript();
    script.task = tasks.find((t) => t.kind === "round_triage");
    const turn = script.turn(botBody("work"));
    expect(turn.kind === "text" && summaryOf(turn.text).reply).toBe("");
  });
});

describe("the scripted retrieval services", () => {
  it("embed deterministically into fixed dimensions, never the zero vector", () => {
    const v = hashedVector("E-4127 is raised by ledger-sync");
    expect(v).toHaveLength(DRY_RUN_VECTOR_DIMS);
    expect(hashedVector("E-4127 is raised by ledger-sync")).toEqual(v);
    expect(hashedVector("").some((x) => x !== 0)).toBe(true);
  });

  it("score rerank by the query's content tokens the document holds", () => {
    expect(overlapScore("Which desk owns the runbook?", "The Heron desk owns the runbook")).toBe(1);
    expect(overlapScore("Which desk owns the runbook?", "nothing here")).toBe(0);
    expect(overlapScore("the", "the")).toBe(0);
  });
});

/**
 * One whole campaign through the executors' path: per block and arm, authorise (gate and pin),
 * order (seeded, first batch first in block 1), check the stop rules before every task, write
 * one observation file per run. Returns the report directory.
 */
function runDryCampaign<T>(input: {
  campaign: string;
  taskSet: string;
  arms: readonly string[];
  repeats: number;
  tasks: readonly T[];
  id: (t: T) => string;
  firstBatch: (t: T) => boolean;
  seed: number;
  models: readonly string[];
  observe: (t: T, arm: string, repeat: number) => object;
}): string {
  const reportDir = mkdtempSync(path.join(tmpdir(), `${input.campaign}-dry-`));
  for (let repeat = 1; repeat <= input.repeats; repeat += 1)
    for (const arm of input.arms) {
      const dryEnv = dryRunEnvironment({ modelBaseUrl: "http://127.0.0.1:1" });
      const env = {
        ...dryEnv,
        EVAL_ARM: arm,
        EVAL_REPEAT: String(repeat),
        EVAL_REPORT_DIR: reportDir,
      };
      const run = authoriseCampaign(env, {
        campaign: input.campaign,
        taskSet: input.taskSet,
        mode: "scripted",
        models: input.models,
        // The same gate a real run takes, on the prices the dry run's stack loads.
        prices: JSON.parse(dryEnv.MODEL_PRICES ?? "[]"),
      });
      expect(run.ceilingUsd).toBeNull();
      const order = firstBatchFirst(
        taskOrder(input.tasks, seeded(input.seed + repeat)),
        input.firstBatch,
        repeat,
      );
      if (repeat === 1) {
        const n = input.tasks.filter(input.firstBatch).length;
        expect(order.slice(0, n).every(input.firstBatch)).toBe(true);
      }
      // The executor checks before every task; a dry run's zero spend never stops it.
      for (const t of order) {
        expect(guard(run, () => 0.1, input.id(t)).stop).toBe(false);
        writeObservation(run, input.observe(t, arm, repeat) as never, [DRY_RUN_TOKEN]);
      }
    }
  return reportDir;
}

// Each test writes 720 observation files and re-reads the directory before every task, as the
// executor does; that takes seconds, more on a loaded host.
describe("a whole scripted dry-run campaign, model-free (T1)", () => {
  it("runs comparison R end to end and decides, marked as not evidence", () => {
    const reportDir = runDryCampaign({
      campaign: "retrieval-v1",
      taskSet: `${retrieval.name}@${retrieval.version}`,
      arms: RETRIEVAL_ARMS.map((a) => a.arm),
      repeats: retrieval.defaults.repeats,
      tasks: items,
      id: (i) => i.id,
      firstBatch: (i) => retrieval.ceiling.smoke_tasks.includes(i.id),
      seed: 1000,
      models: [DRY_RUN_MODELS.default, DRY_RUN_MODELS.cheap],
      observe: retrievalDryObservation,
    });
    const files = readdirSync(reportDir);
    expect(files).toContain(CAMPAIGN_PIN_FILE);
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(
      items.length * RETRIEVAL_ARMS.length * retrieval.defaults.repeats,
    );
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    for (const arm of ["fts5", "vectors"])
      expect(
        retrievalMain(
          ["rows", reportDir, "--arm", arm, "--out", path.join(reportDir, `${arm}.jsonl`)],
          log,
        ),
      ).toBe(0);
    const rows = readFileSync(path.join(reportDir, "vectors.jsonl"), "utf8").trim().split("\n");
    expect(rows).toHaveLength(items.length * retrieval.defaults.repeats);
    expect(rows.every((r) => JSON.parse(r).success === true)).toBe(true);
    const code = retrievalMain(
      ["decide", path.join(reportDir, "fts5.jsonl"), path.join(reportDir, "vectors.jsonl")],
      log,
    );
    expect(lines.some((l) => l.startsWith("dry run:") && l.includes("not evidence"))).toBe(true);
    // Identical scripted arms: complete, nothing worse, nothing better, so never "adopt".
    expect(lines).toContain("decision: not adopted");
    expect(code).toBe(1);
  }, 120_000);

  it("runs comparison C end to end and decides, marked as not evidence", () => {
    const reportDir = runDryCampaign({
      campaign: "cheap-model-v1",
      taskSet: `${cheap.name}@${cheap.version}`,
      arms: CHEAP_ARMS.map((a) => a.arm),
      repeats: cheap.defaults.repeats,
      tasks,
      id: (t) => t.taskId,
      firstBatch: (t) => cheap.ceiling.smoke_cases.includes(t.caseId),
      seed: 2000,
      models: [DRY_RUN_MODELS.incumbent, DRY_RUN_MODELS.candidate, DRY_RUN_MODELS.default],
      observe: cheapDryObservation,
    });
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    for (const arm of ["incumbent", "candidate"])
      expect(
        cheapMain(
          ["rows", reportDir, "--arm", arm, "--out", path.join(reportDir, `${arm}.jsonl`)],
          log,
        ),
      ).toBe(0);
    const rows = readFileSync(path.join(reportDir, "candidate.jsonl"), "utf8").trim().split("\n");
    expect(rows).toHaveLength(tasks.length * cheap.defaults.repeats);
    expect(rows.every((r) => JSON.parse(r).success === true)).toBe(true);
    cheapMain(
      ["decide", path.join(reportDir, "incumbent.jsonl"), path.join(reportDir, "candidate.jsonl")],
      log,
    );
    expect(lines.some((l) => l.startsWith("dry run:") && l.includes("not evidence"))).toBe(true);
    expect(lines.some((l) => l.startsWith("decision: ") && l !== "decision: no verdict")).toBe(
      true,
    );
    expect(lines).not.toContain("decision: reject");
  }, 120_000);
});

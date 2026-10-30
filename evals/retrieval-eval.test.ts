// T0: comparison R of the 2026-10-17 protocol (ADR-0041 decision 10). The task file's schema and
// design properties, the oracle's determinism, the arms, the sample size from `power.ts`, the
// ceilings and the decision rule. Nothing here runs a model, a Gateway or Docker.

import { DEFAULT_MEMORY_INDEX_BUDGETS } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { decideRetrieval } from "./campaign/decide.js";
import { fillerKnowledge, fillerNotes } from "./campaign/text.js";
import type { ResultRow } from "./compare/result-row.js";
import { main } from "./retrieval-eval.js";
import {
  RETRIEVAL_ARMS,
  RETRIEVAL_COMPARISONS,
  retrievalArmEnvironment,
  retrievalArmOrder,
} from "./retrieval/arms.js";
import {
  type RetrievalObservation,
  gradeRetrieval,
  retrievalRow,
  retrievalRows,
} from "./retrieval/grade.js";
import { renderRetrievalPlan, retrievalPlan } from "./retrieval/plan.js";
import {
  type RetrievalItem,
  activeItems,
  loadRetrievalTaskSet,
  requiredTool,
  retrievalInstruction,
  validateRetrievalTaskSet,
} from "./retrieval/task-set.js";

const set = loadRetrievalTaskSet();
const items = activeItems(set);

function observation(
  item: RetrievalItem,
  over: Partial<RetrievalObservation> = {},
): RetrievalObservation {
  return {
    taskId: item.id,
    arm: "fts5",
    repeat: 1,
    status: "succeeded",
    finalReply: `Found it.\nanswer: ${item.answer.value}`,
    toolCalls: { [requiredTool(item)]: 1 },
    hits: [item.gold],
    canarySeen: false,
    costUsd: 0.01,
    ...over,
  };
}

describe("the retrieval task file", () => {
  it("passes every design check: schema, unique ids, strata, grounded answers, frozen filler", () => {
    expect(validateRetrievalTaskSet(set)).toEqual([]);
  });

  it("has 48 active tasks: 32 short and 16 medium, 24 per corpus, about 20% held out", () => {
    expect(items).toHaveLength(48);
    expect(items.filter((i) => i.bucket === "short")).toHaveLength(32);
    expect(items.filter((i) => i.bucket === "medium")).toHaveLength(16);
    expect(items.filter((i) => i.corpus === "knowledge")).toHaveLength(24);
    expect(items.filter((i) => i.corpus === "memory")).toHaveLength(24);
    expect(items.filter((i) => i.holdout)).toHaveLength(10);
    for (const corpus of ["knowledge", "memory"] as const) {
      const strata = (s: string) =>
        items.filter((i) => i.corpus === corpus && i.stratum === s).length;
      expect([strata("lexical"), strata("paraphrase"), strata("cross_lingual")]).toEqual([4, 4, 3]);
      expect([
        strata("identifier"),
        strata("negative"),
        strata("chain"),
        strata("aggregate"),
      ]).toEqual([3, 2, 5, 3]);
    }
  });

  it("finds a broken file: a duplicate id, a paraphrase sharing a word, an ungrounded answer", () => {
    const broken = structuredClone(set);
    broken.items.push({ ...(broken.items[0] as RetrievalItem) });
    const paraphrase = broken.items.find((i) => i.stratum === "paraphrase") as RetrievalItem;
    paraphrase.question = `${paraphrase.question} replication`;
    const lexical = broken.items.find((i) => i.id === "RK-S02") as RetrievalItem;
    lexical.answer = { value: "401", aliases: [] };
    const problems = validateRetrievalTaskSet(broken);
    expect(problems).toContain("duplicate item id RK-S01");
    expect(problems.some((p) => p.includes("shares replication"))).toBe(true);
    expect(problems).toContain("item RK-S02: no accepted answer occurs in a gold source");
  });

  it("keeps the gold memory out of the pinned index: more one-line fillers than workspace lines", () => {
    const notes = fillerNotes(set.filler.memory, set.filler.seed);
    expect(notes.length).toBeGreaterThan(DEFAULT_MEMORY_INDEX_BUDGETS.workspaceLines);
    expect(notes.every((n) => !n.body.includes("\n"))).toBe(true);
    expect(new Set(notes.map((n) => n.body)).size).toBe(notes.length);
  });

  it("generates the same filler every time", () => {
    expect(fillerKnowledge(60, set.filler.seed)).toEqual(fillerKnowledge(60, set.filler.seed));
    expect(fillerNotes(130, set.filler.seed)).toEqual(fillerNotes(130, set.filler.seed));
    expect(fillerNotes(130, set.filler.seed)).not.toEqual(fillerNotes(130, set.filler.seed + 1));
  });

  it("tells each run which tool to use, how to abstain and how to answer", () => {
    const k = retrievalInstruction(
      set,
      items.find((i) => i.corpus === "knowledge") as RetrievalItem,
    );
    const m = retrievalInstruction(set, items.find((i) => i.corpus === "memory") as RetrievalItem);
    expect(k).toContain("knowledge_search");
    expect(m).toContain("memory_search");
    for (const text of [k, m]) {
      expect(text).toContain("answer not found");
      expect(text).toContain("answer: <value>");
    }
  });
});

describe("the retrieval oracle", () => {
  it("passes the gold answer, an alias and a formatted number for every task, twice the same", () => {
    for (const item of items) {
      const row = retrievalRow(item, observation(item));
      expect(row, item.id).toMatchObject({
        success: true,
        failureReason: null,
        bucket: item.bucket,
      });
      expect(retrievalRow(item, observation(item))).toEqual(row);
      for (const alias of item.answer.aliases)
        expect(
          gradeRetrieval(item, observation(item, { finalReply: `answer: ${alias}` })).success,
        ).toBe(true);
    }
    const sum = items.find((i) => i.id === "RK-M08") as RetrievalItem;
    expect(gradeRetrieval(sum, observation(sum, { finalReply: "answer: **3,550**" })).success).toBe(
      true,
    );
  });

  it("fails a wrong answer, no answer, no search, a failed run and the canary", () => {
    const item = items.find((i) => i.id === "RK-S12") as RetrievalItem;
    const fail = (over: Partial<RetrievalObservation>) =>
      gradeRetrieval(item, observation(item, over)).failureReason;
    expect(fail({ finalReply: "answer: quote-engine" })).toBe("wrong_answer");
    expect(fail({ finalReply: "It is ledger-sync." })).toBe("no_answer");
    expect(fail({ toolCalls: { knowledge_read: 2 } })).toBe("tool_not_called");
    expect(fail({ status: "failed" })).toBe("run_failed");
    expect(fail({ canarySeen: true })).toBe("canary");
  });

  it("an abstention passes a negative task and fails an answerable one", () => {
    const negative = items.find((i) => i.stratum === "negative") as RetrievalItem;
    const answerable = items.find((i) => i.stratum === "lexical") as RetrievalItem;
    expect(
      gradeRetrieval(negative, observation(negative, { finalReply: "answer: Not found." })).success,
    ).toBe(true);
    expect(
      gradeRetrieval(answerable, observation(answerable, { finalReply: "answer: not found" }))
        .success,
    ).toBe(false);
  });

  it("writes recall and the first gold rank into the fingerprint, and leaves unknowns out", () => {
    const chain = items.find((i) => i.id === "RK-M01") as RetrievalItem;
    const row = retrievalRow(
      chain,
      observation(chain, {
        hits: [["K02", "K21"], ["K22"]],
        inputTokens: null,
        toolCalls: { knowledge_search: 2, knowledge_read: 1 },
      }),
    );
    expect(row.fingerprint).toMatchObject({
      goldRecall: 2 / 3,
      firstGoldRank: 1,
      searchCalls: 2,
      readCalls: 1,
      toolCalls: 3,
    });
    expect(row.fingerprint).not.toHaveProperty("inputTokens");
  });

  it("refuses to grade a campaign with a harness error, a duplicate or an unknown task", () => {
    const item = items[0] as RetrievalItem;
    expect(() => retrievalRows(set, [observation(item, { harnessError: "seed failed" })])).toThrow(
      /harness error/,
    );
    expect(() => retrievalRows(set, [observation(item), observation(item)])).toThrow(/duplicate/);
    expect(() => retrievalRows(set, [{ ...observation(item), taskId: "RK-X99" }])).toThrow(
      /not an active task/,
    );
  });
});

describe("the retrieval arms", () => {
  const env = {
    EMBEDDING_URL: "http://embed.test/api/embed",
    EMBEDDING_MODEL: "embedding-model",
    RERANK_URL: "http://rerank.test/v1/rerank",
    RERANK_MODEL: "rerank-model",
  };

  it("are FTS5, vectors and vectors with rerank, compared one knob at a time", () => {
    expect(RETRIEVAL_ARMS.map((a) => a.arm)).toEqual(["fts5", "vectors", "vectors-rerank"]);
    expect(RETRIEVAL_COMPARISONS).toEqual([
      { id: "R1", knob: "vectors", baseline: "fts5", candidate: "vectors" },
      { id: "R2", knob: "rerank", baseline: "vectors", candidate: "vectors-rerank" },
    ]);
    expect(retrievalArmEnvironment("fts5", env)).toEqual({
      EMBEDDING_URL: "",
      EMBEDDING_MODEL: "",
      RERANK_URL: "",
      RERANK_MODEL: "",
    });
    expect(retrievalArmEnvironment("vectors", env)).toMatchObject({
      EMBEDDING_MODEL: "embedding-model",
      RERANK_URL: "",
    });
    expect(retrievalArmEnvironment("vectors-rerank", env)).toEqual(env);
  });

  it("refuse a tuned default and a half-configured arm", () => {
    expect(() => retrievalArmEnvironment("vectors", { ...env, RERANK_TOP_N: "10" })).toThrow(
      /defaults/,
    );
    expect(() => retrievalArmEnvironment("vectors-rerank", { ...env, RERANK_MODEL: "" })).toThrow(
      /RERANK_MODEL/,
    );
  });

  it("rotate between repetition blocks", () => {
    expect(retrievalArmOrder(3)).toEqual([
      ["fts5", "vectors", "vectors-rerank"],
      ["vectors", "vectors-rerank", "fts5"],
      ["vectors-rerank", "fts5", "vectors"],
    ]);
  });
});

describe("the retrieval plan (the numbers the protocol quotes)", () => {
  const plan = retrievalPlan(set);

  it("takes its sample size from power.ts: 294 runs per arm needed for 10 points at 0.65, 240 planned", () => {
    expect(plan.runsNeededPerArm).toBe(294);
    expect(plan.runsPerArm).toBe(240);
    const mde = Object.fromEntries(
      plan.power.map((p) => [p.scope, Math.round(p.report.optimistic * 1000) / 10]),
    );
    expect(mde).toEqual({ all: 11.1, short: 13.6, medium: 19.2, knowledge: 15.7, memory: 15.7 });
    expect(Math.round((plan.power[0]?.report.conservative ?? 0) * 1000) / 10).toBe(24.6);
  });

  it("has one ceiling of USD 120.00 for the whole campaign, the first batch inside it (amendment 1)", () => {
    expect(plan.ceiling.totalUsd).toBe(120);
    expect(plan.ceiling.lines.map((l) => l.runs)).toEqual([480, 240]);
    expect(plan.firstBatch.totalUsd).toBe(2.4);
    const text = renderRetrievalPlan(plan);
    expect(text).toContain("Ceiling, the whole campaign (every arm and block): USD 120.00");
    expect(text).toContain("no paid run is authorised");
    expect(text).not.toMatch(/smoke|confirmatory|each needs an explicit owner ruling/);
  });
});

describe("the retrieval decision rule", () => {
  const ids = items.map((i) => i.id);
  const rows = (arm: string, pass: (item: RetrievalItem, repeat: number) => boolean): ResultRow[] =>
    items.flatMap((item) =>
      [1, 2, 3, 4, 5].map((repeat) =>
        retrievalRow(
          item,
          observation(item, {
            arm,
            repeat,
            ...(pass(item, repeat) ? {} : { finalReply: "answer: something else" }),
          }),
        ),
      ),
    );
  const decide = (baseline: ResultRow[], candidate: ResultRow[]) =>
    decideRetrieval({ baseline, candidate, taskIds: ids, k: 5, delta: 0.1, costDelta: 0.15 });
  const paraphrased = (i: RetrievalItem) =>
    ["paraphrase", "cross_lingual", "chain"].includes(i.stratum);

  it("adopts a candidate that is better overall with no corpus or bucket worse", () => {
    const base = rows("fts5", (i, r) => !paraphrased(i) || r === 1);
    const cand = rows("vectors", () => true);
    expect(decide(base, cand).decision).toBe("adopt");
  });

  it("does not adopt a candidate that is merely no worse", () => {
    const same = (i: RetrievalItem, r: number) => (i.id.charCodeAt(4) + r) % 3 !== 0;
    expect(decide(rows("fts5", same), rows("vectors", same)).decision).toBe("not adopted");
  });

  it("rejects a candidate that loses the abstentions, and gives no verdict when incomplete or leaked", () => {
    const base = rows("fts5", (i, r) => !paraphrased(i) || r === 1);
    const cand = rows("vectors", (i) => i.stratum !== "negative");
    const report = decide(base, cand);
    expect(report.decision).toBe("reject");
    expect(report.reasons.some((r) => r.startsWith("abstention"))).toBe(true);
    expect(decide(base, cand.slice(1)).decision).toBe("no verdict");
    const leaked = rows("vectors", () => true).map((r, i) =>
      i === 0 ? { ...r, success: false, failureReason: "canary" } : r,
    );
    expect(decide(base, leaked).decision).toBe("no verdict");
  });
});

describe("the retrieval CLI", () => {
  it("checks and plans without touching anything, and refuses an unknown arm", () => {
    const out: string[] = [];
    expect(main(["check"], (l) => out.push(l))).toBe(0);
    expect(out.at(-1)).toBe(`retrieval ${set.version}: ok`);
    expect(main(["plan"], (l) => out.push(l))).toBe(0);
    expect(out.join("\n")).toContain("294 runs per arm needed, 240 planned");
    expect(main(["rows", "evals/tasks", "--arm", "bm25"], (l) => out.push(l))).toBe(2);
  });
});

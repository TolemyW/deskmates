// T0: the web search comparison of the 2026-10-18 protocol (ADR-0049 decision 13). The task file
// is valid and its oracles meetable by search; the validator catches the ways a task could leak
// or be unanswerable; the grader is deterministic; the plan computes the numbers the protocol
// quotes; the arms differ in one knob; the decision rule adopts, rejects and refuses as written.
// No model, no network, no Docker.

import { describe, expect, it } from "vitest";
import type { ResultRow } from "./compare/result-row.js";
import { main } from "./web-search-eval.js";
import {
  WEB_SEARCH_ARMS,
  webSearchArm,
  webSearchArmEnvironment,
  webSearchArmOrder,
} from "./web-search/arms.js";
import { decideWebSearch } from "./web-search/decide.js";
import { type WebSearchObservation, gradeWebSearch, webSearchRows } from "./web-search/grade.js";
import { webSearchPlan } from "./web-search/plan.js";
import {
  STRATUM_BUCKET,
  type WebSearchItem,
  type WebSearchTaskSet,
  activeItems,
  indexDocuments,
  loadWebSearchTaskSet,
  rankIndex,
  validateWebSearchTaskSet,
  webSearchAnswerMatches,
  webSearchInstruction,
} from "./web-search/task-set.js";

const set = loadWebSearchTaskSet();
const items = activeItems(set);
const byId = (id: string) => items.find((i) => i.id === id) as WebSearchItem;
const clone = (): WebSearchTaskSet => JSON.parse(JSON.stringify(set)) as WebSearchTaskSet;

describe("the web search task file", () => {
  it("is valid: grounded answers, meetable hops, frozen filler", () => {
    expect(validateWebSearchTaskSet(set)).toEqual([]);
    expect(set.name).toBe("web-search");
    expect(items).toHaveLength(40);
  });

  it("has the planned strata, buckets and held-out tasks", () => {
    const count = (s: string) => items.filter((i) => i.stratum === s).length;
    expect(Object.fromEntries(Object.keys(STRATUM_BUCKET).map((s) => [s, count(s)]))).toEqual({
      snippet: 6,
      page: 6,
      negative: 4,
      injection: 4,
      disambiguation: 5,
      chain: 6,
      aggregate: 4,
      enumerate: 5,
    });
    expect(items.filter((i) => i.holdout)).toHaveLength(8);
    expect(indexDocuments(set)).toHaveLength(150);
  });

  it("asks both arms the same instruction, naming no tool", () => {
    for (const item of items) {
      const text = webSearchInstruction(set, item);
      expect(text).toContain(item.question);
      expect(text).not.toMatch(/web_search|browser|curl/);
    }
  });

  it("ranks the other firm of the same name, and the planted notice, ahead on a name-only search", () => {
    const docs = indexDocuments(set);
    const ds = byId("WS-DS01");
    const name = docs.find((d) => d.id === ds.gold[0])?.title ?? "";
    expect(rankIndex(docs, name, 1)[0]?.id).toBe(ds.distractors[0]);
    const ij = byId("WS-IJ01");
    expect(rankIndex(docs, ij.hops[0]?.query ?? "", 1)[0]?.id).toBe(ij.distractors[0]);
  });
});

describe("the validator", () => {
  it("catches a page answer that leaked into the snippet", () => {
    const bad = clone();
    const item = bad.items.find((i) => i.id === "WS-PG01") as WebSearchItem;
    const doc = bad.documents.find((d) => d.id === item.gold[0]);
    if (!doc) throw new Error("fixture");
    doc.snippet = `${doc.snippet} Visitors use ${item.answer.value}.`;
    doc.body = `${doc.snippet} ${doc.body}`;
    expect(validateWebSearchTaskSet(bad).join("\n")).toMatch(/WS-PG01: a page item's answer/);
  });

  it("catches a hop the search cannot find, a planted canary and a present absent token", () => {
    const bad = clone();
    const hop = (bad.items.find((i) => i.id === "WS-CH01") as WebSearchItem).hops[1];
    if (hop) hop.query = "meeting room floor";
    const gold = bad.documents.find((d) => d.id === "E01");
    if (gold) gold.body = `${gold.body} ${bad.canary}`;
    const neg = bad.items.find((i) => i.id === "WS-NG01") as WebSearchItem;
    const any = bad.documents.find((d) => d.id === "E02");
    if (any) any.body = `${any.body} ${neg.absent?.[0] ?? ""}`;
    const problems = validateWebSearchTaskSet(bad).join("\n");
    expect(problems).toMatch(/WS-CH01: query "meeting room floor" does not find/);
    expect(problems).toMatch(/E01 carries the canary/);
    expect(problems).toMatch(/WS-NG01: \w+ is on E02/);
  });

  it("catches a changed filler generator and a wrong enumeration", () => {
    const bad = clone();
    bad.filler.seed += 1;
    const en = bad.items.find((i) => i.id === "WS-EN01") as WebSearchItem;
    en.answer.value = "Somebody Else";
    const problems = validateWebSearchTaskSet(bad).join("\n");
    expect(problems).toMatch(/filler digest/);
    expect(problems).toMatch(/WS-EN01: the answer is not the list of seal holders/);
  });
});

const reference = (item: WebSearchItem, extra: Partial<WebSearchObservation> = {}) =>
  ({
    taskId: item.id,
    arm: "browser",
    repeat: 1,
    status: "succeeded",
    finalReply: `Found it.\nanswer: ${item.answer.value}`,
    toolCalls: { browser_navigate: 2 },
    searches: { tool: 0, browser: item.hops.length },
    pagesOpened: 1,
    costUsd: 0,
    ...extra,
  }) as WebSearchObservation;

describe("the web search oracle", () => {
  it("passes every reference answer, the same way twice", () => {
    for (const item of items) {
      const once = gradeWebSearch(set, item, reference(item));
      expect(once, item.id).toEqual({
        success: true,
        failureReason: null,
        unsafe: false,
        answer: item.answer.value,
      });
      expect(gradeWebSearch(set, item, reference(item))).toEqual(once);
    }
  });

  it("fails a run that never searched, answered wrongly, failed or followed an injection", () => {
    const item = byId("WS-IJ01");
    expect(
      gradeWebSearch(set, item, reference(item, { searches: { tool: 0, browser: 0 } })),
    ).toMatchObject({ failureReason: "no_search" });
    expect(
      gradeWebSearch(set, item, reference(item, { finalReply: "answer: XX-0000" })),
    ).toMatchObject({ failureReason: "wrong_answer" });
    expect(gradeWebSearch(set, item, reference(item, { status: "failed" }))).toMatchObject({
      failureReason: "run_failed",
    });
    expect(gradeWebSearch(set, item, reference(item, { finalReply: "ok" }))).toMatchObject({
      failureReason: "no_answer",
    });
    expect(
      gradeWebSearch(set, item, reference(item, { finalReply: `answer: ${set.canary}` })),
    ).toEqual({ success: false, failureReason: "injected", unsafe: true, answer: set.canary });
  });

  it("matches an enumeration in any order and a dock with or without the word", () => {
    const en = byId("WS-EN01");
    const reversed = en.answer.value.split(", ").reverse().join(",");
    expect(webSearchAnswerMatches(en, reversed)).toBe(true);
    expect(webSearchAnswerMatches(en, en.answer.value.split(", ").slice(1).join(", "))).toBe(false);
    const pg = byId("WS-PG01");
    for (const a of [pg.answer.value, ...pg.answer.aliases])
      expect(webSearchAnswerMatches(pg, a)).toBe(true);
  });

  it("writes rows with the search fingerprint and refuses duplicates and harness errors", () => {
    const item = byId("WS-CH01");
    const [row] = webSearchRows(set, [reference(item)]);
    expect(row).toMatchObject({
      taskId: "WS-CH01",
      bucket: "medium",
      success: true,
      stratum: "chain",
      unsafe: false,
      fingerprint: { searches: 2, toolSearches: 0, browserSearches: 2, pagesOpened: 1 },
    });
    expect(() => webSearchRows(set, [reference(item), reference(item)])).toThrow(/duplicate/);
    expect(() => webSearchRows(set, [reference(item, { harnessError: "seed" })])).toThrow(
      /harness error/,
    );
  });
});

describe("the web search plan (the numbers the protocol quotes)", () => {
  it("sizes the campaign from evals/power.ts and prices one ceiling", () => {
    const plan = webSearchPlan(set);
    expect(plan.tasks).toEqual({ total: 40, short: 20, medium: 15, long: 5, holdout: 8 });
    expect(plan.runsNeededPerArm).toBe(303);
    expect(plan.runsPerArm).toBe(200);
    const all = plan.power.find((p) => p.scope === "all")?.report;
    expect(Number(((all?.optimistic ?? 0) * 100).toFixed(1))).toBe(12.3);
    expect(Number(((all?.conservative ?? 0) * 100).toFixed(1))).toBe(26.7);
    expect(plan.ceiling.totalUsd).toBe(95);
    expect(plan.firstBatch.totalUsd).toBe(2.8);
  });
});

describe("the web search arms", () => {
  it("differ in the workspace switch only, and refuse a campaign that names a search service", () => {
    expect(WEB_SEARCH_ARMS).toEqual([
      { arm: "browser", switchOn: false },
      { arm: "browser-search", switchOn: true },
    ]);
    expect(webSearchArm("browser-search").switchOn).toBe(true);
    expect(() => webSearchArm("tool-only")).toThrow(/EVAL_ARM/);
    const fixture = { url: "http://127.0.0.1:1", token: "t" };
    expect(webSearchArmEnvironment({}, fixture)).toEqual({
      SEARCH_URL: "http://127.0.0.1:1",
      SEARCH_AUTH_TOKEN: "t",
    });
    expect(() =>
      webSearchArmEnvironment({ SEARCH_URL: "https://search.example" }, fixture),
    ).toThrow(/searches its own fixture/);
    expect(webSearchArmOrder(2)).toEqual([
      ["browser", "browser-search"],
      ["browser-search", "browser"],
    ]);
  });
});

/** Rows for every task, K repeats, with `pass(item, repeat)` deciding success. */
function rows(arm: string, pass: (item: WebSearchItem, repeat: number) => boolean, extra = {}) {
  const out: ResultRow[] = [];
  for (const item of items)
    for (let repeat = 1; repeat <= set.defaults.repeats; repeat += 1)
      out.push({
        taskId: item.id,
        bucket: item.bucket,
        repeat,
        success: pass(item, repeat),
        failureReason: null,
        fingerprint: { searches: arm === "browser" ? 1 : 3 },
        costUsd: 0.1,
        arm,
        stratum: item.stratum,
        holdout: item.holdout,
        unsafe: false,
        ...extra,
      });
  return out;
}

const decide = (baseline: ResultRow[], candidate: ResultRow[]) =>
  decideWebSearch({
    baseline,
    candidate,
    taskIds: items.map((i) => i.id),
    k: set.defaults.repeats,
    delta: set.defaults.delta_pass_rate,
    costDelta: set.defaults.delta_cost,
    unsafeFloor: set.defaults.unsafe_floor,
  });

describe("the web search decision rule", () => {
  const half = (item: WebSearchItem, repeat: number) =>
    item.stratum === "negative" || (items.indexOf(item) + repeat) % 2 === 0;

  it("adopts a candidate that is better overall and worse nowhere", () => {
    const report = decide(
      rows("browser", half),
      rows("browser-search", () => true),
    );
    expect(report.decision).toBe("adopt");
    expect(report.effect.map((e) => e.searches)).toEqual([1, 3]);
  });

  it("rejects a worse candidate, more unsafe outcomes or lost abstention", () => {
    expect(
      decide(
        rows("browser", () => true),
        rows("browser-search", half),
      ).decision,
    ).toBe("reject");
    const unsafe = rows("browser-search", () => true);
    if (unsafe[0]) unsafe[0].unsafe = true;
    expect(decide(rows("browser", half), unsafe).reasons.join(" ")).toMatch(/unsafe outcomes/);
    const abstain = decide(
      rows("browser", half),
      rows("browser-search", (i) => i.stratum !== "negative"),
    );
    expect(abstain.decision).toBe("reject");
    expect(abstain.reasons.join(" ")).toMatch(/abstention/);
  });

  it("does not adopt an unchanged candidate and gives no verdict on an incomplete campaign", () => {
    expect(decide(rows("browser", half), rows("browser-search", half)).decision).toBe(
      "not adopted",
    );
    const short = rows("browser-search", () => true).slice(1);
    expect(decide(rows("browser", half), short).decision).toBe("no verdict");
  });
});

describe("npm run web-search-eval", () => {
  it("checks the file and prints the plan", () => {
    const lines: string[] = [];
    expect(main(["check"], (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe("web-search 1.0.0: ok");
    expect(main(["plan"], (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toMatch(
      /Ceiling, the whole campaign \(both arms, every block\): USD 95\.00/,
    );
    expect(main(["nonsense"], () => {})).toBe(2);
  });
});

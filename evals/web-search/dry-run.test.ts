// T1: the scripted dry run of the web search comparison, model-free half (protocol of
// 2026-10-18, §8). The search fixture runs on loopback; the script the dry run's upstream answers
// with makes each task's reference searches, through `web_search` in one arm and the browser in
// the other, and every task then meets every oracle; the fixture tells the two paths apart by the
// search token; its result URLs survive the Gateway's filter only through the campaign
// workspace's explicit entry; and a whole campaign runs through the executor's own path (gate and
// pin, first-batch order, stop rules before every task, one file per observation, rows, decision)
// with no model and no Docker. The Docker half is `EVAL_DRY_RUN=scripted` on the executor.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { webSearchResultUrl } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecordedUpstreamRequest } from "../../acceptance/support/fake-model-upstream.js";
import { readObservations } from "../campaign/cli.js";
import { dryRunEnvironment, dryRunPrices } from "../campaign/dry-run.js";
import { authoriseCampaign, firstBatchFirst } from "../campaign/gate.js";
import { guard, taskOrder, writeObservation } from "../campaign/report-dir.js";
import { seeded } from "../campaign/text.js";
import { main } from "../web-search-eval.js";
import { WEB_SEARCH_ARMS, type WebSearchArm } from "./arms.js";
import { WebSearchDryScript } from "./dry-run-script.js";
import { type SearchFixture, fixtureCounts, startSearchFixture } from "./fixture-server.js";
import { type WebSearchObservation, gradeWebSearch, webSearchRows } from "./grade.js";
import { type WebSearchItem, activeItems, loadWebSearchTaskSet } from "./task-set.js";

type Body = RecordedUpstreamRequest["body"];

const set = loadWebSearchTaskSet();
const items = activeItems(set);
const TOKEN = "dry-run-search-token-0f3a";
let fixture: SearchFixture;
let origin = "";

beforeAll(async () => {
  // `localhost` stands in for the container's name for the host: a reserved name the Gateway
  // keeps only because the campaign workspace lists it.
  fixture = await startSearchFixture(set, {
    searchToken: TOKEN,
    publicOrigin: (port) => `http://localhost:${port}`,
  });
  origin = `http://localhost:${fixture.port}`;
});
afterAll(() => fixture.close());

const toolsOf = (arm: WebSearchArm) => [
  ...(arm === "browser-search" ? [{ name: "mcp__deskmates__web_search" }] : []),
  { name: "mcp__browser__browser_navigate" },
  { name: "Bash" },
];

/** The conversation after `done` tool calls were answered, as the CLI sends it. */
function body(arm: WebSearchArm, prompt: string, done: number): Body {
  const messages: unknown[] = [{ role: "user", content: prompt }];
  for (let i = 0; i < done; i += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${i}`, name: "x", input: {} }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: "ok" }],
    });
  }
  return { model: "dry-run-default", tools: toolsOf(arm), messages };
}

/** One run the scripted upstream drives, with every tool call made against the fixture. */
async function dryRun(item: WebSearchItem, arm: WebSearchArm, repeat: number) {
  const script = new WebSearchDryScript();
  script.current = item;
  script.origin = origin;
  fixture.drain();
  const calls: Record<string, number> = {};
  for (let done = 0; ; done += 1) {
    const turn = script.turn(body(arm, item.question, done));
    if (turn.kind !== "tool_use") {
      if (turn.kind !== "text") throw new Error("unexpected turn");
      const summary = /```json\n([\s\S]*?)\n```/.exec(turn.text)?.[1] ?? "{}";
      const counts = fixtureCounts(fixture.drain());
      const obs: WebSearchObservation = {
        taskId: item.id,
        arm,
        repeat,
        runId: `run-${item.id}-${arm}-${repeat}`,
        status: "succeeded",
        finalReply: (JSON.parse(summary) as { reply?: string }).reply ?? null,
        toolCalls: calls,
        searches: counts.searches,
        pagesOpened: counts.pagesOpened,
        egressAsks: 0,
        costUsd: 0,
        leakUsd: 0,
        config: { taskSet: `${set.name}@${set.version}`, dryRun: "scripted" },
      };
      return obs;
    }
    const short = turn.name.replace(/^mcp__\w+?__/, "");
    calls[short] = (calls[short] ?? 0) + 1;
    if (short === "web_search") {
      // What the Gateway's proxy sends: the fixed template and the search token.
      const q = encodeURIComponent(String(turn.input.query));
      const res = await fetch(`${fixture.url}/search?q=${q}&format=json&pageno=1&safesearch=1`, {
        headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" },
      });
      expect(res.status).toBe(200);
    } else {
      const res = await fetch(String(turn.input.url));
      expect(res.status).toBe(200);
    }
  }
}

describe("the scripted dry run against the search fixture", () => {
  it("searches by the arm's path and meets every oracle in both arms", async () => {
    for (const { arm } of WEB_SEARCH_ARMS)
      for (const item of items) {
        const obs = await dryRun(item, arm, 1);
        const grade = gradeWebSearch(set, item, obs);
        expect(grade, `${arm} ${item.id}`).toMatchObject({ success: true, unsafe: false });
        const hops = item.hops.length;
        expect(obs.searches).toEqual(
          arm === "browser-search" ? { tool: hops, browser: 0 } : { tool: 0, browser: hops },
        );
      }
  });

  it("answers the Gateway's template with SearXNG JSON whose URLs need the workspace's own entry", async () => {
    const query = items[0]?.hops[0]?.query ?? "";
    const res = await fetch(`${fixture.url}/search?q=${encodeURIComponent(query)}&format=json`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const answer = (await res.json()) as {
      results: { url: string; title: string; content: string }[];
    };
    expect(answer.results.length).toBeGreaterThan(0);
    for (const r of answer.results) {
      expect(r.url.startsWith(`${origin}/p/`)).toBe(true);
      expect(webSearchResultUrl(r.url, ["localhost"])).toBe(r.url);
      expect(webSearchResultUrl(r.url, ["*"])).toBeUndefined();
    }
    // A result shows the snippet, never the rest of the page.
    const page = set.items.find((i) => i.id === "WS-PG01");
    const gold = set.documents.find((d) => d.id === page?.gold[0]);
    const hit = answer.results.find((r) => r.title === gold?.title);
    if (hit) expect(hit.content).toBe(gold?.snippet);
    expect(fixtureCounts(fixture.drain()).searches).toEqual({ tool: 1, browser: 0 });
  });

  // This executes all 400 task/arm/repeat rows and their oracles, not a latency assertion.
  it("runs a whole campaign through the executor's path and decides with no model", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "web-search-dry-"));
    const env: Record<string, string> = {
      ...dryRunEnvironment({ modelBaseUrl: "http://127.0.0.1:9" }),
      EVAL_REPORT_DIR: dir,
    };
    for (let repeat = 1; repeat <= set.defaults.repeats; repeat += 1)
      for (const { arm } of WEB_SEARCH_ARMS) {
        const run = authoriseCampaign(
          { ...env, EVAL_ARM: arm, EVAL_REPEAT: String(repeat) },
          {
            campaign: "web-search-v1",
            taskSet: `${set.name}@${set.version}`,
            mode: "scripted",
            models: [env.DEFAULT_MODEL ?? "", env.CHEAP_MODEL ?? ""],
            prices: dryRunPrices(),
          },
        );
        expect(run.ceilingUsd).toBeNull();
        const order = firstBatchFirst(
          taskOrder(items, seeded(2000 + repeat)),
          (i) => set.ceiling.smoke_tasks.includes(i.id),
          repeat,
        );
        if (repeat === 1)
          expect(
            order
              .slice(0, set.ceiling.smoke_tasks.length)
              .map((i) => i.id)
              .sort(),
          ).toEqual([...set.ceiling.smoke_tasks].sort());
        for (const item of order) {
          guard(
            run,
            (id) => set.ceiling.per_run_usd[items.find((i) => i.id === id)?.bucket ?? "long"],
            item.id,
          );
          writeObservation(run, await dryRun(item, arm, repeat), [TOKEN]);
        }
      }
    const rows = webSearchRows(set, readObservations([dir]));
    expect(rows).toHaveLength(items.length * set.defaults.repeats * 2);
    expect(rows.every((r) => r.success)).toBe(true);
    const out = (arm: string) => {
      const file = path.join(dir, `${arm}.jsonl`);
      expect(main(["rows", dir, "--arm", arm, "--out", file], () => {})).toBe(0);
      return file;
    };
    const lines: string[] = [];
    // Identical pass rates: not adopted, and the dry run says it is plumbing, not evidence.
    expect(main(["decide", out("browser"), out("browser-search")], (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toMatch(/^dry run: 400 of 400 rows came from the scripted upstream/);
    expect(lines).toContain("decision: not adopted");
    expect(lines.join("\n")).toMatch(/candidate: pass 100\.0%, searches\/run/);
  }, 30_000);
});

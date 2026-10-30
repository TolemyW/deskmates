import { afterEach, beforeEach, expect, it } from "vitest";
import type { GatewayEvent } from "../events/bus.js";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";
import { publishLearningNotice } from "./learning-notice.js";

let f: MemoryFixture;
beforeEach(async () => {
  f = await memoryFixture();
});
afterEach(async () => {
  await f.close();
});

it("shows a gated correction once without waking bots or changing the current fact", () => {
  const id = f.run();
  f.learn(id, [item("Project order target is 200.")]);
  const run = f.ctx.runs.mustGet(f.run());
  const outcomes = f.learn(run.id, [item("Always use 220 for the project order target.")]);
  expect(outcomes[0]?.outcome).toBe("gated");
  const before = f.ctx.runs.list({ threadId: f.a.thread.id }).length;
  const published: GatewayEvent[] = [];
  publishLearningNotice(f.ctx, run, outcomes, published);
  publishLearningNotice(f.ctx, run, outcomes, published);
  const messages = f.ctx.messages.list(f.a.thread.id);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ authorKind: "system", runId: run.id });
  expect(messages[0]?.body).toContain("need human confirmation");
  expect(messages[0]?.body).toContain("#/knowledge/observations");
  expect(published).toHaveLength(1);
  expect(f.ctx.runs.list({ threadId: f.a.thread.id })).toHaveLength(before);
  expect(
    f.ctx.memory
      .indexFor(f.a.workspace.id, f.a.bot.id)
      .sections.workspace.map((line) => line.body)
      .join("\n"),
  ).toContain("200");
});

it("distinguishes untrusted storage from automatic context and keeps trusted successes quiet", () => {
  const run = f.ctx.runs.mustGet(f.run());
  const published: GatewayEvent[] = [];
  publishLearningNotice(
    f.ctx,
    run,
    f.learn(run.id, [item("Project order target is 200.")]),
    published,
  );
  expect(published).toEqual([]);
  const next = f.ctx.runs.mustGet(f.run());
  publishLearningNotice(
    f.ctx,
    next,
    f.learn(next.id, [
      item("Other project target is 220.", { trust: "untrusted", sourceKind: "tool" }),
    ]),
    published,
  );
  expect(f.ctx.messages.list(f.a.thread.id)[0]?.body).toContain("excluded from automatic context");
  expect(published).toHaveLength(1);
  const maintenance = { ...next, config: { runType: "memory_consolidation" } };
  publishLearningNotice(
    f.ctx,
    maintenance,
    [{ ordinal: 0, outcome: "skipped", reason: "failed_run" }],
    published,
  );
  expect(published).toHaveLength(1);
});

it("stays quiet about the store's own transient-observation filter but reports refused rules and history", () => {
  const run = f.ctx.runs.mustGet(f.run());
  const published: GatewayEvent[] = [];
  publishLearningNotice(
    f.ctx,
    run,
    [
      { ordinal: 0, outcome: "skipped", reason: "session_state" },
      { ordinal: 1, outcome: "skipped", reason: "empty body" },
    ],
    published,
  );
  expect(published).toEqual([]);
  expect(f.ctx.messages.list(f.a.thread.id)).toHaveLength(0);
  const next = f.ctx.runs.mustGet(f.run());
  publishLearningNotice(
    f.ctx,
    next,
    [
      { ordinal: 0, outcome: "refused", code: "memory_rule_refused", message: "no rules" },
      { ordinal: 1, outcome: "skipped", reason: "negative_capability_claim" },
    ],
    published,
  );
  expect(published).toHaveLength(1);
  expect(f.ctx.messages.list(f.a.thread.id)[0]?.body).toContain(
    "1 item(s) were not applied as current memory.",
  );
});

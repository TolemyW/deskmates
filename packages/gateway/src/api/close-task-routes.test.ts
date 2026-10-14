// ADR-0011 task closure remains usable after an ADR-0016 operator stop. All nonterminal runs,
// including parked continuations, still hold their task notes open.
import { TERMINAL_RUN_STATUSES } from "@deskmates/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TEST_OPERATOR_TOKEN } from "../test-support/harness.js";
import { type MemoryFixture, item, memoryFixture } from "../test-support/memory-fixture.js";

let fixture: MemoryFixture;
beforeEach(async () => {
  fixture = await memoryFixture();
});
afterEach(async () => {
  await fixture.close();
});

async function close() {
  return fixture.app.inject({
    method: "POST",
    url: `/api/threads/${fixture.a.thread.id}/close-task`,
    headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    payload: {},
  });
}

it.each([...TERMINAL_RUN_STATUSES])(
  "closes notes after a %s run without creating duplicate episodes",
  async (status) => {
    const runId = fixture.run();
    fixture.learn(runId, [item("Refund sheet: rows 1-40 checked.", { proposedScope: "task" })]);
    fixture.ctx.db.prepare("UPDATE runs SET status=? WHERE id=?").run(status, runId);
    const response = await close();
    expect(response.statusCode).toBe(200);
    expect(response.json().episode).toMatchObject({
      kind: "episode",
      threadId: fixture.a.thread.id,
    });
    expect(
      fixture.ctx.memory.indexFor(fixture.a.workspace.id, fixture.a.bot.id, fixture.a.thread.id)
        .sections.task,
    ).toEqual([]);
    const repeated = await close();
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().episode).toBeNull();
  },
);

it.each([
  "queued",
  "running",
  "waiting_approval_live",
  "waiting_approval",
  "waiting_browser",
  "waiting_continuation",
])("keeps notes open while a run is %s", async (status) => {
  const runId = fixture.run();
  fixture.learn(runId, [item("Refund sheet: rows 1-40 checked.", { proposedScope: "task" })]);
  fixture.ctx.db.prepare("UPDATE runs SET status=? WHERE id=?").run(status, runId);
  expect((await close()).statusCode).toBe(409);
  expect(
    fixture.ctx.memory.indexFor(fixture.a.workspace.id, fixture.a.bot.id, fixture.a.thread.id)
      .sections.task,
  ).toHaveLength(1);
});

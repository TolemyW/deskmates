// T1 fixture for the learned-memory tests (ADR-0011): a Gateway context on an in-memory database
// with its scheduler stopped, two workspaces with one bot and one thread each, and helpers to make
// a finished run and to write a run's learned items the way the run lifecycle does.

import type { BotDefinition, LearnedItem, RunId, Thread, Workspace } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { buildGateway } from "../index.js";
import { type LearnedOutcome, writeLearnedItems } from "../memory/learned-writes.js";
import { FakeProvider } from "./fake-provider.js";
import { testConfig } from "./harness.js";

export interface MemoryFixture {
  app: ReturnType<typeof buildGateway>;
  ctx: GatewayContext;
  a: { workspace: Workspace; bot: BotDefinition; thread: Thread };
  b: { workspace: Workspace; bot: BotDefinition; thread: Thread };
  run(side?: "a" | "b", withThread?: boolean): RunId;
  learn(runId: RunId, items: readonly LearnedItem[]): LearnedOutcome[];
  close(): Promise<void>;
}

export function item(body: string, over: Partial<LearnedItem> = {}): LearnedItem {
  return {
    body,
    proposedScope: "workspace",
    authority: "fact",
    turn: 1,
    trust: "trusted",
    sourceKind: "bot_self",
    ...over,
  };
}

export async function memoryFixture(): Promise<MemoryFixture> {
  const app = buildGateway(testConfig(), new FakeProvider(), {
    surface: "combined-test",
    startCron: false,
  });
  await app.ready();
  app.deskmates.scheduler.stop();
  const ctx = app.deskmates.ctx;
  const side = (name: string) => {
    const workspace = ctx.workspaces.create({
      name: `mem-${name}`,
      sandboxProvider: "docker",
      egressAllowlist: [`${name}.example.test`],
    });
    const bot = ctx.bots.create({ name: `bot-${name}`, role: "test", workspaceId: workspace.id });
    const thread = ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id] });
    return { workspace, bot, thread };
  };
  const a = side("a");
  const b = side("b");
  const startedAt = Date.now() - 3_600_000;
  let runs = 0;
  const run = (which: "a" | "b" = "a", withThread = true): RunId => {
    const s = which === "a" ? a : b;
    const created = ctx.runs.create({
      botId: s.bot.id,
      ...(withThread ? { threadId: s.thread.id } : {}),
      lane: withThread ? "interactive" : "background",
      triggerKind: withThread ? "thread_message" : "cron",
      triggerRef: `fixture-${Math.random()}`,
      config: ctx.runConfig(),
    });
    // One second apart, in creation order: the recency order (ADR-0011 A9) of items without a
    // sidecar stamp follows the run, and two runs in one millisecond would tie.
    runs += 1;
    const createdAt = new Date(startedAt + runs * 1000).toISOString();
    ctx.db
      .prepare("UPDATE runs SET status = 'succeeded', created_at = ? WHERE id = ?")
      .run(createdAt, created.id);
    return created.id;
  };
  const learn = (runId: RunId, items: readonly LearnedItem[]) => {
    const r = ctx.runs.mustGet(runId);
    return writeLearnedItems(
      ctx.memory.stores,
      {
        runId: r.id,
        botId: r.botId,
        workspaceId: ctx.bots.mustGet(r.botId).workspaceId,
        ...(r.threadId ? { threadId: r.threadId } : {}),
        rules: ctx.memory.rulesFor(r.botId),
        createdAt: r.createdAt,
      },
      items,
    );
  };
  return { app, ctx, a, b, run, learn, close: () => app.close() };
}

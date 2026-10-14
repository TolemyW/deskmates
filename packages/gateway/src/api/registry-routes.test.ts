// T1: `PATCH /api/bots/:id`. A bot's model is configuration an operator changes as a deployment
// swaps models (AGENTS.md: "The model is configuration"), so the patch route takes `model` and
// `cheapModel` alongside `cron`. Each field is independent: absent leaves it alone, `null` clears
// the override so the bot inherits DEFAULT_MODEL / CHEAP_MODEL again.

import type { BotDefinition } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;

// ADR-0023 decision 1: a bot override must be priced, so the models these cases set are.
const priced = (model: string) => ({
  model,
  inputPerM: 1,
  outputPerM: 1,
  cacheReadPerM: 1,
  cacheCreatePerM: 1,
  effectiveFrom: "1970-01-01T00:00:00.000Z",
});

beforeEach(async () => {
  h = await startHarness({ modelPrices: [priced("model-swapped"), priced("model-thrifty")] });
});

afterEach(async () => {
  await h.close();
});

const CRON = [{ schedule: "0 9 * * *", prompt: "sweep" }];

describe("PATCH /api/bots/:id", () => {
  it("accepts a body carrying only a model", async () => {
    const { bot } = await h.seed();
    const res = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      model: "model-swapped",
    });
    expect(res.status).toBe(200);
    expect(res.json.bot.model).toBe("model-swapped");
  });

  it("stores the model so a later GET reads it back", async () => {
    const { bot } = await h.seed();
    await h.api("PATCH", `/api/bots/${bot.id}`, { model: "model-swapped" });
    const got = await h.api<{ bot: BotDefinition }>("GET", `/api/bots/${bot.id}`);
    expect(got.json.bot.model).toBe("model-swapped");
  });

  it("sets the cheap model independently of the main one", async () => {
    const { bot } = await h.seed();
    const res = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      cheapModel: "model-thrifty",
    });
    expect(res.json.bot.cheapModel).toBe("model-thrifty");
    expect(res.json.bot.model).toBeUndefined();
  });

  it("clears an override with null so the bot inherits the Gateway default again", async () => {
    const { bot } = await h.seed();
    await h.api("PATCH", `/api/bots/${bot.id}`, { model: "model-swapped" });
    const cleared = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      model: null,
    });
    expect(cleared.json.bot.model).toBeUndefined();
  });

  it("still takes a cron-only body and leaves the models untouched", async () => {
    const { bot } = await h.seed();
    await h.api("PATCH", `/api/bots/${bot.id}`, { model: "model-swapped" });
    const res = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, { cron: CRON });
    expect(res.json.bot.cron).toEqual(CRON);
    expect(res.json.bot.model).toBe("model-swapped");
  });

  it("rejects an empty or non-string model", async () => {
    const { bot } = await h.seed();
    for (const bad of [{ model: "" }, { cheapModel: "" }, { model: 7 }]) {
      const res = await h.api<{ code: string }>("PATCH", `/api/bots/${bot.id}`, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("validation");
    }
  });

  it("sets and clears the reasoning knob (effort, thinking) like a model override", async () => {
    const { bot } = await h.seed();
    const set = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      effort: "low",
      thinking: { type: "enabled", budgetTokens: 4096 },
    });
    expect(set.status).toBe(200);
    expect(set.json.bot.effort).toBe("low");
    expect(set.json.bot.thinking).toEqual({ type: "enabled", budgetTokens: 4096 });
    const got = await h.api<{ bot: BotDefinition }>("GET", `/api/bots/${bot.id}`);
    expect(got.json.bot.effort).toBe("low");
    const cleared = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      effort: null,
      thinking: null,
    });
    expect(cleared.json.bot.effort).toBeUndefined();
    expect(cleared.json.bot.thinking).toBeUndefined();
    for (const bad of [
      { effort: "ultra" },
      { effort: 2 },
      { thinking: "adaptive" },
      { thinking: { type: "on" } },
    ]) {
      const res = await h.api<{ code: string }>("PATCH", `/api/bots/${bot.id}`, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("validation");
    }
  });

  it("rejects a body that asks for no change at all", async () => {
    const { bot } = await h.seed();
    const res = await h.api<{ code: string }>("PATCH", `/api/bots/${bot.id}`, {});
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("validation");
  });

  it("applies the new model to the next run started for the bot", async () => {
    const { bot, thread } = await h.seed();
    await h.api("PATCH", `/api/bots/${bot.id}`, { model: "model-swapped" });
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
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
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      {
        body: "x",
      },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run",
    );
    expect(h.provider.execCalls[0]?.request.model).toBe("model-swapped");
  });
});

describe("bot avatars", () => {
  it("stores an avatar at create and reads it back", async () => {
    const { workspace } = await h.seed();
    const res = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "scout",
      workspaceId: workspace.id,
      avatar: { emoji: "🛰️", color: "teal" },
    });
    expect(res.status).toBe(201);
    expect(res.json.bot.avatar).toEqual({ emoji: "🛰️", color: "teal" });
    const got = await h.api<{ bot: BotDefinition }>("GET", `/api/bots/${res.json.bot.id}`);
    expect(got.json.bot.avatar).toEqual({ emoji: "🛰️", color: "teal" });
  });

  it("patches and clears the avatar independently of the other fields", async () => {
    const { bot } = await h.seed();
    const set = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      avatar: { color: "pink" },
    });
    expect(set.status).toBe(200);
    expect(set.json.bot.avatar).toEqual({ color: "pink" });
    expect(set.json.bot.model).toBe(bot.model);
    const cleared = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      avatar: null,
    });
    expect(cleared.json.bot.avatar).toBeUndefined();
  });

  it("rejects an avatar that is not one character on a named colour", async () => {
    const { bot } = await h.seed();
    for (const avatar of [{ emoji: "ab" }, { color: "mauve" }, { emoji: "" }, { url: "x" }, "🛰️"]) {
      const res = await h.api("PATCH", `/api/bots/${bot.id}`, { avatar });
      expect(res.status, JSON.stringify(avatar)).toBe(400);
    }
  });
});

// Issue #89: a new bot's welcome run holds its lane, so `PATCH /api/bots/:id/soul` right after
// create is 409 lane_busy. Create takes the SOUL instead and writes it, through the canonical SOUL
// write, in the transaction that commits the bot and queues the welcome run (ADR-0024 amendment 1
// decision 9), so the welcome already speaks with the intended role.
describe("POST /api/bots with a SOUL", () => {
  it("stores the SOUL before the welcome run starts and delivers it to that run", async () => {
    const { workspace } = await h.seed();
    h.provider.onRun(async () => {});
    const soul = "You are Ledger, a meticulous bookkeeper.";
    const res = await h.api<{ bot: BotDefinition; welcomeRun: RunRecord }>("POST", "/api/bots", {
      name: "ledger",
      role: "bookkeeper",
      workspaceId: workspace.id,
      soul,
    });
    expect(res.status).toBe(201);
    const got = await h.api<{ soul: { body: string } }>("GET", `/api/bots/${res.json.bot.id}/soul`);
    expect(got.json.soul.body).toBe(soul);
    const runId = res.json.welcomeRun.id;
    await waitFor(
      () => h.provider.execCalls.some((c) => c.request.runId === runId),
      3000,
      "welcome run start",
    );
    const call = h.provider.execCalls.find((c) => c.request.runId === runId);
    expect(call?.request.canonicalFiles?.soul?.body).toBe(soul);
  });

  it("leaves the SOUL empty when the body omits it or sends null", async () => {
    const { workspace } = await h.seed();
    for (const [name, extra] of [
      ["absent", {}],
      ["nulled", { soul: null }],
    ] as const) {
      const res = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
        name,
        workspaceId: workspace.id,
        ...extra,
      });
      expect(res.status, name).toBe(201);
      expect(h.app.deskmates.ctx.bots.canonicalSoul(res.json.bot.id)?.body, name).toBe("");
    }
  });

  it("rejects a SOUL that is not a string or exceeds 64 KiB and creates nothing", async () => {
    const { workspace } = await h.seed();
    for (const soul of [42, { body: "x" }, "x".repeat(65537)]) {
      const res = await h.api("POST", "/api/bots", {
        name: "rejected",
        workspaceId: workspace.id,
        soul,
      });
      expect(res.status, typeof soul).toBe(400);
    }
    const bots = h.app.deskmates.ctx.bots.list(workspace.id);
    expect(bots.some((bot) => bot.name === "rejected")).toBe(false);
  });
});

// T1: bot model overrides are validated against the price table at write time (ADR-0023
// decision 1; test plan SEC-03). A model with no price row cannot be set on a bot, on `POST` and
// `PATCH` alike, and the empty string is a 400 on both routes instead of being dropped silently.

import type { BotDefinition, ModelPrice } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

const price = (model: string): ModelPrice => ({
  model,
  inputPerM: 1,
  outputPerM: 2,
  cacheReadPerM: 0.1,
  cacheCreatePerM: 1.25,
  effectiveFrom: "1970-01-01T00:00:00.000Z",
});

let h: Harness;

beforeEach(async () => {
  h = await startHarness({ modelPrices: [price("model-priced"), price("model-priced-cheap")] });
});

afterEach(async () => {
  await h.close();
});

async function workspaceId(): Promise<string> {
  const { workspace } = await h.seed();
  return workspace.id;
}

describe("bot model overrides must be priced (SEC-03)", () => {
  it("POST accepts priced overrides", async () => {
    const res = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "priced",
      workspaceId: await workspaceId(),
      model: "model-priced",
      cheapModel: "model-priced-cheap",
    });
    expect(res.status).toBe(201);
    expect(res.json.bot.model).toBe("model-priced");
    expect(res.json.bot.cheapModel).toBe("model-priced-cheap");
  });

  it("POST refuses an unpriced model or cheap model and creates no bot", async () => {
    const ws = await workspaceId();
    const before = h.app.deskmates.ctx.bots.list().length;
    for (const [i, bad] of [
      { model: "model-unlisted" },
      { cheapModel: "model-unlisted" },
    ].entries()) {
      const res = await h.api<{ code: string; message: string; details: unknown }>(
        "POST",
        "/api/bots",
        { name: `unpriced${i}`, workspaceId: ws, ...bad },
      );
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("validation");
      expect(res.json.message).toContain("model-unlisted");
      expect(res.json.message).toContain("price");
    }
    expect(h.app.deskmates.ctx.bots.list()).toHaveLength(before);
  });

  it("POST refuses the empty string instead of dropping it silently", async () => {
    const ws = await workspaceId();
    for (const [i, bad] of [{ model: "" }, { cheapModel: "" }].entries()) {
      const res = await h.api<{ code: string }>("POST", "/api/bots", {
        name: `empty${i}`,
        workspaceId: ws,
        ...bad,
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("validation");
    }
  });

  it("POST without overrides still inherits the Gateway defaults", async () => {
    const res = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "plain",
      workspaceId: await workspaceId(),
      model: null,
    });
    expect(res.status).toBe(201);
    expect(res.json.bot.model).toBeUndefined();
  });

  it("PATCH accepts a priced override and refuses an unpriced one, leaving the bot as it was", async () => {
    const { bot } = await h.seed();
    const ok = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      model: "model-priced",
    });
    expect(ok.status).toBe(200);
    for (const bad of [
      { model: "model-unlisted" },
      { cheapModel: "model-unlisted" },
      { model: "" },
      { cheapModel: "" },
    ]) {
      const res = await h.api<{ code: string }>("PATCH", `/api/bots/${bot.id}`, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("validation");
    }
    expect(h.app.deskmates.ctx.bots.mustGet(bot.id).model).toBe("model-priced");
    expect(h.app.deskmates.ctx.bots.mustGet(bot.id).cheapModel).toBeUndefined();
  });

  it("PATCH still clears an override with null without a price check", async () => {
    const { bot } = await h.seed();
    await h.api("PATCH", `/api/bots/${bot.id}`, { model: "model-priced" });
    const res = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      model: null,
    });
    expect(res.status).toBe(200);
    expect(res.json.bot.model).toBeUndefined();
  });

  it("a price added at runtime makes the model settable", async () => {
    const { bot } = await h.seed();
    const before = await h.api("PATCH", `/api/bots/${bot.id}`, { model: "model-later" });
    expect(before.status).toBe(400);
    h.app.deskmates.ctx.prices.upsert(price("model-later"));
    const after = await h.api("PATCH", `/api/bots/${bot.id}`, { model: "model-later" });
    expect(after.status).toBe(200);
  });
});

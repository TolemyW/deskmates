// @vitest-environment jsdom
// T0 web, #113 §3.2: the bounded bot name map asks for the ids a screen renders, 100 per request,
// never the whole roster, and does not ask again for ids it already has.

import type { BotDefinition, BotId } from "@deskmates/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { MockGateway } from "../../demo/mock-gateway.js";
import { bot, fakeFetch } from "../../test-support/fixtures.js";
import { useBotLookup, useBotsByIds } from "./use-bots-by-ids.js";

describe("useBotsByIds (#113 §3.2)", () => {
  it("asks only for the named ids, and only once per id", async () => {
    const second = { ...bot, id: "bot_2" as BotId, name: "scout" } as BotDefinition;
    const { fetch, calls } = fakeFetch({
      "GET /api/bots?ids=bot_1": { bots: [bot] },
      "GET /api/bots?ids=bot_2": { bots: [second] },
    });
    const api = createApiClient({ fetch });
    const { result, rerender } = renderHook(({ ids }) => useBotsByIds(api, ids), {
      initialProps: { ids: ["bot_1", "bot_1"] as readonly string[] },
    });
    await waitFor(() => expect(result.current.get("bot_1")?.name).toBe("ops"));
    rerender({ ids: ["bot_2", "bot_1"] });
    await waitFor(() => expect(result.current.get("bot_2")?.name).toBe("scout"));
    expect(result.current.get("bot_1")?.name).toBe("ops");
    expect(calls.map((c) => c.path)).toEqual(["/api/bots?ids=bot_1", "/api/bots?ids=bot_2"]);
  });

  it("splits more than 100 ids into requests of 100", async () => {
    const paths: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      paths.push(String(input));
      return new Response(JSON.stringify({ bots: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const ids = Array.from({ length: 150 }, (_, i) => `bot_${i}`);
    await createApiClient({ fetch }).listBotsByIds(ids);
    expect(paths).toHaveLength(2);
    const counts = paths.map((p) => decodeURIComponent(p.split("ids=")[1] ?? "").split(",").length);
    expect(counts).toEqual([100, 50]);
  });

  it("the demo Gateway answers a lookup with the named bots only", async () => {
    const gw = new MockGateway(() => {});
    const all = (await gw.handle("GET", "/api/bots", undefined)).json as { bots: BotDefinition[] };
    const first = all.bots[0];
    if (!first) throw new Error("the demo has no bots");
    const named = (await gw.handle("GET", `/api/bots?ids=${first.id},bot_none`, undefined))
      .json as { bots: BotDefinition[] };
    expect(named.bots.map((b) => b.id)).toEqual([first.id]);
  });
});

it("does not show an old page lookup failure on the successfully loaded current page", async () => {
  let rejectOld: (error: Error) => void = () => {};
  const second = { ...bot, id: "bot_2" as BotId };
  const api = {
    listBotsByIds: vi.fn(async (ids: readonly string[]) => {
      if (ids.includes("bot_1"))
        return new Promise<BotDefinition[]>((_resolve, reject) => {
          rejectOld = reject;
        });
      return [second];
    }),
  };
  const { result, rerender } = renderHook(({ ids }) => useBotLookup(api, ids), {
    initialProps: { ids: ["bot_1"] },
  });
  rerender({ ids: ["bot_2"] });
  await waitFor(() => expect(result.current.bots.has("bot_2")).toBe(true));
  await act(async () => rejectOld(new Error("Previous page failed")));
  expect(result.current.error).toBe(false);
  expect(result.current.bots.has("bot_2")).toBe(true);
});

// Operator routes for the price table. The Gateway prices tokens itself from these rows and
// ignores whatever cost the SDK reports (ADR-0002 item 5); `MODEL_PRICES` seeds them at startup
// and this is how they are read and changed afterwards.

import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { parseModelPrices } from "../ledger/model-price.js";
import { asRecord } from "./validate.js";

export function registerPriceRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get("/api/prices", async () => ({ prices: ctx.prices.list() }));

  /**
   * Upsert on `(model, effectiveFrom)`. Not a replace: a table that dropped the rows it was not
   * sent would re-price every historical run of every model the caller forgot to include.
   */
  app.put("/api/prices", async (request) => {
    const body = asRecord(request.body);
    const prices = parseModelPrices(body.prices, "prices");
    ctx.db.transaction(() => {
      for (const price of prices) ctx.prices.upsert(price);
    })();
    return { prices };
  });
}

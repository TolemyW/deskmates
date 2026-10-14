// The price table. Operators load rows; nothing in code names a model.

import type { ModelPrice } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

interface PriceRow {
  model: string;
  input_per_m: number;
  output_per_m: number;
  cache_read_per_m: number;
  cache_create_per_m: number;
  effective_from: string;
}

export class PriceStore {
  constructor(private readonly db: GatewayDb) {}

  upsert(price: ModelPrice): void {
    this.db
      .prepare(
        `INSERT INTO prices (model, input_per_m, output_per_m, cache_read_per_m, cache_create_per_m, effective_from)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (model, effective_from) DO UPDATE SET
           input_per_m = excluded.input_per_m, output_per_m = excluded.output_per_m,
           cache_read_per_m = excluded.cache_read_per_m, cache_create_per_m = excluded.cache_create_per_m`,
      )
      .run(
        price.model,
        price.inputPerM,
        price.outputPerM,
        price.cacheReadPerM,
        price.cacheCreatePerM,
        price.effectiveFrom,
      );
  }

  listForModel(model: string): ModelPrice[] {
    const rows = this.db
      .prepare("SELECT * FROM prices WHERE model = ? ORDER BY effective_from")
      .all(model) as PriceRow[];
    return rows.map(toPrice);
  }

  /** The whole table, for the operator route. Ordered by model, then by when it took effect. */
  list(): ModelPrice[] {
    const rows = this.db
      .prepare("SELECT * FROM prices ORDER BY model, effective_from")
      .all() as PriceRow[];
    return rows.map(toPrice);
  }
}

function toPrice(r: PriceRow): ModelPrice {
  return {
    model: r.model,
    inputPerM: r.input_per_m,
    outputPerM: r.output_per_m,
    cacheReadPerM: r.cache_read_per_m,
    cacheCreatePerM: r.cache_create_per_m,
    effectiveFrom: r.effective_from,
  };
}

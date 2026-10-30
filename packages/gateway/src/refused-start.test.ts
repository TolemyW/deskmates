// T1 (#61 L16): a Gateway that refuses to start after opening its database closes the handle,
// so an embedder or the T1 harness that catches the refusal does not leak it.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayDb } from "./db/open.js";
import { buildGateway } from "./index.js";
import { FakeProvider } from "./test-support/fake-provider.js";
import { testConfig } from "./test-support/harness.js";

const opened = vi.hoisted(() => [] as GatewayDb[]);

vi.mock("./db/open.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./db/open.js")>();
  return {
    ...original,
    openDatabase: (path: string) => {
      const db = original.openDatabase(path);
      opened.push(db);
      return db;
    },
  };
});

afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
});

describe("a refused start", () => {
  it("closes the database it opened", () => {
    expect(() =>
      buildGateway(
        testConfig({
          modelPrices: [],
          fallbackModel: "test-model-unpriced",
        }),
        new FakeProvider(),
        { surface: "combined-test", startCron: false },
      ),
    ).toThrow(/FALLBACK_MODEL/);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.open).toBe(false);
  });
});

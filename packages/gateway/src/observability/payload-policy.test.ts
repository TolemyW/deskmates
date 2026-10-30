// T1, ADR-0046 decision 2: under `OBSERVABILITY_PAYLOADS=derived` no payload body and no
// summary text leaves the ledger, while the derived columns and the body's size still do; under
// `full` a screenshot arrives without its image bytes and a body past 64 KB as valid JSON that
// keeps its start and records its original size; a run in a private chat is `derived` whatever
// the setting, and the private chat's title stays behind.

import {
  OBSERVABILITY_PAYLOAD_MAX_BYTES,
  type ObservabilityPayloadPolicy,
  type RunId,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../test-support/harness.js";
import {
  type Ctx,
  LATER,
  column,
  emptyRows,
  ledgerHarness,
  seedRun,
} from "../test-support/observability-ledger.js";
import { emptyCursor } from "./cursor.js";
import { LedgerReader } from "./ledger-reader.js";
import { shapePayload } from "./payload-policy.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function readAll(ctx: Ctx, payloads: ObservabilityPayloadPolicy) {
  const rows = emptyRows();
  const reader = new LedgerReader(ctx.db);
  let cursor = emptyCursor();
  for (;;) {
    const r = reader.read(cursor, { now: LATER(), payloads });
    for (const [table, list] of Object.entries(r.rows))
      rows[table as keyof typeof rows].push(...(list ?? []));
    cursor = r.cursor;
    if (!r.more) return rows;
  }
}

function bodiesOf(rows: ReturnType<typeof emptyRows>, runId?: RunId) {
  const runs = column(rows, "run_events", "run_id");
  return column(rows, "run_events", "payload_json").filter(
    (_, i) => runId === undefined || runs[i] === runId,
  );
}

describe("observability payload policy (ADR-0046 decision 2)", () => {
  it("derived sends no payload body and no summary text, but keeps derived columns and sizes", async () => {
    const l = await ledgerHarness();
    h = l.h;
    seedRun(l.ctx, l);
    const rows = readAll(l.ctx, "derived");
    expect(rows.run_events.length).toBeGreaterThan(0);
    expect(bodiesOf(rows).every((b) => b === null)).toBe(true);
    expect(column(rows, "run_events", "payload_bytes").every((b) => (b as number) > 0)).toBe(true);
    expect(column(rows, "run_events", "tool_name")).toContain("browser_navigate");
    expect(column(rows, "run_events", "phase")).toContain("browser_rpc");
    expect(column(rows, "run_summaries", "text")).toEqual([null]);
    // Nothing the ledger's payload held is anywhere in what would leave.
    expect(JSON.stringify(rows)).not.toContain("page text");
    expect(JSON.stringify(rows)).not.toContain("Opened the page.");
  });

  it("full keeps bodies, strips a screenshot's image bytes and keeps the summary", async () => {
    const l = await ledgerHarness();
    h = l.h;
    seedRun(l.ctx, l);
    const rows = readAll(l.ctx, "full");
    const kinds = column(rows, "run_events", "kind");
    const bodies = bodiesOf(rows);
    const screenshot = JSON.parse(bodies[kinds.indexOf("screenshot")] as string);
    expect(screenshot).toEqual({ mimeType: "image/png", bytes: 3000, captureIndex: 1 });
    const sizes = column(rows, "run_events", "payload_bytes");
    expect(sizes[kinds.indexOf("screenshot")]).toBeGreaterThan(4000);
    expect(bodies[kinds.indexOf("tool_result")]).toContain("page text");
    expect(column(rows, "run_summaries", "text")).toEqual(["Opened the page."]);
    // The derived duration of the tool call: result time minus call time.
    expect(column(rows, "run_events", "duration_ms")[kinds.indexOf("tool_result")]).toBeTypeOf(
      "number",
    );
  });

  it("full truncates a body past the cap to valid JSON with its original size", () => {
    const big = JSON.stringify({ text: "é".repeat(OBSERVABILITY_PAYLOAD_MAX_BYTES) });
    const bytes = Buffer.byteLength(big, "utf8");
    const shaped = shapePayload("full", big, bytes, false);
    expect(shaped.truncated).toBe(1);
    expect(shaped.bytes).toBe(bytes);
    expect(Buffer.byteLength(shaped.json as string, "utf8")).toBeLessThanOrEqual(
      OBSERVABILITY_PAYLOAD_MAX_BYTES,
    );
    const parsed = JSON.parse(shaped.json as string);
    expect(parsed).toMatchObject({ _truncated: true, _bytes: bytes });
    expect(big.startsWith(parsed._head)).toBe(true);
    expect(shapePayload("full", "{}", 2, false)).toEqual({ json: "{}", bytes: 2, truncated: 0 });
  });

  it("a run in a private chat sends no body, no summary and no chat title, even under full", async () => {
    const l = await ledgerHarness();
    h = l.h;
    const at = new Date().toISOString();
    l.ctx.db
      .prepare(
        "INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('usr_obs', 'Obs', ?, ?)",
      )
      .run(at, at);
    const userId = "usr_obs";
    l.ctx.db
      .prepare("UPDATE threads SET private_to_user_id = ?, title = 'my private chat' WHERE id = ?")
      .run(userId, l.threadId);
    const run = seedRun(l.ctx, l);
    const rows = readAll(l.ctx, "full");
    expect(bodiesOf(rows, run).every((b) => b === null)).toBe(true);
    expect(column(rows, "run_summaries", "text")).toEqual([null]);
    expect(column(rows, "thread_states", "title")).toEqual([null]);
    expect(column(rows, "thread_states", "private")).toEqual([1]);
    expect(JSON.stringify(rows)).not.toContain("my private chat");
    expect(JSON.stringify(rows)).not.toContain("page text");
  });
});

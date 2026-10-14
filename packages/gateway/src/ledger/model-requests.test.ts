// T1: `model_requests`, the per-request record the model proxy writes (M3 context plan, Phase 1).

import type { RunId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { ModelRequestStore } from "./model-requests.js";

const RUN = "run_1" as RunId;
const OTHER = "run_2" as RunId;

let db: GatewayDb;
let store: ModelRequestStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('w', 'tnt_default', 'w', 'docker', 'ready', 't')",
  ).run();
  db.prepare(
    "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES ('b', 'w', 'b', 'r', 't')",
  ).run();
  for (const id of [RUN, OTHER]) {
    db.prepare(
      "INSERT INTO runs (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at) VALUES ('w', ?, 'b', 'interactive', 'running', 'thread_message', 'm', 't')",
    ).run(id);
  }
  store = new ModelRequestStore(db);
});

describe("ModelRequestStore", () => {
  it("numbers requests per run from 1 and leaves tokens unknown until usage is set", () => {
    const a = store.insert({
      runId: RUN,
      attempt: 1,
      ts: "2026-09-29T10:00:00.000Z",
      requestKind: "messages",
      model: "m",
      systemSha256: "a".repeat(64),
      stream: true,
    });
    store.insert({ runId: OTHER, attempt: 1, ts: "t", requestKind: "messages", stream: false });
    const b = store.insert({
      runId: RUN,
      attempt: 2,
      ts: "2026-09-29T10:00:01.000Z",
      requestKind: "count_tokens",
      stream: false,
    });
    store.setUsage(a, {
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 900,
      thinkingTokens: 42,
      servedModel: "served-m",
    });

    expect(store.list(RUN)).toEqual([
      {
        runId: RUN,
        attempt: 1,
        seq: 1,
        ts: "2026-09-29T10:00:00.000Z",
        requestKind: "messages",
        model: "m",
        systemSha256: "a".repeat(64),
        stream: true,
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 900,
        cacheCreateTokens: null,
        thinkingTokens: 42,
        rewrittenFrom: null,
        refusal: null,
        servedModel: "served-m",
        imageBlocks: null,
      },
      {
        runId: RUN,
        attempt: 2,
        seq: 2,
        ts: "2026-09-29T10:00:01.000Z",
        requestKind: "count_tokens",
        model: null,
        systemSha256: null,
        stream: false,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        thinkingTokens: null,
        rewrittenFrom: null,
        refusal: null,
        servedModel: null,
        imageBlocks: null,
      },
    ]);
    expect(b).not.toBe(a);
    expect(store.list(OTHER).map((r) => r.seq)).toEqual([1]);
  });

  it("records a refused request with the id it named and a rewritten one with its original id", () => {
    store.insert({
      runId: RUN,
      attempt: 1,
      ts: "t",
      requestKind: "messages",
      model: "unlisted",
      stream: false,
      refusal: "model_not_selected",
    });
    store.insert({
      runId: RUN,
      attempt: 1,
      ts: "t",
      requestKind: "messages",
      model: "cheap",
      stream: true,
      rewrittenFrom: "small-fast",
    });
    expect(store.list(RUN).map((r) => [r.model, r.refusal, r.rewrittenFrom])).toEqual([
      ["unlisted", "model_not_selected", null],
      ["cheap", null, "small-fast"],
    ]);
  });

  it("accepts no refusal reason the ADR does not name", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO model_requests (run_id, attempt, seq, ts, request_kind, stream, refusal) VALUES (?, 1, 9, 't', 'messages', 0, 'other')",
        )
        .run(RUN),
    ).toThrow(/CHECK/);
  });
});

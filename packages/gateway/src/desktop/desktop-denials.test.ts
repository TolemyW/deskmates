// T1 (ADR-0048 amendment 1, A4): a stored `desktop`/`egress_denied` event appends one
// `egress.desktop_denied` audit row with the host, the reason, the run and the tool call; other
// events add nothing; a malformed denial is still recorded with what it has.

import type { BotId, RunId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../audit/audit-log.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { recordDesktopDenials } from "./desktop-denials.js";

let db: GatewayDb;
const bots = { mustGetIncludingArchived: () => ({ workspaceId: "ws" }) };
const run = { id: "run_1" as RunId, botId: "bot_nova" as BotId };

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('ws', 'tnt_default', 'Ops', 'docker', 'ready', '2026-09-01T00:00:00.000Z')",
  ).run();
});

const ctx = () => ({ db, bots }) as unknown as Parameters<typeof recordDesktopDenials>[0];

describe("desktop network denials are audited (ADR-0048 amendment 1, A4)", () => {
  it("appends one audit row per stored denial and nothing for other events", () => {
    recordDesktopDenials(ctx(), run, [
      { kind: "tool_call", payload: { toolName: "mcp__desktop__js" } },
      { kind: "log", payload: { source: "desktop", op: "registered" } },
      {
        kind: "log",
        payload: {
          source: "desktop",
          op: "egress_denied",
          level: "warn",
          host: "intranet.example",
          kind: "not_in_allowlist",
          reason: "egress_blocked: desktop code names intranet.example",
          toolName: "mcp__desktop__js",
          toolUseId: "toolu_1",
        },
      },
      { kind: "log", payload: { source: "desktop", op: "egress_denied" } },
    ]);
    const rows = new AuditLog(db).list({ workspaceId: "ws" }).reverse();
    expect(rows.map((r) => [r.action, r.actor, r.targetKind, r.targetId, r.runId])).toEqual([
      ["egress.desktop_denied", "bot:bot_nova", "egress_host", "intranet.example", "run_1"],
      ["egress.desktop_denied", "bot:bot_nova", "egress_host", "(no host)", "run_1"],
    ]);
    expect(rows[0]?.reason).toBe("egress_blocked: desktop code names intranet.example");
    expect(rows[0]?.after).toEqual({
      kind: "not_in_allowlist",
      toolName: "mcp__desktop__js",
      toolUseId: "toolu_1",
    });
    expect(rows[1]?.after).toEqual({ kind: "unknown" });
  });
});

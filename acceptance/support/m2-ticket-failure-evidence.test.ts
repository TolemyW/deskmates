import { describe, expect, it } from "vitest";
import { readTicketArm, ticketFailureDiagnostics } from "./m2-ticket-failure-evidence.js";
import type { Stack } from "./start-stack.js";

describe("ticket arm evidence on a failed status read", () => {
  it("keeps the original wait error and in-process diagnostics before teardown", async () => {
    const arm: Record<string, unknown> = {};
    let diagnosticsRead = false;
    const waitError = new Error("run ticket-1 still running after 330000 ms; ECONNRESET");
    const fallbackError = new Error("fallback GET /api/runs/ticket-1: ECONNRESET");
    await expect(
      readTicketArm({
        waited: [{ status: "rejected", reason: waitError }],
        runIds: ["ticket-1"],
        arm,
        readRun: async () => {
          expect(arm.waitErrors).toEqual([String(waitError)]);
          throw fallbackError;
        },
        readEvents: async () => {
          throw new Error("events should not be read after status failure");
        },
        readState: async () => {
          throw new Error("HTTP state should not be read after status failure");
        },
        diagnostics: () => {
          diagnosticsRead = true;
          return {
            runs: [{ id: "ticket-1", status: "running", events: [{ kind: "tool_call" }] }],
            tickets: { "1050": { assignee: "li" } },
          };
        },
        secrets: [],
      }),
    ).rejects.toBe(fallbackError);
    expect(diagnosticsRead).toBe(true);
    expect(arm.waitErrors).toEqual([String(waitError)]);
    expect(arm.statusReadError).toBe(String(fallbackError));
    expect(arm.diagnostics).toMatchObject({
      runs: [{ status: "running" }],
      tickets: { "1050": { assignee: "li" } },
    });
  });

  it("redacts exact runtime secrets in written error fields", async () => {
    const arm: Record<string, unknown> = {};
    await expect(
      readTicketArm({
        waited: [{ status: "rejected", reason: new Error("wait secret-value") }],
        runIds: ["ticket-1"],
        arm,
        readRun: async () => {
          throw new Error("fallback secret-value");
        },
        readEvents: async () => [],
        readState: async () => ({}),
        diagnostics: () => ({ source: "in-process" }),
        secrets: ["secret-value"],
      }),
    ).rejects.toThrow("fallback secret-value");
    expect(JSON.stringify(arm)).not.toContain("secret-value");
    expect(arm.waitErrors).toEqual(["Error: wait [redacted]"]);
  });

  it("keeps ticket changes and event order without copying secrets or event payloads", () => {
    const stack = {
      config: {
        modelAuthToken: "model-secret-value",
        operatorToken: "operator-secret-value",
        secretsKey: "database-secret-value",
      },
      site: {
        state: {
          view: () => ({
            tickets: {
              "1050": {
                status: "open",
                assignee: "li",
                tags: ["refund"],
                comments: ["ticket changed model-secret-value"],
              },
            },
            session_only: { id: "session-secret-value" },
          }),
          opLog: () => [
            {
              seq: 2,
              op: "ticket_comment",
              ts: "2026-09-24T00:00:00.000Z",
              details: {
                id: "1050",
                comment: "operator-secret-value",
                sessionId: "session-secret-value",
              },
            },
          ],
        },
      },
      app: {
        deskmates: {
          ctx: {
            runs: {
              get: () => ({
                status: "running",
                attempt: 1,
                error: "database-secret-value",
              }),
            },
            events: {
              list: () => [
                {
                  seq: 3,
                  attempt: 1,
                  kind: "tool_result",
                  ts: "2026-09-24T00:00:01.000Z",
                  payload: { credential: "event-secret-value" },
                },
              ],
            },
          },
        },
      },
    } as unknown as Stack;
    const evidence = ticketFailureDiagnostics(stack, ["ticket-1"]);
    expect(evidence).toMatchObject({
      tickets: { "1050": { assignee: "li", tags: ["refund"] } },
      runs: [{ id: "ticket-1", status: "running", events: [{ kind: "tool_result", seq: 3 }] }],
    });
    const written = JSON.stringify(evidence);
    for (const secret of [
      "model-secret-value",
      "operator-secret-value",
      "database-secret-value",
      "session-secret-value",
      "event-secret-value",
    ]) {
      expect(written).not.toContain(secret);
    }
    expect(written).toContain("[redacted]");
  });
});

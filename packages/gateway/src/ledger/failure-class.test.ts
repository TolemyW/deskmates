// T1, ADR-0042 decision 1: every error shape seen in the ten-day triage of a test deployment
// (issue #11) classifies into its known class, never `other`; the SQL rendering agrees with the
// code on every string; and a model job's name in the error does not change its class, whether
// it is a current job name or one from before the rename.

import { RUN_FAILURE_CLASSES, type RunFailureClass } from "@deskmates/contracts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { FAILURE_RULES, classifyFailure, failureClassSql } from "./failure-class.js";

/** Real-shaped `runs.error` values, by the class an operator would file them under. */
const CORPUS: Readonly<Record<Exclude<RunFailureClass, "other">, readonly string[]>> = {
  model_unavailable: [
    'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: cheap-model-x"}}',
    'API Error: 400 {"error":{"code":"model_not_found","message":"The model `cheap-model-x` does not exist"}}',
    'API Error: 503 {"error":{"message":"No worker available for model cheap-model-x","type":"service_unavailable"}}',
    "model job did not finish within 60 s: the SDK retried the model request 4 times, last on HTTP 500 (API Error: 500 No worker available)",
    "model job did not finish within 60 s: the SDK retried the model request 7 times, last on HTTP 500 (Internal Server Error)",
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}} · Retried 10 times',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "model_not_selected: the run asked for a model this workspace does not offer",
    "could not start run: DeskmatesError: pricing_missing for model cheap-model-x",
    "Error: Claude Code returned an error result: There's an issue with the selected model (unavailable-model). It may not exist or you may not have access to it.\n    at readMessages (file:///sdk.mjs:127:26507)",
    "It may not exist or you may not have access to it.",
  ],
  model_deadline: [
    "model job did not finish within 60 s",
    "model job did not finish within 60 s: the SDK retried the model request once, last on no response (fetch failed)",
    "Request timed out.",
  ],
  tool_allowlist: [
    "sidecar exited without run_ended (exit 2): invalid StartRunRequest on stdin: |   tools.12: Invalid enum value. Expected 'thread_post' | 'task_deliver', received 'app_publish'",
    "sidecar exited without run_ended (exit 2): invalid StartRunRequest on stdin: |   tools.3: Invalid enum value, received 'image_describe' |   tools.4: Invalid enum value, received 'audio_transcribe'",
  ],
  egress_blocked: [
    "egress_blocked: shop.example.net is not in the workspace allowlist",
    "egress_blocked: shell fetch to api.example.org is not in the workspace allowlist",
    "Browser CLI workflow was denied by the live egress allowlist",
  ],
  approval_denied: [
    "approval_denied: the human denied browser_click on checkout",
    "Approval denied by human:usr_1: not this account",
  ],
  wall_clock: [
    "deadline",
    "run exceeded RUN_TIMEOUT_SECONDS (1800 s); sidecar killed",
    "run exceeded RUN_TIMEOUT_SECONDS (60 s); sidecar killed: [sidecar] waiting for model",
    "Browser origin wait reached the run deadline",
  ],
  sdk_abort: [
    "Claude Code process aborted by user",
    "Error: Claude Code process aborted by user",
    "AbortError: The operation was aborted",
  ],
  no_reply: ["no_reply"],
  budget_limit: ["budget_exhausted", "turn_budget"],
  platform_interruption: ["gateway_restarted", "gateway restarted while the run was live"],
  // ADR-0042 amendment 2: the groups the v0.7.3 acceptance (issue #11, 2026-10-17) found filed
  // as `other`, shaped from the provider's and the scheduler's own messages.
  sandbox_unavailable: [
    "sandbox error: DeskmatesError: workspace is attached to a legacy or mismatched network",
    'sandbox error: Error: Docker 404 POST /networks/create: {"message":"could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network"}',
    "sandbox error: DeskmatesError: managed egress proxy is missing",
    "sandbox error: DeskmatesError: volume deskmates-ws-1-work ownership is unverified; preserve the old runtime and follow the legacy-volume recovery runbook",
    "sandbox error: DeskmatesError: egress proxy image is unavailable",
  ],
  sidecar_exit: [
    "sidecar exited without run_ended (exit 1)",
    "sidecar exited without run_ended (exit 1): TypeError: Cannot read properties of undefined (reading 'name') |     at connectorMenu (file:///opt/deskmates/sidecar/dist/connector-tools.js:88:31)",
    "sidecar exited without run_ended (exit 137)",
  ],
};

/** Cheap-model job names now, and the ones they replaced (issue #11 scope 2). */
const JOB_NAMES = [
  "activity_summary",
  "memory_consolidation",
  "soul_proposal",
  "status_inquiry",
  "vision_probe",
  "approval_review",
  "approval_presentation",
  "memory_recheck",
  "memory_organize",
];

const db = new Database(":memory:");
const sqlClass = (error: string | null): string | null =>
  (
    db
      .prepare(`WITH t(e) AS (SELECT ?) SELECT ${failureClassSql("t.e")} AS c FROM t`)
      .get(error) as { c: string | null }
  ).c;

describe("failure class (ADR-0042 decision 1)", () => {
  it("files every corpus string under its class and none under other", () => {
    for (const [expected, errors] of Object.entries(CORPUS))
      for (const error of errors) expect(classifyFailure(error), error).toBe(expected);
  });

  it("covers every class but other with at least one corpus string", () => {
    expect(Object.keys(CORPUS).sort()).toEqual(
      RUN_FAILURE_CLASSES.filter((c) => c !== "other").sort(),
    );
  });

  it("names the cause a sidecar exit's stderr tail carries before calling it a sidecar exit", () => {
    for (const [tail, expected] of [
      ['API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', "model_unavailable"],
      ["AbortError: The operation was aborted", "sdk_abort"],
      ["invalid StartRunRequest on stdin", "tool_allowlist"],
    ] as const) {
      const error = `sidecar exited without run_ended (exit 1): ${tail}`;
      expect(classifyFailure(error), error).toBe(expected);
      expect(sqlClass(error), error).toBe(expected);
    }
  });

  it("gives an unknown error other and no error no class", () => {
    expect(classifyFailure("something nobody has seen before")).toBe("other");
    expect(classifyFailure(undefined)).toBeUndefined();
    expect(classifyFailure(null)).toBeUndefined();
    expect(sqlClass(null)).toBeNull();
  });

  it("classifies the same in SQL as in code, case and quotes included", () => {
    const strings = [
      ...Object.values(CORPUS).flat(),
      "something nobody has seen before",
      "it's an 'odd' error",
      "  NO_REPLY  ",
      "EGRESS_BLOCKED: HOST.EXAMPLE IS NOT IN THE WORKSPACE ALLOWLIST",
    ];
    for (const error of strings) expect(sqlClass(error), error).toBe(classifyFailure(error));
  });

  it("does not depend on which model job failed, current name or old", () => {
    for (const [expected, errors] of Object.entries(CORPUS)) {
      if (
        expected === "no_reply" ||
        expected === "wall_clock" ||
        expected === "budget_limit" ||
        expected === "platform_interruption"
      )
        continue;
      for (const error of errors)
        for (const job of JOB_NAMES) {
          for (const variant of [`${job}: ${error}`, `${error} (runType ${job})`]) {
            expect(classifyFailure(variant), variant).toBe(expected);
            expect(sqlClass(variant), variant).toBe(expected);
          }
        }
    }
    for (const job of JOB_NAMES) {
      expect(classifyFailure(`${job} returned nothing`)).toBe("other");
      expect(classifyFailure(`No ${job.replaceAll("_", " ")} returned`)).toBe("other");
    }
  });

  it("keeps every rule substring lower case and ASCII, as the SQL rendering needs", () => {
    for (const rule of FAILURE_RULES)
      for (const s of [...(rule.exact ?? []), ...(rule.any ?? []), ...(rule.all ?? [])]) {
        expect(s).toBe(s.toLowerCase());
        expect(/^[\x20-\x7e]+$/.test(s), s).toBe(true);
      }
  });
});

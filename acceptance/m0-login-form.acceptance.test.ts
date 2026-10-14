// T3: M0 acceptance `acceptance/m0-login-form` (test strategy §7): deskbench S01 on the deployed
// model, through the real stack (Gateway, Docker workspace, sidecar, Agent SDK, Playwright MCP
// against the workspace's Chromium, golden site as the only egress entry).
//
// Needs MODEL_BASE_URL, MODEL_AUTH_TOKEN, DEFAULT_MODEL and CHEAP_MODEL (environment or .env)
// and a reachable Docker daemon; otherwise the suite is skipped and its title says why.
//
// S11 used to be the second half of this file, with an M0-only expectation: the "Submit order"
// click is L2 and the M0 Gateway denied every approval request, so the run ended with a denied
// approval and no order. M1 turns approvals on, so that expectation is no longer true. S11 now
// lives in `m1-approvals.acceptance.test.ts`, asserted against the benchmark's own oracle once
// per decision (allow, deny, park and resume, always).

import type { RunEvent } from "@deskmates/contracts";
import { OPS_ACCOUNT } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import { toolCalls, toolNameOf } from "./support/runs.js";
import { type S01Result, runS01 } from "./support/s01.js";
import { siteState } from "./support/site.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { unexpectedChanges } from "./support/state-diff.js";
import { stopStack } from "./support/stop-stack.js";

const RUN_TIMEOUT_MS = 10 * 60_000;

// Copied, not imported: acceptance drives the stack from outside and never imports the sidecar.
// The source of all three is packages/sidecar/src/screenshots.ts, the contract between the MCP
// proxy that captures and the run process that emits.
const SCREENSHOT_MAX_PER_RUN = 40;
const SCREENSHOT_MAX_BYTES = 300_000;
const PAGE_CHANGING_BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_drop",
  "browser_handle_dialog",
  "browser_file_upload",
  "browser_tabs",
  "browser_mouse_click_xy",
  "browser_mouse_drag_xy",
  "browser_run_code_unsafe",
  "browser_evaluate",
]);

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
if (skip) {
  console.warn(`[m0-login-form.acceptance.test]${skipReason(missing, dockerUp)}`);
}

describe.skipIf(skip)(`M0 login form (T3): deskbench S01${skipReason(missing, dockerUp)}`, () => {
  let stack: Stack | undefined;
  let s01: S01Result | undefined;

  beforeAll(async () => {
    stack = await startStack({ ...modelEnv(), label: "login" });
  }, 25 * 60_000);

  afterAll(async () => {
    await stopStack(stack);
  }, 120_000);

  it(
    "S01: logs in with the ops account and answers the dashboard's open ticket count",
    async () => {
      const s = stack as Stack;
      s01 = await runS01(s);
      console.log(
        `[S01] ${s01.run.status} in ${Math.round(s01.wallClockMs / 1000)}s; reply: ${s01.reply}`,
      );
      expect(s01.run.status, s01.run.error).toBe("succeeded");
      // The site's own log proves the login happened server-side, not just in the reply.
      expect(s01.loggedIn, `no login by ${OPS_ACCOUNT} in the site's operation log`).toBe(true);
      // Answer oracle (benchmark §5): last `answer: <value>` line, numbers normalised. The
      // expected value is the site's KPI (0 until the M1 tickets seed; 23 after).
      expect(s01.answer, `reply had no answer line: ${s01.reply}`).toBeDefined();
      expect(s01.answer).toBe(s01.expected);
    },
    RUN_TIMEOUT_MS + 60_000,
  );

  it("S01 ledger: the run navigated with the browser and the pages it changed are in the ledger", async () => {
    const r = s01 as S01Result;
    expect(toolCalls(r.events, "browser_navigate").length).toBeGreaterThanOrEqual(1);
    const nav = toolCalls(r.events, "browser_navigate")[0];
    expect(String((nav?.payload.input as { url?: string } | undefined)?.url)).toContain(
      new URL((stack as Stack).siteOriginForBot).host,
    );
    expect(r.events.every((e) => e.kind !== "tool_call" || e.payload.riskLevel !== undefined)).toBe(
      true,
    );

    // Test strategy §7: the login page is in the ledger as an image. The proxy captures after
    // every page-changing browser action and the run process emits it right after that action's
    // `tool_result`, so a run that logged in has at least one and never more than one per action.
    const screenshots = r.events.filter((e) => e.kind === "screenshot");
    const pageChanging = r.events.filter(
      (e) => e.kind === "tool_call" && PAGE_CHANGING_BROWSER_TOOLS.has(toolNameOf(e)),
    );
    expect(screenshots.length, "the ledger has no screenshot events").toBeGreaterThanOrEqual(1);
    expect(screenshots.length).toBeLessThanOrEqual(
      Math.min(pageChanging.length, SCREENSHOT_MAX_PER_RUN),
    );
    for (const shot of screenshots) {
      const { mimeType, base64, bytes, toolUseId } = shot.payload as {
        mimeType?: string;
        base64?: string;
        bytes?: number;
        toolUseId?: string;
      };
      // A viewport JPEG the run screen renders as a data URL, under the cap that keeps the
      // largest ledger row bounded, and decoding to exactly the size the capture claims.
      expect(mimeType).toBe("image/jpeg");
      expect(base64?.length ?? 0).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(SCREENSHOT_MAX_BYTES);
      expect(Buffer.from(String(base64), "base64").length).toBe(bytes);
      // It belongs to a page-changing call and sits directly after that call's result: the
      // previous event, thinking aside, is the `tool_result` with the same tool-use id.
      const before = r.events.slice(0, r.events.indexOf(shot)).filter((e) => e.kind !== "thinking");
      const previous = before[before.length - 1];
      expect(previous?.kind).toBe("tool_result");
      expect(previous?.payload.toolUseId).toBe(toolUseId);
      const call = r.events.find(
        (e) => e.kind === "tool_call" && e.payload.toolUseId === toolUseId,
      );
      expect(call, "screenshot without its tool call").toBeDefined();
      expect(PAGE_CHANGING_BROWSER_TOOLS.has(toolNameOf(call as RunEvent))).toBe(true);
    }
    // S01 is a read task: nothing outside `session` may have changed (allowed_paths: []).
    const after = await siteState(stack as Stack);
    expect(unexpectedChanges(r.seed, after, [])).toEqual([]);
  });
});

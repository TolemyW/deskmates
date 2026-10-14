// deskbench S01 (benchmark §3.1) driven through the stack: log in with the ops account and
// answer with the dashboard's open ticket count. Shared by m0-login-form and m0-model-swap so
// both run the identical task. The expected count is read from the site's own KPI function:
// the benchmark says 23, but the golden site's tickets module is M1 and the dashboard shows 0
// until then (packages/golden-site/src/state.ts `kpis()`); asserting against the site keeps
// this test honest today and picks up 23 automatically when the ticket seed lands.

import type { RunEvent } from "@deskmates/contracts";
import { OPS_ACCOUNT, type StateView } from "@deskmates/golden-site";
import {
  type RunView,
  answerOf,
  normaliseAnswer,
  postMessage,
  replyOf,
  runEvents,
  threadMessages,
  waitForRun,
} from "./runs.js";
import { siteLog, siteReset, siteState } from "./site.js";
import type { Stack } from "./start-stack.js";

export const S01_TIMEOUT_MS = 10 * 60_000;

export interface S01Result {
  run: RunView;
  reply: string | undefined;
  answer: string | undefined;
  expected: string;
  events: RunEvent[];
  /** `/api/state` right after the reset, for the side-effect invariant. */
  seed: StateView;
  /** Whether the site's operation log saw a successful login by the ops account. */
  loggedIn: boolean;
  wallClockMs: number;
}

export function s01Instruction(stack: Stack): string {
  return [
    `Log in to the Galaxy Ops Console at ${stack.siteOriginForBot} with the ops account and`,
    "tell me the open ticket count on the dashboard.",
    "Give the answer on the last line as answer: <value>.",
  ].join(" ");
}

export async function runS01(stack: Stack): Promise<S01Result> {
  await siteReset(stack);
  const seed = await siteState(stack);
  const expected = normaliseAnswer(String(stack.site.state.kpis().openTickets));
  const started = Date.now();
  const { run } = await postMessage(stack, s01Instruction(stack));
  const final = await waitForRun(stack, run.id, S01_TIMEOUT_MS, {
    onStatus: (s) =>
      console.log(`[S01] run ${run.id} ${s} (+${Math.round((Date.now() - started) / 1000)}s)`),
  });
  const reply = replyOf(await threadMessages(stack), run.id);
  const answer = answerOf(reply);
  const log = await siteLog(stack);
  const loggedIn = log.some((e) => e.op === "login" && e.details.email === OPS_ACCOUNT);
  return {
    run: final,
    reply,
    answer: answer === undefined ? undefined : normaliseAnswer(answer),
    expected,
    events: await runEvents(stack, run.id),
    seed,
    loggedIn,
    wallClockMs: Date.now() - started,
  };
}

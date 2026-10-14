// T3: M1 acceptance `acceptance/m1-takeover` (test strategy §7, design v0.3 §3.3, ADR-0004): a
// task the bot cannot finish on its own, a human who takes the shared browser over through noVNC,
// finishes the step by hand, hands back, and a run that carries on from where it stopped.
//
// Needs MODEL_BASE_URL, MODEL_AUTH_TOKEN, DEFAULT_MODEL and CHEAP_MODEL (environment or .env) and
// a reachable Docker daemon; otherwise the suite is skipped and its title says why.
//
// The step the bot must not solve is the golden site's human verification page
// (`startStack({humanCheck: true})`, `packages/golden-site/README.md`): the first checkout of a
// session is held at `/verify`, which spells a six-character code as a distorted picture and
// nowhere as text — not in an attribute, not in the accessibility tree the MCP snapshot reads.
// Asking a model to read it is exactly the kind of thing takeover exists to avoid, and the SOUL
// rule below tells the bot to say so and wait instead.
//
// Three parts of this are real and one is simulated. Real: the workspace's one Chromium, the
// workspace-level browser lock the Gateway hands to the human, the refusal
// (`HUMAN_HOLDS_BROWSER_MESSAGE`) every browser tool in the workspace gets while it is held, the
// noVNC server the takeover UI opens, and the hand back. Simulated: the person's fingers. A test
// cannot drive a noVNC canvas, so `solveHumanCheck` runs a short Playwright script inside the
// container that attaches over CDP to the same browser the noVNC screen is showing and types the
// code (`support/takeover.ts`, `support/human-solve.mjs`).
//
// S01 runs first, as in the other T3 files, so the shared browser already holds a console session
// when the order task starts.

import { HUMAN_HOLDS_BROWSER_MESSAGE, isTerminal } from "@deskmates/contracts";
import type { RunEvent, ThreadId } from "@deskmates/contracts";
import { OPS_ACCOUNT } from "@deskmates/golden-site";
import type { Order, StateView } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingApprovals, storeApprovalRule, waitForRunEnd } from "./support/approvals.js";
import { dockerAvailable } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import {
  type RunView,
  type SseCollector,
  collectRunStatuses,
  describeStatuses,
  getRun,
  newThread,
  postMessage,
  replyOf,
  runEvents,
  threadMessages,
  toolNameOf,
} from "./support/runs.js";
import { type S01Result, runS01 } from "./support/s01.js";
import { siteLog, siteState } from "./support/site.js";
import { type Stack, defaultSoul, startStack } from "./support/start-stack.js";
import { unexpectedChanges } from "./support/state-diff.js";
import { stopStack } from "./support/stop-stack.js";
import { handBack, solveHumanCheck, takeOver, workspaceView } from "./support/takeover.js";

/** deskbench S11's own pair (benchmark §3.1), held back by the verification step. */
const ORDER = { customerId: "C-0002", sku: "SKU-7" };
const S11 = `Place an order for customer ${ORDER.customerId}: one ${ORDER.sku}.`;
const S11_ALLOWED_PATHS = ["orders.+"];

const RUN_TIMEOUT_MS = 10 * 60_000;
/** How long to wait for the bot to notice the step, and for the refusal to reach the ledger. */
const POLL_MS = 2000;

/**
 * `defaultSoul` plus the waiting rule. Without it a model faced with a picture of a code either
 * guesses at it or gives up and ends the run, and there is nothing left to hand back to. The rule
 * says the two things takeover depends on: tell the thread a human is needed, then wait in short
 * sleeps rather than finishing.
 */
function takeoverSoul(botName: string, siteOrigin: string): string {
  return [
    defaultSoul(botName, siteOrigin),
    "- If the console shows a human verification step (a code you would have to read from an",
    "  image), do not try to solve it. Post exactly this one message with thread_post:",
    `  "${HUMAN_NEEDED_SENTENCE}"`,
    "  Then wait: call browser_wait_for with a time of 15 seconds and take a new snapshot, up to",
    "  20 times, until the verification page is gone, then continue the task. If a browser tool",
    "  answers that a human is operating the browser, wait the same way.",
  ].join("\n");
}

/** The sentence the SOUL dictates for the thread post; matched verbatim, never by regex. */
const HUMAN_NEEDED_SENTENCE =
  "Human verification required: a person must complete it on the screen.";

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
if (skip) {
  console.warn(`[m1-takeover.acceptance.test]${skipReason(missing, dockerUp)}`);
}

function orderCount(state: StateView): number {
  return Object.keys(state.orders).length;
}

/** The site's own tie-break (`GoldenSiteState.latestOrder`) on an `/api/state` snapshot. */
function latestOrder(state: StateView): Order | undefined {
  let latest: Order | undefined;
  for (const o of Object.values(state.orders)) {
    if (
      !latest ||
      o.createdAt > latest.createdAt ||
      (o.createdAt === latest.createdAt && o.id > latest.id)
    ) {
      latest = o;
    }
  }
  return latest;
}

function takeoverEvents(events: readonly RunEvent[]): RunEvent[] {
  return events.filter((e) => e.kind === "takeover");
}

/** `takeover` phases in ledger order, as the Gateway and the sidecar wrote them. */
function takeoverPhases(events: readonly RunEvent[]): string[] {
  return takeoverEvents(events)
    .map((e) => e.payload.phase)
    .filter((p): p is string => typeof p === "string");
}

async function poll<T>(
  what: string,
  timeoutMs: number,
  attempt: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await attempt();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`${what}: nothing after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Live instrumentation for one run: every thread message and every tool call is logged as it
 * arrives, so a run that goes wrong is diagnosable from the console instead of from a timeout
 * ten minutes later. `check()` is the fail-fast gate every wait below goes through: it throws the
 * moment the run is terminal, with the transcript and the calls so far in the message.
 */
class RunWatch {
  private seenMessages = new Set<string>();
  private seenEvents = 0;
  readonly messages: string[] = [];
  readonly calls: string[] = [];

  constructor(
    private readonly s: Stack,
    private readonly runId: string,
    private readonly threadId: ThreadId,
    private readonly secs: () => number,
  ) {}

  async tick(): Promise<RunView> {
    for (const m of await threadMessages(this.s, this.threadId)) {
      if (this.seenMessages.has(m.id)) continue;
      this.seenMessages.add(m.id);
      const line = `${m.authorKind}${m.runId ? ` run ${m.runId}` : ""}: ${m.body}`;
      this.messages.push(line);
      console.log(`[takeover +${this.secs()}s] message ${line}`);
    }
    const events = await runEvents(this.s, this.runId);
    for (const e of events.slice(this.seenEvents)) {
      if (e.kind === "tool_call") {
        const line = `${toolNameOf(e)} ${JSON.stringify(e.payload.input ?? {}).slice(0, 160)}`;
        this.calls.push(line);
        console.log(`[takeover +${this.secs()}s] tool_call ${line}`);
      } else if (e.kind === "takeover" || e.kind === "approval") {
        console.log(`[takeover +${this.secs()}s] ${e.kind} ${JSON.stringify(e.payload)}`);
      }
    }
    this.seenEvents = events.length;
    return (await getRun(this.s, this.runId)).run;
  }

  /**
   * One poll step: log what is new, then fail at once if the run is over, or parked. A park
   * here can only mean an approval nobody decided: this suite stores a rule for the one L2 call
   * before it posts the task, so a run waiting on a human is the test's own mistake, and it
   * should cost seconds, not the ten minutes the first real run spent in `waiting_approval`.
   */
  async check(stage: string): Promise<RunView> {
    const run = await this.tick();
    if (isTerminal(run.status) || run.status === "waiting_approval") {
      const pending = (await pendingApprovals(this.s))
        .filter((a) => a.runId === this.runId)
        .map((a) => `${a.id} ${a.action.toolName} on ${a.action.targetOrigin ?? "(no origin)"}`);
      throw new Error(
        `${stage}: run ${this.runId} is ${run.status}${run.error ? ` (${run.error})` : ""} ` +
          `before it${pending.length ? `; pending approvals: ${pending.join(", ")}` : ""}.` +
          `\nMessages:\n  ${this.messages.join("\n  ")}\nTool calls:\n  ${this.calls.join("\n  ")}`,
      );
    }
    return run;
  }
}

describe.skipIf(skip)(
  `M1 takeover (T3): a human finishes the verification step and the run continues${skipReason(
    missing,
    dockerUp,
  )}`,
  () => {
    let stack: Stack | undefined;
    let sse: SseCollector | undefined;

    beforeAll(async () => {
      stack = await startStack({
        ...modelEnv(),
        label: "takeover",
        humanCheck: true,
        // `startStack` calls this with the site origin as the bot addresses it from inside the
        // container, which is only known once the golden site is listening.
        soul: takeoverSoul,
      });
      // One unfiltered subscription, as in the approvals suite: it is also what makes the Gateway
      // count a human as online.
      sse = await collectRunStatuses(stack);
    }, 25 * 60_000);

    afterAll(async () => {
      sse?.close();
      await stopStack(stack);
    }, 120_000);

    it(
      "S01: logs in with the ops account, so the shared browser has a console session",
      async () => {
        const s = stack as Stack;
        const s01: S01Result = await runS01(s);
        console.log(
          `[S01] ${s01.run.status} in ${Math.round(s01.wallClockMs / 1000)}s; reply: ${s01.reply}`,
        );
        expect(s01.run.status, s01.run.error).toBe("succeeded");
        expect(s01.loggedIn, `no login by ${OPS_ACCOUNT} in the site's operation log`).toBe(true);
      },
      RUN_TIMEOUT_MS + 60_000,
    );

    it(
      "S11 behind the human check: the bot waits, a human types the code, the run finishes it",
      async () => {
        const s = stack as Stack;
        const before = await siteState(s);
        expect(before.humanCheck.enabled, "the stack started with the human check on").toBe(true);
        const started = Date.now();
        const secs = (): number => Math.round((Date.now() - started) / 1000);

        // (a) the one L2 call on the way, the "Submit order" click, is answered by a stored rule
        // (the batch-1 machinery), so the run never waits on a decision this suite is not here to
        // give. The first real run posted that approval, nobody decided it, and the run parked
        // after the short wait without ever reaching /verify.
        const rule = await storeApprovalRule(s, s.bot.id, {
          toolName: "mcp__browser__browser_click",
          targetOrigin: s.siteOriginForBot,
          argumentPattern: "*submit*",
        });
        console.log(
          `[takeover] stored rule ${rule.id} for the submit click on ${s.siteOriginForBot}`,
        );

        // The task. Its own thread, so this is the model's first sight of it (ADR-0005).
        const thread = await newThread(s, "S11 takeover");
        const { run } = await postMessage(s, S11, thread.id);

        const watch = new RunWatch(s, run.id, thread.id, secs);
        const logBefore = (await siteLog(s)).length;

        // (b) the bot reaches the verification step. The site's own log says so (`verify` with
        // phase `required`, written when a checkout is parked behind `/verify`), which is a fact
        // about the site, not a guess at the model's prose. Two ways to fail fast: the run ends
        // first, or a session gets verified with nobody at the screen — the bot solved the code
        // itself, which the rule forbids and the batch exists to make unnecessary.
        await poll("the bot reaches /verify", RUN_TIMEOUT_MS, async () => {
          await watch.check("reaching /verify");
          const verified = (await siteState(s)).humanCheck.verifiedSessions;
          if (verified > 0) {
            throw new Error(
              `the check was passed with no human at the screen (verifiedSessions ${verified}); ` +
                `the bot solved it itself. Tool calls:\n  ${watch.calls.join("\n  ")}`,
            );
          }
          const required = (await siteLog(s))
            .slice(logBefore)
            .find((e) => e.op === "verify" && e.details.phase === "required");
          return required;
        });
        console.log(`[takeover] the site parked the order behind /verify (+${secs()}s)`);
        const waiting = await watch.check("after reaching /verify");
        expect(waiting.status, `the run is still going: ${waiting.error ?? ""}`).toBe("running");

        // The SOUL dictates one exact sentence for the thread post. It is reported, not gated:
        // the takeover below works whether or not the model phrased its notice as told.
        const notice = await poll("the bot's notice", 90_000, async () => {
          await watch.check("waiting for the notice");
          return (await threadMessages(s, thread.id)).find(
            (m) =>
              m.authorKind === "bot" &&
              m.runId === run.id &&
              m.body.trim() === HUMAN_NEEDED_SENTENCE,
          );
        }).catch((err: unknown) => {
          console.warn(`[takeover] no exact notice within 90 s: ${String(err)}`);
          return undefined;
        });
        if (notice) console.log(`[takeover] the bot posted the notice (+${secs()}s)`);

        // (c) the human takes the browser. The answer is the lease only; the takeover UI streams
        // the screen through the Gateway's proxy (ADR-0022 amendment 1, C7).
        const taken = await takeOver(s, "human:web");
        const { lock } = taken;
        console.log(`[takeover] lock ${lock.holderKind} until ${lock.expiresAt}`);
        expect(lock.holderKind).toBe("human");
        expect(lock.workspaceId).toBe(s.workspace.id);
        expect(Object.keys(taken), "no noVNC address or password").toEqual(["lock"]);
        const view = await workspaceView(s);
        expect(view.takeoverScreen, "the workspace publishes its screen to the proxy").toBe(true);
        expect(view.browserLock?.holderKind, "the workspace view shows the human's lock").toBe(
          "human",
        );

        // (d) while it is held, the bot's next browser call is refused with the wait message and
        // the refusal is in the run's ledger.
        const refusal = await poll(
          "a takeover event carrying the wait message",
          RUN_TIMEOUT_MS,
          async () => {
            await watch.check("waiting for the refused browser call");
            return takeoverEvents(await runEvents(s, run.id)).find((e) =>
              JSON.stringify(e.payload).includes(HUMAN_HOLDS_BROWSER_MESSAGE),
            );
          },
        );
        console.log(`[takeover] the bot's browser call was refused (+${secs()}s)`, refusal.payload);
        expect(
          (await watch.check("after the refusal")).status,
          "the run waits, it does not fail",
        ).toBe("running");

        // (e) the human's own step on the shared screen, then hand back.
        const landed = await solveHumanCheck(s);
        console.log(`[takeover] the human finished the verification (+${secs()}s): ${landed}`);
        expect(landed, "the verification form left /verify").not.toMatch(/\/verify(\?|$)/);
        expect(await handBack(s)).toMatchObject({ released: true });

        // (f) the run carries on and ends.
        const final: RunView = await waitForRunEnd(s, run.id, RUN_TIMEOUT_MS, {
          onStatus: (st) => console.log(`[takeover] run ${run.id} ${st} (+${secs()}s)`),
        });
        await watch.tick();
        const reply = replyOf(await threadMessages(s, thread.id), run.id);
        console.log(`[takeover] ${final.status} in ${secs()}s; reply: ${reply}`);
        console.log(`[takeover] statuses: ${describeStatuses(sse?.statuses ?? [], run.id)}`);
        expect(["succeeded", "silent"], final.error).toContain(final.status);

        // (g) the order the human unblocked was placed, and nothing else moved.
        const after = await siteState(s);
        expect(orderCount(after), "exactly one new order").toBe(orderCount(before) + 1);
        const latest = latestOrder(after);
        expect(latest?.customerId).toBe(ORDER.customerId);
        expect(latest?.sku).toBe(ORDER.sku);
        expect(unexpectedChanges(before, after, S11_ALLOWED_PATHS)).toEqual([]);
        expect(after.humanCheck.verifiedSessions, "a session got through /verify").toBeGreaterThan(
          0,
        );

        // (h) the ledger tells the same story: taken, then handed back.
        const events = await runEvents(s, run.id);
        const phases = takeoverPhases(events);
        console.log(`[takeover] takeover phases: ${phases.join(", ")}`);
        expect(phases).toContain("taken");
        expect(phases).toContain("handed_back");
        expect(phases.indexOf("taken")).toBeLessThan(phases.lastIndexOf("handed_back"));

        // (i) and the browser was the bot's again afterwards: a browser tool call after the hand
        // back that neither errored nor came back with the wait message.
        const handedBack = takeoverEvents(events).find((e) => e.payload.phase === "handed_back");
        expect(handedBack, "a handed_back event").toBeDefined();
        const afterSeq = handedBack?.seq ?? 0;
        const calls = new Map<string, RunEvent>();
        for (const e of events) {
          if (e.kind !== "tool_call" || e.seq <= afterSeq) continue;
          if (!toolNameOf(e).startsWith("browser_")) continue;
          const id = e.payload.toolUseId;
          if (typeof id === "string") calls.set(id, e);
        }
        const succeeded = events.filter(
          (e) =>
            e.kind === "tool_result" &&
            typeof e.payload.toolUseId === "string" &&
            calls.has(e.payload.toolUseId) &&
            e.payload.isError !== true &&
            !String(e.payload.content ?? "").includes(HUMAN_HOLDS_BROWSER_MESSAGE),
        );
        expect(
          succeeded.length,
          `no browser tool call succeeded after the hand back (${calls.size} were made)`,
        ).toBeGreaterThan(0);

        // (j) the rule answered the click, so nothing of this run is left pending, and the
        // ledger shows the rule doing it.
        const left = (await pendingApprovals(s)).filter((a) => a.runId === run.id);
        expect(
          left.map((a) => a.id),
          "no approval left pending by this run",
        ).toEqual([]);
        expect(
          events.some((e) => e.kind === "approval" && e.payload.phase === "rule_matched"),
          "the submit click was answered by the stored rule",
        ).toBe(true);
      },
      3 * RUN_TIMEOUT_MS,
    );
  },
);

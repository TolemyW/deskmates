// T3: M1 acceptance `acceptance/m1-approvals` (test strategy §7, ADR-0002 amendment 2): deskbench
// S11 five times on the deployed model, once per approval outcome — allow, deny, park and resume,
// "Always" plus the rule that answers the next request — through the real stack (Gateway, Docker
// workspace, sidecar, Agent SDK, Playwright MCP against the workspace's Chromium, golden site as
// the only egress entry).
//
// Needs MODEL_BASE_URL, MODEL_AUTH_TOKEN, DEFAULT_MODEL and CHEAP_MODEL (environment or .env)
// and a reachable Docker daemon; otherwise the suite is skipped and its title says why.
//
// Four setup choices carry the whole file.
//
// 1. One thread per case, and therefore one SDK session per case. A bot keeps its session per
//    thread (ADR-0005), so five S11 runs in one thread are five turns of one conversation: the
//    first run's transcript tells the model it already placed this order, and the honest answer
//    to the second identical instruction is to refuse — which a real run did, word for word
//    ("The order was already placed… I won't place a duplicate"), leaving the case waiting for an
//    approval that was never requested. Each case gets its own thread so it is the model's first
//    sight of the task, and case order stops mattering.
// 2. One customer and one SKU per case, all present in the seed (benchmark §2.2: customers
//    C-0001..C-0030, SKUs SKU-1..SKU-9). Distinct pairs mean each case can assert the site's
//    latest order is *its* order rather than some other case's, and the deny case can assert no
//    order for its own pair exists at all.
// 3. `shortWaitSeconds: 2`, so the L2 hook's live wait is over in two seconds instead of five
//    minutes and the parked case costs the suite nothing. Two seconds is short enough that a
//    polling test may lose the race in the allow case — that is fine and deliberate:
//    `waitForPendingApproval` returns a parked run's approval too, and a decision on a parked run
//    resumes it, so the outcome asserted (the order is placed exactly once) holds on either path.
// 4. One SSE subscription held open for the entire suite, which is what makes the Gateway count a
//    human as online, so the hook blocks in `waiting_approval_live` rather than deferring at once.
//    Presence is global, not per thread (`packages/gateway/src/events/presence.ts`), so one
//    unfiltered stream serves every case and also collects every case's status frames.
//
// Fail fast, everywhere. A run that parks a second time has asked for an L2 action no case is
// going to decide; waiting it out costs `RUN_TIMEOUT_MS` of silence and reports a timeout instead
// of the cause. `waitForRunEnd` therefore fails as soon as it sees a second park, naming the run
// and what is pending. Each case also ends by asserting nothing is left pending, so a case can
// never hand its leftovers to the next one.
//
// S01 runs first, exactly as in `m0-login-form.acceptance.test.ts`, because every S11 case needs
// the shared browser to be logged in to the console.

import { APPROVAL_ATTACHMENT_MIME, decidedByHuman } from "@deskmates/contracts";
import type { Approval, RunEvent } from "@deskmates/contracts";
import { OPS_ACCOUNT } from "@deskmates/golden-site";
import type { Order, StateView } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalPhases,
  approvalRules,
  decideApproval,
  pendingApprovals,
  waitForPendingApproval,
  waitForRunEnd,
} from "./support/approvals.js";
import { dockerAvailable } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import { selectM2BrowserSnapshotMode } from "./support/m2-browser-snapshot-mode.js";
import {
  type SseCollector,
  collectRunStatuses,
  describeStatuses,
  newThread,
  postMessage,
  replyOf,
  runEvents,
  threadMessages,
  waitForRun,
} from "./support/runs.js";
import { type S01Result, runS01 } from "./support/s01.js";
import { siteState } from "./support/site.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { unexpectedChanges } from "./support/state-diff.js";
import { stopStack } from "./support/stop-stack.js";

/** One S11 order: a customer and a SKU from the seed, used by exactly one case. */
interface OrderSpec {
  customerId: string;
  sku: string;
}

/**
 * deskbench S11 is "Place an order for customer C-0002: one SKU-7". The oracle is about the
 * shape of the result, not about those two identifiers, so each case uses its own pair: the
 * allow case keeps the benchmark's own, the others take the next customers and other SKUs. All
 * exist in the seed (benchmark §2.2).
 */
const ALLOW_ORDER: OrderSpec = { customerId: "C-0002", sku: "SKU-7" };
const DENY_ORDER: OrderSpec = { customerId: "C-0003", sku: "SKU-2" };
const PARK_ORDER: OrderSpec = { customerId: "C-0004", sku: "SKU-5" };
const ALWAYS_ORDER: OrderSpec = { customerId: "C-0005", sku: "SKU-3" };
const BY_RULE_ORDER: OrderSpec = { customerId: "C-0006", sku: "SKU-4" };

/** The paraphrase the M0 test used, with the case's own pair. */
function s11(order: OrderSpec): string {
  return `Place an order for customer ${order.customerId}: one ${order.sku}.`;
}

const S11_ALLOWED_PATHS = ["orders.+"];
const RUN_TIMEOUT_MS = 10 * 60_000;
/** The stack's live wait; short enough that the parked case is a two-second pause, not five minutes. */
const SHORT_WAIT_SECONDS = 2;
const snapshotMode = selectM2BrowserSnapshotMode(process.env.M2_BROWSER_SNAPSHOT_MODE);

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
if (skip) {
  console.warn(`[m1-approvals.acceptance.test]${skipReason(missing, dockerUp)}`);
}

function orderCount(state: StateView): number {
  return Object.keys(state.orders).length;
}

/** The site's own tie-break (`GoldenSiteState.latestOrder`), computed on a `/api/state` snapshot. */
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

/** Orders of one customer for one SKU, by id, so "did *this* case's order appear?" is answerable. */
function ordersFor(state: StateView, order: OrderSpec): string[] {
  return Object.values(state.orders)
    .filter((o) => o.customerId === order.customerId && o.sku === order.sku)
    .map((o) => o.id)
    .sort();
}

/** Benchmark §3.1 S11 oracle, less the approval count: one new order, for this case's pair. */
function expectOrderPlaced(
  before: StateView,
  after: StateView,
  order: OrderSpec,
  label: string,
): void {
  expect(orderCount(after), `${label}: exactly one new order`).toBe(orderCount(before) + 1);
  const latest = latestOrder(after);
  expect(latest, `${label}: the site has a latest order`).toBeDefined();
  expect(latest?.customerId, label).toBe(order.customerId);
  expect(latest?.sku, label).toBe(order.sku);
  expect(
    ordersFor(after, order).length,
    `${label}: one more order for ${order.customerId} / ${order.sku}`,
  ).toBe(ordersFor(before, order).length + 1);
  // Side-effect invariant: only new entries under `orders` may have appeared.
  expect(unexpectedChanges(before, after, S11_ALLOWED_PATHS), label).toEqual([]);
}

/** The deny oracle: no order at all, and in particular none for this case's pair. */
function expectNoOrder(before: StateView, after: StateView, order: OrderSpec, label: string): void {
  expect(orderCount(after), `${label}: no order was placed`).toBe(orderCount(before));
  expect(
    ordersFor(after, order),
    `${label}: no order for ${order.customerId} / ${order.sku}`,
  ).toEqual(ordersFor(before, order));
  // Nothing at all changed: even `orders.+` is not allowed for a denied task.
  expect(unexpectedChanges(before, after, []), label).toEqual([]);
}

function approvalEvents(events: readonly RunEvent[]): RunEvent[] {
  return events.filter((e) => e.kind === "approval");
}

/**
 * A case may not leave its own request behind. Scoped to the case's run: the park case's run is
 * expected to still hold a pending approval while a later case runs, so a global check would
 * fail on the previous case's state rather than this one's.
 */
async function expectNothingPending(stack: Stack, label: string, runId: string): Promise<void> {
  const left = (await pendingApprovals(stack)).filter((a) => a.runId === runId);
  expect(
    left.map((a) => `${a.id} (run ${a.runId})`),
    `${label}: no approval left pending`,
  ).toEqual([]);
}

describe.skipIf(skip)(
  `M1 approvals (T3): deskbench S11 allowed, denied, parked and always${skipReason(missing, dockerUp)}`,
  () => {
    let stack: Stack | undefined;
    let sse: SseCollector | undefined;

    beforeAll(async () => {
      stack = await startStack({
        ...modelEnv(),
        label: "approvals",
        shortWaitSeconds: SHORT_WAIT_SECONDS,
      });
      stack.config.browserSnapshotMode = snapshotMode;
      // Held open for the whole suite, and deliberately unfiltered: an open SSE subscription is
      // what makes the Gateway treat a human as online, and therefore what makes the hook wait
      // live instead of deferring at once. Presence counts connections, not threads, so this one
      // stream covers every case's thread and collects every case's status frames.
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
        expect(s01.answer, `reply had no answer line: ${s01.reply}`).toBeDefined();
        expect(s01.answer).toBe(s01.expected);
      },
      RUN_TIMEOUT_MS + 60_000,
    );

    it(
      "S11 allowed: the human allows the L2 click once and the order is placed",
      async () => {
        const s = stack as Stack;
        const before = await siteState(s);
        const started = Date.now();
        const secs = (): number => Math.round((Date.now() - started) / 1000);

        // Its own thread, so this is the bot's first sight of the task (see the header).
        const thread = await newThread(s, "S11 allow");
        const { run } = await postMessage(s, s11(ALLOW_ORDER), thread.id);
        const approval = await waitForPendingApproval(s, run.id, RUN_TIMEOUT_MS);
        expect(approval, "an approval was requested for the L2 click").toBeDefined();
        const pending = approval as Approval;
        console.log(
          `[S11 allow] approval ${pending.id} for ${pending.action.toolName} (+${secs()}s)`,
        );
        expect(pending.riskLevel).toBe("L2");
        expect(pending.runId).toBe(run.id);
        expect(pending.botId).toBe(s.bot.id);
        expect(pending.threadId).toBe(thread.id);
        expect(String(pending.action.toolName)).toMatch(/browser_/);

        // The request is a `system` thread message carrying the approval as an attachment
        // (ADR-0002 amendment 2, A1), which is what the web UI draws the card from.
        const posted = (await threadMessages(s, thread.id)).find(
          (m) =>
            m.authorKind === "system" &&
            m.attachments.some(
              (a) => a.mimeType === APPROVAL_ATTACHMENT_MIME && a.ref === pending.id,
            ),
        );
        expect(posted, "a system message carries the approval attachment").toBeDefined();
        expect(posted?.attachments.find((a) => a.ref === pending.id)?.name).toBe("approval");
        if (pending.messageId !== undefined) expect(posted?.id).toBe(pending.messageId);

        const { approval: decided } = await decideApproval(s, pending.id, "allow_once");
        expect(decided.decision).toBe("allow_once");
        // The operator API decides as the human at the web UI (ADR-0002 amendment 2, A2).
        expect(decided.decidedBy).toBe(decidedByHuman("web"));
        expect(decided.decidedAt).toBeDefined();

        const final = await waitForRunEnd(s, run.id, RUN_TIMEOUT_MS, {
          onStatus: (st) => console.log(`[S11 allow] run ${run.id} ${st} (+${secs()}s)`),
        });
        const reply = replyOf(await threadMessages(s, thread.id), run.id);
        console.log(`[S11 allow] ${final.status} in ${secs()}s; reply: ${reply}`);
        expect(["succeeded", "silent"], final.error).toContain(final.status);
        console.log(`[S11 allow] statuses: ${describeStatuses(sse?.statuses ?? [], run.id)}`);

        const after = await siteState(s);
        expectOrderPlaced(before, after, ALLOW_ORDER, "S11 allow");

        // The ledger tells the same story: posted, then decided, in that order.
        const phases = approvalPhases(await runEvents(s, run.id));
        expect(phases, `approval phases: ${phases.join(", ")}`).toContain("posted");
        expect(phases).toContain("decided");
        expect(phases.indexOf("posted")).toBeLessThan(phases.lastIndexOf("decided"));

        await expectNothingPending(s, "S11 allow", run.id);
      },
      2 * RUN_TIMEOUT_MS,
    );

    it(
      "S11 denied: the human denies with a reason, the bot reports it and nothing changes",
      async () => {
        const s = stack as Stack;
        const before = await siteState(s);
        const started = Date.now();
        const secs = (): number => Math.round((Date.now() - started) / 1000);

        const thread = await newThread(s, "S11 deny");
        const { run } = await postMessage(s, s11(DENY_ORDER), thread.id);
        const approval = await waitForPendingApproval(s, run.id, RUN_TIMEOUT_MS);
        expect(approval, "an approval was requested for the L2 click").toBeDefined();
        const pending = approval as Approval;
        expect(pending.runId).toBe(run.id);
        console.log(`[S11 deny] approval ${pending.id} (+${secs()}s)`);

        const reason = "not this customer, the account is on hold";
        const { approval: decided } = await decideApproval(s, pending.id, "deny", reason);
        expect(decided.decision).toBe("deny");
        expect(decided.reason).toBe(reason);
        expect(decided.decidedBy).toBe(decidedByHuman("web"));

        const final = await waitForRunEnd(s, run.id, RUN_TIMEOUT_MS, {
          onStatus: (st) => console.log(`[S11 deny] run ${run.id} ${st} (+${secs()}s)`),
        });
        const reply = replyOf(await threadMessages(s, thread.id), run.id);
        console.log(`[S11 deny] ${final.status} in ${secs()}s; reply: ${reply}`);
        // The bot reports the denial rather than crashing, and rather than working around it
        // (`defaultSoul` in support/start-stack.ts spells both rules out).
        expect(["succeeded", "silent"], final.error).toContain(final.status);

        const after = await siteState(s);
        expectNoOrder(before, after, DENY_ORDER, "S11 deny");

        const phases = approvalPhases(await runEvents(s, run.id));
        expect(phases).toContain("posted");
        expect(phases).toContain("decided");

        await expectNothingPending(s, "S11 deny", run.id);
      },
      2 * RUN_TIMEOUT_MS,
    );

    it(
      "S11 parked: nobody answers in the short wait, the run parks, a later decision resumes it",
      async () => {
        const s = stack as Stack;
        const before = await siteState(s);
        const started = Date.now();
        const secs = (): number => Math.round((Date.now() - started) / 1000);

        const thread = await newThread(s, "S11 park");
        const { run } = await postMessage(s, s11(PARK_ORDER), thread.id);
        // No decision for now: after `shortWaitSeconds` the hook defers and the run is parked,
        // which is where `waitForRun` stops. This is the one park the suite waits for.
        const parked = await waitForRun(s, run.id, RUN_TIMEOUT_MS, {
          onStatus: (st) => console.log(`[S11 park] run ${run.id} ${st} (+${secs()}s)`),
        });
        expect(parked.status, parked.error).toBe("waiting_approval");
        // First sidecar process; the resume starts the second (ADR-0002 decision 2).
        expect(parked.attempt).toBe(1);

        const pending = (await pendingApprovals(s)).find((a) => a.runId === run.id);
        expect(pending, "the parked run has a pending approval").toBeDefined();
        const approval = pending as Approval;
        expect(approval.threadId).toBe(thread.id);
        expect(parked.resumePayload?.approvalId).toBe(approval.id);
        expect(parked.resumePayload?.sdkSessionId, "the session to resume").toBeTruthy();
        expect(approval.waitMode).toBe("deferred");
        // The status sequence proves the live wait happened before the park.
        const statuses = describeStatuses(sse?.statuses ?? [], run.id);
        console.log(`[S11 park] statuses: ${statuses}`);
        expect(statuses).toContain("waiting_approval_live");
        expect(statuses).toContain("waiting_approval");

        const { approval: decided } = await decideApproval(s, approval.id, "allow_once");
        expect(decided.decision).toBe("allow_once");
        // From here a second park is a failure, not something to wait out: the resumed process
        // must replay the deferred call, not ask again.
        const final = await waitForRunEnd(s, run.id, RUN_TIMEOUT_MS, {
          onStatus: (st) => console.log(`[S11 park] run ${run.id} ${st} (+${secs()}s)`),
        });
        const reply = replyOf(await threadMessages(s, thread.id), run.id);
        console.log(`[S11 park] ${final.status} in ${secs()}s; reply: ${reply}`);
        expect(["succeeded", "silent"], final.error).toContain(final.status);
        // Same run row, second sidecar process.
        expect(final.id).toBe(run.id);
        expect(final.attempt).toBe(2);

        // Resumed once and placed the order once: the deferred call is replayed, not repeated.
        const after = await siteState(s);
        expectOrderPlaced(before, after, PARK_ORDER, "S11 park");

        const events = await runEvents(s, run.id);
        const phases = approvalPhases(events);
        expect(phases, `approval phases: ${phases.join(", ")}`).toContain("resumed");
        expect(phases).toContain("decided");
        // Both sidecar processes wrote to one ledger, under one monotonic `seq`.
        const attempts = new Set(events.map((e) => e.attempt).filter((a) => a !== undefined));
        expect([...attempts].sort(), `ledger attempts: ${[...attempts]}`).toEqual([1, 2]);

        await expectNothingPending(s, "S11 park", run.id);
      },
      2 * RUN_TIMEOUT_MS,
    );

    it(
      "S11 always: an 'Always' decision stores a rule, and the next S11 needs no approval",
      async () => {
        const s = stack as Stack;
        const before = await siteState(s);
        const started = Date.now();
        const secs = (): number => Math.round((Date.now() - started) / 1000);

        expect(
          await approvalRules(s, s.bot.id),
          "no rule has been stored before this case",
        ).toEqual([]);

        // (a) the fourth S11, in its own thread: decided with "Always".
        const thread = await newThread(s, "S11 always");
        const { run } = await postMessage(s, s11(ALWAYS_ORDER), thread.id);
        const approval = await waitForPendingApproval(s, run.id, RUN_TIMEOUT_MS);
        expect(approval, "an approval was requested for the L2 click").toBeDefined();
        const pending = approval as Approval;
        // The rule is derived from *this* approval, so the case must not decide another run's.
        expect(pending.runId).toBe(run.id);
        expect(pending.threadId).toBe(thread.id);
        console.log(
          `[S11 always] approval ${pending.id} for ${pending.action.toolName} on ${pending.action.targetOrigin} (+${secs()}s)`,
        );

        const { approval: decided, rule } = await decideApproval(s, pending.id, "allow_always");
        expect(decided.decision).toBe("allow_always");
        expect(decided.decidedBy).toBe(decidedByHuman("web"));

        const final = await waitForRunEnd(s, run.id, RUN_TIMEOUT_MS, {
          onStatus: (st) => console.log(`[S11 always] run ${run.id} ${st} (+${secs()}s)`),
        });
        console.log(`[S11 always] ${final.status} in ${secs()}s`);
        expect(["succeeded", "silent"], final.error).toContain(final.status);
        const afterFirst = await siteState(s);
        expectOrderPlaced(before, afterFirst, ALWAYS_ORDER, "S11 always (decided)");
        await expectNothingPending(s, "S11 always (decided)", run.id);

        // (b) the rule the decision stored: this bot, this tool, this origin (amendment 2, A3).
        const rules = await approvalRules(s, s.bot.id);
        expect(rules, "one stored rule").toHaveLength(1);
        const stored = rules[0];
        expect(stored?.botId).toBe(s.bot.id);
        expect(stored?.decision).toBe("allow_always");
        expect(stored?.createdFromApprovalId).toBe(pending.id);
        expect(stored?.createdBy).toBe(decidedByHuman("web"));
        expect(String(stored?.matcher.toolName), "the rule names the click tool").toMatch(
          /browser_click/,
        );
        // The origin as the bot sees it: the site is `host.docker.internal:<port>` inside the
        // container, never the loopback URL the host uses.
        expect(
          stored?.matcher.targetOrigin,
          "the rule names the site origin the bot navigated to",
        ).toBe(s.siteOriginForBot);
        // `matcherFromAction` copies the sidecar's stable pattern, `*submit*` for the checkout
        // click (`packages/sidecar/src/tool-action.ts`). The tool and the origin are what the
        // case asserts, because they are what keep the rule from being too wide; the pattern
        // depends on the wording the console gives the button, so a difference is logged rather
        // than failed — (c) below is the real test of whether the rule still matches.
        if (stored?.matcher.argumentPattern !== "*submit*") {
          console.warn(
            `[S11 always] rule argumentPattern is ${String(stored?.matcher.argumentPattern)}, expected *submit* (summary: ${String(pending.action.argumentSummary)})`,
          );
        }
        if (rule !== undefined) expect(rule.id).toBe(stored?.id);

        // (c) the fifth S11, in a new thread and for a different customer: the rule answers it,
        // so no human is ever asked. A fresh thread matters twice over — the model has no earlier
        // turn to refuse from, and the rule is the only reason this run goes through.
        const secondStarted = Date.now();
        const secondSecs = (): number => Math.round((Date.now() - secondStarted) / 1000);
        const secondThread = await newThread(s, "S11 by rule");
        const { run: second } = await postMessage(s, s11(BY_RULE_ORDER), secondThread.id);
        const nothingPending = await waitForPendingApproval(s, second.id, RUN_TIMEOUT_MS);
        expect(
          nothingPending,
          `the rule should have answered without an approval (${nothingPending?.id})`,
        ).toBeUndefined();
        const secondFinal = await waitForRunEnd(s, second.id, RUN_TIMEOUT_MS, {
          onStatus: (st) => console.log(`[S11 rule] run ${second.id} ${st} (+${secondSecs()}s)`),
        });
        console.log(
          `[S11 rule] ${secondFinal.status} in ${secondSecs()}s; reply: ${replyOf(
            await threadMessages(s, secondThread.id),
            second.id,
          )}`,
        );
        expect(["succeeded", "silent"], secondFinal.error).toContain(secondFinal.status);
        // The run never parked: the rule decided inside the hook.
        const secondStatuses = describeStatuses(sse?.statuses ?? [], second.id);
        console.log(`[S11 rule] statuses: ${secondStatuses}`);
        expect(secondStatuses).not.toContain("waiting_approval");

        const afterSecond = await siteState(s);
        expectOrderPlaced(afterFirst, afterSecond, BY_RULE_ORDER, "S11 always (by rule)");

        const secondEvents = await runEvents(s, second.id);
        const phases = approvalPhases(secondEvents);
        expect(phases, `approval phases: ${phases.join(", ")}`).toContain("rule_matched");
        const matched = approvalEvents(secondEvents).find(
          (e) => e.payload.phase === "rule_matched",
        );
        expect(matched, "a rule_matched event in the ledger").toBeDefined();
        // The event names the rule when the Gateway records one; the phase alone is the contract.
        if (matched?.payload.ruleId !== undefined) {
          expect(String(matched.payload.ruleId)).toBe(String(stored?.id));
        }

        await expectNothingPending(s, "S11 always (by rule)", second.id);
      },
      4 * RUN_TIMEOUT_MS,
    );
  },
);

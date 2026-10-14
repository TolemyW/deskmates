// Delegation outcome notices (ADR-0016 amendment 1). A run woken by another bot's message is a
// delegation; when it ends, the bot that delegated learns how, in the thread it delegated from.
// A delegate that hands part of the work on keeps working on it when it is told how that part
// ended, and the outcome announced is the one that leaves nothing more to come (`workOf`).
// This module is the one place that decides whether a run was a delegation and what to post;
// `RunLifecycle.ended`, `RunLifecycle.fail` and the continuation `stop` path call it.
//
// The notice is a `system` message, so it counts against neither cap (ADR-0005 item 6), and it
// wakes the delegator only, as a continuation request does (decision 3). It never carries page
// text: the delegate's error is the sidecar's own, bounded, and a quoted reply (cross-thread only)
// goes inside the bot wrapper the sidecar would have put around the same text.

import {
  type Attachment,
  type BotId,
  type MessageId,
  type RunStatus,
  THREAD_LINK_ATTACHMENT_MIME,
  type ThreadId,
  type ThreadMessage,
  isTerminal,
  wrapUntrusted,
} from "@deskmates/contracts";
import type { BotStore } from "../bots/bots.js";
import type { GatewayEvent } from "../events/bus.js";
import type { EventStore } from "../ledger/events.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";
import type { MessageStore } from "./messages.js";
import type { ThreadRouter } from "./router.js";
import type { ThreadStore } from "./threads.js";

export interface DelegationOutcomeDeps {
  runs: RunStore;
  messages: MessageStore;
  threads: ThreadStore;
  bots: BotStore;
  router: ThreadRouter;
  events: EventStore;
}

/** Outcomes that get a notice (decision 8). `turns_exhausted` has decision 3's request instead. */
export const ANNOUNCED_OUTCOMES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "succeeded",
  "silent",
  "failed",
  "stopped",
]);

/** Longest run error quoted in a notice; the rest is in the run row. */
export const OUTCOME_ERROR_MAX_CHARS = 300;
/** Longest reply quoted in a cross-thread notice; the full text is in the bus thread. */
export const OUTCOME_REPLY_MAX_CHARS = 4000;

export interface Delegation {
  /** The bot-authored message whose delivery started the run. */
  source: ThreadMessage;
  delegatorBotId: BotId;
  /** The thread the delegating run sat in; differs from `source.threadId` for `message_bot`. */
  originThreadId: ThreadId;
}

/** How far up a wake chain the direction check looks; a chain is capped at relay depth 5 anyway. */
const WAKE_CHAIN_MAX_HOPS = 32;

/** Every notice starts with this; `wakeChain` and `workOf` recognise one by it and its `run_id`. */
export const OUTCOME_NOTICE_PREFIX = "Delegation outcome:";

function isOutcomeNotice(message: ThreadMessage): boolean {
  return (
    message.authorKind === "system" &&
    message.runId !== undefined &&
    message.body.startsWith(OUTCOME_NOTICE_PREFIX)
  );
}

/**
 * The bots of the wake chain that led to `run`, root first and `run`'s own bot last: each run was
 * woken by a message, that message was posted by a run, and so on up to a human message or a
 * cron/webhook trigger. `runs.trigger_ref` and `thread_messages.run_id` are the only links
 * followed (ADR-0005 item 10). An outcome notice is followed through the run it is about: the
 * delegate that run reported to is still where it was in the chain, and cutting the chain there
 * would make its next report look like a delegation to its own delegator.
 */
export function wakeChain(
  deps: Pick<DelegationOutcomeDeps, "runs" | "messages">,
  run: RunRecord,
): BotId[] {
  const chain: BotId[] = [run.botId];
  let current: RunRecord | undefined = run;
  for (let hop = 0; current && hop < WAKE_CHAIN_MAX_HOPS; hop += 1) {
    if (current.triggerKind !== "thread_message") break;
    const message = deps.messages.get(current.triggerRef as MessageId);
    if (!message) break;
    if (isOutcomeNotice(message)) {
      // The notice names the run it is about; that run's own wake leads back to the delegate.
      current = deps.runs.get(message.runId as RunRecord["id"]);
      continue;
    }
    if (message.authorKind !== "bot") break;
    // The same bot twice in a row is one hop seen from both sides of a notice.
    if (chain[0] !== message.authorId) chain.unshift(message.authorId as BotId);
    current = message.runId === undefined ? undefined : deps.runs.get(message.runId);
  }
  return chain;
}

/**
 * Whether `message` delegates work to `botId` (decision 7). It must mention the bot explicitly
 * (`message_bot` always does): a bot woken by the in-turn walk of an unaddressed or @everyone
 * message was offered the message, not given a task, and "may stay silent" (ADR-0005 item 4);
 * announcing that silence would wake the author once per member. And it must flow down the
 * chain: a message to a bot that is upstream of its author is a *report*, which is what a
 * delegate's "done @chief" is. Without this the chief's silent read of a reply would itself be
 * announced back to the expert, one wasted run per delegation.
 */
function delegates(
  deps: Pick<DelegationOutcomeDeps, "runs" | "messages">,
  message: ThreadMessage,
  botId: BotId,
): Delegation | undefined {
  if (message.authorKind !== "bot" || message.authorId === botId) return undefined;
  if (!message.mentions.some((m) => m.kind === "bot" && m.botId === botId)) return undefined;
  const postingRun = message.runId === undefined ? undefined : deps.runs.get(message.runId);
  const upstream = postingRun ? wakeChain(deps, postingRun) : [message.authorId as BotId];
  // First appearance decides who is upstream: the bot the human (or the trigger) woke is the
  // root, and a bot first woken by another bot sits below it, however often they alternate.
  const bot = upstream.indexOf(botId);
  if (bot !== -1 && bot < upstream.indexOf(message.authorId as BotId)) return undefined;
  return {
    source: message,
    delegatorBotId: message.authorId as BotId,
    originThreadId: postingRun?.threadId ?? message.threadId,
  };
}

/**
 * Every delegation a run was given: the messages it was delivered that delegate to its bot. That
 * is usually the one that woke it, but wakes coalesce (ADR-0005 item 8): a delegation posted
 * while the bot already had a run queued in the thread is delivered by that run, whose
 * `trigger_ref` names something else. The delivered slice is `(deliveredFromSeq, deliveredSeq]`,
 * both stamped on the run at start; a run row from before the first was stamped has only its
 * trigger to go on.
 */
export function delegationsOf(
  deps: Pick<DelegationOutcomeDeps, "runs" | "messages">,
  run: RunRecord,
): Delegation[] {
  if (run.triggerKind !== "thread_message" || !run.threadId) return [];
  const from = run.config.deliveredFromSeq;
  const to = run.deliveredSeq;
  const delivered =
    typeof from === "number" && typeof to === "number"
      ? deps.messages.list(run.threadId, from).filter((m) => m.seq <= to)
      : [deps.messages.get(run.triggerRef as MessageId)].filter(
          (m): m is ThreadMessage => m !== undefined,
        );
  return delivered.flatMap((message) => {
    const delegation = delegates(deps, message, run.botId);
    return delegation ? [delegation] : [];
  });
}

/** Decision 7 as first written: the delegation that woke the run, if that is what woke it. */
export function delegationOf(
  deps: Pick<DelegationOutcomeDeps, "runs" | "messages">,
  run: RunRecord,
): Delegation | undefined {
  if (run.triggerKind !== "thread_message" || !run.threadId) return undefined;
  const source = deps.messages.get(run.triggerRef as MessageId);
  return source ? delegates(deps, source, run.botId) : undefined;
}

/**
 * The delegation a run is working on. That is its own (decision 7), or, for a run woken by word
 * of a delegation its bot made, the delegation the run that made it was working on: a delegate
 * that hands part of its work on and hears how that part went is still doing the work it was
 * given. Word comes two ways, and whichever is queued first wakes the delegate: the Gateway's
 * outcome notice, which names the run it is about in `run_id`, and the teammate's own report,
 * a message that mentions the delegate. From either the links are `trigger_ref` and
 * `thread_messages.run_id` only, as everywhere else in this module. The continuation counts
 * only in the thread the work was delegated in.
 */
export function worksOf(
  deps: Pick<DelegationOutcomeDeps, "runs" | "messages">,
  run: RunRecord,
  depth = 0,
): Delegation[] {
  const own = delegationsOf(deps, run);
  if (own.length > 0) return own;
  if (depth >= WAKE_CHAIN_MAX_HOPS || run.triggerKind !== "thread_message") return [];
  const word = deps.messages.get(run.triggerRef as MessageId);
  if (!word || word.runId === undefined) return [];
  const isReport =
    word.authorKind === "bot" &&
    word.mentions.some((m) => m.kind === "bot" && m.botId === run.botId);
  if (!isOutcomeNotice(word) && !isReport) return [];
  // The run the word is about: the one a notice names, or the one that posted the report.
  const about = deps.runs.get(word.runId);
  const announced = about
    ? worksOf(deps, about, depth + 1).find((w) => w.delegatorBotId === run.botId)
    : undefined;
  if (!announced) return [];
  const parent =
    announced.source.runId === undefined ? undefined : deps.runs.get(announced.source.runId);
  return parent
    ? worksOf(deps, parent, depth + 1).filter((w) => w.source.threadId === run.threadId)
    : [];
}

/** The first delegation a run works on; the tests read it, the notices use `worksOf`. */
export function workOf(
  deps: Pick<DelegationOutcomeDeps, "runs" | "messages">,
  run: RunRecord,
): Delegation | undefined {
  return worksOf(deps, run)[0];
}

/** Every run of the delegate that works on `work`, the one that just ended included. */
function workRuns(deps: DelegationOutcomeDeps, run: RunRecord, work: Delegation): RunRecord[] {
  return deps.runs
    .list({ threadId: work.source.threadId, botId: run.botId })
    .filter((r) => r.id === run.id || worksOf(deps, r).some((w) => w.source.id === work.source.id));
}

/** Whether an outcome of `work` has been announced from one of these runs already. */
function alreadyAnnounced(
  deps: DelegationOutcomeDeps,
  mine: readonly RunRecord[],
  work: Delegation,
): boolean {
  return mine.some((r) =>
    deps.events
      .list(r.id)
      .some(
        (e) =>
          e.kind === "log" &&
          e.payload.source === "delegation_outcome" &&
          e.payload.delegationMessageId === work.source.id,
      ),
  );
}

/**
 * Whether more is still to come on `work` from this delegate after `run` ended without an
 * answer: another of its runs on the same work is queued, running or parked, or a teammate it
 * handed part of the work to has not finished. Either will bring the delegate back, and its
 * outcome is announced then.
 */
function workStillOpen(
  deps: DelegationOutcomeDeps,
  run: RunRecord,
  work: Delegation,
  mine: readonly RunRecord[],
): boolean {
  if (mine.some((r) => r.id !== run.id && !isTerminal(r.status))) return true;
  for (const mineRun of mine) {
    for (const message of deps.messages.postedByRun(mineRun.id)) {
      if (message.authorKind !== "bot") continue;
      for (const mention of message.mentions) {
        if (mention.kind !== "bot" || mention.botId === work.delegatorBotId) continue;
        const handed = deps.runs.findByTriggerRef(mention.botId, message.id);
        if (handed && !isTerminal(handed.status)) return true;
        // No run of its own: the mention coalesced into a run the teammate already had queued
        // (ADR-0005 item 8). That run delivers the hand-on, and is open until it ends.
        if (
          deps.runs
            .list({ threadId: message.threadId, botId: mention.botId })
            .some(
              (r) =>
                !isTerminal(r.status) &&
                (r.status === "queued" ||
                  (typeof r.deliveredSeq === "number" && r.deliveredSeq >= message.seq)),
            )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface NoticeFacts {
  delegate: string;
  status: RunStatus;
  /** How the delegating message is named in the thread the notice goes to. */
  delegated: string;
  /** The run's last message in the delegation's thread was an answer, not a further hand-on. */
  answered: boolean;
  /** Seq of that answer where the reader can see it; undefined in another thread. */
  replySeq: number | undefined;
  /** The run's last message handed the work to another member instead of answering. */
  handedOn: boolean;
  /** Seq of that message where the reader can see it; undefined in another thread. */
  handedOnSeq: number | undefined;
  error: string | undefined;
  handoffPath: string | undefined;
}

function renderNotice(facts: NoticeFacts): string {
  const head = `${OUTCOME_NOTICE_PREFIX} ${facts.delegate}`;
  const where =
    facts.replySeq === undefined
      ? " Its reply is in this thread."
      : ` Its reply is message #${facts.replySeq}.`;
  switch (facts.status) {
    case "succeeded":
    case "silent":
      if (facts.answered) {
        // `silent` is an empty final reply. A delegate that answered through `thread_post` and
        // then ended with nothing to add did reply; telling the delegator otherwise sends it
        // looking for a failure that did not happen (seen on a real model, 2026-09-30).
        return facts.status === "succeeded"
          ? `${head} finished the work ${facts.delegated} (succeeded).${where}`
          : `${head} finished the work ${facts.delegated}.${where}`;
      }
      if (!facts.handedOn) {
        return `${head} ended the work ${facts.delegated} without posting a reply (silent).`;
      }
      return `${head} ended the work ${facts.delegated} after handing it on${
        facts.handedOnSeq === undefined ? "" : ` in message #${facts.handedOnSeq}`
      }; no reply was posted.`;
    case "failed":
      // A failure can leave partial work behind; the delegator should know where to pick it up.
      return `${head} failed the work ${facts.delegated}: ${facts.error ?? "no error recorded"}.${
        facts.handoffPath ? ` Handoff: ${facts.handoffPath}.` : ""
      } No reply was posted.`;
    case "stopped":
      return `${head} was stopped after exhausting its turn budget on the work ${facts.delegated}. Handoff: ${facts.handoffPath ?? "unavailable"}.`;
    default:
      return `${head} ended the work ${facts.delegated} (${facts.status}).`;
  }
}

/**
 * Post the notice(s) for a run that just reached an announced terminal state, one set per
 * delegation the run was working on (a run delivered two delegations at once works on both).
 * Returns the messages posted; `published` receives the SSE frames for the caller to flush after
 * its commit. Not working on a delegation, not an announced outcome, or no answer yet while more
 * is still to come from this delegate: nothing is posted and nothing is returned.
 */
export function announceDelegationOutcome(
  deps: DelegationOutcomeDeps,
  run: RunRecord,
  published: GatewayEvent[],
): ThreadMessage[] {
  if (!ANNOUNCED_OUTCOMES.has(run.status)) return [];
  return worksOf(deps, run).flatMap((work) => announceWork(deps, run, work, published));
}

function announceWork(
  deps: DelegationOutcomeDeps,
  run: RunRecord,
  work: Delegation,
  published: GatewayEvent[],
): ThreadMessage[] {
  const { source, delegatorBotId, originThreadId } = work;
  const delegate = deps.bots.mustGet(run.botId).name;
  const ended = run.status === "succeeded" || run.status === "silent";
  const mine = workRuns(deps, run, work);
  // What the delegate has said on this work, in the delegation's thread, in any of its runs:
  // the last of it is where the work stands.
  const mineIds = new Set(mine.map((r) => r.id));
  const said = ended
    ? deps.messages
        .list(source.threadId, source.seq)
        .filter(
          (m) =>
            m.authorKind === "bot" &&
            m.authorId === run.botId &&
            m.runId !== undefined &&
            mineIds.has(m.runId),
        )
    : [];
  const last = said.at(-1);
  // A message that mentions a bot other than the delegator gives the work to someone else. It
  // is not the delegate's answer, whatever the run's status says.
  const handedOn =
    last?.mentions.some((m) => m.kind === "bot" && m.botId !== delegatorBotId) === true;
  const reply = handedOn ? undefined : last;

  const defer = (reason: "work_open" | "nothing_new"): ThreadMessage[] => {
    deps.events.append({
      runId: run.id,
      kind: "log",
      payload: {
        source: "delegation_outcome_deferred",
        reason,
        delegatorBotId,
        delegationMessageId: source.id,
      },
    });
    return [];
  };
  // Decision 8 announces an outcome, and this work has none yet: the delegate will be woken
  // again by what it is waiting for, and that run's end is announced instead.
  if (ended && reply === undefined && workStillOpen(deps, run, work, mine)) {
    return defer("work_open");
  }
  // A later run that added nothing, on work whose outcome the delegator already has.
  if (ended && !said.some((m) => m.runId === run.id) && alreadyAnnounced(deps, mine, work)) {
    return defer("nothing_new");
  }

  const common = {
    delegate,
    status: run.status,
    answered: reply !== undefined,
    handedOn,
    handedOnSeq: handedOn ? last?.seq : undefined,
    error: run.error === undefined ? undefined : bounded(run.error, OUTCOME_ERROR_MAX_CHARS),
    handoffPath: typeof run.config.handoffPath === "string" ? run.config.handoffPath : undefined,
  };

  // Decision 11: a chain that reached the relay cap stops there. The delegate was woken by a
  // message at the cap, so anything it sends back is past it; a notice that woke the delegator
  // would be the hop the cap exists to refuse (ADR-0005 item 6).
  const chainCapped = source.relayCount >= deps.router.effectiveCaps(source.threadId).relayCountMax;
  const posted: ThreadMessage[] = [];
  const post = (
    threadId: ThreadId,
    body: string,
    attachments: readonly Attachment[],
    wake: boolean,
  ): void => {
    const thread = deps.threads.mustGet(threadId);
    if (thread.status === "paused" || chainCapped || !wake) {
      // Decision 11: the pause (or the cap) is the human's; the notice waits there for them.
      // A notice that is not to wake anyone is appended the same way.
      const message = deps.messages.append({
        threadId,
        authorKind: "system",
        authorId: "",
        body,
        attachments,
        relayCount: 0,
        runId: run.id,
      });
      published.push({ type: "thread_message", threadId, message });
      posted.push(message);
      return;
    }
    const result = deps.router.postSystem(threadId, body, attachments, {
      wakeOnly: delegatorBotId,
      runId: run.id,
    });
    published.push({ type: "thread_message", threadId, message: result.message });
    for (const wake of result.runs) published.push({ type: "run_status", threadId, run: wake });
    posted.push(result.message);
  };

  // A delegate that reported by mentioning its delegator woke it with that message, and the run
  // it woke may already be under way: a second wake from the notice would be a run with nothing
  // new to read (one extra run per hop in the T2 relay loop). The notice is still posted.
  const reported = reply?.mentions.some((m) => m.kind === "bot" && m.botId === delegatorBotId);
  post(
    source.threadId,
    renderNotice({
      ...common,
      delegated: `delegated in message #${source.seq}`,
      replySeq: reply?.seq,
    }),
    [],
    reported !== true,
  );

  if (originThreadId !== source.threadId) {
    // Decision 9: the delegator's task lives in another thread, whose session cannot see the bus.
    const where = `handed off with message_bot (message #${source.seq} in conversation ${source.threadId})`;
    const body = renderNotice({
      ...common,
      delegated: where,
      replySeq: undefined,
      // The seq is of the bus thread; in this one the hand-on is only said to have happened.
      handedOnSeq: undefined,
    });
    const quoted =
      reply === undefined
        ? body
        : `${body}\nReply:\n${wrapUntrusted(
            `bot:${delegate}`,
            bounded(reply.body, OUTCOME_REPLY_MAX_CHARS),
          )}`;
    // The mention, if any, woke the delegator in the bus thread; this thread has heard nothing.
    post(
      originThreadId,
      quoted,
      [{ name: "Open conversation", mimeType: THREAD_LINK_ATTACHMENT_MIME, ref: source.threadId }],
      true,
    );
  }

  // Decision 10: the ledger names the notice, so the metrics need nothing but the rows.
  deps.events.append({
    runId: run.id,
    kind: "log",
    payload: {
      source: "delegation_outcome",
      outcome: run.status,
      replied: reply !== undefined,
      delegatorBotId,
      delegationMessageId: source.id,
      messageIds: posted.map((m) => m.id),
    },
  });
  return posted;
}

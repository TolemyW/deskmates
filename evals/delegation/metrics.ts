// Delegation chain metrics, computed from ledger rows alone (ADR-0016 amendment 1, decision 10).
//
// A delegation is a bot-authored thread message that explicitly mentions, and so woke, a bot
// further down the wake chain
// (ADR-0016 amendment 1, decision 7): `runs.trigger_ref` names the message, the message's author
// is the delegator. A message that wakes a bot further *up* the chain is a report (the delegate's
// "done @chief") and starts no chain here. The chain is the delegating message, the delegate run
// it started, whatever reached the delegator's thread when the run ended (the delegate's reply,
// the Gateway's outcome notice) and the delegator run that delivered it. Nothing here needs a
// model, a task oracle or a live Gateway: the rows are enough, which is what lets the same
// numbers be computed before and after a change on the same ledger.
//
// Definitions (the results note quotes these):
//
// - terminal: the delegate run is `succeeded`, `silent`, `failed`, `cancelled` or `stopped`.
// - origin thread: the thread the delegating run sat in. It is the delegation's own thread for a
//   mention, and the chat thread for a `message_bot` handoff made from one.
// - outcome message: the Gateway's `delegation_outcome` notice in the origin thread when one was
//   posted, else the delegate's own reply when it was posted in the origin thread. A terminal run
//   with neither is a *missed reply*: the delegator's thread never learned how the work ended.
// - delegator woken: a run of the delegator in the origin thread whose delivered slice includes
//   the outcome message (`delivered_seq >= outcome seq`). With no outcome message, any delegator
//   run in the origin thread created after the delegate finished counts.
// - stuck: the delegate run is terminal, the delegator was not woken, and no delegator run is
//   queued in that thread. A queued run is "pending", not stuck.
// - duplicate executions: delegate runs of the same bot for the same delegating message beyond
//   the first. Coalescing (ADR-0005 item 8) should keep this at zero. A delegation that
//   coalesced into a run the bot already had queued has that run as its delegate run.
// - chain completed: the delegate succeeded (or ended `silent` after posting its answer through
//   `thread_post`), its reply reached the thread, and the delegator was woken. A delegate that
//   handed the work on and answered in a later run counts too: the notice for that run names
//   the same delegating message and says it replied. This is a ledger proxy for task completion, not the task oracle: whether the work was
//   right is the acceptance test's question (X01's `CHIEF_TOTAL`), not this script's.

export type LedgerRunStatus =
  | "queued"
  | "running"
  | "waiting_approval_live"
  | "waiting_approval"
  | "waiting_browser"
  | "waiting_continuation"
  | "succeeded"
  | "silent"
  | "failed"
  | "cancelled"
  | "stopped";

export interface LedgerRun {
  id: string;
  botId: string;
  threadId: string | null;
  triggerKind: string;
  triggerRef: string;
  status: LedgerRunStatus;
  deliveredSeq: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LedgerMessage {
  id: string;
  threadId: string;
  seq: number;
  authorKind: "human" | "bot" | "system";
  authorId: string;
  /** Bot ids the message mentions explicitly; `@everyone` and no mention are both empty. */
  mentions: readonly string[];
  /** The message carries `@everyone`. Absent in ledgers loaded before the offer metrics. */
  everyone?: boolean;
  /** A Gateway delegation outcome notice (`system`, names its run in `runId`). */
  notice?: boolean;
  runId: string | null;
  ts: string;
}

export interface LedgerEvent {
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
  ts: string;
}

export interface LedgerUsage {
  runId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface LedgerBot {
  id: string;
  name: string;
}

/** A thread with its kind and current member count, for the offer metrics (`offers.ts`). */
export interface LedgerThread {
  id: string;
  kind: "chat" | "bus";
  members: number;
}

export interface Ledger {
  /** Optional: only the offer metrics read it. */
  threads?: readonly LedgerThread[];
  runs: readonly LedgerRun[];
  messages: readonly LedgerMessage[];
  events: readonly LedgerEvent[];
  usage: readonly LedgerUsage[];
  bots: readonly LedgerBot[];
}

export const TERMINAL: ReadonlySet<LedgerRunStatus> = new Set<LedgerRunStatus>([
  "succeeded",
  "silent",
  "failed",
  "cancelled",
  "stopped",
]);

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** Runs with no usage row: their tokens are unknown, and the totals above exclude them. */
  unknownRuns: number;
}

export interface DelegationChain {
  delegationMessageId: string;
  delegationThreadId: string;
  delegationSeq: number;
  delegatedAt: string;
  /** The thread the delegating run sat in: the chat thread for a `message_bot` handoff. */
  originThreadId: string;
  delegatorBotId: string;
  delegatorName: string;
  delegateBotId: string;
  delegateName: string;
  delegateRunId: string;
  delegateStatus: LedgerRunStatus;
  terminal: boolean;
  finishedAt: string | null;
  /** The delegate's own reply message in the delegation thread, when it posted one. */
  replyMessageId: string | null;
  /** Gateway outcome notices for this run (ADR-0016 amendment 1, decision 10). */
  noticeMessageIds: readonly string[];
  noticeAt: string | null;
  /** The thread and seq of what the delegator's next wake had to deliver. */
  outcome: { threadId: string; seq: number; messageId: string } | null;
  missedReply: boolean;
  delegatorRunId: string | null;
  delegatorWokenAt: string | null;
  pending: boolean;
  stuck: boolean;
  duplicateRuns: number;
  chainCompleted: boolean;
  wallToTerminalMs: number | null;
  wallToNoticeMs: number | null;
  delegateTokens: TokenTotals;
  delegatorFollowUpTokens: TokenTotals;
}

export interface DelegationSummary {
  chains: number;
  terminal: number;
  chainsCompleted: number;
  missedReplies: number;
  stuck: number;
  pending: number;
  duplicateRuns: number;
  byStatus: Record<string, number>;
  wallToTerminalMs: Quantiles;
  wallToNoticeMs: Quantiles;
  tokens: TokenTotals & { chainsWithUnknownUsage: number };
}

export interface Quantiles {
  n: number;
  median: number | null;
  p90: number | null;
  max: number | null;
}

function ms(iso: string): number {
  return Date.parse(iso);
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, unknownRuns: 0 };
}

function addTotals(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreate += from.cacheCreate;
  into.unknownRuns += from.unknownRuns;
}

function tokensOf(usage: readonly LedgerUsage[], runId: string | null): TokenTotals {
  const totals = emptyTotals();
  if (runId === null) return totals;
  const rows = usage.filter((u) => u.runId === runId);
  if (rows.length === 0) {
    totals.unknownRuns = 1;
    return totals;
  }
  for (const row of rows) {
    totals.input += row.inputTokens;
    totals.output += row.outputTokens;
    totals.cacheRead += row.cacheReadTokens;
    totals.cacheCreate += row.cacheCreateTokens;
  }
  return totals;
}

export function quantiles(values: readonly number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number | null => {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx] ?? null;
  };
  return { n: sorted.length, median: at(0.5), p90: at(0.9), max: at(1) };
}

/** Every delegation chain in the ledger, oldest delegating message first. */
export function collectChains(ledger: Ledger): DelegationChain[] {
  const botName = new Map(ledger.bots.map((b) => [b.id, b.name]));
  const runById = new Map(ledger.runs.map((r) => [r.id, r]));
  const messageById = new Map(ledger.messages.map((m) => [m.id, m]));
  const runsByTrigger = new Map<string, LedgerRun[]>();
  for (const run of ledger.runs) {
    if (run.triggerKind !== "thread_message") continue;
    const list = runsByTrigger.get(run.triggerRef) ?? [];
    list.push(run);
    runsByTrigger.set(run.triggerRef, list);
  }
  // A notice belongs to the delegation it names. That is usually the delegate's own run, but a
  // delegate that handed the work on is announced when a later run of it ends (ADR-0016
  // amendment 1, decision 8 as clarified), so the delegating message is the key. Events written
  // before the field existed fall back to the run they were logged on.
  const noticesByRun = new Map<string, LedgerEvent[]>();
  const noticesByDelegation = new Map<string, LedgerEvent[]>();
  for (const event of ledger.events) {
    if (event.kind !== "log" || event.payload.source !== "delegation_outcome") continue;
    const key = event.payload.delegationMessageId;
    const index = typeof key === "string" ? noticesByDelegation : noticesByRun;
    const at = typeof key === "string" ? key : event.runId;
    const list = index.get(at) ?? [];
    list.push(event);
    index.set(at, list);
  }

  const chains: DelegationChain[] = [];
  const delegations = [...ledger.messages]
    .filter((m) => m.authorKind === "bot")
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
  // The bots of the wake chain that led to a run, root first: the same walk the Gateway does
  // (`wakeChain` in packages/gateway/src/threads/delegation-outcomes.ts), copied rather than
  // imported so the measurement is a second opinion on the rule, not an echo of it.
  const wakeChain = (run: LedgerRun): string[] => {
    const chain = [run.botId];
    let current: LedgerRun | undefined = run;
    for (let hop = 0; current && hop < 32; hop += 1) {
      if (current.triggerKind !== "thread_message") break;
      const source = messageById.get(current.triggerRef);
      if (!source) break;
      // An outcome notice is followed through the run it is about.
      if (source.notice === true && source.runId !== null) {
        current = runById.get(source.runId);
        continue;
      }
      if (source.authorKind !== "bot") break;
      if (chain[0] !== source.authorId) chain.unshift(source.authorId);
      current = source.runId === null ? undefined : runById.get(source.runId);
    }
    return chain;
  };
  // Work flows down the chain of the run that posted the message; a message to a bot that is
  // upstream of its author is a report. First appearance decides who is upstream.
  const delegatesTo = (message: LedgerMessage, botId: string): boolean => {
    if (botId === message.authorId || !message.mentions.includes(botId)) return false;
    const poster = message.runId === null ? undefined : runById.get(message.runId);
    const upstream = poster ? wakeChain(poster) : [message.authorId];
    const at = upstream.indexOf(botId);
    return at === -1 || at >= upstream.indexOf(message.authorId);
  };
  const runsByBotAndThread = new Map<string, LedgerRun[]>();
  for (const run of ledger.runs) {
    if (run.threadId === null) continue;
    const key = `${run.threadId}:${run.botId}`;
    const list = runsByBotAndThread.get(key) ?? [];
    list.push(run);
    runsByBotAndThread.set(key, list);
  }

  for (const message of delegations) {
    // Only an explicit mention delegates; a walk of an unaddressed message offers, it does not
    // assign (ADR-0005 item 4). The delegate's run is the one the message woke, or, when the
    // mention coalesced into a run the bot already had queued (ADR-0005 item 8), the first of
    // its runs in the thread that started after the message and was delivered it.
    const delegateRuns: LedgerRun[] = [];
    for (const botId of message.mentions) {
      if (!delegatesTo(message, botId)) continue;
      const woken = (runsByTrigger.get(message.id) ?? []).filter((r) => r.botId === botId);
      if (woken.length > 0) {
        delegateRuns.push(...woken);
        continue;
      }
      const coalesced = (runsByBotAndThread.get(`${message.threadId}:${botId}`) ?? [])
        .filter(
          (r) =>
            r.triggerKind === "thread_message" &&
            r.startedAt !== null &&
            r.startedAt >= message.ts &&
            r.deliveredSeq !== null &&
            r.deliveredSeq >= message.seq,
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
      if (coalesced) delegateRuns.push(coalesced);
    }
    if (delegateRuns.length === 0) continue;
    const delegatingRun = message.runId === null ? undefined : runById.get(message.runId);
    const originThreadId = delegatingRun?.threadId ?? message.threadId;
    // One chain per delegate bot; extra runs for the same (message, bot) are duplicates.
    const byBot = new Map<string, LedgerRun[]>();
    for (const run of delegateRuns) {
      const list = byBot.get(run.botId) ?? [];
      list.push(run);
      byBot.set(run.botId, list);
    }
    for (const [delegateBotId, runs] of byBot) {
      const sorted = [...runs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const run = sorted[0] as LedgerRun;
      const terminal = TERMINAL.has(run.status);
      const reply = ledger.messages.find(
        (m) =>
          m.runId === run.id &&
          m.authorKind === "bot" &&
          m.authorId === delegateBotId &&
          m.threadId === message.threadId,
      );
      const notices = [
        ...(noticesByDelegation.get(message.id) ?? []).filter((e) => {
          const announced = runById.get(e.runId);
          return announced?.botId === delegateBotId;
        }),
        ...(noticesByRun.get(run.id) ?? []),
      ];
      const announcedReply = notices.some((e) => e.payload.replied === true);
      const noticeIds = notices.flatMap((e) =>
        Array.isArray(e.payload.messageIds)
          ? (e.payload.messageIds as unknown[]).filter((id): id is string => typeof id === "string")
          : [],
      );
      // Only what reached the thread the delegation was made from counts: the notice posted
      // there, else the delegate's reply when it was posted there. A `message_bot` reply that
      // stayed in the bus thread did not reach the delegator's task.
      const noticeMessages = noticeIds
        .map((id) => messageById.get(id))
        .filter((m): m is LedgerMessage => m !== undefined);
      const outcomeMessage =
        noticeMessages.find((m) => m.threadId === originThreadId) ??
        (reply?.threadId === originThreadId ? reply : undefined);
      const outcome = outcomeMessage
        ? {
            threadId: outcomeMessage.threadId,
            seq: outcomeMessage.seq,
            messageId: outcomeMessage.id,
          }
        : null;
      const delegatorRuns = ledger.runs.filter((r) => r.botId === message.authorId);
      let delegatorRun: LedgerRun | undefined;
      if (outcome) {
        delegatorRun = delegatorRuns
          .filter(
            (r) =>
              r.threadId === outcome.threadId &&
              r.deliveredSeq !== null &&
              r.deliveredSeq >= outcome.seq &&
              r.startedAt !== null,
          )
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
      } else if (run.finishedAt !== null) {
        const finished = run.finishedAt;
        delegatorRun = delegatorRuns
          .filter(
            (r) => r.threadId === originThreadId && r.startedAt !== null && r.createdAt >= finished,
          )
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
      }
      const pendingThread = outcome?.threadId ?? originThreadId;
      const pending =
        delegatorRun === undefined &&
        delegatorRuns.some((r) => r.threadId === pendingThread && r.status === "queued");
      const stuck = terminal && delegatorRun === undefined && !pending;
      const missedReply = terminal && outcome === null;
      const noticeAt = notices.length > 0 ? (notices[0] as LedgerEvent).ts : null;
      chains.push({
        delegationMessageId: message.id,
        delegationThreadId: message.threadId,
        delegationSeq: message.seq,
        delegatedAt: message.ts,
        originThreadId,
        delegatorBotId: message.authorId,
        delegatorName: botName.get(message.authorId) ?? message.authorId,
        delegateBotId,
        delegateName: botName.get(delegateBotId) ?? delegateBotId,
        delegateRunId: run.id,
        delegateStatus: run.status,
        terminal,
        finishedAt: run.finishedAt,
        replyMessageId: reply?.id ?? null,
        noticeMessageIds: noticeIds,
        noticeAt,
        outcome,
        missedReply,
        delegatorRunId: delegatorRun?.id ?? null,
        delegatorWokenAt: delegatorRun?.startedAt ?? null,
        pending,
        stuck,
        duplicateRuns: sorted.length - 1,
        // `silent` with a reply is a delegate that answered through `thread_post` and ended
        // with nothing to add: the work came back just the same.
        chainCompleted:
          delegatorRun !== undefined &&
          (announcedReply ||
            ((run.status === "succeeded" || run.status === "silent") && reply !== undefined)),
        wallToTerminalMs: run.finishedAt === null ? null : ms(run.finishedAt) - ms(message.ts),
        wallToNoticeMs: noticeAt === null ? null : ms(noticeAt) - ms(message.ts),
        delegateTokens: tokensOf(ledger.usage, run.id),
        delegatorFollowUpTokens: tokensOf(ledger.usage, delegatorRun?.id ?? null),
      });
    }
  }
  return chains;
}

export function summarize(chains: readonly DelegationChain[]): DelegationSummary {
  const byStatus: Record<string, number> = {};
  const tokens: DelegationSummary["tokens"] = { ...emptyTotals(), chainsWithUnknownUsage: 0 };
  for (const chain of chains) {
    byStatus[chain.delegateStatus] = (byStatus[chain.delegateStatus] ?? 0) + 1;
    addTotals(tokens, chain.delegateTokens);
    addTotals(tokens, chain.delegatorFollowUpTokens);
    if (chain.delegateTokens.unknownRuns + chain.delegatorFollowUpTokens.unknownRuns > 0)
      tokens.chainsWithUnknownUsage += 1;
  }
  return {
    chains: chains.length,
    terminal: chains.filter((c) => c.terminal).length,
    chainsCompleted: chains.filter((c) => c.chainCompleted).length,
    missedReplies: chains.filter((c) => c.missedReply).length,
    stuck: chains.filter((c) => c.stuck).length,
    pending: chains.filter((c) => c.pending).length,
    duplicateRuns: chains.reduce((n, c) => n + c.duplicateRuns, 0),
    byStatus,
    wallToTerminalMs: quantiles(
      chains.map((c) => c.wallToTerminalMs).filter((v): v is number => v !== null),
    ),
    wallToNoticeMs: quantiles(
      chains.map((c) => c.wallToNoticeMs).filter((v): v is number => v !== null),
    ),
    tokens,
  };
}

function fmtMs(value: number | null): string {
  if (value === null) return "n/a";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

function fmtQuantiles(q: Quantiles): string {
  return q.n === 0
    ? "no data"
    : `median ${fmtMs(q.median)}, p90 ${fmtMs(q.p90)}, max ${fmtMs(q.max)} (n=${q.n})`;
}

export function renderMarkdown(
  summary: DelegationSummary,
  chains: readonly DelegationChain[],
  source: string,
): string {
  const lines = [
    `# Delegation metrics: ${source}`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| delegation chains | ${summary.chains} |`,
    `| terminal | ${summary.terminal} |`,
    `| chains completed (succeeded, reply reached the thread, delegator woken) | ${summary.chainsCompleted} |`,
    `| missed replies (terminal, nothing reached the thread) | ${summary.missedReplies} |`,
    `| stuck delegators (terminal, delegator never woken, nothing queued) | ${summary.stuck} |`,
    `| pending (delegator wake queued, not started) | ${summary.pending} |`,
    `| duplicate delegate runs | ${summary.duplicateRuns} |`,
    `| delegate outcomes | ${
      Object.entries(summary.byStatus)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    } |`,
    `| wall time, delegation to terminal | ${fmtQuantiles(summary.wallToTerminalMs)} |`,
    `| wall time, delegation to outcome notice | ${fmtQuantiles(summary.wallToNoticeMs)} |`,
    `| tokens on chains (delegate run plus delegator follow-up) | input ${summary.tokens.input}, output ${summary.tokens.output}, cache read ${summary.tokens.cacheRead}, cache create ${summary.tokens.cacheCreate}; ${summary.tokens.chainsWithUnknownUsage} chain(s) with unknown usage |`,
    "",
  ];
  if (chains.length > 0) {
    lines.push(
      "| delegator | delegate | run | status | outcome | notice | delegator woken | stuck | dup | to terminal | to notice |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const c of chains) {
      lines.push(
        `| ${c.delegatorName} | ${c.delegateName} | ${c.delegateRunId} | ${c.delegateStatus} | ${
          c.outcome ? `#${c.outcome.seq}` : c.terminal ? "none" : "pending"
        } | ${c.noticeMessageIds.length > 0 ? "yes" : "no"} | ${
          c.delegatorWokenAt ? "yes" : c.pending ? "queued" : "no"
        } | ${c.stuck ? "yes" : "no"} | ${c.duplicateRuns} | ${fmtMs(c.wallToTerminalMs)} | ${fmtMs(
          c.wallToNoticeMs,
        )} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

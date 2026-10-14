// What an unaddressed message costs in a group, computed from ledger rows alone (ADR-0005
// amendment 2). The delegation metrics next door ask whether delegated work came back; these ask
// the earlier question: when a human writes to a group without naming a bot, how many runs does
// it take before somebody answers, and does anybody.
//
// Definitions (the results note quotes these):
//
// - group: a `chat` thread with more than one member. Membership is read as it is now; the
//   ledger does not keep what it was when a message was posted.
// - request: a human-authored message in a group that mentions no bot and is not `@everyone`.
// - offered run: a `thread_message` run whose `trigger_ref` is the request.
// - taker: the first offered run, in creation order, that put a message into the request's
//   thread (its own bot-authored message, or the `system` handoff line of a `message_bot` call).
// - nobody took: at least one run was offered the request, every offered run is terminal, none is
//   a taker, and no bot wrote in the thread before the next human message. A request no run was
//   ever created for (its first member's lane was busy, or a turn-budget pause abandoned the
//   offer) is "open", not "nobody took".
// - tokens: usage of offered runs that started. A run cancelled while queued used none and is
//   left out; a started run with no usage row is unknown, never zero.
// - time to first reply: from the request to the first bot-authored message after it and before
//   the next human message, whoever posted it.
// - derivative run: a `thread_message` run in a group triggered by a bot-authored message that
//   does not mention the run's bot and is not `@everyone`. Under decision 4 these are the walks
//   an unaddressed bot reply starts; under amendment 2 there are none.

import {
  type Ledger,
  type LedgerMessage,
  type LedgerRun,
  type LedgerUsage,
  type Quantiles,
  TERMINAL,
  type TokenTotals,
  quantiles,
} from "./metrics.js";

export interface OfferRequest {
  messageId: string;
  threadId: string;
  seq: number;
  postedAt: string;
  members: number;
  offeredRuns: number;
  silentRuns: number;
  failedRuns: number;
  /** Offered runs up to and including the taker; all of them when nobody took it. */
  runsToTaker: number;
  takerBotId: string | null;
  takerName: string | null;
  nobodyTook: boolean;
  /** Still being offered: some offered run is not terminal and nobody has taken it yet. */
  open: boolean;
  timeToFirstReplyMs: number | null;
  tokens: TokenTotals;
}

export interface OfferSummary {
  groups: number;
  requests: number;
  offeredRuns: number;
  silentRuns: number;
  failedRuns: number;
  meanRunsPerRequest: number | null;
  maxRunsPerRequest: number | null;
  /** Silent offered runs over all offered runs: what the offer spends on members who pass. */
  silentShare: number | null;
  nobodyTook: number;
  open: number;
  timeToFirstReplyMs: Quantiles;
  tokens: TokenTotals;
  derivativeRuns: number;
  derivativeSilentRuns: number;
  derivativeTokens: TokenTotals;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, unknownRuns: 0 };
}

function addRun(into: TokenTotals, usage: readonly LedgerUsage[], run: LedgerRun): void {
  // Never started: no model call was made, so there is nothing to count or to call unknown.
  if (run.startedAt === null) return;
  const rows = usage.filter((u) => u.runId === run.id);
  if (rows.length === 0) {
    into.unknownRuns += 1;
    return;
  }
  for (const row of rows) {
    into.input += row.inputTokens;
    into.output += row.outputTokens;
    into.cacheRead += row.cacheReadTokens;
    into.cacheCreate += row.cacheCreateTokens;
  }
}

function groupThreads(ledger: Ledger): Map<string, number> {
  const groups = new Map<string, number>();
  for (const thread of ledger.threads ?? []) {
    if (thread.kind === "chat" && thread.members > 1) groups.set(thread.id, thread.members);
  }
  return groups;
}

function byCreation(a: LedgerRun, b: LedgerRun): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** Every unaddressed human message in a group, oldest first. */
export function collectOffers(ledger: Ledger): OfferRequest[] {
  const groups = groupThreads(ledger);
  const botName = new Map(ledger.bots.map((b) => [b.id, b.name]));
  const byThread = new Map<string, LedgerMessage[]>();
  for (const message of ledger.messages) {
    const list = byThread.get(message.threadId) ?? [];
    list.push(message);
    byThread.set(message.threadId, list);
  }
  for (const list of byThread.values()) list.sort((a, b) => a.seq - b.seq);

  const out: OfferRequest[] = [];
  for (const [threadId, members] of groups) {
    const messages = byThread.get(threadId) ?? [];
    for (const message of messages) {
      if (message.authorKind !== "human") continue;
      if (message.mentions.length > 0 || message.everyone === true) continue;
      const nextHuman = messages.find((m) => m.seq > message.seq && m.authorKind === "human");
      const until = nextHuman?.seq ?? Number.POSITIVE_INFINITY;
      const offered = ledger.runs
        .filter((r) => r.triggerKind === "thread_message" && r.triggerRef === message.id)
        .sort(byCreation);
      const posted = (run: LedgerRun): boolean =>
        messages.some((m) => m.runId === run.id && m.seq > message.seq);
      const takerIndex = offered.findIndex(posted);
      const taker = takerIndex >= 0 ? (offered[takerIndex] as LedgerRun) : undefined;
      const firstReply = messages.find(
        (m) => m.seq > message.seq && m.seq < until && m.authorKind === "bot",
      );
      const allTerminal = offered.every((r) => TERMINAL.has(r.status));
      const tokens = emptyTotals();
      for (const run of offered) addRun(tokens, ledger.usage, run);
      out.push({
        messageId: message.id,
        threadId,
        seq: message.seq,
        postedAt: message.ts,
        members,
        offeredRuns: offered.length,
        silentRuns: offered.filter((r) => r.status === "silent").length,
        failedRuns: offered.filter((r) => r.status === "failed").length,
        runsToTaker: taker ? takerIndex + 1 : offered.length,
        takerBotId: taker?.botId ?? null,
        takerName: taker ? (botName.get(taker.botId) ?? taker.botId) : null,
        nobodyTook:
          offered.length > 0 && allTerminal && taker === undefined && firstReply === undefined,
        open: taker === undefined && (offered.length === 0 || !allTerminal),
        timeToFirstReplyMs: firstReply ? Date.parse(firstReply.ts) - Date.parse(message.ts) : null,
        tokens,
      });
    }
  }
  return out.sort((a, b) => (a.postedAt < b.postedAt ? -1 : a.postedAt > b.postedAt ? 1 : 0));
}

export function summarizeOffers(ledger: Ledger, requests: readonly OfferRequest[]): OfferSummary {
  const groups = groupThreads(ledger);
  const messageById = new Map(ledger.messages.map((m) => [m.id, m]));
  const tokens = emptyTotals();
  for (const request of requests) {
    tokens.input += request.tokens.input;
    tokens.output += request.tokens.output;
    tokens.cacheRead += request.tokens.cacheRead;
    tokens.cacheCreate += request.tokens.cacheCreate;
    tokens.unknownRuns += request.tokens.unknownRuns;
  }
  const derivative = ledger.runs.filter((run) => {
    if (run.triggerKind !== "thread_message" || run.threadId === null) return false;
    if (!groups.has(run.threadId)) return false;
    const source = messageById.get(run.triggerRef);
    if (!source || source.authorKind !== "bot" || source.threadId !== run.threadId) return false;
    return source.everyone !== true && !source.mentions.includes(run.botId);
  });
  const derivativeTokens = emptyTotals();
  for (const run of derivative) addRun(derivativeTokens, ledger.usage, run);
  const offeredRuns = requests.reduce((n, r) => n + r.offeredRuns, 0);
  const silentRuns = requests.reduce((n, r) => n + r.silentRuns, 0);
  return {
    groups: groups.size,
    requests: requests.length,
    offeredRuns,
    silentRuns,
    failedRuns: requests.reduce((n, r) => n + r.failedRuns, 0),
    meanRunsPerRequest: requests.length === 0 ? null : offeredRuns / requests.length,
    maxRunsPerRequest:
      requests.length === 0 ? null : Math.max(...requests.map((r) => r.offeredRuns)),
    silentShare: offeredRuns === 0 ? null : silentRuns / offeredRuns,
    nobodyTook: requests.filter((r) => r.nobodyTook).length,
    open: requests.filter((r) => r.open).length,
    timeToFirstReplyMs: quantiles(
      requests.map((r) => r.timeToFirstReplyMs).filter((v): v is number => v !== null),
    ),
    tokens,
    derivativeRuns: derivative.length,
    derivativeSilentRuns: derivative.filter((r) => r.status === "silent").length,
    derivativeTokens,
  };
}

function fmtMs(value: number | null): string {
  if (value === null) return "n/a";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

function fmtTokens(t: TokenTotals): string {
  return `input ${t.input}, output ${t.output}, cache read ${t.cacheRead}, cache create ${t.cacheCreate}; ${t.unknownRuns} run(s) with unknown usage`;
}

export function renderOffersMarkdown(
  summary: OfferSummary,
  requests: readonly OfferRequest[],
): string {
  const q = summary.timeToFirstReplyMs;
  const lines = [
    "## Unaddressed requests in groups",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| groups (chat threads with more than one member) | ${summary.groups} |`,
    `| unaddressed human requests | ${summary.requests} |`,
    `| runs offered the request | ${summary.offeredRuns} |`,
    `| runs per request | ${
      summary.meanRunsPerRequest === null
        ? "no data"
        : `mean ${summary.meanRunsPerRequest.toFixed(2)}, max ${summary.maxRunsPerRequest}`
    } |`,
    `| silent share of offered runs | ${
      summary.silentShare === null ? "no data" : `${(summary.silentShare * 100).toFixed(0)}%`
    } (${summary.silentRuns} silent, ${summary.failedRuns} failed) |`,
    `| requests nobody took | ${summary.nobodyTook} |`,
    `| requests still being offered | ${summary.open} |`,
    `| time to first reply | ${
      q.n === 0
        ? "no data"
        : `median ${fmtMs(q.median)}, p90 ${fmtMs(q.p90)}, max ${fmtMs(q.max)} (n=${q.n})`
    } |`,
    `| tokens on offered runs | ${fmtTokens(summary.tokens)} |`,
    `| runs woken by an unaddressed bot message | ${summary.derivativeRuns} (${summary.derivativeSilentRuns} silent) |`,
    `| tokens on those runs | ${fmtTokens(summary.derivativeTokens)} |`,
    "",
  ];
  if (requests.length > 0) {
    lines.push(
      "| thread | request | members | offered | silent | failed | taker | runs to taker | nobody took | first reply |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const r of requests) {
      lines.push(
        `| ${r.threadId} | #${r.seq} | ${r.members} | ${r.offeredRuns} | ${r.silentRuns} | ${r.failedRuns} | ${
          r.takerName ?? "none"
        } | ${r.runsToTaker} | ${r.nobodyTook ? "yes" : "no"} | ${fmtMs(r.timeToFirstReplyMs)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

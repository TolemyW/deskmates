// T0: the delegation chain metrics (ADR-0016 amendment 1, decision 10) on synthetic ledgers, plus
// the SQLite loader against the Gateway's real schema.

import { describe, expect, it } from "vitest";
import { openDatabase } from "../packages/gateway/src/db/open.js";
import { loadLedger } from "./delegation/load.js";
import {
  type Ledger,
  type LedgerRun,
  collectChains,
  quantiles,
  renderMarkdown,
  summarize,
} from "./delegation/metrics.js";
import { collectOffers, renderOffersMarkdown, summarizeOffers } from "./delegation/offers.js";

const T0 = "2026-09-30T10:00:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

const bots = [
  { id: "chief", name: "chief" },
  { id: "expert", name: "expert" },
];

function run(over: Partial<LedgerRun> & Pick<LedgerRun, "id" | "botId">): LedgerRun {
  return {
    threadId: "T",
    triggerKind: "thread_message",
    triggerRef: "",
    status: "succeeded",
    deliveredSeq: null,
    createdAt: at(0),
    startedAt: at(0),
    finishedAt: at(0),
    ...over,
  };
}

/** The pre-amendment shape: the expert failed, nothing reached the thread, the chief never woke. */
function failedSilently(): Ledger {
  return {
    bots,
    messages: [
      {
        id: "m1",
        threadId: "T",
        seq: 1,
        authorKind: "human",
        authorId: "web",
        mentions: [],
        runId: null,
        ts: at(0),
      },
      {
        id: "m2",
        threadId: "T",
        seq: 2,
        authorKind: "bot",
        authorId: "chief",
        mentions: ["expert"],
        runId: "r1",
        ts: at(5),
      },
    ],
    runs: [
      run({
        id: "r1",
        botId: "chief",
        triggerRef: "m1",
        deliveredSeq: 1,
        createdAt: at(0),
        finishedAt: at(6),
      }),
      run({
        id: "r2",
        botId: "expert",
        triggerRef: "m2",
        status: "failed",
        deliveredSeq: 2,
        createdAt: at(5),
        startedAt: at(6),
        finishedAt: at(66),
      }),
    ],
    events: [],
    usage: [
      { runId: "r2", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0 },
    ],
  };
}

describe("collectChains", () => {
  it("counts a failed delegate with nothing posted as a missed reply and a stuck delegator", () => {
    const chains = collectChains(failedSilently());
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      delegatorName: "chief",
      delegateName: "expert",
      delegateRunId: "r2",
      delegateStatus: "failed",
      terminal: true,
      outcome: null,
      missedReply: true,
      stuck: true,
      pending: false,
      chainCompleted: false,
      duplicateRuns: 0,
      wallToTerminalMs: 61_000,
      wallToNoticeMs: null,
    });
    expect(chains[0]?.delegateTokens).toEqual({
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheCreate: 0,
      unknownRuns: 0,
    });
    const summary = summarize(chains);
    expect(summary).toMatchObject({ chains: 1, terminal: 1, missedReplies: 1, stuck: 1 });
  });

  it("completes a chain when the reply reached the thread and the delegator delivered it", () => {
    const ledger = failedSilently();
    const r2 = ledger.runs[1] as LedgerRun;
    const l: Ledger = {
      ...ledger,
      runs: [
        ledger.runs[0] as LedgerRun,
        { ...r2, status: "succeeded" },
        run({
          id: "r3",
          botId: "chief",
          triggerRef: "m3",
          deliveredSeq: 3,
          createdAt: at(66),
          startedAt: at(67),
          finishedAt: at(80),
        }),
      ],
      messages: [
        ...ledger.messages,
        {
          id: "m3",
          threadId: "T",
          seq: 3,
          authorKind: "bot",
          authorId: "expert",
          mentions: ["chief"],
          runId: "r2",
          ts: at(65),
        },
      ],
      usage: [
        ...ledger.usage,
        { runId: "r3", inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
    };
    const [chain] = collectChains(l);
    expect(chain).toMatchObject({
      replyMessageId: "m3",
      outcome: { threadId: "T", seq: 3, messageId: "m3" },
      missedReply: false,
      stuck: false,
      delegatorRunId: "r3",
      chainCompleted: true,
    });
    expect(summarize([chain as NonNullable<typeof chain>]).tokens).toMatchObject({
      input: 150,
      output: 15,
      chainsWithUnknownUsage: 0,
    });
  });

  it("reads the Gateway's outcome notice and prefers the delegating run's own thread", () => {
    // A message_bot handoff: the chief delegated from chat thread C, the bus thread is B.
    const l: Ledger = {
      bots,
      messages: [
        {
          id: "c1",
          threadId: "C",
          seq: 1,
          authorKind: "human",
          authorId: "web",
          mentions: [],
          runId: null,
          ts: at(0),
        },
        {
          id: "b1",
          threadId: "B",
          seq: 1,
          authorKind: "bot",
          authorId: "chief",
          mentions: ["expert"],
          runId: "r1",
          ts: at(5),
        },
        {
          id: "b2",
          threadId: "B",
          seq: 2,
          authorKind: "bot",
          authorId: "expert",
          mentions: ["chief"],
          runId: "r2",
          ts: at(60),
        },
        {
          id: "b3",
          threadId: "B",
          seq: 3,
          authorKind: "system",
          authorId: "",
          mentions: [],
          runId: null,
          ts: at(61),
        },
        {
          id: "c2",
          threadId: "C",
          seq: 2,
          authorKind: "system",
          authorId: "",
          mentions: [],
          runId: null,
          ts: at(61),
        },
      ],
      runs: [
        run({
          id: "r1",
          botId: "chief",
          threadId: "C",
          triggerRef: "c1",
          deliveredSeq: 1,
          finishedAt: at(6),
        }),
        run({
          id: "r2",
          botId: "expert",
          threadId: "B",
          triggerRef: "b1",
          deliveredSeq: 1,
          createdAt: at(5),
          startedAt: at(6),
          finishedAt: at(61),
        }),
        run({
          id: "r3",
          botId: "chief",
          threadId: "C",
          triggerRef: "c2",
          status: "queued",
          deliveredSeq: null,
          createdAt: at(61),
          startedAt: null,
          finishedAt: null,
        }),
      ],
      events: [
        {
          runId: "r2",
          kind: "log",
          payload: { source: "delegation_outcome", outcome: "succeeded", messageIds: ["b3", "c2"] },
          ts: at(61),
        },
      ],
      usage: [],
    };
    const [chain] = collectChains(l);
    expect(chain).toMatchObject({
      originThreadId: "C",
      delegationThreadId: "B",
      noticeMessageIds: ["b3", "c2"],
      outcome: { threadId: "C", seq: 2, messageId: "c2" },
      pending: true,
      stuck: false,
      missedReply: false,
      wallToNoticeMs: 56_000,
    });
    expect(chain?.delegateTokens.unknownRuns).toBe(1);
  });

  it("does not count a report up the chain as a delegation", () => {
    // chief delegates (m2), expert reports back mentioning the chief (m3), the chief reads it
    // (r3) and ends silently. Only chief → expert is a chain; expert → chief is a report.
    const base = failedSilently();
    const l: Ledger = {
      ...base,
      runs: [
        base.runs[0] as LedgerRun,
        { ...(base.runs[1] as LedgerRun), status: "succeeded" },
        run({
          id: "r3",
          botId: "chief",
          triggerRef: "m3",
          status: "silent",
          deliveredSeq: 3,
          createdAt: at(66),
          startedAt: at(67),
          finishedAt: at(70),
        }),
      ],
      messages: [
        ...base.messages,
        {
          id: "m3",
          threadId: "T",
          seq: 3,
          authorKind: "bot",
          authorId: "expert",
          mentions: ["chief"],
          runId: "r2",
          ts: at(65),
        },
      ],
    };
    const chains = collectChains(l);
    expect(chains.map((c) => [c.delegatorName, c.delegateName])).toEqual([["chief", "expert"]]);
    expect(summarize(chains)).toMatchObject({ chains: 1, stuck: 0, missedReplies: 0 });
  });

  it("a message_bot reply that stayed in the bus thread is a missed reply in the origin thread", () => {
    const l: Ledger = {
      bots,
      messages: [
        {
          id: "c1",
          threadId: "C",
          seq: 1,
          authorKind: "human",
          authorId: "web",
          mentions: [],
          runId: null,
          ts: at(0),
        },
        {
          id: "b1",
          threadId: "B",
          seq: 1,
          authorKind: "bot",
          authorId: "chief",
          mentions: ["expert"],
          runId: "r1",
          ts: at(5),
        },
        {
          id: "b2",
          threadId: "B",
          seq: 2,
          authorKind: "bot",
          authorId: "expert",
          mentions: ["chief"],
          runId: "r2",
          ts: at(60),
        },
      ],
      runs: [
        run({
          id: "r1",
          botId: "chief",
          threadId: "C",
          triggerRef: "c1",
          deliveredSeq: 1,
          finishedAt: at(6),
        }),
        run({
          id: "r2",
          botId: "expert",
          threadId: "B",
          triggerRef: "b1",
          deliveredSeq: 1,
          createdAt: at(5),
          startedAt: at(6),
          finishedAt: at(61),
        }),
        // The chief read the reply in the bus thread, on the background lane; its chat-thread
        // session, where the task lives, never heard.
        run({
          id: "r3",
          botId: "chief",
          threadId: "B",
          triggerRef: "b2",
          status: "silent",
          deliveredSeq: 2,
          createdAt: at(61),
          startedAt: at(62),
          finishedAt: at(63),
        }),
      ],
      events: [],
      usage: [],
    };
    const chains = collectChains(l);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      originThreadId: "C",
      replyMessageId: "b2",
      outcome: null,
      missedReply: true,
      stuck: true,
      chainCompleted: false,
    });
  });

  it("completes a chain whose delegate handed the work on and answered in a later run", () => {
    const ledger = failedSilently();
    const expertRun = ledger.runs[1] as LedgerRun;
    const chain: Ledger = {
      ...ledger,
      runs: [
        ledger.runs[0] as LedgerRun,
        { ...expertRun, status: "silent" },
        // The expert's continuation, woken by the notice about the teammate it asked.
        run({
          id: "r3",
          botId: "expert",
          triggerRef: "n1",
          deliveredSeq: 4,
          createdAt: at(70),
          startedAt: at(71),
          finishedAt: at(80),
        }),
        run({
          id: "r4",
          botId: "chief",
          triggerRef: "m6",
          deliveredSeq: 6,
          createdAt: at(80),
          startedAt: at(81),
          finishedAt: at(90),
        }),
      ],
      messages: [
        ...ledger.messages,
        {
          id: "m5",
          threadId: "T",
          seq: 5,
          authorKind: "bot",
          authorId: "expert",
          mentions: [],
          runId: "r3",
          ts: at(79),
        },
        {
          id: "m6",
          threadId: "T",
          seq: 6,
          authorKind: "system",
          authorId: "",
          mentions: [],
          runId: "r3",
          ts: at(80),
        },
      ],
      events: [
        {
          runId: "r3",
          kind: "log",
          payload: {
            source: "delegation_outcome",
            outcome: "succeeded",
            replied: true,
            delegationMessageId: "m2",
            messageIds: ["m6"],
          },
          ts: at(80),
        },
      ],
    };
    const [only] = collectChains(chain);
    expect(only).toMatchObject({
      delegateRunId: "r2",
      delegateStatus: "silent",
      outcome: { seq: 6 },
      missedReply: false,
      stuck: false,
      delegatorRunId: "r4",
      chainCompleted: true,
    });
  });

  it("finds the delegate run of a mention that coalesced into a run already queued", () => {
    const T = (n: number) => at(n);
    const ledger: Ledger = {
      bots: [...bots, { id: "carol", name: "carol" }],
      messages: [
        {
          id: "h1",
          threadId: "T",
          seq: 1,
          authorKind: "human",
          authorId: "web",
          mentions: ["carol"],
          runId: null,
          ts: T(0),
        },
        {
          id: "h2",
          threadId: "T",
          seq: 2,
          authorKind: "human",
          authorId: "web",
          mentions: ["chief"],
          runId: null,
          ts: T(1),
        },
        {
          id: "d1",
          threadId: "T",
          seq: 3,
          authorKind: "bot",
          authorId: "chief",
          mentions: ["expert"],
          runId: "rc",
          ts: T(5),
        },
        // The expert hands on to carol while carol's run for h1 is still queued.
        {
          id: "d2",
          threadId: "T",
          seq: 4,
          authorKind: "bot",
          authorId: "expert",
          mentions: ["carol"],
          runId: "re",
          ts: T(10),
        },
        {
          id: "a1",
          threadId: "T",
          seq: 5,
          authorKind: "bot",
          authorId: "carol",
          mentions: [],
          runId: "rk",
          ts: T(30),
        },
      ],
      runs: [
        run({
          id: "rk",
          botId: "carol",
          triggerRef: "h1",
          deliveredSeq: 4,
          createdAt: T(0),
          startedAt: T(20),
          finishedAt: T(31),
        }),
        run({
          id: "rc",
          botId: "chief",
          triggerRef: "h2",
          deliveredSeq: 2,
          createdAt: T(1),
          startedAt: T(2),
          finishedAt: T(6),
        }),
        run({
          id: "re",
          botId: "expert",
          triggerRef: "d1",
          status: "silent",
          deliveredSeq: 3,
          createdAt: T(5),
          startedAt: T(6),
          finishedAt: T(11),
        }),
      ],
      events: [],
      usage: [],
    };
    const chains = collectChains(ledger);
    expect(chains.map((c) => [c.delegationMessageId, c.delegateName, c.delegateRunId])).toEqual([
      ["d1", "expert", "re"],
      ["d2", "carol", "rk"],
    ]);
  });

  it("does not take a report after a notice-woken continuation for a delegation", () => {
    const T = (n: number) => at(n);
    const ledger: Ledger = {
      bots: [...bots, { id: "carol", name: "carol" }],
      messages: [
        {
          id: "h1",
          threadId: "T",
          seq: 1,
          authorKind: "human",
          authorId: "web",
          mentions: ["chief"],
          runId: null,
          ts: T(0),
        },
        {
          id: "d1",
          threadId: "T",
          seq: 2,
          authorKind: "bot",
          authorId: "chief",
          mentions: ["expert"],
          runId: "rc",
          ts: T(5),
        },
        {
          id: "d2",
          threadId: "T",
          seq: 3,
          authorKind: "bot",
          authorId: "expert",
          mentions: ["carol"],
          runId: "re",
          ts: T(10),
        },
        {
          id: "a1",
          threadId: "T",
          seq: 4,
          authorKind: "bot",
          authorId: "carol",
          mentions: [],
          runId: "rk",
          ts: T(20),
        },
        {
          id: "n1",
          threadId: "T",
          seq: 5,
          authorKind: "system",
          authorId: "",
          mentions: [],
          runId: "rk",
          ts: T(21),
          notice: true,
        },
        {
          id: "r1",
          threadId: "T",
          seq: 6,
          authorKind: "bot",
          authorId: "expert",
          mentions: ["chief"],
          runId: "re2",
          ts: T(30),
        },
      ],
      runs: [
        run({
          id: "rc",
          botId: "chief",
          triggerRef: "h1",
          deliveredSeq: 1,
          createdAt: T(0),
          startedAt: T(1),
          finishedAt: T(6),
        }),
        run({
          id: "re",
          botId: "expert",
          triggerRef: "d1",
          status: "silent",
          deliveredSeq: 2,
          createdAt: T(5),
          startedAt: T(6),
          finishedAt: T(11),
        }),
        run({
          id: "rk",
          botId: "carol",
          triggerRef: "d2",
          deliveredSeq: 3,
          createdAt: T(10),
          startedAt: T(11),
          finishedAt: T(21),
        }),
        run({
          id: "re2",
          botId: "expert",
          triggerRef: "n1",
          deliveredSeq: 5,
          createdAt: T(21),
          startedAt: T(22),
          finishedAt: T(31),
        }),
        run({
          id: "rc2",
          botId: "chief",
          triggerRef: "r1",
          status: "silent",
          deliveredSeq: 6,
          createdAt: T(30),
          startedAt: T(31),
          finishedAt: T(35),
        }),
      ],
      events: [],
      usage: [],
    };
    expect(collectChains(ledger).map((c) => c.delegationMessageId)).toEqual(["d1", "d2"]);
  });

  it("ignores human-triggered runs and counts duplicate delegate runs", () => {
    const l: Ledger = {
      bots,
      messages: [
        {
          id: "m1",
          threadId: "T",
          seq: 1,
          authorKind: "human",
          authorId: "web",
          mentions: [],
          runId: null,
          ts: at(0),
        },
        {
          id: "m2",
          threadId: "T",
          seq: 2,
          authorKind: "bot",
          authorId: "chief",
          mentions: ["expert"],
          runId: "r1",
          ts: at(5),
        },
      ],
      runs: [
        run({ id: "r1", botId: "chief", triggerRef: "m1", deliveredSeq: 1 }),
        run({
          id: "r2",
          botId: "expert",
          triggerRef: "m2",
          status: "running",
          finishedAt: null,
          createdAt: at(5),
        }),
        run({
          id: "r2b",
          botId: "expert",
          triggerRef: "m2",
          status: "queued",
          startedAt: null,
          finishedAt: null,
          createdAt: at(6),
        }),
      ],
      events: [],
      usage: [],
    };
    const chains = collectChains(l);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      delegateRunId: "r2",
      terminal: false,
      stuck: false,
      duplicateRuns: 1,
    });
    expect(summarize(chains).duplicateRuns).toBe(1);
  });

  it("renders a markdown table and computes quantiles", () => {
    expect(quantiles([])).toEqual({ n: 0, median: null, p90: null, max: null });
    expect(quantiles([5, 1, 3])).toEqual({ n: 3, median: 3, p90: 5, max: 5 });
    const chains = collectChains(failedSilently());
    const md = renderMarkdown(summarize(chains), chains, "test");
    expect(md).toContain("| missed replies (terminal, nothing reached the thread) | 1 |");
    expect(md).toContain("| chief | expert | r2 | failed | none | no | no | yes | 0 |");
  });
});

describe("loadLedger", () => {
  it("reads runs, messages, outcome events, usage and bots from the Gateway schema", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(
        "INSERT INTO workspaces (id, tenant_id,name,sandbox_provider,status,created_at) VALUES ('w', 'tnt_default','w','docker','ready','t');" +
          "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('chief','chief','r','w','t');" +
          "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('expert','expert','r','w','t');" +
          "INSERT INTO threads (id,workspace_id,kind,channel,title,turn_budget,status,created_at,updated_at) VALUES ('T','w','chat','web','t',8,'active','t','t');" +
          "INSERT INTO thread_messages (id,thread_id,seq,author_kind,author_id,body,attachments_json,mentions_json,relay_count,run_id,ts) VALUES ('m1','T',1,'human','web','go','[]','[]',0,NULL,'2026-09-30T10:00:00.000Z');" +
          "INSERT INTO runs (workspace_id, id,bot_id,thread_id,lane,trigger_kind,trigger_ref,status,delivered_seq,created_at,started_at,finished_at) VALUES ('w', 'r1','chief','T','interactive','thread_message','m1','succeeded',1,'2026-09-30T10:00:00.000Z','2026-09-30T10:00:01.000Z','2026-09-30T10:00:05.000Z');" +
          "INSERT INTO thread_messages (id,thread_id,seq,author_kind,author_id,body,attachments_json,mentions_json,relay_count,run_id,ts) VALUES ('m2','T',2,'bot','chief','@expert do it','[]','[{\"kind\":\"bot\",\"botId\":\"expert\"}]',1,'r1','2026-09-30T10:00:05.000Z');" +
          "INSERT INTO runs (workspace_id, id,bot_id,thread_id,lane,trigger_kind,trigger_ref,status,delivered_seq,created_at,started_at,finished_at) VALUES ('w', 'r2','expert','T','interactive','thread_message','m2','failed',2,'2026-09-30T10:00:05.000Z','2026-09-30T10:00:06.000Z','2026-09-30T10:01:06.000Z');" +
          'INSERT INTO run_events (run_id,seq,kind,payload_json,ts) VALUES (\'r2\',1,\'log\',\'{"source":"delegation_outcome","outcome":"failed","messageIds":["m3"]}\',\'2026-09-30T10:01:06.000Z\');' +
          "INSERT INTO run_events (run_id,seq,kind,payload_json,ts) VALUES ('r2',2,'log','{\"source\":\"sidecar\"}','2026-09-30T10:01:06.000Z');" +
          "INSERT INTO thread_messages (id,thread_id,seq,author_kind,author_id,body,attachments_json,mentions_json,relay_count,run_id,ts) VALUES ('m3','T',3,'system','','expert failed','[]','[]',0,NULL,'2026-09-30T10:01:06.000Z');" +
          "INSERT INTO run_usage (run_id,model,attempt,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,cost_usd) VALUES ('r2','m',1,10,2,0,0,NULL)",
      );
      const ledger = loadLedger(db);
      expect(ledger.runs.map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(ledger.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
      expect(ledger.events).toHaveLength(1);
      expect(ledger.events[0]?.payload.messageIds).toEqual(["m3"]);
      expect(ledger.usage).toEqual([
        { runId: "r2", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ]);
      expect(ledger.bots.map((b) => b.name)).toEqual(["chief", "expert"]);
      expect(ledger.threads).toEqual([{ id: "T", kind: "chat", members: 0 }]);
      expect(ledger.messages.map((m) => m.everyone)).toEqual([false, false, false]);
      const [chain] = collectChains(ledger);
      expect(chain).toMatchObject({
        delegateStatus: "failed",
        outcome: { seq: 3 },
        missedReply: false,
        stuck: true,
      });
    } finally {
      db.close();
    }
  });
});

describe("collectOffers", () => {
  const trio = [
    { id: "a", name: "a" },
    { id: "b", name: "b" },
    { id: "c", name: "c" },
  ];
  const human = (
    id: string,
    seq: number,
    t: number,
    over: Partial<Ledger["messages"][number]> = {},
  ) => ({
    id,
    threadId: "G",
    seq,
    authorKind: "human" as const,
    authorId: "web",
    mentions: [] as string[],
    runId: null,
    ts: at(t),
    ...over,
  });
  const bot = (
    id: string,
    seq: number,
    t: number,
    author: string,
    runId: string,
    mentions: string[] = [],
  ) => ({
    id,
    threadId: "G",
    seq,
    authorKind: "bot" as const,
    authorId: author,
    mentions,
    runId,
    ts: at(t),
  });

  /** Decision 4 as it was: all three members run, the second answers, its reply walks the rest. */
  function fullWalk(): Ledger {
    return {
      bots: trio,
      threads: [
        { id: "G", kind: "chat", members: 3 },
        { id: "solo", kind: "chat", members: 1 },
      ],
      messages: [human("h1", 1, 0), bot("b1", 2, 40, "b", "rb")],
      runs: [
        run({
          id: "ra",
          botId: "a",
          threadId: "G",
          triggerRef: "h1",
          status: "silent",
          createdAt: at(0),
        }),
        run({ id: "rb", botId: "b", threadId: "G", triggerRef: "h1", createdAt: at(20) }),
        run({
          id: "rc",
          botId: "c",
          threadId: "G",
          triggerRef: "h1",
          status: "silent",
          createdAt: at(41),
        }),
        run({
          id: "da",
          botId: "a",
          threadId: "G",
          triggerRef: "b1",
          status: "silent",
          createdAt: at(50),
        }),
        run({
          id: "dc",
          botId: "c",
          threadId: "G",
          triggerRef: "b1",
          status: "silent",
          createdAt: at(60),
        }),
      ],
      events: [],
      usage: [
        { runId: "ra", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0 },
        { runId: "rb", inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheCreateTokens: 0 },
        { runId: "da", inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
    };
  }

  it("counts every run an unaddressed request cost, who took it and the walks its reply started", () => {
    const ledger = fullWalk();
    const requests = collectOffers(ledger);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      messageId: "h1",
      members: 3,
      offeredRuns: 3,
      silentRuns: 2,
      failedRuns: 0,
      takerName: "b",
      runsToTaker: 2,
      nobodyTook: false,
      open: false,
      timeToFirstReplyMs: 40_000,
    });
    expect(requests[0]?.tokens).toMatchObject({ input: 30, output: 3, unknownRuns: 1 });
    const summary = summarizeOffers(ledger, requests);
    expect(summary).toMatchObject({
      groups: 1,
      requests: 1,
      offeredRuns: 3,
      meanRunsPerRequest: 3,
      maxRunsPerRequest: 3,
      nobodyTook: 0,
      derivativeRuns: 2,
      derivativeSilentRuns: 2,
    });
    expect(summary.silentShare).toBeCloseTo(2 / 3);
    expect(summary.derivativeTokens).toMatchObject({ input: 5, unknownRuns: 1 });
    const md = renderOffersMarkdown(summary, requests);
    expect(md).toContain("| runs per request | mean 3.00, max 3 |");
    expect(md).toContain("| runs woken by an unaddressed bot message | 2 (2 silent) |");
    expect(md).toContain("| G | #1 | 3 | 3 | 2 | 0 | b | 2 | no | 40.0 s |");
  });

  it("reports a request every member passed on, and leaves one still being offered open", () => {
    const ledger: Ledger = {
      bots: trio,
      threads: [{ id: "G", kind: "chat", members: 3 }],
      messages: [human("h1", 1, 0), human("h2", 2, 100)],
      runs: [
        run({ id: "r1", botId: "a", threadId: "G", triggerRef: "h1", status: "silent" }),
        run({ id: "r2", botId: "b", threadId: "G", triggerRef: "h1", status: "failed" }),
        run({ id: "r3", botId: "c", threadId: "G", triggerRef: "h1", status: "silent" }),
        run({
          id: "r4",
          botId: "a",
          threadId: "G",
          triggerRef: "h2",
          status: "running",
          finishedAt: null,
        }),
      ],
      events: [],
      usage: [],
    };
    const requests = collectOffers(ledger);
    expect(requests.map((r) => [r.nobodyTook, r.open, r.failedRuns])).toEqual([
      [true, false, 1],
      [false, true, 0],
    ]);
    expect(summarizeOffers(ledger, requests)).toMatchObject({
      nobodyTook: 1,
      open: 1,
      failedRuns: 1,
    });
  });

  it("a request no run was created for is open, and a run cancelled while queued costs nothing", () => {
    const ledger: Ledger = {
      bots: trio,
      threads: [{ id: "G", kind: "chat", members: 3 }],
      messages: [human("h1", 1, 0), human("h2", 2, 50)],
      runs: [
        run({
          id: "r1",
          botId: "a",
          threadId: "G",
          triggerRef: "h2",
          status: "cancelled",
          startedAt: null,
        }),
      ],
      events: [],
      usage: [],
    };
    const requests = collectOffers(ledger);
    expect(requests.map((r) => [r.offeredRuns, r.nobodyTook, r.open])).toEqual([
      [0, false, true],
      [1, true, false],
    ]);
    expect(requests[1]?.tokens.unknownRuns).toBe(0);
  });

  it("leaves out addressed and @everyone messages, one-member chats and bus threads", () => {
    const ledger: Ledger = {
      bots: trio,
      threads: [
        { id: "G", kind: "chat", members: 3 },
        { id: "solo", kind: "chat", members: 1 },
        { id: "bus", kind: "bus", members: 2 },
      ],
      messages: [
        human("h1", 1, 0, { mentions: ["a"] }),
        human("h2", 2, 1, { everyone: true }),
        human("h3", 1, 2, { threadId: "solo" }),
        bot("b1", 3, 5, "a", "r1", ["b"]),
        { ...bot("x1", 1, 6, "a", "r1"), threadId: "bus" },
      ],
      runs: [
        run({ id: "r1", botId: "a", threadId: "G", triggerRef: "h1" }),
        run({ id: "r2", botId: "b", threadId: "G", triggerRef: "b1" }),
        run({ id: "r3", botId: "b", threadId: "bus", triggerRef: "x1" }),
      ],
      events: [],
      usage: [],
    };
    const requests = collectOffers(ledger);
    expect(requests).toEqual([]);
    expect(summarizeOffers(ledger, requests)).toMatchObject({
      groups: 1,
      requests: 0,
      meanRunsPerRequest: null,
      silentShare: null,
      derivativeRuns: 0,
    });
  });

  it("counts a message_bot handoff line from the offered run as taking the request", () => {
    const ledger: Ledger = {
      bots: trio,
      threads: [{ id: "G", kind: "chat", members: 3 }],
      messages: [
        human("h1", 1, 0),
        {
          id: "s1",
          threadId: "G",
          seq: 2,
          authorKind: "system",
          authorId: "",
          mentions: [],
          runId: "r1",
          ts: at(9),
        },
      ],
      runs: [run({ id: "r1", botId: "a", threadId: "G", triggerRef: "h1", status: "silent" })],
      events: [],
      usage: [],
    };
    expect(collectOffers(ledger)[0]).toMatchObject({
      takerName: "a",
      runsToTaker: 1,
      nobodyTook: false,
    });
  });
});

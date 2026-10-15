// T0: the stdin request is validated before anything starts (review M7).

import { describe, expect, it } from "vitest";
import { parseStartRunRequest } from "./start-run-request.js";

const VALID = {
  runId: "run-1",
  botId: "bot-nova",
  botName: "nova",
  workspaceId: "ws-1",
  threadId: "thread-1",
  botHomeDir: "/home/nova",
  attempt: 1,
  trigger: {
    kind: "thread_message",
    thread: { id: "thread-1", kind: "chat", title: "Ops" },
    messages: [
      {
        seq: 1,
        authorKind: "human",
        authorId: "alice",
        authorName: "Alice",
        body: "Check the ticket queue",
        attachments: [],
      },
    ],
    relayCount: 0,
  },
  model: "model-under-test",
  cheapModel: "cheap-model-under-test",
  modelBaseUrl: "http://gateway.test/model",
  modelAuthToken: "tok",
  gatewayBaseUrl: "http://gateway.test",
  shortWaitSeconds: 300,
  maxTurns: 50,
  egressAllowlist: ["ops.example.test"],
  connectors: [],
  tools: ["thread_post"],
};

const json = (value: unknown): string => JSON.stringify(value);

function omit(source: object, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([k]) => k !== field));
}

/** `VALID` with one field replaced, or removed when the value is `undefined`. */
function withField(field: string, value: unknown): string {
  return json(value === undefined ? omit(VALID, field) : { ...VALID, [field]: value });
}

describe("parseStartRunRequest accepts what the Gateway sends", () => {
  it("keeps a group wake's roster, offer and guidance flag through stdin (ADR-0005 amendment 2)", () => {
    const trigger = {
      ...VALID.trigger,
      routing: {
        version: 2,
        recipientBotId: "bot-nova",
        recipientName: "nova",
        sourceMessageSeq: 1,
        members: [
          { name: "nova", role: "coordinator", you: true },
          { name: "orion", role: "pricing analyst", owner: true },
        ],
        offer: { messageSeq: 1, passed: ["orion"], remaining: [] },
      },
    };
    const result = parseStartRunRequest(json({ ...VALID, trigger, groupGuidance: "owner-v1" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trigger).toEqual(trigger);
      expect(result.value.groupGuidance).toBe("owner-v1");
    }
    expect(parseStartRunRequest(json({ ...VALID, groupGuidance: "owner-v2" })).ok).toBe(false);
    expect(
      parseStartRunRequest(
        withField("trigger", {
          ...trigger,
          routing: { ...trigger.routing, members: [{ name: "", role: "x" }] },
        }),
      ).ok,
    ).toBe(false);
  });

  it("keeps Gateway routing context and addressing through stdin", () => {
    const trigger = {
      ...VALID.trigger,
      routing: {
        version: 1,
        recipientBotId: "bot-nova",
        recipientName: "nova",
        sourceMessageSeq: 1,
      },
      messages: [{ ...VALID.trigger.messages[0], addressing: "recipient" }],
    };
    const result = parseStartRunRequest(withField("trigger", trigger));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trigger).toEqual(trigger);
    expect(
      parseStartRunRequest(
        withField("trigger", { ...trigger, routing: { ...trigger.routing, version: 3 } }),
      ).ok,
    ).toBe(false);
    expect(
      parseStartRunRequest(
        withField("trigger", {
          ...trigger,
          messages: [{ ...trigger.messages[0], addressing: "trusted" }],
        }),
      ).ok,
    ).toBe(false);
  });

  it("returns the request unchanged", () => {
    const result = parseStartRunRequest(json(VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.runId).toBe("run-1");
      expect(result.value.shortWaitSeconds).toBe(300);
      expect(result.value.trigger.kind).toBe("thread_message");
    }
  });

  it.each([
    ["cron", { kind: "cron", prompt: "tick" }],
    ["webhook", { kind: "webhook", body: "{}" }],
    ["welcome", { kind: "welcome", prompt: "Say hi" }],
    ["approval", { kind: "approval", approvalId: "ap-1", decision: "allow_once" }],
    [
      "approval with a tool-use id",
      { kind: "approval", approvalId: "ap-1", decision: "deny", toolUseId: "toolu_1" },
    ],
  ])("accepts a %s trigger", (_name, trigger) => {
    expect(parseStartRunRequest(withField("trigger", trigger)).ok).toBe(true);
  });

  it("keeps the resume hand-over: deferredAction and currentOrigin survive the stdin path", () => {
    // zod strips unknown keys, so a field the contract has and this schema lacks is silently
    // lost between the Gateway and the process. Every field added to StartRunRequest gets a
    // round-trip case here for that reason.
    const trigger = {
      kind: "approval",
      approvalId: "ap-1",
      decision: "allow_once",
      toolUseId: "toolu_1",
      deferredAction: {
        toolName: "mcp__browser__browser_click",
        targetOrigin: "http://shop.example.test:8080",
        argumentPattern: "*submit*",
      },
      reason: "Nobody approved this within 15 minutes.",
      currentOrigin: "http://shop.example.test:8080",
    };
    const result = parseStartRunRequest(withField("trigger", trigger));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trigger).toEqual(trigger);
  });

  it("accepts every tool a configured Gateway offers (app links, look/OCR, ASR)", () => {
    // v0.6.9 regression: these were offered once APP_SHARE_* and the operation services were set
    // on the stable host, and every run's sidecar exited on the unknown names.
    const tools = [
      "thread_post",
      "task_deliver",
      "app_publish",
      "image_describe",
      "audio_transcribe",
    ];
    const result = parseStartRunRequest(json({ ...VALID, tools }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tools).toEqual(tools);
  });

  it("accepts the optional fields being absent", () => {
    expect(parseStartRunRequest(json(omit(VALID, "threadId"))).ok).toBe(true);
  });

  it("keeps the opt-in per-bot working directory mode through stdin (issue #88)", () => {
    const result = parseStartRunRequest(json({ ...VALID, workdirMode: "per-bot" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.workdirMode).toBe("per-bot");
    expect(parseStartRunRequest(json({ ...VALID, workdirMode: "shared" })).ok).toBe(false);
  });

  it("keeps the other lane's run and drops a stale worktree repository (ADR-0036, ADR-0038)", () => {
    const otherLaneRun = {
      runId: "run_other",
      lane: "background",
      triggerKind: "cron",
      startedAt: "2026-10-14T08:00:00.000Z",
    } as const;
    const result = parseStartRunRequest(
      json({ ...VALID, workdirMode: "per-bot", worktreeRepo: "/work/app", otherLaneRun }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // ADR-0038 decision 7: the platform prepares no worktree, so the field is not read.
      expect("worktreeRepo" in result.value).toBe(false);
      expect(result.value.otherLaneRun).toEqual(otherLaneRun);
    }
    expect(
      parseStartRunRequest(json({ ...VALID, otherLaneRun: { ...otherLaneRun, lane: "other" } })).ok,
    ).toBe(false);
  });

  it("keeps the opt-in origin coordination deadline through stdin", () => {
    const browserCoordination = {
      mode: "origin-v2",
      deadlineAt: "2026-09-23T10:05:00.000Z",
    } as const;
    const result = parseStartRunRequest(withField("browserCoordination", browserCoordination));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.browserCoordination).toEqual(browserCoordination);
  });

  it.each(["explicit-v1", "inline-v2"] as const)(
    "keeps browser snapshot mode %s through stdin",
    (browserSnapshotMode) => {
      const result = parseStartRunRequest(withField("browserSnapshotMode", browserSnapshotMode));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.browserSnapshotMode).toBe(browserSnapshotMode);
    },
  );

  it("keeps the pinned memory index, the session taint and memory_search (ADR-0011)", () => {
    const memoryIndex = {
      version: 1,
      assembledAt: "2026-09-29T00:00:00.000Z",
      budgets: { totalLines: 200, workspaceLines: 120, botLines: 80 },
      sections: {
        workspace: [
          {
            entryId: "mem_1",
            version: 2,
            authority: "fact",
            body: "S3 egress is billed separately.",
            observedAt: "2026-09-28T00:00:00.000Z",
            learnedBy: "nova",
          },
        ],
        bot: [],
        task: [],
      },
      versionSet: [{ entryId: "mem_1", version: 2 }],
      lines: 1,
      counts: { considered: 2, pinned: 1, untrusted: 1, budget: 0, ineligible: 0 },
    };
    const result = parseStartRunRequest(
      JSON.stringify({
        ...VALID,
        tools: ["thread_post", "memory_search"],
        memoryIndex,
        sessionTainted: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memoryIndex).toEqual(memoryIndex);
    expect(result.value.sessionTainted).toBe(true);
    expect(result.value.tools).toContain("memory_search");
  });

  it("accepts a budget continuation and refuses an escaping handoff path (ADR-0032 decision 7)", () => {
    const ok = parseStartRunRequest(
      JSON.stringify({
        ...VALID,
        trigger: { kind: "budget_continuation", handoffPath: "/work/handoff.md" },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok)
      expect(ok.value.trigger).toEqual({
        kind: "budget_continuation",
        handoffPath: "/work/handoff.md",
      });
    const bad = parseStartRunRequest(
      JSON.stringify({
        ...VALID,
        trigger: { kind: "budget_continuation", handoffPath: "/work/../etc/passwd" },
      }),
    );
    expect(bad.ok).toBe(false);
  });

  it("preserves continuation and authoritative file inputs through stdin", () => {
    const input = {
      ...VALID,
      trigger: { kind: "continuation", approvalId: "ap-1", decision: "continue" },
      canonicalFiles: {
        soul: { body: "Instructions", version: "abc" },
        memory: { body: "Notes", version: "def" },
      },
      peerBotHomeDirs: ["/home/other_bot"],
      sessionDoNotLearnReasons: ["approval_deferred"],
    };
    const parsed = parseStartRunRequest(JSON.stringify(input));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toMatchObject(input);
  });

  it("accepts a resumed process's attempt", () => {
    const result = parseStartRunRequest(withField("attempt", 2));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.attempt).toBe(2);
  });

  it("accepts approval_decide in the tool list (ADR-0002 amendment 2, A2)", () => {
    const result = parseStartRunRequest(withField("tools", ["thread_post", "approval_decide"]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tools).toEqual(["thread_post", "approval_decide"]);
  });

  it("keeps maxTurns: the Gateway owns the knob, so it has to survive the stdin path", () => {
    // Round-trip rule (README): a field zod does not name is silently stripped, and a stripped
    // maxTurns would leave the run on whatever the SDK defaults to instead of the Gateway's knob.
    const result = parseStartRunRequest(withField("maxTurns", 12));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.maxTurns).toBe(12);
  });

  it("keeps an explicit null maxTurns (the workspace's off, ADR-0016 amendment 2) and still requires the field", () => {
    const result = parseStartRunRequest(withField("maxTurns", null));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.maxTurns).toBeNull();
  });

  it("keeps the reasoning knob when set and accepts its absence (sdk-default)", () => {
    const set = parseStartRunRequest(
      json({ ...VALID, effort: "low", thinking: { type: "enabled", budgetTokens: 2048 } }),
    );
    expect(set.ok && set.value.effort).toBe("low");
    expect(set.ok && set.value.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
    const unset = parseStartRunRequest(json(VALID));
    expect(unset.ok && "effort" in unset.value).toBe(false);
    expect(unset.ok && "thinking" in unset.value).toBe(false);
    for (const bad of [
      { effort: "ultra" },
      { thinking: { type: "on" } },
      { thinking: "adaptive" },
    ]) {
      expect(parseStartRunRequest(json({ ...VALID, ...bad })).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("keeps FALLBACK_MODEL verbatim and accepts its absence (ADR-0023 decision 3)", () => {
    const set = parseStartRunRequest(json({ ...VALID, fallbackModel: "fallback-under-test" }));
    expect(set.ok && set.value.fallbackModel).toBe("fallback-under-test");
    const unset = parseStartRunRequest(json(VALID));
    expect(unset.ok && "fallbackModel" in unset.value).toBe(false);
    for (const bad of [{ fallbackModel: "" }, { fallbackModel: 3 }]) {
      expect(parseStartRunRequest(json({ ...VALID, ...bad })).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts an empty egress allowlist, which means deny everything", () => {
    const result = parseStartRunRequest(withField("egressAllowlist", []));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.egressAllowlist).toEqual([]);
  });
});

describe("parseStartRunRequest rejects what would fail later and obscurely", () => {
  it("names the field when shortWaitSeconds is missing, so the poll loop never sees NaN", () => {
    const result = parseStartRunRequest(withField("shortWaitSeconds", undefined));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toContain("shortWaitSeconds");
  });

  it.each([0, -1, Number.NaN, "300", null])("rejects shortWaitSeconds %p", (value) => {
    expect(parseStartRunRequest(withField("shortWaitSeconds", value)).ok).toBe(false);
  });

  it.each([
    "runId",
    "botId",
    "botName",
    "workspaceId",
    "botHomeDir",
    "attempt",
    "trigger",
    "model",
    "cheapModel",
    "modelBaseUrl",
    "modelAuthToken",
    "gatewayBaseUrl",
    "maxTurns",
    "egressAllowlist",
    "connectors",
    "tools",
  ])("rejects a request with no %s", (field) => {
    const result = parseStartRunRequest(withField(field, undefined));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toContain(field);
  });

  // The attempt is the second half of the `(run, attempt, seq)` dedup key: a zero, a fraction or
  // a string would make a resumed process's events look like a redelivery of the first process's.
  it.each([0, -1, 1.5, "1", null])("rejects attempt %p", (value) => {
    expect(parseStartRunRequest(withField("attempt", value)).ok).toBe(false);
  });

  // A zero or negative maxTurns would end every run before its first turn; a fraction or a string
  // reaches the SDK as a number it cannot use. NaN is not listed: JSON carries it as null, which
  // is the explicit off; the Gateway never sends a non-finite value (`scheduler/run-limits.ts`).
  it.each([0, -1, 1.5, "50"])("rejects maxTurns %p", (value) => {
    expect(parseStartRunRequest(withField("maxTurns", value)).ok).toBe(false);
  });

  it.each([
    ["connectors", "not-an-array"],
    ["egressAllowlist", { host: "ops.example.test" }],
    ["tools", ["rm_rf"]],
    ["trigger", { kind: "telepathy" }],
    ["runId", ""],
    ["runId", 7],
  ])("rejects a bad %s", (field, value) => {
    expect(parseStartRunRequest(withField(field, value)).ok).toBe(false);
  });

  it.each([
    { mode: "tab-v1", deadlineAt: "2026-09-23T10:05:00.000Z" },
    { mode: "origin-v2", deadlineAt: "not-a-date" },
    { mode: "origin-v2" },
  ])("rejects invalid browser coordination %p", (browserCoordination) => {
    expect(parseStartRunRequest(withField("browserCoordination", browserCoordination)).ok).toBe(
      false,
    );
  });

  it.each(["auto", "inline", 2, null])(
    "rejects invalid browser snapshot mode %p",
    (browserSnapshotMode) => {
      expect(parseStartRunRequest(withField("browserSnapshotMode", browserSnapshotMode)).ok).toBe(
        false,
      );
    },
  );

  it("rejects an incomplete thread_message trigger", () => {
    const result = parseStartRunRequest(
      withField("trigger", {
        kind: "thread_message",
        thread: { id: "thread-1", kind: "chat", title: "Ops" },
        messages: [{ seq: 1, authorKind: "human", body: "hi" }],
        relayCount: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toContain("messages.0");
  });

  it("reports every problem, not only the first", () => {
    const result = parseStartRunRequest(json({ runId: "run-1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(3);
  });

  it("reports unparseable JSON as a root issue rather than throwing", () => {
    const result = parseStartRunRequest("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toContain("not valid JSON");
  });

  it.each(["null", '"a string"', "[]", "42"])("rejects %s, which is not an object", (raw) => {
    expect(parseStartRunRequest(raw).ok).toBe(false);
  });
});

it("preserves versioned browser execution and terminal tools across stdin", () => {
  const parsed = parseStartRunRequest(
    json({
      ...VALID,
      browserExecutionMode: "vision-cli-v2",
      tools: ["tty_session", "browser_cli_workflow"],
    }),
  );
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.browserExecutionMode).toBe("vision-cli-v2");
    expect(parsed.value.tools).toEqual(["tty_session", "browser_cli_workflow"]);
  }
  expect(parseStartRunRequest(withField("browserExecutionMode", "future")).ok).toBe(false);
});

// ADR-0013 verification row 4, static half: a start request carries a count of integration
// connections, never the runtime's URL, a token or a connection secret.
describe("integrations cross stdin as a count only (ADR-0013 item 4)", () => {
  const INTEGRATION_TOOLS = [
    "integration_apps",
    "integration_connections",
    "integration_search",
    "integration_guide",
    "integration_execute",
  ];

  it("accepts the five integration tools and a connection count", () => {
    const parsed = parseStartRunRequest(
      json({ ...VALID, integrationConnections: 2, tools: INTEGRATION_TOOLS }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.tools).toEqual(INTEGRATION_TOOLS);
      expect(parsed.value.integrationConnections).toBe(2);
    }
    expect(parseStartRunRequest(withField("integrationConnections", -1)).ok).toBe(false);
    expect(parseStartRunRequest(withField("integrationConnections", "1")).ok).toBe(false);
  });

  it("drops any runtime URL, token or key a sender adds beside the count", () => {
    const parsed = parseStartRunRequest(
      json({
        ...VALID,
        integrationConnections: 1,
        integrationRuntimeUrl: "http://integration-runtime.internal:3000",
        integrationToken: "oct_must-not-cross",
        integrationApiKey: "key-must-not-cross",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const text = JSON.stringify(parsed.value);
      expect(text).not.toContain("integration-runtime.internal");
      expect(text).not.toContain("must-not-cross");
      expect(Object.keys(parsed.value).filter((k) => /integration/i.test(k))).toEqual([
        "integrationConnections",
      ]);
    }
  });
});

// ADR-0012 verification row 2, static half: a start request names connectors, it never carries
// where they are or how to authenticate. The Gateway-side T1 test (`connector-proxy.test.ts`)
// checks the request and sandbox env a real registration produces.
describe("connectors cross stdin as names only (ADR-0012 item 2)", () => {
  const CONNECTOR_TOOLS = [
    "connector_describe",
    "connector_validate",
    "connector_submit",
    "connector_status",
    "connector_receipt",
  ];

  it("accepts the five connector tools and a list of connector names", () => {
    const parsed = parseStartRunRequest(
      json({ ...VALID, connectors: ["tickets"], tools: CONNECTOR_TOOLS }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.tools).toEqual(CONNECTOR_TOOLS);
  });

  it("rejects a connector entry that is not a plain name", () => {
    const withEndpoint = { name: "tickets", url: "http://db.internal", credential: "secret" };
    expect(parseStartRunRequest(withField("connectors", [withEndpoint])).ok).toBe(false);
  });

  it("drops any connector endpoint or credential a sender adds beside the names", () => {
    const parsed = parseStartRunRequest(
      json({
        ...VALID,
        connectors: ["tickets"],
        connectorUrl: "http://db.internal:7000",
        connectorCredential: "cred-must-not-cross",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const text = JSON.stringify(parsed.value);
      expect(text).not.toContain("db.internal");
      expect(text).not.toContain("cred-must-not-cross");
      expect(Object.keys(parsed.value).filter((k) => /connector/i.test(k))).toEqual(["connectors"]);
    }
  });
});

it("round-trips the isolated presentation job flag", () => {
  const result = parseStartRunRequest(json({ ...VALID, presentationSummary: true }));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.presentationSummary).toBe(true);
});

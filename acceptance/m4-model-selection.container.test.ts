// T2: ADR-0023 on the real stack (Gateway and its model proxy, workspace container, sidecar, Agent
// SDK 0.3.278) with a scripted upstream, no model. Test plan PROXY-01 and the live half of
// PROXY-02 (docs/design/model-selection-test-plan-2026-10-08.md).
//
// PROXY-01: the scripted model makes the bot run one `Bash` call that curls the Gateway's model
// proxy with the run's own `ANTHROPIC_AUTH_TOKEN` from the CLI's environment, once per model id:
// an id outside the run's frozen set (for `messages` and `count_tokens`), the frozen cheap model,
// the frozen fallback, and the configured `CLI_SMALL_FAST_MODEL`. The outside id gets 403
// `model_not_selected`, a `model_requests` row and no upstream call; the frozen ids are forwarded
// as they are; the small-fast id is forwarded as the cheap model with the rewrite on its row; the
// main run carries on and succeeds. Every successful row's `served_model` is the id the upstream's
// response named, which this upstream makes differ from the requested one.
//
// PROXY-02 (live half): `FALLBACK_MODEL` reaches the real CLI as `--fallback-model`, and when the
// upstream answers the primary with 529 the real SDK switches to the frozen fallback on its own,
// the proxy forwards it with its served model, and the sidecar records the retries and exactly
// one `model_switch` event for the switch.
//
// Curl with a body is L2 (`risk-tier.ts`); a stored "Always" rule for `Bash` answers it, so the
// case is about the proxy, not about the approval path.
import type { RunEvent, RunUsage } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeApprovalRule } from "./support/approvals.js";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type FakeTurn,
  type RecordedUpstreamRequest,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import {
  type RunView,
  getRun,
  newThread,
  postMessage,
  runEvents,
  threadMessages,
  waitForRun,
} from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
const TOKEN = "adr23-model-selection-fake";
const SOUL_MARKER = "ADR23_SOUL";
const SOUL = `# adr23 bot\n${SOUL_MARKER}: run the probe the message asks for.`;
const DEFAULT_MODEL = "fake-adr23";
const CHEAP_MODEL = "fake-adr23-cheap";
const FALLBACK_MODEL = "fake-adr23-fallback";
const SMALL_FAST_MODEL = "fake-adr23-small-fast";
const OTHER_MODEL = "fake-adr23-unselected";
/** What the upstream says it served: never equal to what was asked, so the ledger cannot guess. */
const served = (requested: string): string => `${requested}@served-20261010`;
const PROBE = "ADR23_PROBE";
const CURL_MARKER = "ADR23_CURL";
const OVERLOAD = "ADR23_OVERLOAD";
const OVERLOADS = 3;
const RUN_TIMEOUT_MS = 180_000;
const PRICE = { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.1, cacheCreatePerM: 1.25 };
const EFFECTIVE_FROM = "2026-01-01T00:00:00.000Z";

/** The probes the `Bash` call makes, in order: name, path, model. */
const PROBES = [
  { name: "unselected", path: "/v1/messages", model: OTHER_MODEL },
  { name: "unselected-count", path: "/v1/messages/count_tokens", model: OTHER_MODEL },
  { name: "cheap", path: "/v1/messages", model: CHEAP_MODEL },
  { name: "fallback", path: "/v1/messages", model: FALLBACK_MODEL },
  { name: "small-fast", path: "/v1/messages", model: SMALL_FAST_MODEL },
] as const;

function hasTools(body: RecordedUpstreamRequest["body"]): boolean {
  return Array.isArray(body?.tools) && body.tools.length > 0;
}

function isBot(request: RecordedUpstreamRequest): boolean {
  return hasTools(request.body) && JSON.stringify(request.body?.system ?? "").includes(SOUL_MARKER);
}

function isCurl(request: RecordedUpstreamRequest): boolean {
  return !hasTools(request.body) && request.rawBody.includes(CURL_MARKER);
}

/**
 * One shell command: a curl per probe against the proxy URL the run itself uses, each with the
 * token from the CLI's environment, the status line appended to a file and the body kept. The
 * URL is spelled out because the hook's egress check refuses a URL it cannot read; the token is
 * an environment reference because the point is that the run already has it. Then the CLI's
 * argv, which is where the SDK puts `--fallback-model`.
 */
function probeCommand(proxyBase: string): string {
  const lines = PROBES.map(({ name, path, model }) => {
    const body = JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: `${CURL_MARKER} ${name}` }],
    });
    return [
      "curl -sS",
      `-o /work/adr23-${name}.json`,
      `-w '${name} %{http_code}\\n'`,
      '-H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN"',
      "-H 'content-type: application/json'",
      "-H 'anthropic-version: 2023-06-01'",
      `--data '${body}'`,
      `${proxyBase}${path}`,
      ">> /work/adr23-codes.txt",
    ].join(" ");
  });
  return [...lines, "ps -eo args > /work/adr23-ps.txt", "cat /work/adr23-codes.txt"].join("\n");
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!available)("ADR-0023 model proxy (real Docker/SDK, scripted upstream)", () => {
  let upstream: FakeModelUpstream | undefined;
  let stack: Stack | undefined;

  beforeAll(async () => {
    upstream = await startFakeModelUpstream({
      expectedToken: TOKEN,
      reply: "",
      servedModel: served,
      script: (_turn, body): FakeTurn => {
        if (!hasTools(body)) return { kind: "text", text: assistantText("") };
        const conversation = JSON.stringify(body?.messages ?? []);
        if (conversation.includes(OVERLOAD)) {
          if (body?.model === DEFAULT_MODEL) {
            return {
              kind: "error",
              status: 529,
              type: "overloaded_error",
              message: "Overloaded",
            };
          }
          return { kind: "text", text: assistantText("ADR23_FALLBACK_REPLY") };
        }
        if (conversation.includes(PROBE)) {
          if (conversation.includes('"tool_result"')) {
            return { kind: "text", text: assistantText("ADR23_PROBED") };
          }
          const proxyBase = (stack as Stack).config.gatewayBaseUrl ?? "";
          return {
            kind: "tool_use",
            name: "Bash",
            input: { command: probeCommand(proxyBase), description: "probe the model proxy" },
          };
        }
        return { kind: "text", text: assistantText("") };
      },
    });
    stack = await startStack({
      modelBaseUrl: upstream.url,
      modelAuthToken: TOKEN,
      defaultModel: DEFAULT_MODEL,
      cheapModel: CHEAP_MODEL,
      fallbackModel: FALLBACK_MODEL,
      cliSmallFastModel: SMALL_FAST_MODEL,
      modelPrices: [DEFAULT_MODEL, CHEAP_MODEL, FALLBACK_MODEL].map((model) => ({
        model,
        ...PRICE,
        effectiveFrom: EFFECTIVE_FROM,
      })),
      label: "adr23-proxy",
      botName: "adr23bot",
      soul: SOUL,
    });
    stack.config.runTimeoutSeconds = 180;
    await storeApprovalRule(stack, stack.bot.id, { toolName: "Bash" });
  }, 180_000);

  afterAll(async () => {
    await stopStack(stack);
    await upstream?.close();
  }, 120_000);

  const cat = async (path: string): Promise<string> => {
    const s = stack as Stack;
    const result = await s.provider.exec(s.handle, { cmd: ["cat", path], timeoutMs: 15_000 });
    expect(result.exitCode, `${path}: ${result.stderr}`).toBe(0);
    return result.stdout;
  };

  it(
    "PROXY-01: a model outside the frozen set is refused 403 with a ledger row and no upstream call; frozen ids pass; small-fast is rewritten; served_model is the response's",
    async () => {
      const s = stack as Stack;
      const up = upstream as FakeModelUpstream;
      const { run } = await postMessage(s, PROBE);
      const done = await waitForRun(s, run.id, RUN_TIMEOUT_MS);
      expect(done.status, done.error ?? "").toBe("succeeded");
      const replies = await threadMessages(s);
      expect(replies.find((m) => m.runId === run.id)?.body).toContain("ADR23_PROBED");

      // The frozen set on the run row: the Gateway's models, with the fallback.
      const record = s.app.deskmates.ctx.runs.mustGet(run.id);
      expect(record.config).toMatchObject({
        model: DEFAULT_MODEL,
        cheapModel: CHEAP_MODEL,
        fallbackModel: FALLBACK_MODEL,
      });

      // What the curls got back, as the run saw it.
      const codes = await cat("/work/adr23-codes.txt");
      expect(codes.trim().split("\n")).toEqual([
        "unselected 403",
        "unselected-count 403",
        "cheap 200",
        "fallback 200",
        "small-fast 200",
      ]);
      for (const name of ["unselected", "unselected-count"]) {
        const refused = JSON.parse(await cat(`/work/adr23-${name}.json`)) as {
          code?: string;
          details?: { model?: string };
        };
        expect(refused.code).toBe("model_not_selected");
        expect(refused.details?.model).toBe(OTHER_MODEL);
      }
      for (const [name, model] of [
        ["cheap", CHEAP_MODEL],
        ["fallback", FALLBACK_MODEL],
        // The CLI's small-fast id was forwarded as the cheap model: the response names it.
        ["small-fast", CHEAP_MODEL],
      ] as const) {
        const forwarded = JSON.parse(await cat(`/work/adr23-${name}.json`)) as { model?: string };
        expect(forwarded.model, name).toBe(served(model));
      }

      // The upstream: the refused id and the small-fast id never arrived; the rest did, once each.
      const curls = up.requests.filter(isCurl);
      expect(curls.map((r) => r.body?.model)).toEqual([CHEAP_MODEL, FALLBACK_MODEL, CHEAP_MODEL]);
      expect(up.requests.some((r) => r.body?.model === OTHER_MODEL)).toBe(false);
      expect(up.requests.some((r) => r.body?.model === SMALL_FAST_MODEL)).toBe(false);
      // The CLI counts tokens on the frozen model through the proxy; the refused id's count never
      // arrives.
      expect(
        up.requests.some(
          (r) => r.url.startsWith("/v1/messages/count_tokens") && r.body?.model === OTHER_MODEL,
        ),
      ).toBe(false);
      expect(curls.at(-1)?.rawBody).toContain(`${CURL_MARKER} small-fast`);

      // The ledger: one row per request in arrival order, refusals and the rewrite included.
      const rows = s.app.deskmates.ctx.modelRequests.list(run.id);
      const refusals = rows.filter((r) => r.refusal !== null);
      expect(refusals.map((r) => [r.requestKind, r.model, r.refusal, r.servedModel])).toEqual([
        ["messages", OTHER_MODEL, "model_not_selected", null],
        ["count_tokens", OTHER_MODEL, "model_not_selected", null],
      ]);
      const forwardedRows = rows.filter((r) => r.refusal === null);
      const rewritten = forwardedRows.filter((r) => r.rewrittenFrom !== null);
      expect(rewritten.map((r) => [r.model, r.rewrittenFrom])).toEqual([
        [CHEAP_MODEL, SMALL_FAST_MODEL],
      ]);
      // Every row the proxy forwarded names a frozen id, and each one's served model is the
      // response's, never the request's.
      for (const row of forwardedRows) {
        expect([DEFAULT_MODEL, CHEAP_MODEL, FALLBACK_MODEL]).toContain(row.model);
        // A count_tokens answer names no model, so only a messages row has a served model.
        if (row.requestKind === "messages")
          expect(row.servedModel, `seq ${row.seq}`).toBe(served(row.model as string));
        else expect(row.servedModel, `seq ${row.seq}`).toBeNull();
      }
      expect(forwardedRows.map((r) => r.model)).toEqual(
        expect.arrayContaining([DEFAULT_MODEL, CHEAP_MODEL, FALLBACK_MODEL]),
      );
      // The run's own SDK turns: every one forwarded on the primary model; the upstream saw as
      // many bot turns as the ledger has primary rows.
      const botTurns = up.requests.filter(isBot);
      expect(botTurns.length).toBeGreaterThanOrEqual(2);
      expect(botTurns.every((r) => r.body?.model === DEFAULT_MODEL)).toBe(true);

      // PROXY-02 live half, first part: the real CLI was started with the frozen models.
      const ps = await cat("/work/adr23-ps.txt");
      const cli = ps.split("\n").find((line) => line.includes("--fallback-model"));
      expect(cli, ps).toBeDefined();
      expect(cli).toContain(`--fallback-model ${FALLBACK_MODEL}`);
      expect(cli).toContain(`--model ${DEFAULT_MODEL}`);
      expect(cli).toContain("--include-partial-messages");
      expect(ps).not.toContain(TOKEN);
    },
    RUN_TIMEOUT_MS + 30_000,
  );

  it(
    "PROXY-02 live half: a 529 primary makes the real SDK switch to the frozen fallback; the proxy forwards it; served model, retries and one model_switch are recorded",
    async () => {
      const s = stack as Stack;
      const up = upstream as FakeModelUpstream;
      const before = up.requests.length;
      const thread = await newThread(s, "adr23 overload");
      const { run } = await postMessage(s, OVERLOAD, thread.id);
      const done: RunView = await waitForRun(s, run.id, RUN_TIMEOUT_MS);
      expect(done.status, done.error ?? "").toBe("succeeded");
      const replies = await threadMessages(s, thread.id);
      expect(replies.find((m) => m.runId === run.id)?.body).toContain("ADR23_FALLBACK_REPLY");

      // The SDK's own choice, observed at the upstream: three 529s on the primary, then the
      // fallback, with no other id and nothing from the Gateway in between.
      const turns = up.requests.slice(before).filter(isBot);
      expect(turns.slice(0, OVERLOADS).map((r) => r.body?.model)).toEqual(
        Array(OVERLOADS).fill(DEFAULT_MODEL),
      );
      expect(turns.length).toBeGreaterThan(OVERLOADS);
      expect(turns.slice(OVERLOADS).every((r) => r.body?.model === FALLBACK_MODEL)).toBe(true);

      // The proxy forwarded every one (the fallback is in the frozen set); a failed request has
      // no served model, a successful one has the response's.
      const rows = s.app.deskmates.ctx.modelRequests
        .list(run.id)
        .filter((r) => r.requestKind === "messages");
      expect(rows.every((r) => r.refusal === null && r.rewrittenFrom === null)).toBe(true);
      const primaryRows = rows.filter((r) => r.model === DEFAULT_MODEL);
      const fallbackRows = rows.filter((r) => r.model === FALLBACK_MODEL);
      expect(primaryRows).toHaveLength(OVERLOADS);
      expect(primaryRows.every((r) => r.servedModel === null)).toBe(true);
      expect(fallbackRows.length).toBe(turns.length - OVERLOADS);
      expect(fallbackRows.every((r) => r.servedModel === served(FALLBACK_MODEL))).toBe(true);
      expect(primaryRows.length + fallbackRows.length).toBe(rows.length);

      // One `model_retry` per SDK `api_retry` message. SDK 0.3.278 sends one for the first and
      // second 529; the third raises its fallback instead of a retry.
      const events: RunEvent[] = await runEvents(s, run.id);
      const retries = events.filter((e) => e.kind === "model_retry");
      expect(retries.map((e) => [e.payload.attempt, e.payload.errorStatus])).toEqual([
        [1, 529],
        [2, 529],
      ]);

      // Exactly one `model_switch` for the switch. SDK 0.3.278 reports an overload fallback as an
      // untyped `system` / `model_fallback` message and does not call `PostModelSwitch`; the
      // sidecar records that message (`model-switch.ts`), once even if the hook also fired.
      expect(events.filter((e) => e.kind === "model_switch").map((e) => e.payload)).toEqual([
        { from: DEFAULT_MODEL, to: FALLBACK_MODEL, source: "auto" },
      ]);

      // Usage is on the fallback, priced from the table.
      const { usage } = await waitFor("the run's usage", 15_000, async () => {
        const view = await getRun(s, run.id);
        return view.usage.length > 0 ? view : undefined;
      });
      const fallbackUsage = usage.find((u: RunUsage) => u.model === FALLBACK_MODEL);
      expect(fallbackUsage?.costUsd).toBeTypeOf("number");
    },
    RUN_TIMEOUT_MS + 30_000,
  );
});

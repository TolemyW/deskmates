# Model selection and routing: research and proposal — 2026-10-08

Issue: [#10](https://github.com/TolemyW/deskmates/issues/10). Baseline inspected:
main `ee817be7574c470231927779ba6e54c8920afa77` (v0.3.2). Every `path:line`
below is on that revision. This is a research deliverable for owner review.
No production code changed, no model was called, no provider was configured.

Companion documents: [ADR-0023](../adr/0023-model-selection-policy.md) (the
proposal) and the [test plan](model-selection-test-plan-2026-10-08.md).

## 1. Summary

Today a run's model is chosen once, by a three-step precedence in the Gateway,
frozen on the run row and sent to the sidecar, which passes it to the SDK as
`options.model`. That part works and is tested. Around it there are seven
gaps, two of which matter for cost and safety before any routing exists:
`CHEAP_MODEL` is resolved and shipped but consumed by nothing, and the model
proxy forwards whatever model id the sandbox writes into the request body, so
the frozen choice is a record, not an enforced one.

The recommendation, after the owner asked for the lightweight path, is
**five small changes and no new component**: enforce the frozen models at
the proxy, rewrite the CLI's own background calls to the cheap model, run
memory consolidation on the cheap model, record the served model and every
switch or retry in the ledger, and optionally pass one fallback model to the
SDK (section 11). A selection-policy interface, shadow mode and a paired A/B
gate are deferred until a second policy exists; the five changes are the
boundary such an interface would sit on. A provider/protocol adapter in the
Gateway is not justified: protocol translation is already the upstream
gateway's job. Delegating the choice to the upstream is rejected because the
served model must be frozen and attributable per run; recording what the
upstream actually served is adopted instead. Open-source gateways and
routers are compared in section 7a; none replaces a layer we have, and one
rule is borrowed. Learned routing stays a research candidate.

## 2. Current call chain (verified)

Three questions are kept apart throughout: **which model**, **which
provider/protocol**, and **who runs the agent loop**.

### 2.1 Configuration

- `DEFAULT_MODEL` and `CHEAP_MODEL` are required, trimmed, never defaulted and
  never format-checked (`packages/gateway/src/config.ts:376-377`, `required`
  at `:211-217`). `MODEL_BASE_URL` and `MODEL_AUTH_TOKEN` name the single
  upstream (`:374-375`); the token stays in memory.
- `MODEL_PRICES` is an optional JSON price table, validated at startup
  (`config.ts:287-300`, `packages/gateway/src/ledger/model-price.ts:23-66`),
  loaded into `prices` (`packages/gateway/src/index.ts:104`), editable by the
  platform role through `PUT /api/prices`
  (`packages/gateway/src/api/price-routes.ts:11-24`).
- The operator UI sees only `defaultModel` and `cheapModel`
  (`packages/gateway/src/api/config-routes.ts:17-25`).
- Reasoning knobs (`effort`, `thinking`) travel beside the model and are
  frozen the same way (`run-lifecycle.ts:104-118`).

### 2.2 Bot override

- `bots.model` and `bots.cheap_model` are nullable text
  (`packages/gateway/migrations/0001-init.sql:35-36`). `POST /api/bots`
  accepts any non-empty string (`packages/gateway/src/api/registry-routes.ts:131-151`,
  `validate.ts:51-57`); `PATCH` clears with `null` or requires a non-empty
  string (`:176-198`). Both routes are `admin`
  (`packages/gateway/src/api/route-policy.ts:61,63`).
- There is no allowlist and no check against the price table. `POST` drops
  `model: ""` silently while `PATCH` rejects it.

### 2.3 Run snapshot and precedence

- `ctx.runConfig()` stamps the deployment defaults into every new run's
  `config_json` (`packages/gateway/src/context.ts:158-193`); the thread
  router, cron, webhooks and memory consolidation all use it.
- At first start `effectiveModels` resolves
  `run.config.model ?? bot.model ?? DEFAULT_MODEL` and the same chain for the
  cheap model, writes both back only when absent, and every later start of
  the same run reads them back
  (`packages/gateway/src/scheduler/run-lifecycle.ts:77-94`; callers at
  `:257`, `:318`, `:383`). Approval resumes and continuations go through
  `resume()` and therefore keep attempt 1's models (`:219-220`, `:399-407`).
- Pinned by `run-lifecycle.test.ts` ("the run's effective model is recorded
  on the row", six cases) and `registry-routes.test.ts` (seven PATCH cases).

### 2.4 Sidecar and SDK

- `StartRunRequest` carries `model`, `cheapModel`, optional `effort` and
  `thinking`, and the proxy address plus run token
  (`packages/contracts/src/sidecar-protocol.ts:64-79`).
- The SDK is called once per run (`packages/sidecar/src/run-once.ts:578`).
  Options set: `model`, conditional `effort`/`thinking`/`resume`, `cwd`,
  `settingSources: []`, `permissionMode`, `systemPrompt`, `env`, `maxTurns`,
  `includePartialMessages`, `disallowedTools`, `mcpServers`, `hooks`
  (`PreToolUse`, `PostToolUse`, `PreCompact`), `canUseTool` (`:514-576`).
  Not set: `fallbackModel`, `agents`, `betas`.
- `cheapModel` is schema-required (`packages/sidecar/src/start-run-request.ts:157`)
  and read nowhere else in `packages/sidecar/src`.
- The CLI environment is an allowlist; `ANTHROPIC_MODEL`,
  `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_API_KEY` and
  `CLAUDE_CODE_OAUTH_TOKEN` are deliberately not forwarded
  (`run-once.ts:116-138`, test `run-once.test.ts:1236-1293`). Nothing sets a
  subagent or small-fast model, and `Task`/`Agent` is not in
  `DISALLOWED_TOOLS` (`:72-83`), so whatever the CLI does for subagents and
  small-fast calls applies unchanged. **Which model ids those produce is
  unverified** (section 6).
- The end-of-run summary is parsed from the main run's final text, not a
  second model call (`packages/sidecar/src/summary.ts:18-34`, `:56-73`).
  The sidecar makes no model call of its own.
- The SDK session id is captured from `system/init`, assistant and result
  messages (`run-once.ts:754`, `:768`, `:829`) and stored by the Gateway per
  (bot, thread) (`packages/gateway/src/threads/sessions.ts:11-37`). No code
  checks that a resumed session's model matches the model now selected.

### 2.5 Proxy and upstream

- One upstream, `POST /v1/messages` and `POST /v1/messages/count_tokens`
  only, request and response header allowlists, Bearer replaced
  (`packages/gateway/src/model-proxy/model-proxy.ts:58-83`, `:132`).
- The body is forwarded as a raw buffer, never re-encoded and never inspected
  for enforcement (`:98-104`, `:192-196`). There is no model allowlist and no
  check against the run's frozen model.
- Every request writes a `model_requests` row with the body's `model`,
  `system_sha256`, `stream` and the usage read from the response stream
  (`packages/gateway/migrations/0015-model-requests.sql`,
  `packages/gateway/src/ledger/model-requests.ts:67-100`,
  `response-usage.ts:4-8,120-128`). These rows are not priced and are not
  reconciled with `run_usage`.
- No retry and no fallback in the proxy; `retry-after` and `x-should-retry`
  pass through (`model-proxy.ts:80-81`, `:223-226`). Unreachable upstream is
  502 `upstream_unavailable` (`:204-210`).
- Run tokens are per run, hashed, TTL-bound and revoked at end or park
  (`packages/gateway/src/secrets/run-tokens.ts:38-60`,
  `run-lifecycle.ts:799-802`).

### 2.6 Usage, pricing, alerts

- The sidecar reports `RunEnded.usage` from the SDK result's `modelUsage`,
  one entry per model key (`run-once.ts:210-228`, `:832`); `costUSD` is
  ignored by design (`:4`). Per-response `turn_usage` events carry
  `message.model` (`packages/sidecar/src/turn-usage.ts:121-131`).
- The Gateway prices each (run, attempt, model) from the newest price row in
  force at `run.startedAt ?? run.createdAt`
  (`packages/gateway/src/ledger/pricing.ts:29-46`, `usage.ts:80-102`). An
  unknown model prices as `null`, never zero, and emits `pricing_missing`.
  Session-cumulative counts are turned into per-run deltas keyed
  (bot, thread, model, session) (`usage.ts:135-160`).
- Cost alerts (`known_cost`, `unpriced_usage`) only notify (ADR-0018;
  `packages/gateway/src/ledger/cost-alerts.ts:86-105`, `:182-216`).
- Tenancy: model config and the price table are installation-wide;
  `run_usage` and `model_requests` have no `tenant_id` and are scoped by
  joining through bots and workspaces (`costs.ts:47-51`). Tenant quotas cover
  queue, request rate, streams and desktop connections, not tokens or dollars
  (`packages/gateway/src/tenancy/quotas.ts:1-18`).

### 2.7 Retry ownership today

| Layer | Retries a failed model call? |
|---|---|
| SDK/CLI | Yes, internally; each retry is visible as a `system`/`api_retry` message with `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (`sdk.d.ts:3383-3396`). The sidecar does not currently log these as a ledger event. |
| Sidecar | No. A throw from `query()` ends the run `failed` (`run-once.ts:582-608`). |
| Proxy | No. |
| Scheduler | Retries sandbox preparation once, before any model call (`scheduler.ts:443-477`); never requeues a failed run. |

So there is exactly one retry owner already, the SDK. The proposal keeps it
that way.

## 3. Gap list

| # | Gap | Evidence | Why it matters |
|---|---|---|---|
| G1 | `CHEAP_MODEL` is dead configuration: resolved, frozen, validated by the sidecar schema, consumed by nothing. Memory consolidation runs on the main model. | `start-run-request.ts:157`; `consolidation.ts:116-138` goes through `startTrigger` | Every background job pays the main model's price; the operator believes otherwise. |
| G2 | The proxy does not enforce the frozen model. The run token is in the CLI's environment, so a `Bash` tool call inside the sandbox can `curl` the proxy with any model id on the upstream. | `model-proxy.ts:98-104`, `:192-196`; env at `run-once.ts:507-508` | Cost and attribution: a prompt-injected run can switch to the most expensive model; `run_usage` still prices it, but the choice was never the Gateway's. |
| G3 | No model allowlist on bot create/patch. | `registry-routes.ts:131-198` | A typo makes a bot unpriced (`pricing_missing`) at its next run instead of failing at edit time. |
| G4 | No fallback. An overloaded upstream fails the run. | `run-once.ts:514-519` sets no `fallbackModel`; proxy has none | Reliability dimension "robustness: faults" (measurement §3.4) is unmeasured for model outages. |
| G5 | Subagent and small-fast model ids are unknown. | `settingSources: []`, no `agents`, `Task` allowed | Hidden calls may use a model id that is unpriced, or the main model where a cheap one was intended. |
| G6 | A resumed thread session may run on a different model than it started on, silently. | `sessions.ts:11-37`; no check in `run-lifecycle.ts` or `run-once.ts` | Transcript, thinking-block and cache compatibility across models is unverified (section 5). |
| G7 | `model_requests` (what the proxy saw) and `run_usage` (what the SDK reported) are never reconciled; the proxy does not record the model the upstream actually served. | `model-requests.ts:67-100`; `response-usage.ts` reads usage only | A silent upstream alias change is invisible, although measurement §4.1 requires `served_model` to be held fixed. |
| G8 | Pricing time on a resumed attempt is the resume time, not attempt 1's start. | `run-lifecycle.ts:385-388` resets `startedAt`; `:483` prices at it; comment at `usage.ts:56` says otherwise | Only matters when a price row changes while a run is parked; document or fix. |
| G9 | The fake SDK cannot emit multi-model `modelUsage`, `api_retry`, model-switch hook events or nested subagent streams. | `packages/testkit/src/fake-sdk/fake-sdk.ts:261-275`, `:624` | Any routing behaviour would be untestable at T0/T1 until the fake grows. |

## 4. SDK and protocol facts (primary sources)

Read from the installed `@anthropic-ai/claude-agent-sdk` 0.3.278 typings
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`).

| Fact | Source |
|---|---|
| `fallbackModel?: string`, comma-separated list tried in order "if the primary model is overloaded or unavailable"; the primary is re-tried at the start of each user turn. | `sdk.d.ts:1607-1612` |
| Mid-session switch is `Query.setModel(model?)`, streaming-input mode only. | `sdk.d.ts:2720` |
| Hook events `PreModelSwitch` and `PostModelSwitch` carry `from_model`, `to_model`, `requested_model` and `source`; `PostModelSwitch.source` includes `auto` (automatic fallback) and `resume`. | `sdk.d.ts:891`, `:2471-2490`, `:2592-2612` |
| Result `modelUsage` is keyed by the model id that served requests; each entry has token kinds, `costUSD`, `contextWindow`, and optional `canonicalModel`, `provider` and `costBasis: 'list' \| 'managed' \| 'unknown'`. | `sdk.d.ts:1361-1384` |
| Each assistant message echoes `message.model`. | `sdk.d.ts:3410`; Anthropic SDK `BetaMessage.model` |
| `AgentDefinition.model` accepts an alias, a full id, `'inherit'` or nothing ("default subagent model when configured, else the main model"); `effort` is per agent. | `sdk.d.ts:38-104` |
| SDK retries are automatic and visible as `SDKAPIRetryMessage`; no option disables them. | `sdk.d.ts:3383-3396` |
| `betas` exists (`context-1m-2025-08-07`, Sonnet-class only). | `sdk.d.ts:1644` |

Representative routing approaches, read for the comparison in section 7:

- **RouteLLM** (Ong et al., ICLR 2025, [arXiv:2406.18665](https://arxiv.org/abs/2406.18665)):
  a learned router between one strong and one weak model trained on
  preference data; reports more than 2× cost reduction at equal quality on
  public benchmarks and transfer when the model pair changes. It is a
  per-request classifier, which assumes requests are independent; Deskmates
  requests are turns of one session.
- **LiteLLM Router** ([docs](https://docs.litellm.ai/docs/routing)): client-side
  deployments list with retries, cooldown after `allowed_fails`, ordered
  fallbacks and context-window fallbacks. Routing lives in the caller, which
  is where our Gateway proxy sits.
- **OpenRouter** ([model routing](https://openrouter.ai/docs/guides/routing),
  [fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)):
  server-side `models` fallback list, any error can trigger fallback, the
  response's `model` field names what was used and pricing follows it; an
  `auto` router model id delegates the choice. This is the shape of option 4.

Unverified after this research (kept explicit): whether `fallbackModel`
also fires on HTTP 429; whether the Anthropic prompt cache is keyed on model
(assumed yes); whether thinking blocks produced by one model are accepted as
history by another on the internal gateway; which model ids the CLI's
built-in subagents and small-fast tasks request. Section 6 turns the last
one into a zero-code check.

## 5. Context continuity and session semantics

The "under the proposal" column describes the full design; of it, only the
automatic-fallback row and the frozen-config row are in the lightweight set
(section 11). The cross-run switch record and the capability filter are
deferred with the interface.

| Situation | Today | Under the proposal |
|---|---|---|
| Model change between runs of the same thread (bot re-pointed) | Resumes the old session on the new model with no record | Allowed; the Gateway writes a `model_switch` event with `source: resume` and the two ids; the run row records both. Compatibility is a measured question (test plan C-04). |
| Model change inside one run | Only by SDK automatic fallback, invisible | Visible through `PostModelSwitch` → `model_switch` event with `source: auto`; `run_usage` already prices by actual model. No Gateway-initiated mid-run switch; `setModel` is not used. |
| Resume with frozen config after approval `defer` | Frozen (`effectiveModels`) | Unchanged. The fallback list is frozen with it. |
| Cache | Unverified whether keyed on model; assumed yes | Fallback is expected to cost a cache-create on the first fallback turn; the test plan measures `cacheCreate` around switches rather than assuming. |
| Vision, tool calling, structured output | Whatever the upstream gateway's model supports; nothing declares capabilities | A policy output must satisfy the run's declared requirements (`vision` when browser snapshots are on, context window ≥ configured max); unsupported combinations fail closed at selection, not mid-run. |
| Compaction | `PreCompact` hook flushes memory (`run-once.ts:567`) | Unchanged. |

## 6. Zero-code checks that precede any implementation

These need no new code and no new budget beyond one ordinary run; they close
G5 and sharpen G7.

1. **Hidden-call inventory.** On the Testbox stable deployment, pick one
   completed run that used the `Task`/`Agent` tool and one that compacted,
   then list `SELECT DISTINCT model, request_kind FROM model_requests WHERE
   run_id = ?`. Any model id other than the run's frozen `model` is a hidden
   consumer. Record the ids in the follow-up; if one is unpriced, the price
   table is the first fix.
2. **Reconciliation sample.** For the same runs compare `SUM(input_tokens)`
   per model in `model_requests` with `run_usage`. A mismatch is G7 evidence.
3. **Served model.** Inspect one stored response `message_start` for its
   `model` field against the request body. The proxy can record this in the
   same observer that reads usage.

### 6.1 Result of checks 1 and 2 (2026-10-08, read-only, no model called)

Sources, all opened read-only on copies: the stable deployment's database
copy `upgrade-receipts/v0.3.2/pre-migration.sqlite` (18 runs, all from
2026-09-29) and the 2026-10-06 functional round's ledgers under
`deskmates-reusable-release-20261006-19e7ec04` (7 GLM-5.3 runs, 32 proxy
requests: 6 in `scenario-results`, 26 in the group ledger).

| Question | Finding |
|---|---|
| Any `model_requests` row whose model differs from the run's frozen `model`? | None. All 32 requests name `glm-5.3`, each run's frozen model. |
| Any `count_tokens` or other request kind? | None; all 32 are `messages`. |
| Any run that used the `Task`/`Agent` tool? | None, in either source. Tools seen: `Bash`, `Write`, `Edit`, `Read`, browser MCP tools, `thread_post`. |
| Stable database `model_requests` | 0 rows: its 18 runs predate proxy recording on that deployment, and no run has started since 2026-09-29. |
| Stable `DEFAULT_MODEL` versus `CHEAP_MODEL` | Both `deepseek-v4.1-flash` on every stable run, so change #1 would change nothing there until the cheap model is configured differently. |

So the hidden-call hypothesis (G5) is **not observed** in the evidence at
hand: with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set and no subagent
or compaction in these runs, the CLI made no request on another model id.
This does not prove it never does; a run that uses `Task` or compacts is
still needed to close G5. Consequence for change #2: there is no small-fast
id to rewrite yet, so the proxy rule is simply "frozen set or 403"; the
rewrite is added only if a later ledger shows such an id. One ledger file in
the 10-06 root could not be opened because its directory is read-only to
SQLite; it was not read and is not counted.

Side observation, outside this issue's scope: on the stable runs,
cache-create tokens dominate cost (one run priced at 1.05 USD carried 3.4 M
cache-create tokens against 1.7 k input). Worth its own look.

## 7. Options compared

Baseline is "keep what exists": fixed per-bot override over a deployment
default, frozen per run, no fallback.

| Criterion | (0) Baseline | (1) Minimal internal policy | (2) Replaceable policy interface | (3) Provider/protocol adapter in Gateway | (4) Routing delegated upstream |
|---|---|---|---|---|---|
| What it decides | which model, statically | which model per run kind, plus fallback list | same as (1) behind a named contract | which upstream/protocol per model id | nothing locally; upstream picks |
| Complexity | none | one function, one table | one interface, one implementation, policy id in ledger | per-upstream credentials, header/body translation, streaming shapes | tiny client change |
| SDK compatibility | fine | `fallbackModel` is a supported option | same | SDK sees one base URL regardless | same |
| Observability | run row only | run row + reason | run row + reason + policy version + switch events | adds upstream id per request | served model must be read back from the response; the choice is not reproducible |
| Security | G2 open | G2 closable if paired with proxy enforcement | same | a second credential class in the Gateway; new trust domain per upstream | upstream chooses models the price table may not list |
| Operating cost | known | enables cheap model for background jobs | same, and can be measured per policy version | more images/secrets to operate | lowest engineering cost |
| Migration / reversibility | n/a | reversible by config | reversible by selecting `fixed-v1` | hard to remove once credentials are spread | reversible per request |
| Fit with architecture rules | fine | fine (Gateway stays thin: table lookup, no model call) | fine if in-process only | conflicts with "control plane is thin" and with ADR-0010 egress shape | conflicts with "model is configuration" and with frozen per-run attribution |

**Verdict.** (1), reduced further to the five changes in section 11: the
run-kind mapping is one enumerated list, not an interface. (2) is deferred
until a second policy exists; its contract is kept below in section 8 so it
can be added without touching the five changes. (3) rejected for the Gateway
(it is what the internal Anthropic-protocol gateway already does). (4)
rejected as the mechanism, but its one useful idea, recording the served
model, is adopted. Rules-based selection beyond run kind, and learned
routing, are future work that must pass the paired A/B protocol before
becoming a default.

Where pluggability is justified and where it is not:

| Question | Extension point? | Reason |
|---|---|---|
| Which model | Not now; later, one in-process interface chosen by name, when a second policy exists | Today one enumerated job-kind list is enough; an interface with one implementation is cost without a consumer |
| Which provider / protocol | Never in the Gateway | The upstream gateway owns it; the proxy stays single-upstream |
| Who runs the agent loop | Never | ADR-0002: the sidecar is the SDK host |
| Dynamic plugin loading, marketplace | Never | No requirement; a security surface |

### 7a. Open-source components, by layer

The owner asked whether an existing component can be used directly. Each
one covers one layer; none covers the chain.

| Component | Layer | What it would give | Why not adopt now |
|---|---|---|---|
| LiteLLM proxy ([routing](https://docs.litellm.ai/docs/routing), virtual keys with `models`, `max_budget`, `duration`, `tpm/rpm`, spend logs) | proxy/gateway | per-key model allowlist, hard budgets, expiry, fallbacks with cooldown, spend tracking | A Python service plus Postgres and Redis; a second holder of the upstream credential (today it lives only in Gateway memory); a key-creation call per run start; its own price table beside ours, while measurement §4.1 needs ours; `model_requests` attribution (`attempt`, `seq`, `system_sha256`) would have to stay in a proxy of our own anyway. Several 2026 comparisons describe it as "under remediation"; not verified here. Worth it only for per-tenant hard budgets, which ADR-0022 keeps soft for now. |
| Bifrost, Portkey gateway, Kong AI gateway | proxy/gateway | same category, Go or Lua; enterprise tiers | Same trade-offs as LiteLLM; same conclusion. |
| claude-code-router ([overview](https://claudelog.com/claude-code-mcps/claude-code-router)) | request router for Claude Code specifically | per-request rewrite by six rules: `default`, `background`, `think`, `longContext`, `webSearch`, `image`; `background` catches the CLI's own summary/compaction/title calls | A per-developer local proxy with no run scope, token check or ledger. Its `background` rule is the one thing we lack and is adopted as the small-fast rewrite in ADR-0023 decision 1; its `longContext` rule uses token counts, not content, so it is admissible later. |
| RouteLLM ([arXiv:2406.18665](https://arxiv.org/abs/2406.18665)) | learned strong/weak selector | pretrained routers and an OpenAI-compatible server; >2× cost reduction on its benchmarks | Trained on GPT-4 versus Mixtral preferences; must be recalibrated on our model pair and task set; classifies per request, not per session; must read the prompt, which needs its own ADR on admissible inputs. The S5 candidate, nothing earlier. |
| The SDK itself (`fallbackModel`, `agents[].model`, `PostModelSwitch`) | agent loop | fallback, per-subagent model, switch visibility | Already installed; this is what the five changes use. |
| The internal Anthropic-protocol gateway behind `MODEL_BASE_URL` | upstream | may already offer fallback or an `auto` alias | Ask the gateway team before building fallback; if it exists, `FALLBACK_MODEL` stays unset. |

## 8. Deferred contract (kept for the day a second policy exists)

Not part of ADR-0023 as proposed. Retained so the interface can be added on
top of the five changes without redesign.

Inputs the policy may read: deployment config (`DEFAULT_MODEL`,
`CHEAP_MODEL`, `MODEL_ALLOWLIST`, price table), bot overrides, run kind
(`chat`, `bus`, `cron`, `webhook`, `memory_consolidation`, `approval`,
`continuation`), lane, attempt number, tenant id, declared requirements
(vision, context window). Inputs it may never read: prompt text, thread
messages, tool output, webhook bodies, anything a bot wrote. Routing
authority never comes from untrusted content.

Output: `{ model, cheapModel, fallbackModels: string[], policyId,
policyVersion, reason }`, every id in the allowlist, recorded in
`runs.config_json` at first start and frozen for the run. The proxy accepts a
request only if its body model is in the run's frozen set.

Ownership: platform maintains the allowlist and price table; tenant admins
set bot overrides within the allowlist; nobody edits a running run's set.

## 9. Predeclared thresholds and decision rule

These apply to any future policy that changes which model an interactive
run gets; the lightweight set changes only background jobs and enforcement,
so it is judged by the T0/T1/T2 cases and the replay diff, not by this rule.
Declared now, before any trial, per measurement §4.3 and the issue's order
of precedence:

1. **Quality floor first.** A candidate policy is adoptable only if the
   paired comparison against `fixed-v1` on the deployed model is not
   "worse" in total nor in any duration bucket (δ = 0.10, 95% interval,
   K = 5, 44 verdict tasks; MDE stated at the top of the report).
2. **Critical safety failures = 0**: unapproved L2, egress outside the
   allowlist, credential in the ledger, request with a model outside the
   frozen set, unpriced usage.
3. **Then cost**: cost per successful task at least 15% lower (δ_cost) with
   the interval excluding zero; tokens by kind reported per model.
4. **Then latency**: end-to-end and model p95 not worse than 15%; routing
   overhead (policy evaluation) p95 under 20 ms, measured in the Gateway
   with no model call.
5. **Reliability**: fallback rate, SDK retry count, failure rate reported;
   a fallback rate above 20% over the campaign is a stop regardless of cost.
6. Failed and partial attempts, every physical call and every fallback
   count; unknown usage stays unknown.

Sample size: the existing defaults detect a 10-point regression at 80% power
and cannot detect 5 points (`evals/power.ts`). A policy whose claimed benefit
is cost, not quality, is judged on the cost interval with the quality floor
as a gate, so the quality test is one-sided against regression.

## 10. Rollout and rollback

Each of the five changes in section 11 is its own small commit and reverts
on its own. None changes a running run: the frozen set on the run row is
what the proxy checks, so a Gateway restart mid-run keeps the same
behaviour for in-flight and parked runs. The consolidation change is the one
intended decision diff that replay will report; it is declared with the
commit. Shadow mode and canary pinning belong to the deferred interface and
are not built.

## 11. The lightweight set (five changes, for separate approval)

| # | Change | Where | Size | Closes |
|---|---|---|---|---|
| 0 | Ledger check, no code: list distinct `model` and `request_kind` in `model_requests` for one run that used `Task` and one that compacted, on the Testbox stable database | one SQL | 0 | G5: names the small-fast id that #2 must rewrite, or shows there is none |
| 1 | Consolidation writes `model: cheapModel` into its run config at creation; the enumerated background job kinds live in one list | `packages/gateway/src/memory/consolidation.ts:116-138` | about 3 lines, one test | G1 |
| 2 | Proxy checks the parsed body `model`: equal to the run's `model` or `cheapModel` forwards; anything else is 403 `model_not_selected` with a ledger row, `count_tokens` included. The small-fast rewrite is added only if a ledger ever shows such an id (§6.1 found none) | `packages/gateway/src/model-proxy/model-proxy.ts`; the id is already parsed in `request-facts.ts:44-46` | about 20 lines, T0 cases, one T2 | G2, G5 (as observed) |
| 3 | Proxy reads `model` from the response `message_start` into a new `model_requests.served_model` column | `response-usage.ts` already parses that event; one forward-only migration | about 15 lines | G7 |
| 4 | Bot routes refuse a `model`/`cheapModel` with no price row, consistently on `POST` and `PATCH` | `registry-routes.ts:131-198` | about 10 lines | G3 |
| 5 | Optional: `FALLBACK_MODEL` in Gateway config, carried in `StartRunRequest`, set as `options.fallbackModel`; `PostModelSwitch` forwarded as `model_switch`, `api_retry` as `model_retry` | gateway config, contracts, `run-once.ts:514-519` | about 40 lines; fake SDK must emit the hook and message | G4, part of G6 and G9 |

Change #5 is built only if the internal gateway exposes a second
acceptable model id (or already provides fallback itself, in which case it
is skipped). G6 (silent cross-model resume) and G8 (pricing time on resume)
stay open by decision and are listed for the deferred interface.

Not built: `SelectionPolicy`, `MODEL_POLICY`, shadow mode, A/B tooling for
policies. They are needed only when a second policy exists.

## 12. Unresolved questions for the owner

1. Change #0 is done on the evidence at hand (§6.1): no foreign model id,
   no `Task` use. Is one deliberate run that uses `Task` and one that
   compacts worth scheduling to close G5, or is "frozen set or 403" enough
   until a ledger shows otherwise?
2. Is there a second acceptable model id on the internal gateway, or does
   the gateway itself fall back? Decides whether #5 exists.
3. Confirm the allowlist source is the price table (change #4), so an
   unpriced model cannot be set on a bot at all.
4. Whether the five changes go in one PR or five; the recommendation is
   five commits in one PR, each revertible.

# Model selection: test design — 2026-10-08

Companion to [ADR-0023](../adr/0023-model-selection-policy.md) and the
[research document](model-selection-research-2026-10-08.md). Issue #10.
Every case below is a requirement. As of 2026-10-10 these have run, with the
files, images and sources recorded in ADR-0023's Verification table: at
T0/T1 SEL-02, SEL-04, SEL-06 (as a selection replay; `npm run replay` on a
trace corpus has not), SEC-01 to SEC-04, SEC-06, FB-01 (a single id; a comma
list is refused), FB-02 to FB-05, FAULT-01 to FAULT-03, FAULT-09 and
FAULT-10; at T2 PROXY-01 and the live half of PROXY-02 for `fallbackModel`,
`includePartialMessages` and the served model (not `effort`, `thinking` or
`resume`). No other case has run: SEC-05, FAULT-04 to FAULT-08, every
real-model case (C-01 to C-04, AB-01, AB-02) and every deferred case. ADR-0023
covers the lightweight set (research §11); the cases that belong
to the deferred selection-policy interface (SEL-01, SEL-03, SEL-05, FRZ,
CONT, SHD, AB, FAULT-05) are kept here, marked *deferred* in section 7, so
the interface can be added later without a new plan. Tiers follow the
[test strategy](test-strategy-2026-09-20.md): T0/T1 use the fake SDK and the
fake provider, T2 uses real Docker and the workspace image with no model, T3
uses a real model on the golden site, T4 is the paired model-in-the-loop
measurement. Offline evidence and real-model evidence are kept in separate
sections and never summed.

## 1. Fixtures and prerequisites

| Fixture | Purpose | Status |
|---|---|---|
| Fake SDK extensions (`packages/testkit/src/fake-sdk`) | emit multi-model `modelUsage`, `system/api_retry` messages, `PreModelSwitch`/`PostModelSwitch` hook calls with `source: auto \| resume`, nested `parent_tool_use_id` streams, `message.model` per assistant message | not implemented; gap G9 |
| Two-model price table | `test-model-default`, `test-model-cheap`, `test-model-fallback`; one unpriced id `test-model-unlisted` | extend `harness.ts` |
| Policy fixtures | `fixed-v1` config; a deterministic `rules-test` policy that maps run kind and lane to ids; a `throwing-test` policy and a `slow-test` policy for failure cases | new |
| Golden site task subset | deskbench v1.1 short+medium (44), plus the 4 long smoke tasks; routing development cases are a separate held-out list (`evals/tasks/routing-dev.json`, to be generated, never in the verdict set) | partly exists |
| Fault injection | the test strategy §5 list: 429, 5xx, 529 overloaded, timeout, malformed and partial SSE, context overflow, unavailable model, missing price row, Gateway restart mid-run | fake upstream in `model-proxy.test.ts` can be extended |

## 2. T0/T1 deterministic cases

### Selection (SEL)

| Id | Case | Expected | Oracle |
|---|---|---|---|
| SEL-01 | `fixed-v1` precedence: run config, bot override, default | same ids as `effectiveModels` today for `chat`, `bus`, `cron`, `webhook`, `approval`, `continuation` | run row `config.model`, `cheapModel`, `policyId`, `policyVersion`, `reason` |
| SEL-02 | run kind `memory_consolidation` | `model` equals `cheapModel` | run row; `StartRunRequest.model` |
| SEL-03 | capability filter | a run declaring `vision` or a context window the id cannot satisfy fails closed at selection with `model_unsuitable`; no run starts | run status `failed`, ledger reason |
| SEL-04 | untrusted inputs | prompt text, thread messages, tool output and a webhook body containing `model: <other>` directives change nothing | selection equal with and without the directive |
| SEL-05 | unknown `MODEL_POLICY` name, policy throws, policy exceeds its time budget | Gateway refuses to start (unknown name); a throwing or slow policy fails the run closed with a ledger reason and never falls back to an unlisted id | startup error; run `failed` |
| SEL-06 | `fixed-v1` on an existing trace corpus | replay diff is empty except on consolidation runs | `npm run replay` report |

### Freezing and precedence (FRZ)

| Id | Case | Expected |
|---|---|---|
| FRZ-01 | approval `defer` then resume after the bot is re-pointed and the policy changed | attempt 2 uses attempt 1's full set and policy version |
| FRZ-02 | continuation after `turns_exhausted` | same as FRZ-01 |
| FRZ-03 | price row changes while a run is parked | pricing time rule is the documented one (attempt start); the choice is recorded explicitly and tested |

### Fallback and switches (FB)

| Id | Case | Expected |
|---|---|---|
| FB-01 | `fallbackModels` of length 0, 1, 2, 3 | 0 and 1 and 2 are passed as the comma-joined `fallbackModel`; 3 is rejected at selection |
| FB-02 | fake SDK emits `PostModelSwitch` with `source: auto` | one `model_switch` ledger event with `from`, `to`, `source`; `run_usage` has two model rows, both priced |
| FB-03 | fake SDK emits three `api_retry` messages then succeeds | three `model_retry` events with `attempt`, `error_status`, `retry_delay_ms`; run succeeds |
| FB-04 | fallback id is unpriced | selection rejects it (allowlist) rather than letting usage go `pricing_missing` |
| FB-05 | T1 proxy observer records the response's `model` as `served_model`, for streaming and non-streaming bodies | `model_requests.served_model` equals the fixture's response model; absent on upstream failure, never guessed |

### Continuity (CONT)

| Id | Case | Expected |
|---|---|---|
| CONT-01 | stored session model `A`, new selection `B` | run row records `sessionModel: A`, `model: B`; `model_switch` with `source: resume` written before `query()` |
| CONT-02 | continue versus restart knob | `continue`: `resume` passed; `restart`: no `resume`, new session id stored; both recorded in `config_json` |

### Shadow and canary (SHD)

| Id | Case | Expected |
|---|---|---|
| SHD-01 | `MODEL_POLICY_SHADOW=rules-test` | `shadowSelection` on the run row; `StartRunRequest.model` is the active policy's; fake SDK sees exactly one `query()` |
| SHD-02 | shadow policy throws | active run unaffected; `shadow_error` recorded |
| SHD-03 | canary pin on one bot | that bot's runs carry `policyId: rules-test`, others `fixed-v1` |
| SHD-04 | rollback: policy env changed, Gateway restarted with a parked run and a queued run | parked run resumes on its frozen set; queued run selects under the new policy; both facts on the rows |

## 3. Contract and security cases (SEC, PROXY)

| Id | Tier | Case | Expected |
|---|---|---|---|
| SEC-01 | T1 | proxy request whose body model is outside the run's frozen set; also `count_tokens` | 403 `model_not_selected`, `model_requests` row with the rejected id, nothing forwarded upstream |
| SEC-02 | T0 | prompt-injected routing directive in page content, tool output and a bot-to-bot message (injection corpus) | no change in selection or in the frozen set; existing untrusted wrapping unchanged |
| SEC-03 | T1 | `POST`/`PATCH /api/bots` with a model outside the allowlist; empty string on both | 400 on both routes consistently; today's `POST` silent drop removed |
| SEC-04 | T1 | missing, expired, revoked run token with a valid model | 401 as today (`operator-auth.test.ts` style), unchanged |
| SEC-05 | T1 | tenant A's bot override cannot name a tenant-private price row (price table is installation-wide); cost report for tenant A excludes tenant B's `model_switch`/`model_retry` events | tenant scoping holds for the new events |
| SEC-06 | T0 | ledger events never contain the run token, upstream token or prompt text | redaction tests extended to the new events |
| PROXY-01 | T2 | real workspace image: a `Bash` tool call `curl`s the proxy with a different model id using the run's own env token | 403 at the proxy; event in the ledger; the main run continues |
| PROXY-02 | T2 | `sdk-shape.container.test.ts` extended to pin `fallbackModel`, `effort`, `thinking`, `resume`, `includePartialMessages` | compile-time assignability and the live option set agree |

## 4. Fault matrix (FAULT)

Run at T1 against the fake upstream, with the T2 variant where the row says so.

| Id | Fault | Expected |
|---|---|---|
| FAULT-01 | 529 overloaded on primary, fallback configured | SDK switches; `model_switch(auto)`; usage priced on both ids; no duplicate tool side effect (the fake tool ledger shows each tool call once) |
| FAULT-02 | 429 on primary | SDK retries per its policy; `model_retry` events; whether fallback fires is recorded as observed, not assumed |
| FAULT-03 | 5xx / timeout / no first byte | `model_retry` events; after exhaustion the run fails with the upstream error class; no Gateway retry |
| FAULT-04 | malformed or partial SSE | usage absent for that request, never zero; run outcome per the sidecar's existing handling |
| FAULT-05 | context overflow | fail closed with the SDK's error; no automatic switch to a larger model unless the policy declared one |
| FAULT-06 | unavailable fallback too | run fails; both ids in the ledger |
| FAULT-07 | missing price row for the served model | `pricing_missing` event; `unpriced_usage` alert; cannot happen for a selected id (SEL/FB-04), can only happen for an upstream alias change caught by `served_model` |
| FAULT-08 | Gateway restart mid-run, then approval resume | frozen set survives; `served_model` continuity across attempts |
| FAULT-09 | fallback after a tool already executed | the tool's effect is committed once; the next request carries the tool result to the fallback model; verified with the fake tool ledger and, at T2, a file the tool wrote |
| FAULT-10 | `model_not_selected` 403 mid-run | SDK treats it as a non-retryable client error; run fails with the reason; no loop |

## 5. Real-model cases (T3/T4), separately scoped

These need a model endpoint, an approved scope and a budget. None is
requested by this plan.

| Id | Case | Evidence |
|---|---|---|
| C-01 | Hidden-call inventory on one `Task`-using run and one compacting run | distinct `model` and `request_kind` in `model_requests`; every id priced or listed as a finding |
| C-02 | `served_model` equals the requested id across a run | zero mismatches, or the mismatch is the finding |
| C-03 | fallback on the deployed gateway, if a second id exists | one induced overload (or a deliberately wrong primary id) shows `model_switch(auto)` and per-model pricing |
| C-04 | cross-model resume on one thread (continue vs restart) | transcript accepted or the exact upstream error; cache-create delta around the switch; task outcome |
| AB-01 | paired A/B `fixed-v1` vs candidate per measurement §5.2 | report with MDE, per-bucket verdicts, safety count, cost and latency intervals, fallback rate |
| AB-02 | offline shadow analysis before AB-01 | agreement rate and price-table-implied cost delta from the ledger alone |

### Case coverage required of AB-01

Simple extraction/summary, multi-step tool use, long-context browser work
with vision, consolidation, ambiguous requests, approval and continuation,
and degraded upstream variants. For every case: expected output or artifact,
forbidden side effects (`allowed_paths`), and the evidence file. Routing
development cases live in a separate held-out list and never enter the
verdict set.

### Predeclared thresholds

As in ADR-0023 decision 7 and research §9: quality floor first (δ = 0.10,
per bucket), critical safety failures zero, cost per successful task
(δ = 15%), latency p95 (15%), routing overhead p95 under 20 ms, fallback
rate above 20% is a stop. K = 5, 44 verdict tasks, MDE at the top of the
report, long tasks reported per task only.

## 6. Evidence rules

- Every T3/T4 run records input, output, cache-read and cache-create tokens
  per model; a missing field is unknown, never zero.
- Every physical attempt, retry, fallback and rejected request counts.
- Fake and contract evidence is reported in its own table; real-model
  evidence in its own; no total is formed across them.
- A trace that catches a routing regression is committed under
  `evals/traces/` next to the fix.

## 7. Mapping to ADR-0023

| Decision | Cases |
|---|---|
| 1 proxy enforcement and bot validation | SEC-01, SEC-03, FB-04, FAULT-10, PROXY-01, C-01 |
| 2 background jobs on the cheap model | SEL-02, SEL-04, SEL-06 |
| 3 served model, switches, retries, optional fallback | FB-01..03, FB-05, FAULT-01..03, FAULT-09, PROXY-02, C-02, C-03 |
| deferred (selection-policy interface) | SEL-01, SEL-03, SEL-05, FRZ-01..03, CONT-01..02, SHD-01..04, FAULT-05, C-04, AB-01..02 |

Case SEC-02 (prompt-injected routing directives) applies to decision 1 as
well: a directive in page content cannot change the frozen set, because the
proxy checks the row, not the request's intent.

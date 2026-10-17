# Multi-model and multimodal configuration: current state, design and test plan — 2026-10-14

Status: **proposal for owner review** (issue #115). Research and design only. No code, provider
setup, credential, model call, paid experiment or deployment was made for this document, and it
amends no ADR. Where it proposes a decision, a later ADR (or ADR amendment) must record it with a
Verification table before any implementation (ADR-0001).

Source: repository at `26d0c1cc` (v0.6.7). Builds on ADR-0002, ADR-0014 amendment A4, ADR-0021
amendment 3, ADR-0023 (decisions 1-3, amendments 1-2), ADR-0032, and the research in
[model-selection-research-2026-10-08.md](model-selection-research-2026-10-08.md),
[model-selection-test-plan-2026-10-08.md](model-selection-test-plan-2026-10-08.md) and
[vision-protocol-check-2026-09-28.md](vision-protocol-check-2026-09-28.md).

## Evidence markers

Every factual statement carries one of these:

- **[src]** read in source at `26d0c1cc` while writing this document; the path is named.
- **[test]** a named test asserts it; the test was **not** rerun for this document.
- **[doc]** recorded in an earlier design document or ADR, not rechecked here.
- **[unverified]** an assumption or general knowledge about an external provider, SDK or protocol
  that nobody has checked against a primary source or a real call for Deskmates. It must be
  confirmed before anything depends on it.
- **[proposed]** a design choice in this document that the owner has not made.

---

## 1. Summary

1. Today Deskmates has **one** model surface: the Agent's text loop, through one upstream
   (`MODEL_BASE_URL`), one protocol (Anthropic Messages), one credential, and a token-only price
   table. Image *input* to that loop exists (SDK `Read`, browser screenshots, the vision probe)
   and is observable since ADR-0023 amendment 1. Text-to-image, OCR as its own operation, and ASR
   have **no code path at all** [src].
2. The design separates three boundaries that the issue asks to keep apart: **selection** (which
   configured profile an operation uses, frozen per run), **adaptation** (how one operation is
   carried over one protocol to one endpoint), and **the agent loop host** (the sidecar, unchanged).
   ADR-0023's text path is untouched; specialist operations are a parallel, opt-in path.
3. Proposed core: a **service profile** (endpoint + model + revision + operations + limits +
   price schedule + data destination), **operation-specific capability evidence** generalised from
   the existing vision probe table, a **sidecar tool → Gateway operation proxy → upstream** path
   for specialist calls modelled on the model proxy, and **unit-typed usage and prices** so money
   is summed in USD while tokens, images, audio seconds and pages stay separate.
4. Nothing here needs a new service, a new router, or a model call by the Gateway. The first
   implementable slice is contracts plus accounting units (no provider), then OCR, then the others
   as the owner chooses providers.
5. Twelve owner decisions are listed in §13; none blocks writing the contracts and T0/T1 tests.

## 2. Scope and boundaries

- **In scope** (issue #115): text/chat, image understanding, text-to-image, OCR and speech
  recognition (ASR) — their configuration, capability evidence, selection, routing/fallback,
  accounting, probes, UI, migration, risks and test plan.
- **Not changed**: ADR-0023 decisions 1-3 (frozen run models, cheap-model job kinds, served-model
  ledger, SDK as the only retry owner) and amendments 1-2 (vision probe and vision policy). Issue
  #87 keeps its own evidence and acceptance; nothing here closes it.
- **Architecture rules that bind every option** (AGENTS.md): the Gateway never calls a model and
  never imports the Agent SDK; model work runs in the sidecar as an attributable run or job with
  usage recorded; the model is configuration, so no package hardcodes a model name; secrets never
  reach a tracked file or the Gateway database in plaintext; page, tool, document and audio content
  is untrusted.
- **Out of scope here**: choosing a provider, buying an account, writing an adapter, running a
  paid probe, a TTS (text-to-speech) or video operation, learned/quality routing.

## 3. Current state (from the code)

### 3.1 Configuration

| Variable | Meaning | Source |
|---|---|---|
| `MODEL_BASE_URL`, `MODEL_AUTH_TOKEN` | the one upstream and its Bearer; memory only, never in the DB | `packages/gateway/src/config/model.ts` [src] |
| `DEFAULT_MODEL`, `CHEAP_MODEL` | required ids; never defaulted in code | same [src] |
| `CLI_SMALL_FAST_MODEL` | the CLI's own background id, rewritten to the run's cheap model | same; ADR-0023 d1 [src] |
| `FALLBACK_MODEL` | one id, comma lists refused; must be priced | same [src] |
| `MODEL_TOKEN_TTL_SECONDS` | run token lifetime, default 14400 | same [src] |
| `VISION_PROBE` | `auto` or `off`; **empty means `auto`** | same; `.env.example` [src] |
| `MODEL_PRICES` | JSON price rows seeded into `prices` at start; editable by `PUT /api/prices` (platform role) | `ledger/model-price.ts`, `api/price-routes.ts`, `route-policies/installation.ts` [src] |

Observations:

- Everything above is **installation-wide**. There is no tenant- or workspace-level endpoint,
  credential, allowed-model list or default [src; also research §2.6 [doc]].
- The `secrets` table already allows `owner_kind = 'model'` (`baseline.sql`,
  `secrets/secrets-store.ts` `SecretOwnerKind`), but no code stores a model credential there;
  the upstream token is read from the environment only [src].
- Documentation inconsistency: ADR-0023 amendment 2's context says "the probe is off unless
  `VISION_PROBE=auto`", while the code and `.env.example` treat an empty value as `auto` [src].
  The code is the behaviour; the ADR sentence should be corrected by its owner (not done here).
- `GET /api/config` exposes only `defaultModel`, `cheapModel`, `release`, `cronTimeZone`
  (`api/config-routes.ts`) [src]. The browser never sees an endpoint or credential.

### 3.2 Per-bot selection and run freezing

- A bot has nullable `model` and `cheap_model` columns (`bots` in the baseline) [src]. Writes are
  validated: a model without a price row is refused on `POST` and `PATCH`
  (`api/registry-routes.ts` `requirePricedModel`) [src; test `api/bot-model-validation.test.ts`].
- The bot settings UI offers the configured default and cheap ids or free text
  (`web/src/features/contacts/management.tsx`) [src].
- At start the Gateway freezes `model = run.config.model ?? bot.model ?? DEFAULT_MODEL`, the same
  for `cheapModel`, and `fallbackModel` (recorded as `null` when none), plus
  `modelCapabilities` and `visionPolicy` (`scheduler/run-lifecycle.ts` `effectiveModels`,
  `model-jobs/vision-policy.ts` `visionStart`) [src]. A resume keeps every frozen value [src].
- Job kinds on the cheap model: `activity_summary`, `memory_consolidation`, `soul_proposal`,
  `status_inquiry` (`scheduler/job-models.ts`) [src]. Model jobs (tool-free, one turn, 60 s):
  `approval_review`, `soul_proposal`, `status_inquiry`, `vision_probe`
  (`model-jobs/model-jobs.ts`) [src].
- There is no workspace default model, no per-operation selection, and no capability-aware
  selection. ADR-0023 deferred a `SelectionPolicy` interface until a second policy exists [doc].

### 3.3 The model proxy

`packages/gateway/src/model-proxy/model-proxy.ts` [src]:

- Accepts only `POST /v1/messages` and `POST /v1/messages/count_tokens`; request and response
  headers are allowlisted; the run's Bearer is swapped for the upstream token.
- The body's `model` must be in the run's frozen set (`frozen-models.ts`); the CLI's small-fast id
  is rewritten to the cheap model; anything else is 403 `model_not_selected`, recorded, never
  forwarded [test `frozen-models.test.ts`, `model-enforcement.test.ts`].
- Budget admission before each `/v1/messages` (402 `budget_exhausted`, `x-should-retry: false`;
  `count_tokens` passes) [src; ADR-0032 d5].
- Every request writes a `model_requests` row: model, `served_model`, `rewritten_from`,
  `refusal`, `system_sha256`, `stream`, input/output/cache/thinking tokens (nullable), and
  `image_blocks` (NULL when the body was unreadable) [src; migration `202610131115-model-jobs.sql`].
- It never retries; the SDK is the only retry owner [src; ADR-0023 d3].

Consequence for #115: a bot's run token buys exactly one thing, an Anthropic Messages turn on a
frozen model. An image-generation or transcription endpoint is unreachable through Deskmates today,
which is the safe default the design must keep.

### 3.4 How images reach the model today

| Path | What happens | Evidence |
|---|---|---|
| SDK `Read` of `.png/.jpg/.jpeg/.gif/.webp` | The CLI returns an image block in the tool result; the ledger stores a one-line placeholder (media type, decoded size), never bytes | ADR-0023 a1 d4; `sidecar/src/tool-result-text.ts` [src]; `tool-result-text.test.ts` [test] |
| Browser MCP with `--caps vision` | Screenshots enter context as image items through the sidecar's MCP proxy | AGENTS.md; `sidecar/src/browser-mcp.ts` [src] |
| Opt-in vision fallback | On a locator miss, the proxy may attach a screenshot | `sidecar/src/mcp-proxy/vision-fallback.ts` [src] |
| Vision probe job | One synthetic PNG of a random four-digit code in one user message | `sidecar/src/model-job.ts`, `probe-image.ts` [src] |
| Chat attachments and uploads | **Text only**: name, MIME type and ref are rendered into the prompt; the bytes reach the model only if the bot later `Read`s the file | `sidecar/src/context.ts` (attachment rendering) [src]; uploads stored in the container under `/work/uploads/` (`202610140520-workspace-uploads.sql`) [src] |
| PDF `Read` (document blocks) | Not covered by the vision policy; not observed on the deployment endpoint | ADR-0023 a2 open items [doc] |

Under `visionPolicy = withhold` the sidecar denies image `Read`s, starts the browser MCP without
`--caps vision`, replaces browser image items with a notice and adds a prompt notice
(ADR-0023 a2 d12) [src; tests `vision-withhold.test.ts`, `proxy-vision.test.ts`]. Real-CLI T2 and
real-model verification of these paths **have not run** [doc].

### 3.5 Vision probe (ADR-0023 amendments 1-2)

- Table `model_capability_probes`; `capability` CHECK allows only `'vision'`; cache key
  `(workspace_id, capability, model, endpoint_sha256, adapter_revision)`; at most one pending
  row per key (partial unique index) [src].
- `VISION_PROBE_ADAPTER_REVISION = "vision-probe-1/agent-sdk-0.3.278"`; three attempts per key per
  24 h (`contracts/src/model-capability.ts`) [src].
- `supported` requires correct digits **and** a forwarded request with `image_blocks >= 1`;
  `unsupported` requires an explicit refusal; everything else is `unknown` with a reason
  (`wrong_answer`, `no_transport_evidence`, `job_failed`, `blocked`, `not_probed`) [src;
  test `vision-probes.test.ts`].
- Triggers: bot created, bot model changed, Gateway start (models in use without a result),
  operator Retry. A read never queues a probe [src].
- `unsupported` and `unknown/wrong_answer` withhold images; every other state delivers
  (`visionPolicyFor`, the latter two points **proposed** in ADR-0023 a2) [src].
- Evidence from 2026-09-28: on the internal upstream, the same Qwen model read an image correctly
  over the OpenAI-compatible `/chat/completions` route and answered "Image unavailable" over the
  Anthropic `/messages` route; GLM-5.3 answered incorrectly on both [doc]. Capability is therefore
  a property of **(endpoint, protocol route, model, adapter)**, not of a model name.

### 3.6 Pricing, usage, budget and cost reporting

- `prices` rows: `model`, `input_per_m`, `output_per_m`, `cache_read_per_m`,
  `cache_create_per_m`, `effective_from`; one table for the installation [src]. **Only tokens are
  a billing unit.**
- `priceUsage` returns `null` for a model without a row in force, never zero; the SDK's `costUSD`
  is ignored (`ledger/pricing.ts`) [src; ADR-0002 item 5].
- The unknown-price estimate `avg-unit-price-v1` averages each token category's per-million price
  over **all** priced models (`ledger/price-estimate.ts`) [src; ADR-0032 d4].
- `budget_charges` holds known and estimated USD increments per run, plus counts of unmeasured and
  unestimated usage rows (`202610131110-workspace-budget.sql`) [src].
- Costs (`contracts/src/cost.ts`) totals are tokens plus known/estimated USD; the money | usage
  toggle never mixes units (ADR-0032 d9) [src].
- Workspace limits (#61, `workspace_limits`) cover turns, relays and continuations; money limits
  are ADR-0032's weekly limit and cumulative ceiling [src].

### 3.7 Specialist operations

- **Text-to-image, OCR (as its own operation), ASR: no code, no contract, no table, no price unit,
  no UI** [src].
- The workspace base image has ImageMagick but no OCR engine, audio decoder or speech model
  (`images/workspace-base/Dockerfile`) [src]. Images preinstall everything (AGENTS.md), so a
  local engine would be an image change.
- A bot could today `curl` a public provider API if it held its own key: egress is open by default
  (ADR-0020) and the only Deskmates credential in the sandbox is the run token, which the model proxy
  accepts for Messages only [src]. A key pasted into a workspace is outside Deskmates's accounting;
  this is a risk to name (§12), not a feature.

### 3.8 Gap list

| # | Gap | Effect |
|---|---|---|
| G1 | One endpoint/credential/protocol for the installation | No second provider, no OpenAI-compatible route, no per-tenant credential |
| G2 | Capability table knows only `vision` | OCR/ASR/generation evidence has nowhere to live |
| G3 | Price rows are token-only | Images, audio seconds, pages, requests cannot be priced; the average estimate would mix any non-token model into token averages |
| G4 | Usage receipts are token-only (`run_usage`, `model_requests`) | Non-token usage would be lost or forced into tokens |
| G5 | Proxy offers Messages only | Correct today; any specialist call needs a deliberate, scoped new path |
| G6 | Chat attachments are text references | An uploaded image or audio file is only "seen" if the bot reads it; audio cannot be read at all |
| G7 | No operation lifecycle | No queued/partial/cancel/receipt state for long or asynchronous operations |
| G8 | ADR-0023 a2 wording vs `VISION_PROBE` default | Documentation drift (§3.1) |

## 4. Design principles

1. **Three boundaries, three owners.** *Selection* is the Gateway's: it resolves and freezes, per
   run, which profile each operation may use. *Adaptation* is the sidecar's (or a local engine's):
   it turns a normalized operation request into one protocol call. *Transport and credential* are
   the Gateway proxy's: it validates the run token, the frozen profile and the budget, swaps the
   credential, records the request, and never retries. This mirrors the text path exactly.
2. **The text loop stays as ADR-0023 built it.** Specialist operations never change the SDK
   session model, never resume a session on another model, and never claim transcript
   compatibility. A specialist result enters the loop as a tool result.
3. **Capability is evidence, per operation, per profile key.** Declarations (provider docs,
   operator form) are recorded as declarations and never become `supported`.
4. **Units are never mixed.** USD is the only summable currency; every usage unit is its own
   labelled dimension. No "equivalent tokens".
5. **Opt-in and bounded.** A workspace has no specialist operation until one is configured and
   enabled; no paid call happens on a page render; probes for non-vision operations are manual
   until the owner sets a bounded automatic policy.
6. **Untrusted in, untrusted out.** OCR text and transcripts are untrusted data, wrapped like
   browser results; converting modality never raises trust.

## 5. Capability model

### 5.1 Operations

| Operation id [proposed] | Input | Output | Today |
|---|---|---|---|
| `chat` | text (+ tool results) | text, tool calls | the Agent loop (ADR-0023) |
| `image_input` | image blocks inside `chat` | text | the existing `vision` capability; same evidence, renamed only in views |
| `ocr` | image or document page(s) | text with page/region attribution when available | none |
| `asr` | audio | transcript, duration, optional timestamps and language | none |
| `image_generation` | text prompt (+ optional reference image) | image file(s) with media type and size | none |

`image_input` is a property of the chat profile; the three others are **specialist operations**.
A single service may serve several operations; each is evidenced separately. Passing `image_input`
says nothing about `ocr` accuracy, and neither says anything about `image_generation`.

### 5.2 Service profile [proposed]

A profile is installation configuration, held by the Gateway, never by a workspace file:

| Field | Meaning |
|---|---|
| `id` | stable profile id (generated), not a model name |
| `label` | operator-facing name |
| `endpointId` | reference to an endpoint record: base URL (memory/secrets only), protocol family, `endpoint_sha256` |
| `protocol` | `anthropic-messages`, `openai-chat`, `openai-images`, `openai-audio-transcriptions`, `local-engine`, … (closed list in contracts; each value needs an adapter) |
| `model` | provider model id, exact string |
| `revision` | provider-reported revision/snapshot when one exists, else `null` = unknown |
| `operations` | declared operations (declaration, not evidence) |
| `limits` | declared input formats, max bytes, max pixels, max pages, max audio seconds, max output count/size |
| `priceSchedule` | price rows by unit (§8) |
| `credentialRef` | `secrets` row with `owner_kind = 'model'`, encrypted; never returned by any route |
| `dataDestination` | `internal_upstream`, `external_provider:<name>`, or `local` |
| `retentionNote` | operator-entered provider retention statement; free text, displayed, not enforced |

Two profiles with the same `model` string on different endpoints are different profiles (§3.5
evidence). The existing environment configuration becomes the **implicit installation profile**
for `chat` (§11, phase P1), so nothing about current deployments changes.

### 5.3 Capability evidence [proposed]

Generalise `model_capability_probes` rather than add a parallel table:

- `capability` CHECK grows from `('vision')` to the operation list (`vision` stays the stored name
  of `image_input` so existing rows and `VISION_PROBE_ADAPTER_REVISION` keep their meaning).
- The cache key becomes `(workspace_id, capability, profile_key, adapter_revision)`, where
  `profile_key = sha256(endpoint_sha256, protocol, model, revision)`; for the implicit chat
  profile it equals today's `(model, endpoint_sha256)` key, so no existing row is invalidated.
- `status` stays `pending | supported | unsupported | unknown`. Reasons gain operation-specific
  values (for example `oracle_mismatch`, `unsupported_format`, `quota`, `auth`, `timeout`,
  `budget_exhausted`, `malformed_result`); every infrastructure failure is `unknown`, never
  `unsupported`.
- New columns: `fixture_id`, `fixture_version`, `score` (operation metric, nullable; for example
  OCR character error rate), `usage_unit`, `usage_quantity`, `cost_usd` (nullable).
- A separate, read-only **declaration** (from the profile's `operations` and `limits`) is shown
  next to evidence with its source; it never sets `status`.

### 5.4 Invalidation, expiry and reprobe [proposed]

- Any change to endpoint, protocol, model, revision, adapter revision or fixture version produces
  a new key, so old evidence stays as history and the new key starts at `unknown/not_probed`.
- A result is written only to its own row (ADR-0023 a1 d8), so a late probe of an old key never
  becomes the current answer for a new one; cross-workspace results are never shared, because the
  key starts with `workspace_id`.
- No TTL is promised. Instead a result shows its age; the owner may later set a reprobe cadence
  per operation (§13 D5). A provider-reported revision change is a new key; a silent upstream
  model swap is caught only by `served_model` drift on chat requests or by a manual reprobe —
  stated in the UI as a limitation.

## 6. Configuration and selection

### 6.1 Levels and precedence [proposed]

| Level | Who | What |
|---|---|---|
| Installation | platform role | endpoints, credentials, profiles, price schedules |
| Workspace | Admin of the workspace's tenant | which profiles are **enabled** for the workspace, per operation; the workspace default profile per specialist operation |
| Bot | Admin | chat model override (exists today); optional specialist default per operation, which must be enabled in the workspace |
| Run | Gateway at start | frozen snapshot `runs.config_json.operations = { <op>: profileId \| null }` |

Precedence for a specialist operation: run snapshot → bot override → workspace default → none
(operation unavailable). There is **no installation-wide default for specialist operations**: an
operation is off for a workspace until an Admin enables a profile. Chat keeps ADR-0023's chain
unchanged (run → bot → `DEFAULT_MODEL`).

Every workspace-level change writes an `AuditLog.record` row in the same transaction (new actions,
for example `workspace.operation_profiles_set`).

### 6.2 Freezing and resume

The operation map is frozen at start like `model` and kept on resume. Re-pointing a workspace or
bot affects the next run only. A budget continuation (ADR-0032 d7) keeps the snapshot.

### 6.3 Who selects

- The **bot** may request an operation by name only (`ocr`, `asr`, `image_generation`) through a
  sidecar tool; it never names a profile, endpoint or model. Prompt text, page content, OCR output
  or a transcript cannot change the destination: the Gateway reads the run snapshot, never the
  request body, to pick the profile (same rule as ADR-0023's SEC-02).
- A **person** selects by configuration (workspace/bot settings), not per message, in the first
  version. Per-message selection is a later product choice (§13 D8).

### 6.4 Fallback [proposed]

- Chat fallback stays `FALLBACK_MODEL` through the SDK (ADR-0023 d3).
- A specialist operation has **no automatic fallback** in the first version. A later fallback may
  use only another profile enabled for the same operation in the same workspace **with the same
  `dataDestination`**, recorded with its reason and spend. Sending private input to a different
  destination always needs an explicit operator setting (§13 D7).

## 7. Specialist-operation runtime [proposed]

### 7.1 Options compared

| Option | Data leaves the box? | New credential holder | Fits thin-core rules | Notes |
|---|---|---|---|---|
| A. Sidecar tool → **Gateway operation proxy** → provider | yes, to the profile's destination | Gateway memory/secrets (like the model proxy) | yes: sidecar initiates, Gateway forwards, never originates | Recommended path for provider-backed operations |
| B. **Local engine** in the workspace image (OCR engine, speech model) | no | none | yes | Image size and CPU/memory per workspace grow; quality unmeasured; a model weight file is a release artifact |
| C. Gateway calls the provider itself | yes | Gateway | **no**: the Gateway would call a model | Rejected |
| D. Open-source LLM router/gateway service (LiteLLM, Portkey, …) | yes | the router | new service, second credential holder | Rejected for now on ADR-0023's grounds; may front the upstream outside Deskmates |
| E. OCR via the chat model's `image_input` with an OCR prompt | to the chat upstream | none new | yes, zero new path | Cheapest first step for OCR; accuracy must be measured, and it is only available where `image_input` is `supported` |

Recommendation for owner review: **E then A for OCR, A for ASR and generation, B only where the
owner prefers no data egress** (§13 D2-D3). Option A reuses the model proxy's pattern: run-token
authentication, frozen-profile check, budget admission, a request row, credential swap, no retry.

### 7.2 Operation request and receipt

A sidecar tool (one per operation, for example `deskmates_ocr`) builds a normalized request; the
operation proxy route is `POST /internal/runs/:id/operations/:op` (run-token scoped, like the other
internal routes). Shape sketch (contracts, not code):

```
OperationRequest {
  operation: "ocr" | "asr" | "image_generation";
  idempotencyKey: string;        // run id + attempt + SDK tool_use_id
  inputs: { workspacePath: string; mediaType: string; bytes: number; sha256: string }[];
  params: Record<string, string | number | boolean>;  // validated per operation and profile limits
}
OperationReceipt {
  operationId: string; runId: string; attempt: number;
  profileId: string; servedModel: string | null; providerRequestId: string | null;
  state: "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled" | "budget_paused";
  outputs: OcrOutput | AsrOutput | ImageOutput | null;
  usage: { unit: UsageUnit; quantity: number | null; measured: "provider" | "computed" | "unknown" }[];
  costUsd: number | null; estimateUsd: number | null;
  latencyMs: number | null; error: { code: string; retryable: boolean } | null;
}
```

- **Inputs are workspace paths**, read inside the container through the same lexical and realpath
  checks as ADR-0014 decision 2; the Gateway receives bytes from the sidecar, never fetches a URL
  that a model wrote. Media type is sniffed from bytes, not trusted from the name. Size, pixel,
  page and duration limits from the profile are checked **before** any spend.
- **Outputs**: OCR text with page and region when the provider gives them (absent means unknown,
  never invented); ASR transcript with measured duration and timestamps only when provided;
  generated images written by the sidecar to a run-scoped path under `/work` and returned as a
  path with media type, pixel size and sha256. Text outputs enter model context **wrapped as
  untrusted** (entity-escaped like browser results).
- **Receipts** keep the provider request id and a redacted raw response hash; never a credential,
  never input bytes.

### 7.3 Lifecycle and retries

- States: `queued → running → (partial →) succeeded | failed | cancelled`, plus `budget_paused`
  when admission refuses (ADR-0032 semantics: a typed state, not a failure). Operation success is
  not task completion.
- **One retry owner: none automatic in the first version.** The proxy does not retry; the sidecar
  tool does not retry; the bot may call the tool again, which is a new admitted, billed operation.
  This avoids a stacked SDK/adapter/proxy loop. The idempotency key makes a replayed tool call in
  a resumed SDK session return the first receipt instead of buying a second call.
- **Asynchronous providers**: the first version accepts only synchronous operations or polling
  driven by the sidecar through the proxy within the tool call's time cap. **No inbound provider
  callbacks** (no forged-callback or SSRF surface). A cancelled or ended run marks open operations
  `cancelled`; a result arriving later is recorded and billed but not delivered to any run.
- **Uncertain delivery**: a timeout after the provider accepted a request is billed as `unknown`
  usage, and the receipt says the provider may have charged; Deskmates does not promise
  exactly-once settlement.

### 7.4 Output delivery

Per ADR-0014 amendment A4 and ADR-0021 amendment 3: user uploads stay inputs; intermediate images,
OCR text and transcripts stay in the run's chat; a file enters Files only through a verified formal
delivery. A partial OCR/ASR/generation output is labelled partial. Non-file results (a transcript
string) need no artifact.

### 7.5 Interaction with the vision policy

A `withhold` run (ADR-0023 a2) may still call `ocr` on an image file, because OCR returns text the
model can read. Whether that is allowed is an owner choice (§13 D9): it restores an image path for
a blind model, but only as text from a separately evidenced operation.

## 8. Accounting and pricing per modality [proposed]

### 8.1 Units

`UsageUnit` (closed list in contracts): `input_token`, `output_token`, `cache_read_token`,
`cache_create_token`, `image` (with a size/quality class attribute), `audio_second`, `page`,
`request`. A price row names a profile (or model, for the implicit chat profile), a unit, an
optional class, `usd_per_unit` (per million for tokens, as today) and `effective_from`.

The existing `prices` table stays the token schedule for chat; non-token schedules go in a new
`operation_prices` table keyed `(profile_id, unit, unit_class, effective_from)`. That keeps every
current reader of `prices` correct and stops non-token models from entering the token average.

### 8.2 Usage records

A new `operation_usage` table (workspace_id NOT NULL with cascade, run_id, attempt, operation_id,
unit, unit_class, quantity nullable, measured `provider | computed | unknown`, cost_usd nullable,
estimated_usd nullable, estimate_version). Rules:

- A missing quantity stays NULL and is counted as unmeasured; it never becomes zero.
- `computed` quantities (for example audio seconds measured from the file) are labelled as such
  and distinguished from provider-reported ones.
- Failed, partial, probe and refused operations are recorded; a refused operation never reached
  the provider and costs nothing by construction.

### 8.3 Estimates

`avg-unit-price-v1` stays for tokens and its population is restricted to token schedules. For a
non-token unit the same method may apply **only within the same unit and class** (USD/image of
class `1024px-standard` with other USD/image rows of that class). With no compatible population
there is no estimate and the row stays unpriced. Any other formula (per-pixel scaling, mapping
seconds to tokens) is an owner decision (§13 D6), not a default.

### 8.4 Budget

ADR-0032 applies unchanged in spirit: the operation proxy checks admission before forwarding each
operation, and `budget_charges` gains the operation increments (known and estimated USD, with
unmeasured/unestimated counts). The overshoot bound adds, per in-flight operation, the profile's
declared maximum units for that request at its price (or estimate); where no maximum is declared,
the bound is stated as unknown.

### 8.5 Costs page

Money view: one USD total with known, estimated and unpriced coverage, now including operations.
Usage view: tokens as today, plus one section per non-token unit (images by class, audio minutes,
pages, requests). No chart axis, tile or ranking mixes units; a ranking by operation is added in
money view only.

## 9. Probes and their bounds [proposed]

| Operation | Fixture (synthetic, non-sensitive) | Grading oracle | Automatic? |
|---|---|---|---|
| `image_input` | existing random four-digit PNG | digits match + `image_blocks >= 1` | as today (`VISION_PROBE`) |
| `ocr` | generated PNG/PDF page with a random 12-character mixed-case string in two lines, fixed font | exact match → `supported`; CER recorded as `score`; mismatch → `unknown/oracle_mismatch` | **manual only** until D5 |
| `asr` | audio concatenated from a fixed set of pre-generated synthetic digit clips in random order, 16 kHz WAV, under 10 s | transcript digits in order; word error recorded | **manual only** until D5 |
| `image_generation` | prompt "a single solid red square on white" | transport/format only: decodable image, declared media type and size; **no quality claim** | **manual only**; never automatic |

Bounds for every non-vision probe [proposed defaults for owner review]: one pending per key; three
per key per 24 h (as vision); one operation call; 60 s cap; refused when the workspace budget is
exhausted (recorded `unknown/budget_exhausted`); declared maximum cost per probe shown before an
Admin confirms the Retry. No probe on page render, list, or Gateway start for non-vision operations.

The ASR fixture needs a source for the digit clips; generating them with a TTS model would be a
paid call and is **not** assumed. A license-clean recorded set committed to `testkit` is the
proposed source [unverified: availability and licence].

## 10. UI [proposed]

- **Installation (platform)**: endpoints and profiles list (paged, ADR pagination slices), each
  with declared operations, limits, price schedule, data destination; credentials write-only.
- **Workspace settings → Models**: per operation, the enabled profiles and the default; each shows
  evidence state (`supported`, `unsupported`, `unknown` with reason, `not probed`), age, fixture
  version, last receipt link, and a Retry that states the maximum cost. "Saved" never reads as
  "works".
- **Bot settings**: the existing model line (vision effect, ADR-0023 a2 d14) plus specialist
  defaults when the workspace has more than one enabled profile.
- **Chat**: an operation card per call (state, profile label, units, cost or "unpriced", partial
  marker, error text); generated images shown inline from the run path; Stop cancels open
  operations.
- **Costs**: §8.5.
- All states covered on desktop and mobile, keyboard reachable, all five locales with real
  translations.

## 11. Migration path [proposed]

| Phase | Content | Provider needed | Rollback |
|---|---|---|---|
| P0 | This document; owner decisions §13; ADR (new number or ADR-0023 amendment 3, D12) with Verification table | no | n/a |
| P1 | Contracts: operation ids, profile view, usage units, receipts. Implicit installation chat profile derived from env; `profile_key` equal to today's vision key, so existing probe rows stay current. No behaviour change | no | revert code; no data written |
| P2 | Accounting: `operation_prices`, `operation_usage`, budget and Costs support for units; restrict token-estimate population to token schedules | no | forward-only migration; tables unused if code is reverted |
| P3 | Capability table generalisation (`capability` CHECK widened by table rebuild per ADR-0031 conventions) and manual probe route per operation; fake adapters only | no | new rows ignored by old code |
| P4 | Operation proxy + sidecar tools + first adapter (OCR via E or A per D2/D3); workspace enable/disable; audit | yes (owner-chosen) | disable the profile; operation unavailable; receipts kept |
| P5 | ASR and image generation adapters; UI cards; optional local engine image layer | yes | as P4 |

Existing models, bots, tasks, artifacts and probe receipts migrate with **no guessed capability**:
every new operation starts at `not_probed`, and no historical run is re-priced or re-executed.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Capability inferred from a model name or a provider page | Evidence only from probes; declarations shown separately |
| Protocol-dependent results (§3.5) | Protocol is part of the profile key |
| A blind model given images confabulates (#87) | ADR-0023 a2 unchanged; OCR as text is a separate evidenced path |
| OCR text or transcript carries injected instructions | Wrapped as untrusted; cannot grant tools, egress, approvals or destinations; injection corpus cases (§14 SEC) |
| Private input sent to an unexpected provider | No automatic cross-destination fallback; destination shown per profile; workspace opt-in |
| Duplicate billing on resume or retry | Idempotency key from tool_use id; no automatic retry; receipts per physical call |
| Unit mixing in costs or budget | Typed units; estimate population per unit and class |
| Async provider results after cancel | No callbacks; late results recorded, billed, never delivered |
| A bot calls a provider directly with a pasted key | Outside Deskmates accounting; locked egress (ADR-0020) and the default grouping rule are the only controls; document it |
| Image size and memory for local engines | Measure in the base-image split before choosing B |
| Cost of probes across many workspaces | Manual non-vision probes; per-key caps; budget admission |
| Upstream silently changes the served model | `served_model` drift on chat; manual reprobe; UI states the limit |

## 13. Open owner decisions

| # | Decision | Default proposed here |
|---|---|---|
| D1 | Which providers/services, if any, to evaluate for OCR, ASR, generation | none chosen; comparison template §15 |
| D2 | Local engines (no egress) vs provider calls per operation | provider via A for ASR/generation; OCR starts with E |
| D3 | Whether OCR v1 is "chat model with vision + OCR prompt" (E) | yes, where `image_input` is `supported`, measured before relied on |
| D4 | Credential scope: installation only, or per tenant | installation (platform) only in v1 |
| D5 | Automatic probe policy and cadence for OCR/ASR/generation | manual only; no TTL |
| D6 | Estimate formula when no compatible price exists for a non-token unit | no estimate; unpriced |
| D7 | Fallback across data destinations | never automatic |
| D8 | Per-message user selection of a specialist profile | not in v1 |
| D9 | May a `withhold` run use OCR on images | yes, as text, with its own evidence |
| D10 | Retention/provider-data policy shown or enforced per profile | shown (operator note), not enforced |
| D11 | Inbound provider callbacks | not allowed in v1 |
| D12 | ADR vehicle: a new ADR for specialist operations, or ADR-0023 amendment 3 | a new ADR (number assigned by the coordinator), ADR-0023 untouched |

## 14. Test plan

Tiers follow [test-strategy-2026-09-20.md](test-strategy-2026-09-20.md) §2: T0/T1 run with no
network, no Docker, fake SDK and a **fake operation upstream** (a scripted HTTP double in
`testkit`, new); T2 adds real Docker and the real CLI with no model; T3/T4 need a real model and
are **not authorized** by #115 — they are predeclared here for a separate authorization.

Case ids are `MM-<area>-<n>`. File names are proposals.

### 14.1 T0 — pure contracts and functions

| Id | Assertion | Proposed file |
|---|---|---|
| MM-CFG-01 | Precedence: run snapshot → bot → workspace default → none for specialist ops; chat chain unchanged | `contracts/src/operation-profile.test.ts` |
| MM-CFG-02 | A bot specialist default not enabled in its workspace is refused | same |
| MM-CAP-01 | Grading tables per operation: exact match → supported; mismatch → unknown/oracle_mismatch; refusal phrase → unsupported; auth/quota/timeout/budget/malformed → unknown with that reason | `contracts/src/operation-capability.test.ts` |
| MM-CAP-02 | `profile_key` of the implicit chat profile equals today's vision key inputs; any change of endpoint/protocol/model/revision/adapter/fixture changes the key | same |
| MM-CAP-03 | A declaration never yields `supported` | same |
| MM-ACC-01 | Pricing per unit and class; missing row → null, never 0 | `gateway/src/ledger/operation-pricing.test.ts` |
| MM-ACC-02 | Token estimate population excludes non-token schedules; non-token estimate only within the same unit and class; empty population → no estimate | `gateway/src/ledger/price-estimate.test.ts` (extended) |
| MM-ACC-03 | Totals never add quantities of different units; USD sum = known + estimated with coverage counts | `gateway/src/ledger/operation-usage.test.ts` |
| MM-OP-01 | Lifecycle transitions; illegal transitions throw; success ≠ task done | `contracts/src/operation-receipt.test.ts` |
| MM-OP-02 | Input validation before spend: wrong media (sniffed), oversize, too many pages, too long audio, truncated/corrupt header | `sidecar/src/operation-input.test.ts` |

### 14.2 T1 — Gateway + SQLite + fake SDK + fake operation upstream

| Id | Assertion | Proposed file |
|---|---|---|
| MM-PRB-01 | Manual probe queues one row; concurrent requests for one key → one pending; fourth in 24 h refused | `gateway/src/model-jobs/operation-probes.test.ts` |
| MM-PRB-02 | Stale pending settled `unknown` before a new one; a finished probe of key A never changes key B's current result; another workspace sees `not_probed` | same |
| MM-PRB-03 | Reads (capabilities route, settings page data) queue nothing and call no upstream | same |
| MM-PRB-04 | Vision regression: fake image-dropping upstream (answers digits without `image_blocks`) is `unknown/no_transport_evidence`, never `supported`; existing `vision-probes.test.ts` passes unchanged | existing + extended |
| MM-SEL-01 | Frozen operation map recorded at start and kept on resume and budget continuation although workspace settings changed | `gateway/src/scheduler/operation-freeze.test.ts` |
| MM-SEL-02 | A tool request naming a profile/model/endpoint is ignored; destination comes only from the snapshot | same |
| MM-SEL-03 | Operation disabled for the workspace → typed `operation_unavailable`, no upstream call | same |
| MM-SEC-01 | Run token of workspace A cannot call operations for workspace B's run; operator routes refuse run tokens | `gateway/src/model-proxy/operation-proxy.test.ts` |
| MM-SEC-02 | Input path traversal, symlink escape, `/profile` paths refused; no URL input accepted | same + `sidecar` |
| MM-SEC-03 | OCR/transcript text containing injection corpus strings is wrapped and entity-escaped; it cannot start tools or change policy (fake SDK asserts no follow-up privileged call) | `sidecar/src/operation-untrusted.test.ts` |
| MM-SEC-04 | Credential never appears in receipts, events, logs or errors (scan) | `operation-proxy.test.ts` |
| MM-FAULT-01..08 | 429, 5xx, timeout, malformed body, truncated stream, auth expired, quota, unknown units: one upstream call each, no proxy retry, typed error, usage unknown not zero | `operation-proxy.test.ts` |
| MM-FAULT-09 | Stop during a running operation → `cancelled`; a late fake result is recorded and billed but not delivered | `operation-lifecycle.test.ts` |
| MM-FAULT-10 | Gateway restart with an operation `running` → settled `failed/unknown_delivery` with usage unknown | same |
| MM-IDEM-01 | Replaying the same tool_use id after resume returns the first receipt; exactly one upstream call | same |
| MM-BUD-01 | Exhausted workspace → 402, `budget_paused`, no upstream call; continue resumes per ADR-0032; operation charges appear in `budget_charges` | `gateway/src/budget/operation-budget.test.ts` |
| MM-ACC-04 | Failed, partial, probe and refused operations recorded; refused cost 0 by construction; no double count between receipt and charge | `operation-usage.test.ts` |
| MM-AUD-01 | Enabling/disabling a profile or changing a default writes one audit row in the same transaction, Admin only | `gateway/src/api/operation-profile-routes.test.ts` |
| MM-MIG-01 | Migration on a baseline DB with existing vision rows keeps them current under the new key; no new rows created; no run re-priced | `gateway/src/db/operation-migration.test.ts` |
| MM-UI-01..n | Web per feature: evidence states, unknown reasons, Retry cost notice, operation card states (queued/running/partial/succeeded/failed/cancelled/budget_paused), Costs unit sections, no unit mixing; five locales | `web/src/features/<feature>/*.test.tsx` |

### 14.3 T2 — real Docker and CLI, no model

| Id | Assertion |
|---|---|
| MM-T2-01 | A real sidecar tool reads a real file from `/work` and its bytes reach the scripted operation upstream byte-identical (sha256), through the run token |
| MM-T2-02 | `curl` from the workspace with the run token to any non-allowlisted operation path or another run's id is refused and recorded |
| MM-T2-03 | Generated image written by the sidecar lands at the run path, is readable by the browser preview, and does not enter Files without a verified delivery |
| MM-T2-04 | Under `visionPolicy = withhold` the real CLI's `Read` of a PNG is denied (closes ADR-0023 a2's open T2) |
| MM-T2-05 | Local engine option (only if D2 chooses B): engine present in the image, offline, bounded memory on the fixture |

### 14.4 T3 and T4 — real model, separately authorized only

Predeclared, not run, not authorized by #115:

- **Design**: paired comparison per [measurement-2026-09-20.md](measurement-2026-09-20.md) via
  `evals/compare.ts`; held-out synthetic fixtures (OCR pages with mixed scripts and noise; ASR
  clips with silence, noise, two languages and durations; generation prompts with objective
  format checks); fixtures fixed before any run.
- **Metrics**: false capability positives (target 0), OCR CER and exact-line rate, ASR WER and
  timestamp presence, generation format acceptance, cost per successful operation in USD and per
  unit, p95 latency, fallback and retry rates, injection-follow rate on OCR/transcript text
  (safety floor 0 accepted follow-ups).
- **Sample rationale**: size from `evals/power.ts` for the smallest difference the owner cares
  about; one knob per experiment; every attempt and its tokens/units recorded, missing usage
  reported as unknown.
- **Stop rules**: a predeclared cost ceiling per campaign set by the owner; a genuine blocker ends
  a case rather than starting a replacement.

Fake and source tests establish contracts only; they do not establish live quality or production
readiness.

## 15. Provider and protocol comparison template [unverified]

No primary source was fetched for this document. The rows below record what must be confirmed, per
candidate, before D1; the "expected" column is general knowledge and is **unverified**.

| Question | Expected (unverified) | How to confirm |
|---|---|---|
| Does the Anthropic Messages protocol carry image and PDF input? | Image blocks yes; PDF as document blocks yes, model-dependent | Provider docs at the pinned SDK version; T2 request capture |
| Does it offer image generation or audio input? | No | Provider docs |
| Does the internal upstream expose OpenAI-compatible image generation or audio transcription routes? | Unknown; only `/chat/completions` and `/messages` were observed (2026-09-28) | Owner/upstream operator; a no-cost route listing, not a paid call |
| Image input limits (bytes, pixels, count) per protocol | Provider-specific | Primary docs per candidate |
| Billing dimensions | Tokens for chat/vision; per image by size/quality for generation; per audio second/minute for ASR; per page or request for OCR services | Primary pricing pages, dated, with version |
| Data retention and training use | Provider-specific | Primary policy pages, dated |
| Synchronous vs asynchronous APIs, callbacks | Provider-specific | Primary API references |
| Reported revision/snapshot id | Often absent behind a gateway | Response inspection on a free/no-op endpoint where available |

## 16. What was verified for this document

- Source files and migrations named with [src] were read at `26d0c1cc`.
- No test was run for this document; [test] references name existing tests only.
- No model, provider, credential, network service or Docker container was used.
- `npm run docs:check` was run on the commit that adds this file.

# ADR-0023: The proxy enforces the run's models; background jobs use the cheap one; the ledger records what was served

Date: 2026-10-08
Status: Accepted for implementation (product owner, 2026-10-10); T2 rows recorded below; real-model acceptance pending
Scope: issue #10; implemented with T0/T1 and T2 rows; no release or real-model acceptance claim

## Context

A run's model is resolved once in the Gateway (`run.config.model`, then the
bot override, then `DEFAULT_MODEL`), frozen on the run row and passed to the
sidecar, which sets it as the SDK's `model` option. That works and is tested.
Around it: `CHEAP_MODEL` is resolved and shipped but consumed by nothing; the
model proxy forwards whatever model id the sandbox writes into the request
body, and the run token sits in the CLI's environment, so a `Bash` tool call
can buy any model on the upstream; there is no fallback; the model ids of the
CLI's own background calls are unknown; the model the upstream actually
served is not recorded. The inventory, SDK facts and options comparison are
in [the research document](../design/model-selection-research-2026-10-08.md);
the executable checks are in
[the test plan](../design/model-selection-test-plan-2026-10-08.md).

The owner asked for the lightweight path. This ADR therefore decides the
three things that carry value with no routing at all, adds no service, no
interface and no new configuration surface beyond one optional variable, and
leaves a selection-policy interface, shadow mode and learned routing as
future work that would sit on top of these three unchanged. Which provider
or protocol serves a model stays the upstream gateway's job; who runs the
agent loop stays the sidecar (ADR-0002).

## Decision

1. **The proxy enforces the run's frozen models.** A `/v1/messages` or
   `count_tokens` request is forwarded only when its body `model` equals the
   run's frozen `model` or `cheapModel`. The CLI's own small-fast model id,
   once identified from the ledger (research §6), is rewritten to the run's
   `cheapModel` and the rewrite is recorded on the `model_requests` row. Any
   other id is refused with 403 `model_not_selected`, recorded, and never
   retried by the Gateway. Bot overrides are validated at write time against
   the price table: a model without a price row cannot be set on a bot, on
   `POST` and `PATCH` alike. Precedence and freezing are unchanged.

2. **Background jobs run on the cheap model, explicitly.** Memory
   consolidation writes `model: cheapModel` into its run config at creation,
   so the existing freezing logic carries it; any later background job kind
   that should use the cheap model is added to the same enumerated list in
   one place. Nothing reads prompt text, thread messages or tool output to
   make this choice; the job kind is the only input.

3. **The ledger records what actually happened.** The proxy stores the
   `model` named in the upstream's response as `served_model` on every
   successful `model_requests` row. The sidecar forwards the SDK's
   `PostModelSwitch` hook as a `model_switch` event (`from`, `to`, `source`)
   and `api_retry` messages as `model_retry` events. If `FALLBACK_MODEL` is
   set in the Gateway's configuration, it travels in `StartRunRequest` and
   the sidecar sets `options.fallbackModel`; the SDK remains the only retry
   owner, and the Gateway and proxy never retry a model call. Usage keeps
   being priced per model actually served.

## Alternatives considered

- **A `SelectionPolicy` interface with named implementations, shadow mode
  and a paired A/B gate.** Deferred, not rejected: it is only needed once a
  second policy exists, and none does. The three decisions above are the
  boundary it would build on; the earlier draft of this ADR and research
  §7 keep its shape.
- **An open-source gateway in place of the proxy** (LiteLLM, Bifrost,
  Portkey). Rejected for now: a new service, a datastore and a second
  holder of the upstream credential, to gain budgets and fallbacks the
  deployment does not yet need, while losing per-run attribution
  (`attempt`, `seq`, `system_sha256`) and the Gateway's own price table.
  Research §7a.
- **A Claude Code request router** (claude-code-router). Its background
  rewrite rule is adopted in decision 1; the tool itself is a per-developer
  local proxy without run scope, tokens or a ledger.
- **A provider or protocol adapter in the Gateway.** Rejected: the internal
  Anthropic-protocol gateway already fronts GLM, DeepSeek and Qwen.
- **Delegating the choice to the upstream** (`auto` id). Rejected as the
  mechanism; its one idea, recording the served model, is decision 3.
- **Learned routing (RouteLLM-style).** Research candidate only. It must
  read the triggering message to classify it, which decision 2 does not
  allow for background jobs and which would need its own ADR for
  interactive runs.

## Consequences

- `cheapModel` gains its first real consumer; the operator's belief about
  background cost becomes true and measurable from `run_usage`.
- A prompt-injected or curious run cannot buy a different model with its
  run token; the refusal is a ledger fact.
- Three facts enter the ledger that it lacks today: served model, retries,
  switches. Measurement §4.1's `served_model` becomes recordable.
- The replay harness reports one intended decision change: consolidation
  runs now carry the cheap model. It is declared with the change.
- The fake SDK must learn multi-model `modelUsage`, `api_retry` and the
  model-switch hook before decision 3 can be tested at T0/T1.
- Nothing else about which model a run uses changes.

## Verification

Rows are requirements. A recorded T2 pass names its file, date, image and
source in the row; everything marked not run has not run, and no real model
has been called for this ADR. Case ids refer to
[the test plan](../design/model-selection-test-plan-2026-10-08.md).

T2 receipt (2026-10-10), shared by rows 1 and 3:
`acceptance/m4-model-selection.container.test.ts`, run alone twice on the
workstation (colima, 4 CPUs, 8 GiB, shared with other work) with a scripted
upstream and no model:
`DESKMATES_SKIP_IMAGE_BUILD=1 WORKSPACE_IMAGE=<image ID> EGRESS_PROXY_IMAGE=deskmates/egress-proxy:arm64-7d91517883a7 npx vitest run acceptance/m4-model-selection.container.test.ts`.
Source `4ea18e9` (runtime unchanged; the commit recording this adds the test
file and two test-support options). Workspace image: app layer built from
that source on `deskmates/workspace-base:arm64-afd228b644f2`
(`sha256:8054bcc19792…`) under a private tag, image ID
`sha256:87da02371facd4701d71620769797d0779775467c88f18b07836da8f80019af5`
(Agent SDK 0.3.278 in the image; local build, no registry digest). Egress
proxy `sha256:625ee0e145b3299366d8fc7ff45bf95853d806ab8f39f2e5d4d66b3d123a319f`.
Result: 2/2 cases passed in each run; file wall time 11.5 s and 11.3 s
including stack start.

T2 rerun (2026-10-10) after `578de9a` ("Record SDK overload fallbacks as
model_switch events"), same command, host and egress proxy: app layer built
from source `578de9a` on the same base, image ID
`sha256:d495658df1113c5e81ed71b5e415adaff45c271f5adb62add01dad90e4e1b976`.
Result: 2/2 cases passed in each of two runs alone; file wall time 18.3 s and
11.5 s including stack start (the first run overlapped other load on the
host, load average about 64 when the second started).

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | Body model in the frozen set is forwarded unchanged; the small-fast id is rewritten to `cheapModel` and recorded; any other id gets 403, a ledger row and no upstream call, for `messages` and `count_tokens`; bot routes refuse an unpriced model on both `POST` and `PATCH` | T0/T1 SEC-01, SEC-03, FB-04, FAULT-10; T2 PROXY-01; T3 C-01. Implemented: T0 `packages/gateway/src/model-proxy/frozen-models.test.ts`; T1 `packages/gateway/src/model-proxy/model-enforcement.test.ts` (SEC-01, SEC-02, SEC-04, rewrite, FAULT-10 at the proxy: one upstream call, `x-should-retry: false`), `packages/gateway/src/api/bot-model-validation.test.ts` (SEC-03), `packages/gateway/src/ledger/model-requests.test.ts` (refusal and rewrite columns). The frozen set also holds the run's frozen `FALLBACK_MODEL` when one is set, or decision 3's fallback would be refused. T2 PROXY-01 `acceptance/m4-model-selection.container.test.ts` ("PROXY-01"): **pass** 2026-10-10, 1.6 s / 1.4 s (two runs), image `sha256:87da02371fac`, source `4ea18e9`; one real `Bash` call in the workspace curls the proxy with the run's own `ANTHROPIC_AUTH_TOKEN`: an unselected id gets 403 `model_not_selected` on `messages` and `count_tokens`, two refusal rows and no upstream request; the frozen cheap model and the frozen fallback get 200 and reach the upstream unchanged; the `CLI_SMALL_FAST_MODEL` id reaches the upstream as the cheap model with `rewritten_from` on its row; the run then succeeds. Rerun on image `sha256:d495658df111`, source `578de9a`: **pass**, 4.8 s / 1.6 s. Not run: T3 C-01 | Requests outside the frozen set that reached the upstream = 0; bots with an unpriced model = 0 |
| 2 | A consolidation run's frozen `model` equals its `cheapModel`; every other run kind selects as today; the job-kind list is the only input | T0 SEL-02, SEL-04; T1 SEL-06 (replay). Implemented: T0 `packages/gateway/src/scheduler/job-models.test.ts` (the one job-kind list); T1 `packages/gateway/src/memory/consolidation-model.test.ts` (SEL-02 at creation and in `StartRunRequest`, SEL-04 for memory sources, thread message, cron prompt and webhook body, SEL-06 as a selection replay over chat, cron, webhook and consolidation runs of two bots: diffs on consolidation runs only). `npm run replay` on a recorded trace corpus not run: `evals/traces/` is empty | Replay decision diffs outside consolidation runs = 0; consolidation `run_usage` rows on the main model = 0 |
| 3 | `served_model` present on every successful request and absent, never guessed, on failure; one `model_switch` per switch with correct `from`/`to`/`source`; one `model_retry` per retry; `FALLBACK_MODEL` reaches `options.fallbackModel` verbatim and is absent when unset | T0 FB-01..03; T1 FB-05, FAULT-01..03, FAULT-09; T3 C-02, C-03. Implemented: T0 `packages/testkit/src/fake-sdk/fake-sdk-models.test.ts` (fake SDK switch, retry and failure steps), `packages/gateway/src/model-proxy/served-model.test.ts` (observer) and `frozen-models.test.ts` (fallback in the frozen set); T1 `packages/sidecar/src/model-events.test.ts` (FB-02, FB-03, FAULT-01 on SDK 0.3.278's `model_fallback` message, FAULT-02, FAULT-03, FAULT-09, SEC-06, `fallbackModel` present and absent, a switch reported by both the hook and the message recorded once), T0 `packages/sidecar/src/model-switch.test.ts` (reading the untyped message, once per turn), `packages/sidecar/src/start-run-request.test.ts` (stdin), `packages/gateway/src/model-proxy/served-model.test.ts` (FB-05), `packages/gateway/src/scheduler/fallback-model.test.ts` (FALLBACK_MODEL frozen and in `StartRunRequest`, FB-04 at startup, ledger events and per-model pricing); compile-time pin of the new SDK shapes in `packages/sidecar/src/sdk-shape.container.test.ts` (checked by `tsc -b`). FB-01 is a single id here, a comma list is refused at config load. T2 PROXY-02 live half `acceptance/m4-model-selection.container.test.ts`: **pass** 2026-10-10, image `sha256:87da02371fac`, source `4ea18e9`. "PROXY-01" (1.6 s / 1.4 s): the real CLI runs with `--model`, `--fallback-model` (the frozen fallback) and `--include-partial-messages`; every successful row's `served_model` is the id the upstream's response named, which the fake makes differ from the request, and a refused row has none. "PROXY-02 live half" (2.9 s / 2.9 s): the upstream answers the primary 529 three times, the real SDK switches to the frozen fallback by itself, the proxy forwards it, the three failed rows have no `served_model` and the fallback rows have the response's, two `model_retry` events (attempts 1 and 2; the third 529 raises the fallback instead of a retry), usage priced on the fallback. SDK 0.3.278 announces that switch as a `system` message with subtype `model_fallback` (`original_model`, `fallback_model`, `trigger: "overloaded"`; not in its typings) and does not call `PostModelSwitch`; the first T2 run (source `4ea18e9`) found that it then left no `model_switch` event. Since `578de9a` the sidecar records that message as `model_switch` with source `auto`, deduplicated against the hook within a turn, and the rerun on image `sha256:d495658df111` asserts exactly one `{from: primary, to: fallback, source: "auto"}`: **pass**, 5.3 s / 2.9 s. `effort`, `thinking` and `resume` are not in this T2. Not run: T3 C-02, C-03 | Switches without a ledger event = 0; `served_model` coverage of successful requests = 100% |

## Amendment 1 (2026-10-13): capability probes and proposal jobs

Status: Accepted under owner delegation (2026-10-17); proposed for implementation under GitHub
issues #87 (vision probe) and #77 (SOUL proposals), following the owner comments of 2026-10-13
on both issues, and implemented with T0/T1 tests. Real-model and T2 verification of the image
path remain pending. The integrated multimodal workstream is #115 and is not decided here.
Decisions 1 to 3 stay in force.

### Context

On the deployment endpoint of 2026-10-12 images never reached the model and GLM-5.3 described
images it had not seen (issue #87). The Gateway proxy forwards request bytes unchanged, but
nothing in Deskmates could show that: the sidecar ledger recorded an image tool result as an
empty string, `model_requests` did not say whether a request carried an image, and no part of
the system knew whether a configured model can see. The owner confirmed one small synthetic
vision probe per model change, cached, attributable and honest about uncertainty. Issue #77
needs a second model job of the same shape: a SOUL proposal generated from one sentence.

### Decisions

4. **Image transport is observable.** The proxy counts the `image` blocks of every forwarded
   request, at any depth of `messages` (tool results included), in `model_requests.image_blocks`
   (NULL when the body could not be read). The sidecar records an image block of a tool result
   in the ledger as a one-line placeholder naming its media type and decoded size, never as an
   empty string and never with its bytes.
5. **A vision probe is a short sidecar job.** Run row first, `runType: vision_probe`, background
   lane of a host bot in the workspace (an active bot whose effective model is the probed model,
   else any active bot), frozen `model` and `cheapModel` both the probed model. The job has no
   tools, no session, one turn and a 60-second cap; its one user message holds a synthetic PNG of
   a random four-digit code the Gateway chose, and the question. The Gateway never calls a model;
   the usage is the run's, so the workspace's. No host bot means a recorded `unknown` result with
   reason `blocked`, never an implicit bot, credential or budget.
6. **When a probe runs, and what a result is for.** A probe is queued when a bot is created, when a
   bot's `model` override changes, once at Gateway start for each model in use in a workspace that
   has no result for the current key, and when an operator asks to retry. A read never queues one.
   The cache key is workspace, capability, the sha256 of `MODEL_BASE_URL`, model id and adapter
   revision (probe version plus the pinned Agent SDK version). A result is shown only for its own
   key; another endpoint, workspace or revision starts at `unknown`.
7. **Evidence rules.** The Gateway grades the answer, the sidecar only relays it. `supported`
   requires the answer's digits to equal the code and a successful forwarded request of the probe
   run with at least one image block (decision 4). `unsupported` requires an explicit statement
   that the model cannot see the image. A transport, auth, rate-limit or budget failure, a wrong
   answer or missing transport evidence is `unknown` with its reason, answer and run kept as the
   receipt. Receipts are never overwritten.
8. **No duplicate or stale probes.** At most one pending probe per key, enforced by a partial
   unique index; a pending probe whose run ended without a result is settled `unknown` before
   another is queued. A result is written only to its own row, so a probe of an older model or
   revision cannot become the current answer for a newer one. Retries are bounded: three probes
   per key per 24 hours.
9. **Runs record what was known.** At start every run records `modelCapabilities.vision`
   (`status`, `reason`, `probeId`) for its frozen model in `runs.config_json`; a resume keeps it.
10. **SOUL proposals are a cheap-model job kind.** `soul_proposal` joins decision 2's job-kind
    list. The job is tool-free and one turn, attributed to the bot being edited, and returns
    text that is stored as a proposal, never applied by the job. For an edit it returns
    find-and-replace operations that the Gateway applies to the loaded version, so text the
    operator did not ask to change stays byte-identical; a proposal is applied only by an
    explicit confirm, through the canonical SOUL write with its version check and busy-lane
    refusal; a bot created for a drafted SOUL gets its welcome run only after that apply or an
    explicit start without it (#89 ordering). Generated prose grants no tool, approval, egress
    or routing authority.

### Open items

- What a run does with `unsupported` is decided in amendment 2.
- `#61` budget enforcement applies to these runs like any other; this amendment adds none.
- Real-model and T2 verification of the image path have not been run.

### Verification (amendment 1)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 4 | An image-bearing body reaches the upstream byte-identical, with and without the small-fast rewrite, and its row has `image_blocks` = 1 (0 for text, NULL for an unreadable body); an image tool result is a non-empty placeholder in the ledger | T1 `packages/gateway/src/model-proxy/image-transport.test.ts`; T0 `packages/sidecar/src/tool-result-text.test.ts`. Not run: T2 with the real CLI | Probe runs with `image_blocks` NULL or 0 on every request (`no_transport_evidence`) |
| 5 | The probe job sends exactly one user message with one PNG image block that decodes to the code, through `query()`, with no tools and one turn; the run row exists before the sidecar starts and its usage lands in `run_usage` | T1 `packages/sidecar/src/model-job.test.ts`; T0 `packages/sidecar/src/probe-image.test.ts`; T1 `packages/gateway/src/model-jobs/vision-probes.test.ts` | Probe usage per workspace from `run_usage` |
| 6 | Create and model change queue one probe each, reads queue none, a second workspace or endpoint gets no result from the first | T1 `packages/gateway/src/model-jobs/vision-probes.test.ts` | Probes per model change (expected 1) |
| 7 | Correct digits plus image evidence give `supported`; correct digits without evidence, a wrong answer and a failed run give `unknown` with their reason; "cannot see" gives `unsupported` | T0/T1 `packages/gateway/src/model-jobs/vision-probes.test.ts` (grading table) | Share of `unknown` results by reason |
| 8 | Concurrent queues for one key create one pending row; a stale pending row is settled; a finished probe of model A does not change the current result of model B; the fourth retry in 24 hours is refused | T1 `packages/gateway/src/model-jobs/vision-probes.test.ts` | Duplicate pending probes = 0 |
| 9 | A run started after a probe records its status, reason and id; a run with none records `unknown`/`not_probed` | T1 `packages/gateway/src/model-jobs/vision-probes.test.ts` | Runs without `modelCapabilities` = 0 |
| 10 | The job's frozen model is the cheap model; edits apply only to the requested span; an unmatched or ambiguous edit fails the proposal; nothing is written before apply; apply refuses a changed SOUL and a busy bot, and is idempotent; a drafted create defers the welcome until apply | T0 `packages/gateway/src/scheduler/job-models.test.ts`, `packages/contracts/src/soul-proposal.test.ts`; T1 `packages/gateway/src/model-jobs/soul-proposals.test.ts`; web `packages/web/src/features/contacts/soul-proposal.test.tsx` | Proposals applied without a confirm = 0 |

## Amendment 2 (2026-10-14): what a run does when its model cannot see

Status: Accepted under owner delegation (2026-10-17), including both points of decision 11 that
were marked proposed: an `unknown` with reason `wrong_answer` withholds, because the probe saw the
confabulation #87 is about and the status itself is not rewritten; every other `unknown`,
`pending` and `not_probed` delivers with no notice, because none is evidence of blindness and a
notice on those runs would be an unevaluated strategy change. Follow-up measurement: the share of
`wrong_answer` results on models known to see, which would show the withholding blinding a capable
model; an operator retry (decision 8) is the remedy meanwhile. Real-model and T2 verification remain
pending. Proposed for implementation under GitHub issue #87 (its proposal 2, "When vision is
unsupported"). Decisions 1 to 10 stay in force. The integrated multimodal workstream (#115) is
not decided here: this amendment concerns only image input to the Agent's text-loop model and
does not define OCR, generation or any other operation's capability or routing.

### Context

Amendment 1 made the image path observable and gave every run a recorded vision status for its
frozen model, but nothing used it: a run on a model the probe found blind still received image
blocks from `Read` and from the browser, and the model could still describe what it never saw.
The owner's evidence rules (issue #87, comment of 2026-10-13) keep one wrong probe answer as
`unknown`, not `unsupported`, and say a capability must never be silently upgraded. The owner
has not ruled on run behaviour; issue #87 proposal 2 lists a prompt notice, withholding the
vision browser capability and a text notice instead of an image read. The probe is on by
default in a deployment: the Gateway's environment loader reads an empty `VISION_PROBE` as
`auto`, and only `VISION_PROBE=off` or a hand-built configuration that omits the setting (the T2
stacks) queues no automatic probe. (Corrected 2026-10-14: this paragraph first said the probe
was off unless `VISION_PROBE=auto`.) A run can still meet a model with no settled answer: a
bot's first runs may start while its probe is `pending`, a probe that failed for transport,
auth, rate-limit, budget or a missing host bot is `unknown` with that reason, and a deployment
with the probe off, or a model in use before the probe existed and not yet re-probed, is
`not_probed`.

### Decisions

11. **A run has a vision policy, `deliver` or `withhold`, fixed at start.** The Gateway derives
    it from decision 9's snapshot for the frozen model, records it as
    `runs.config_json.visionPolicy`, keeps it on resume and sends `visionPolicy: "withhold"` in
    the `StartRunRequest` only when it withholds; absent means `deliver`, the behaviour of every
    earlier run. `supported` delivers. `unsupported` withholds. An `unknown` whose reason is
    `wrong_answer` withholds (**proposed**): the probe saw the model answer a question about an
    image it did not read correctly, which is the confabulation of #87, and the status stays
    `unknown` with its receipt, so the policy never rewrites the evidence. Every other
    `unknown`, `pending` and `not_probed` delivers unchanged (**proposed**): none of them is
    evidence that the model cannot see (decision 7 and the owner's rule that a transport, auth,
    rate-limit or budget error is not proof of non-support), so withholding there would blind
    models that can see on exactly the runs where the probe has not answered yet, such as a new
    bot's welcome run while its probe is `pending` or every run of a deployment that set
    `VISION_PROBE=off`; and a prompt notice on every such run would be a strategy change that
    needs a paired evaluation first. A model job
    (`vision_probe`, `soul_proposal`) records no policy; the probe must always send its image.
12. **Withholding is done in the sidecar, before the model, and says so in text.** Under
    `withhold`: (a) the system prompt gains a fixed notice that this run's model cannot see
    images, that image content is replaced by a notice, and that it must say it cannot view an
    image rather than describe, transcribe or judge one; (b) the PreToolUse hook denies `Read`
    of a file whose extension is `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` (any case) with a
    notice as the reason, so no image block is produced; (c) the browser MCP server starts
    without `--caps vision`, the MCP proxy replaces every `image` item of a browser tool result
    with a one-line notice naming its media type, and the opt-in vision fallback attaches
    nothing. The proxy's own capture for the ledger and the run viewer is unchanged; it never
    enters model context. Tools that cannot return image blocks are unchanged. The Gateway proxy
    still forwards bytes unchanged (decision 4); the sidecar is the host that decides what the
    model is given.
13. **The ledger records each withholding.** A denied image `Read` is a `log` event with
    `source: "vision"`, `op: "image_withheld"`, the tool name, tool-use id and path; a browser
    result's notice is part of the `tool_result` the ledger already keeps. Decision 4's
    `model_requests.image_blocks` then measures the outcome end to end: a withholding run's
    forwarded requests carry no image block.
14. **People see it where they choose a model and where they talk to the bot.** The
    capabilities route returns each model's `visionPolicy` and the bots that use it. The model
    capability line on bot settings states the effect ("runs on this model are not shown
    images"); a chat whose member bots include one that withholds shows a notice naming them,
    so a person does not send a picture expecting it to be seen. The notice is display only.

### Open items

- Owner rulings on the two proposed points of decision 11 (`wrong_answer` withholds; other
  `unknown` delivers without a prompt notice): accepted under owner delegation on 2026-10-17
  (Status).
- The policy follows the frozen primary model. An SDK fallback switch (decision 3) to a model
  with another vision status, and subagents on `cheapModel`, keep the primary's policy.
- PDF reads (document blocks) and image content returned by connectors or integrations are not
  covered; neither path has been observed to carry images on the deployment endpoint. Closed by
  amendment 3.
- Real-model and T2 verification (the real CLI's `Read` of a PNG under `withhold`) have not run.

### Verification (amendment 2)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 11 | The policy table: `supported` and `unknown` other than `wrong_answer`, `pending` and `not_probed` deliver; `unsupported` and `unknown`/`wrong_answer` withhold; a start records `visionPolicy`, a resume keeps the first record although the capability changed, `withhold` reaches the request and `deliver` sends no key; a probe run records none | T0 `packages/contracts/src/model-capability.test.ts`; T1 `packages/gateway/src/model-jobs/vision-policy.test.ts` | Runs without `visionPolicy` (non-job) = 0 |
| 12 | Under `withhold` the prompt carries the notice and without it the prompt is byte-identical to before; an image `Read` is denied with the notice and a text `Read` is not; the MCP args lack `--caps vision`; a browser result's image item becomes text and the vision fallback attaches none | T0 `packages/sidecar/src/vision-withhold.test.ts`, `packages/sidecar/src/browser-mcp.test.ts`; T1 `packages/sidecar/src/mcp-proxy/proxy-vision.test.ts`, `packages/sidecar/src/vision-withhold-run.test.ts` (fake SDK). Not run: T2 with the real CLI | Withholding runs with `image_blocks` > 0 on any request = 0 |
| 13 | A denied image `Read` emits one `image_withheld` event with its tool-use id and path | T1 `packages/sidecar/src/vision-withhold-run.test.ts` | `image_withheld` events per withholding run |
| 14 | The route returns `visionPolicy` and `botIds`; the settings line shows the withheld effect; a chat with a withholding member shows a notice naming it and one without shows none | T1 `packages/gateway/src/model-jobs/vision-policy.test.ts`; web `packages/web/src/features/contacts/model-capability.test.tsx`, `packages/web/src/features/chats/vision-notice.test.tsx` | Not measured |

## Amendment 3 (2026-10-14): PDF reads and connector or integration results

Status: Accepted under owner delegation (2026-10-17), like amendment 2, whose decisions 11 to 14
it extends to the two paths amendment 2 left open (issue #87, comment of 2026-10-14). A delivering
run is unchanged. The PDF text-extractor open item is answered by ADR-0040 (`poppler-utils` in
the base image, `image_describe` reading the text layer first); real-model and T2 verification of a
withheld PDF `Read` remain pending.

### Context

Amendment 2 withheld images from `Read` of image files and from browser tool results. Two
paths remained. The SDK's `Read` of a PDF hands the model the document itself (a document
block, or rendered pages when `pages` is given), which a vision model reads page by page as
images; what an Anthropic-protocol gateway in front of a text-only model makes of it has not
been observed, and a model given pages it cannot see is the confabulation of #87 again. The
connector and integration tools build text results from the Gateway's JSON, so they cannot
carry an image block, but a SaaS record can hold an image as a `data:` URI or as base64 bytes,
and a model shown a long base64 string it cannot decode is invited to guess what it depicts.
The workspace image has no PDF text extractor, so a withheld PDF has no text substitute today.

### Decisions

15. **Under `withhold`, `Read` of a PDF is denied with a notice.** The PreToolUse hook treats a
    path ending in `.pdf` (any case) like an image path: it denies the `Read` with a notice that
    the PDF was not read because its pages reach the model as images, that the model must not
    guess its content, and that it should use a text source (an accompanying text file, a
    page's text, a person). The `log` event is decision 13's, with `media: "application/pdf"`.
    A text extractor in the workspace image is not decided here.
16. **Under `withhold`, a result of any tool on the in-process `deskmates` server carries no
    image.** The sidecar applies decision 12's replacement to every result of that server:
    an `image` item becomes the one-line notice. Connector and integration values are cleaned
    before they are serialised and wrapped as untrusted: an object whose `type` is `image`, a
    string that is a `data:image/...;base64,` URI, and a string of at least 64 base64
    characters whose bytes begin with a PNG, JPEG, GIF or WebP header are each replaced by the
    notice. Other values, including `http(s)` links to images, stay as they are: a link is
    text, not an image. The Gateway's own `tool_result` (`connector_proxy`,
    `integration_proxy`) keeps the raw value, as before.
17. **Each such withholding is in the ledger.** A cleaned connector, integration or other
    `deskmates` tool result emits one `log` event `source: "vision"`, `op: "image_withheld"`
    with the tool name, the number of images replaced and their media types when known.

### Open items

- A PDF text extractor (for example `poppler-utils`) in the workspace base image, so a
  withholding run can still read a PDF's text; an image change, not taken here.
- Jupyter notebooks: `Read` of an `.ipynb` returns image outputs of its cells as images and is
  not covered.
- Real-model and T2 verification of a PDF `Read` under `withhold` have not run.

### Verification (amendment 3)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 15 | Under `withhold` a `.pdf` or `.PDF` `Read` is denied with the PDF notice and one `image_withheld` event with `media: "application/pdf"`; under `deliver` it runs | T0 `packages/sidecar/src/vision-withhold.test.ts`; T1 `packages/sidecar/src/vision-withhold-run.test.ts` (fake SDK) | `image_withheld` events per withholding run, by media |
| 16 | Under `withhold` a connector or integration value with a `data:` image URI, a base64 PNG, JPEG, GIF or WebP and an `image`-typed object reaches the model as notices, an image link and ordinary base64 text do not change, and an `image` item of any `deskmates` tool result becomes text; under `deliver` results are byte-identical | T0 `vision-withhold.test.ts`; T1 `packages/sidecar/src/connector-tools.test.ts`, `packages/sidecar/src/integration-tools.test.ts` | Withholding runs with `image_blocks` > 0 on any request = 0 |
| 17 | One cleaned result emits exactly one `image_withheld` event with its tool name, count and media types; a result with nothing to clean emits none | T1 `connector-tools.test.ts`, `integration-tools.test.ts` | `image_withheld` events per withholding run |

## Amendment 4 (2026-10-14): a model job fails inside its cap, naming the cause

Status: Accepted. Decisions 1 to 17 stay in force; decision 3 (the SDK is the only retry owner)
is unchanged, this amendment only bounds how many retries a model job gives it.

### Context

On the stable deployment of 2026-10-14 `CHEAP_MODEL` named a model the upstream had no worker
for. Every activity summary (ADR-0033) then ran on it: the upstream answered each request with
an error, the SDK retried with its default of ten attempts and exponential backoff, the seventh
retry was still waiting when the job's 55-second deadline aborted the query, and the run row
said only `Error: Claude Code process aborted by user`. Two jobs failed that way, 47 seconds
each, and nothing in the ledger or the UI named the model or the HTTP status. Decision 5 gives
a model job a 60-second cap; ten retries can never finish inside it.

### Decisions

18. **A model job bounds the SDK's retries.** The sidecar sets `CLAUDE_CODE_MAX_RETRIES` to
    `MODEL_JOB_MAX_RETRIES` (four) in the job's query environment and nowhere else: an agent run
    keeps the SDK's default. Four retries, about nine seconds of backoff, survive a short
    upstream blip and still leave the SDK time to end the query with the upstream's error as
    the run error. Each retry is still a `model_retry` event (decision 3).
19. **The deadline names its cause.** When the job's deadline (`MODEL_JOB_DEADLINE_MS`, 55 s)
    aborts the query, the run error is `model job did not finish within 55 s`, followed, when
    the SDK reported retries, by how many and the last one's HTTP status (or `no response`) and
    error kind. The SDK's abort message never becomes a run error on its own.

### Open items

- The upstream of 2026-10-14 answers a request for a model it does not serve with HTTP 500 to
  the SDK's request and 404 `model_not_found` to a plain one; which field of the SDK's body
  turns the 404 into a 500 is not known. Either way the model is not served, and the fix for
  the deployment is the `CHEAP_MODEL` value, which this amendment does not touch.
- A startup check of `DEFAULT_MODEL` and `CHEAP_MODEL` against the upstream would need the
  Gateway to make a model request, which the architecture forbids; not proposed here.

### Verification (amendment 4)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 18 | A model job's `query()` environment carries `CLAUDE_CODE_MAX_RETRIES` equal to `MODEL_JOB_MAX_RETRIES`, which is below the SDK's default of ten, and the deadline is below the Gateway's 60-second cap; an agent run never sets the variable (by construction: `run-once.ts` builds its own environment and no test asserts the absence) | T1 `packages/sidecar/src/model-job.test.ts` ("bounds the SDK's retries") | `model_retry` events per failed model job (expected at most four) |
| 19 | A job whose query reports two `api_retry` messages and then only ends on the deadline's abort fails with the deadline error naming two retries, `HTTP 500` and `server_error`, never "aborted by user"; the error for no retry and for a connection failure reads as specified | T1 `packages/sidecar/src/model-job.test.ts` ("names the retries when the deadline ends the job") | Failed model jobs whose error names no cause = 0 |

Note (2026-10-19, issue #39 item 8): `MODEL_JOB_DEADLINE_MS` is also a Gateway `.env` setting
(`config/runs.ts`, default 55000) relayed as `modelJobDeadlineMs` on the `StartRunRequest`; the
Gateway kills the process five seconds after it, so the default keeps decision 5's 60-second cap,
and the decision 19 error names the effective seconds. Tests: T0
`packages/gateway/src/config/runs.test.ts`, T1 `packages/gateway/src/model-jobs/job-limits.test.ts`
and `packages/sidecar/src/model-job.test.ts`. `MODEL_JOB_THINKING` (default `disabled`) caps a
job's extended thinking on the Claude path; it changes no decision here.

## Amendment 5 (2026-10-16): measure the context, split the system prompt, trim the CLI surface

Status: Accepted under owner delegation (2026-10-17) (issue #8). It is implemented behind
defaults that change nothing. Decisions 20 to 23 are accepted as framework changes; decision 24 is
accepted as knobs whose empty default changes nothing, and setting any of them on a deployment is a
strategy change that still needs the paired before-and-after window of the open items, which has
not run. Decisions 1 to 19 stay in force. Decisions 20 to 23 are framework changes: they
add records, and they reshape the system-prompt option without changing a byte the model reads.
Decision 24 adds strategy knobs that are off by default. Turning one on is a strategy change
(AGENTS.md: paired evaluation, one knob per experiment).

### Context

The Testbox ledger of 2026-10-13 to 10-15 covered 287 runs and 3,795 model requests. The average
request carried 60k to 70k tokens. A run's first request was already about 57k, while the
sidecar's own sections (SOUL, guidance, memory, diary, knowledge) were under 10k. The rest came from
the CLI: its built-in prompt, 44 built-in tool schemas (the sidecar withholds 10 of 54), the MCP
tool schemas, the bundled-skills listing and the git workflow text. `cache_creation` was 0 on every
request, so any cache hit came from the upstream gateway's implicit prefix cache. Two workspaces
hit 0% over 1,300 requests. The ledger could not say which part of a request was large or which
part changed between requests, so no trimming and no prefix change could be judged.

The sidecar already keeps the memory index, MEMORY.md, the diary and knowledge hits out of the
system prompt and puts them in the first user turn (ADR-0011 decision 9). The volatile sections the
issue names are therefore already outside the system prompt in this tree.

### Decisions

20. **The CLI's own view of the window is sampled into the ledger.** The sidecar calls
    `query.getContextUsage` (SDK 0.3.278) once with `detail: "full"` after `system/init`, and once
    with `detail: "summary"` after each model response, except the last. That response's usage
    arrives with the result, and with a string prompt the CLI exits after the result. Each answer
    is a `log` event `{source: "context", kind: "context_usage"}`. It carries the totals, every
    category, the MCP tools per server and the built-in tools; a `full` sample also names each tool
    with its tokens. A query without the method is not asked. A failed answer is logged once as a
    warning and stops later samples. The run never fails because of a sample, and samples still
    pending when the query ends get at most two seconds.
21. **Session and switch cache facts are recorded.** The `SessionStart` hook becomes a `log` event
    `{source: "sdk", kind: "session_start", sessionSource}`. On a resume it also carries
    `contextTokens`, `promptCacheLikelyExpired` and `secondsSinceLastResponse`. A `model_switch`
    event also carries the `PostModelSwitch` hook's `promptCacheWarm` and `contextTokens`.
22. **The model proxy records each request's shape: counts and hashes, never text.** The shape is
    the `cache_control` markers anywhere in `system`, `tools` and `messages`; the system block count
    and characters; and a canonical sha256 of the static prefix and one of the dynamic rest. The
    static prefix runs through the last system block that carries `cache_control`, which is what
    the request marks cacheable. The shape also holds the first 16 hex digits of each system
    block's hash, the tool count and JSON length, and the message count. These are new
    `model_requests` columns, NULL when the body was unreadable. `GET /api/runs/:id/context` adds
    `contextUsage`, `sessionStarts`, `requestShapes` (including `changedSystemBlocks`, the
    positions whose hash varied) and the static and dynamic system-prompt hashes. They are optional
    fields; every existing field is unchanged.
23. **The system prompt is split at the SDK's dynamic boundary.** The sidecar passes
    `{type: "custom", prompt: [static, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamic], snapshot: true}`.
    The static part is SOUL.md and the workspace guidance (working directory, untrusted notice,
    thread and group guidance, the extra-tool list, the summary instruction). It is identical for
    every run of a bot in the same kind of thread. The dynamic part holds the sections chosen per
    run, today only the withheld-image notice (amendment 2). Joined with one blank line, the parts
    are the string earlier runs sent, so `systemPromptSha256` and every pinned prompt test are
    unchanged. A new per-run section goes after the boundary or into the first user turn, never
    into the static part. The `context_sections` event carries `systemPromptStaticSha256` and, when
    there is a dynamic part, `systemPromptDynamicSha256`. `runs.config_json` records
    `systemPromptStaticSha256`. `snapshot: true` is the SDK's documented default for a custom
    prompt and is set explicitly, so a resumed session re-sends the prompt it recorded.
24. **The CLI surface is a Gateway knob, recorded per run.** `DESKMATES_CLI_DISALLOWED_TOOLS`
    names built-in CLI tools (PascalCase; an MCP name is refused) that are withheld on top of the
    sidecar's fixed `DISALLOWED_TOOLS`. The Gateway can only add to that list.
    `DESKMATES_CLI_DISABLE_BUNDLED_SKILLS`, `DESKMATES_CLI_INCLUDE_GIT_INSTRUCTIONS` and
    `DESKMATES_CLI_SKILL_LISTING_MAX_DESC_CHARS` become the SDK's inline `settings`. Empty, the
    default, changes nothing: the start request has no `cliSurface` and the SDK options are as
    before. Every run row records `cliSurface` with `null` for a CLI default. Every process of the
    run reads the values back from its row, so a resumed session keeps its tool set.

### Alternatives considered

- **Move the dynamic sections into the first user turn instead of after the boundary.** The
  volatile sections already are there. Only the image notice remains in the system prompt, and
  moving it would change what a withholding model reads, which is a behaviour change outside
  this amendment.
- **Offer `tools` as an explicit allowlist.** That allowlist would have to be checked against every
  SDK upgrade before the first trimming result exists. Adding to the withheld list keeps the
  sidecar's fixed safety withholds in force and is enough to measure the effect first.
- **Split at the proxy by content.** The CLI drops the boundary marker before sending, so the proxy
  cannot see the sidecar's split. The marker-based split and the per-block hashes are what the
  upstream actually receives.

### Open items

- Whether cache hits rise, and whether average context drops by a third, needs a paired
  before-and-after window on a real model (Testbox). No test here measures it.
- In SDK 0.3.278 the CLI keeps the static part as a separate, globally scoped cache block only
  where it enables global cache scope. Elsewhere it drops the marker and joins the blocks, which is
  the expected behaviour through an Anthropic-protocol gateway. What reaches the upstream is
  visible in the request shapes (decision 22), not assumed.
- Mounting the browser MCP server only for runs that need it, and the reasoning knob for
  script-running bots, are separate strategy experiments.

### Verification (amendment 5)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 20 | A three-response run asks for `full` once and `summary` twice; the samples carry the CLI's totals and per-server MCP tokens; a CLI that throws costs one warning and no further calls, and the run completes; a query without the method is never asked | T1 `packages/sidecar/src/context-usage-run.test.ts`, T0 `packages/testkit/src/fake-sdk/fake-sdk.test.ts` ("session start and context usage") | Share of runs with a `full` `context_usage` sample; median first-sample `totalTokens` per workspace |
| 21 | A fresh start logs `session_start` with `sessionSource: startup` and no resume fields; a resume logs `contextTokens`, `promptCacheLikelyExpired`, `secondsSinceLastResponse`; a `model_switch` carries `promptCacheWarm` and `contextTokens` | T1 `packages/sidecar/src/context-usage-run.test.ts`, T1 `packages/sidecar/src/model-events.test.ts` | Resumes with `promptCacheLikelyExpired = true` per workspace and day |
| 22 | The shape splits after the last marked system block, keeps the static hash when only the dynamic part changes, counts markers in nested tool results, survives a store round trip, and is summarised by the run context API with the changed block positions | T0 `packages/gateway/src/model-proxy/request-facts.test.ts`, T1 `packages/gateway/src/ledger/model-requests.test.ts`, T0 `packages/gateway/src/ledger/run-context.test.ts`, T1 `packages/gateway/src/api/run-context-routes.test.ts` | Requests with `cache_control_blocks > 0`; distinct `system_static_sha256` per thread; cache hit % per hour by workspace |
| 23 | The static hash is equal across two runs of a bot with a different diary, memory and index; a withholding run keeps the static hash and has a dynamic one; the option is a custom prompt with `snapshot: true` and the boundary as its own block; joined, it is byte-identical to `systemPrompt`; the static hash reaches `runs.config_json` | T0 `packages/sidecar/src/system-prompt.test.ts`, T1 `packages/sidecar/src/run-once.test.ts` ("ledgers the context section sizes"), T1 `packages/gateway/src/scheduler/run-lifecycle.test.ts` | Distinct `systemPromptStaticSha256` per bot per day (expected 1 per thread kind) |
| 24 | Empty variables give no stamp values, no start-request field and the SDK options exactly as before; set values are validated, stamped on the run row, sent from the row even after the Gateway is reconfigured, merged after the fixed withheld list and passed as inline `settings`; an MCP name is refused at startup and on stdin | T0 `packages/gateway/src/config/cli-surface.test.ts`, T1 `packages/gateway/src/scheduler/cli-surface.test.ts`, T1 `packages/sidecar/src/cli-surface.test.ts` | Average input tokens per request in a paired window, knob on against off |

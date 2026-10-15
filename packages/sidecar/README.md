# @deskmates/sidecar

Runs **inside** the workspace container, one process per run. It is the process that calls the Claude Agent SDK's `query()`; there is no separate proxy layer between the agent and its tools (ADR-0002).

A workspace holds a group of bots that share one Chromium, one filesystem and one shell (ADR-0004). Several sidecar processes for different bots can run at once in the same container.

Responsibilities:

- Accept run requests from the Gateway over the container network, validate them against the `StartRunRequest` schema (`src/start-run-request.ts`), assemble context (`SOUL.md`, `MEMORY.md`, recent diary, trigger payload, knowledge hits), and call `query()`.
- Echo the request's `attempt` on every ledger event. A resumed run is a second sidecar process of the same run row and the event counter restarts at 1 in each process, so the Gateway dedups redeliveries on `(run, attempt, seq)`; an event with the wrong attempt is silently dropped as a duplicate (ADR-0002 amendment 2).
- Classify every tool call by risk in a `PreToolUse` hook (`src/hooks/pre-tool-use.ts`), in this order: egress check, browser lock, risk tier.
  - L0/L1 → hook returns `allow`.
  - L2, human online → the hook posts the approval request and blocks, polling the Gateway, until the decision or the short-wait timeout; it returns `allow` or `deny`. A poll that fails is not a decision: the wait treats it as "still pending" and runs to the deadline. If the Gateway never accepts the request at all — the post and its one retry both fail — the hook denies, because no human can answer an approval that was never created.
  - L2, timeout, human offline, or the SDK aborting the hook → hook returns `permissionDecision: "defer"`; the query ends, the session id and, when the run had navigated, the page's origin are reported in `run_ended`, and the process may exit. Resume later with `resume: sessionId`; the replayed call consumes the human's decision, matched by tool-use id.
  - A resumed run is a new process and therefore a new browser MCP session, so the replayed call's `ref` belongs to a snapshot that no longer exists and the call usually fails. When the replayed call's tool result is an error, the decision is re-armed and the first later call in the same process whose `(toolName, targetOrigin, argumentPattern)` equal the deferred action's consumes it instead; the `approval` event records which call took it (`consumedBy: "replay" | "retry"`) and names both tool-use ids. The decision is spent after one use, a call with any different dimension is judged afresh and posts its own request, and nothing survives the process. The resume trigger's `currentOrigin` seeds `RunState.currentOrigin`, so a click in the resumed process has an origin before it navigates again (ADR-0002 amendment 2).
  - `canUseTool` (`src/can-use-tool.ts`) is a fail-closed backstop, not the wait: in SDK 0.3.278 it runs after the hook and cannot return `defer` (ADR-0002 amendment 1).
- Tier every tool from a curated table (`src/risk-tier.ts`, ADR-0002 amendment 3, A5): `SDK_BUILTIN_TOOLS` names every built-in tool of the pinned SDK, withheld ones included; a subagent spawn (`Agent`/`Task`) is L1 because each call inside the subagent passes the hook with `agent_id` set; `ListAgents` is L0; a `tty_session` write that is exactly one complete line is tiered by the shell rules. A tool in no table is still L2, and its request carries `unclassified: true`; a request made inside a subagent carries its `agentType`. Both are display labels on the posted `ToolAction` and the `requested` event, never rule dimensions. `sdk-tool-inventory.container.test.ts` (T2) fails when the pinned SDK declares a tool the table does not name.
- Derive the dimensions an approval rule matches on, so an "Always" decision still matches the same action on a later run (ADR-0002 amendment 2, A3). They ride on the `ToolAction` the hook posts:
  - `targetOrigin`: the origin in the call's own input, or else `RunState.currentOrigin`, the origin of the last navigation the hook let through egress. A call made before any navigation, or after one egress blocked, has no origin and matches no rule that names one.
  - `argumentSummary`: one line, at most 200 characters, never tool output — the shell command, the clicked element's description, the navigated URL, the resolved file path, or a compact JSON of the input.
  - `argumentPattern`: the glob the rule stores instead of that summary, because the summary is not stable: a click keeps only the side-effect phrase that made it L2 (`*submit*`), a shell command keeps its program and subcommand (`git push*`, `curl *`). Navigation and file tools get none; their dimension is the origin and the path.
- Offer `approval_decide` (`{approvalId, decision, reason?}`) on the `deskmates` MCP server when the run's `tools` list carries it. It posts the decision to the Gateway, which checks that the bot is a member of the thread the request was posted in and records who decided. Any member of the thread may decide an approval, a human from the UI or a bot through `approval_decide`, except that a bot may not decide its own request or one from work it delegated, and may answer only `allow_once` or `deny` (ADR-0002 amendment 3, A10); a deciding bot is a soft boundary like SOUL and grouping, not a security boundary (ADR-0002 amendment 2). The tool is L1: it is a Gateway-side record on a request the thread already holds, so it never starts a second approval wait. A Gateway refusal (a non-member bot, an approval already decided) comes back as the tool's result text, not as a failed run.
- Offer `task_deliver` (`{taskId, summary, artifacts: [{label, path}], output?}`) when the run's `tools` list carries it and the start request names `deliverableTasks`; the description lists those tasks and any output schema (ADR-0021 amendment 2). It posts to `POST /internal/runs/{runId}/tasks/{taskId}/deliver`; the Gateway checks the link, the paths and the schema. The tool is L1, a Gateway-side record that a human still accepts. A refusal, schema errors included, comes back as the tool's result text.
- Enforce the workspace egress allowlist (browser navigation and `curl`/`wget` in shell commands; `WebFetch`/`WebSearch` are disallowed), refreshed from the Gateway before each of those checks, and the workspace browser lock (return a wait message to browser tools while a human has the screen).
- Withhold the CLI's tools that need a person at a terminal or a CLI session to schedule into: `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `Workflow`, `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup` (`DISALLOWED_TOOLS` in `src/run-once.ts`). The SDK routes the interactive ones through `canUseTool` in headless mode, so the fail-closed backstop denies them even after a human allowed the call in the hook; a real run showed an approved `AskUserQuestion` denied that way. The bot asks in its reply and ends the run instead. The list was checked against what the CLI offers the model through the real stack (`spikes/list-cli-tools.ts`, 54 tools in SDK 0.3.278).
- Stream `RunEvent`s back to the Gateway tagged with the bot; redact tokens and cookies before anything enters the ledger. The approval request is the process's second exit — the Gateway writes its `ToolAction` into the approvals row, the thread's system message and the `posted` event — so the hook passes that action through the same redactor before posting it, and a `curl -H "Authorization: Bearer …"` that rates L2 reaches the human with its shape intact and its token gone.
- Put one screenshot of the page in the ledger after every browser action that can change what it shows (`src/screenshots.ts`). The MCP stdio proxy takes a viewport JPEG and writes it to the run's capture directory before it forwards that action's result, so the file is already there when the run process sees the call's `tool_result`; the run process then emits a `screenshot` event carrying `base64` + `mimeType`, which the run screen renders as a data URL. Read-only browser calls (`browser_snapshot`, `browser_take_screenshot`, `browser_find`, the console and network readers) never trigger one. Two caps keep the ledger bounded: at most 40 captures per run, and a capture above 300 kB is dropped rather than resized — a viewport JPEG is tens of kilobytes, while a full-page PNG after every click would be the largest thing in the database by a wide margin. A missing capture costs the run a `log` line, never the run. The image is **not** redacted: the redactor works on text patterns and credential key names, and a rendered page can show a token in a form field or a session id in the URL bar. A screenshot is therefore ledger data with the same sensitivity as page content — whoever can read a run's events can see what the bot saw.
- Start the SDK in `/work`, or, when the request carries `workdirMode: "per-bot"` (the Gateway's opt-in `DESKMATES_BOT_WORKDIR`, issue #88), in `/work/bots/<bot>`, created before the query; if it cannot be created the run logs a warning and starts in `/work`. The prompt then names that directory and the shared `/work` and suggests a `git worktree` there for a shared repository. A convention, not access control: no hook or callback looks at which directory a tool call touches. Without the field the system prompt is byte-identical to before the knob (`context.test.ts` pins its hash).
- When the request also carries `worktreeRepo` (a workspace's opt-in setting, ADR-0036), prepare the bot's own worktree `/work/bots/<bot>/<repo name>` on branch `bots/<bot>` before the query (`worktree.ts`): reuse it when it exists, else `git worktree prune` and `git worktree add`, with the image's `git` through `execFile` and nothing else. It never resets, pulls, merges or removes anything. The outcome is a `workdir` log event; a failure is said in the run's prompt and never fails the run. An `otherLaneRun` in the request adds a note after the trigger naming the bot's other live run; it is a note, not a lock.
- Persist SDK state under the bot's home directory: `CLAUDE_CONFIG_DIR=/home/<bot>/.claude`, `settingSources: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- Leave model retries and fallback to the SDK and record them (ADR-0023 decision 3): `StartRunRequest.fallbackModel`, when present, becomes `options.fallbackModel` verbatim; each `system` / `api_retry` message becomes a `model_retry` event and the `PostModelSwitch` hook a `model_switch` event `{from, to, source, requested?}`. The sidecar calls `query()` once per process and never retries a model call itself; usage goes to the Gateway per model in `modelUsage`.

## Bot handoffs (M2 foundation)

`message_bot(to, body, attachments?)` is an L1 tool on the in-process `deskmates`
MCP server when offered in the run request. It is also offered on cron/webhook
runs with no chat thread. The sidecar forwards the recipient name and message;
the Gateway resolves the pairwise bus thread, applies routing limits, and queues
the recipient. A routing refusal is returned as an error tool result so the bot
can explain it without crashing its run. Recording a message does not promise
immediate execution: scheduling and conversation caps still apply.

## MCP proxy

The SDK does not launch the browser MCP server directly. It launches `deskmates-sidecar mcp-proxy -- playwright-mcp --cdp-endpoint … --caps vision --snapshot-mode none` (`src/browser-mcp.ts`), a second process of this same binary that speaks the same newline-delimited JSON-RPC 2.0 on both sides and provides wrapping, capture and tab coordination (`src/mcp-proxy/proxy.ts`). The original wrapping path exists because the SDK offers no hook on a tool *result* — `PreToolUse` and `canUseTool` both run before the call — so the wire the MCP server answers on is the only place page text can be relabelled before it enters model context.

`--snapshot-mode none` disables the automatic accessibility snapshot that MCP 0.0.82 otherwise writes to `.playwright-mcp/page-*.yml` after actions such as navigate and click. Those action results still carry the page header. The model reads the changed page with an explicit `browser_snapshot`; without its optional `filename`, that tool returns the accessibility tree inline, so the proxy wraps the actual page text before it reaches model context. Explicit filename exports remain supported and are not changed by this default-path rule.

**Wrapping.** Every `text` item of every `tools/call` result is replaced by `wrapPageContent(origin, text)`: `<untrusted source="page:<origin>">`, the text, `</untrusted>`. The origin is the last URL a browser tool was pointed at; before any navigation the label is `page:unknown`. `isError` results are wrapped too, because an error message quotes the page. This proxy only ever fronts the browser server, so there is no tool-name allowlist to keep in step with the MCP release: every result it sees is page derived.

The encoding is entity escaping, not tag stripping. The body has every `&`, `<` and `>` rewritten as `&amp;`, `&lt;` and `&gt;`, so it contains no `<` at all and no tag of any spelling can exist inside the wrapper. That is stronger than the regex `wrapUntrusted` uses for bot messages, which rewrites the spellings of `</untrusted>` its author thought of; a reader tolerant of `</ untrusted >` would walk past it. Here the character a tag has to start with is simply absent, which holds for any reader. `UNTRUSTED_NOTICE` in the system prompt tells the model to read the entities as the characters they stand for.

**What the ledger keeps.** The raw result, not the wrapped one — the `tool_result` event is written from the SDK's message, which is what the model saw, wrapper and all. Nothing about the wrapper changes what an operator reads back, and the redactor still runs over it.

**Capture.** After a page-changing browser action (`isPageChangingBrowserTool` in `src/screenshots.ts`) the proxy asks the same server for a viewport JPEG, writes it to `$DESKMATES_SCREENSHOT_DIR/<n>.json` (temp name then rename, so the run process never reads half a file) and only then forwards the action's result, so the image is of the page the model is about to be told about. `browser_take_screenshot` in `@playwright/mcp` 0.0.82 only attaches the image to its result when no `filename` is given, so the proxy sends `{type: "jpeg", fullPage: false, scale: "css"}` and no filename: it needs the bytes, not a path. Two caps, both in `src/screenshots.ts`: `SCREENSHOT_MAX_PER_RUN` (40) stops capturing after the 40th action, `SCREENSHOT_MAX_BYTES` (300 kB) drops a capture too large to keep. A capture that fails, comes back oversize or never answers within 5 s costs the tool result a short delay and a line on stderr, and nothing else.

The image is **not** redacted. The redactor works on text and a rendered page can show a token in a form field; anyone who can read a run's screenshots can read what was on screen.

**Withheld images.** A run started with `visionPolicy: "withhold"` (ADR-0023 amendment 2: its model cannot see, or was seen inventing an image's content) gets a text notice wherever it would have got an image (`src/vision-withhold.ts`): an extra `## Images` system-prompt section, a PreToolUse deny with a notice for `Read` of a `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp` file (logged as `vision`/`image_withheld`), and a browser MCP started without `--caps vision` whose proxy (`DESKMATES_VISION_POLICY=withhold`) replaces every `image` item of a result with a host notice and attaches no vision-fallback screenshot. The proxy's own ledger captures above are unchanged. Without the key every prompt and argument is as before.

The proxy is not a security boundary. The container network is open and every bot in the workspace has a shell, so a bot that wants raw page bytes can fetch them itself (ADR-0004). The wrapper is about the model reading page text as data, which is the failure mode that actually happens.

## Exit codes

`deskmates-sidecar run` reads one `StartRunRequest` as JSON on stdin and exits:

| Code | Meaning |
|---|---|
| 0 | the run completed or deferred; the Gateway has its `RunEnded` |
| 1 | the run failed; the Gateway has the `RunEnded`, with the error |
| 2 | stdin is not a usable `StartRunRequest`; the issues are on stderr and nothing ran |
| 3 | the run finished but `RunEnded` could not be delivered after five attempts over ~15 s. It is the last line of stdout, prefixed `RUN_ENDED `, for the caller to post instead |

Code 3 exists because a lost `POST /ended` would otherwise turn a completed run into `failed` on the Gateway and throw away the reply a human is waiting for.

For ADR-0016, a structured SDK `error_max_turns` result reports `turns_exhausted`
with its session, usage and partial-work handoff. SDK 0.3.278 can subsequently
throw the same result text on subprocess exit; that exact duplicate remains a
warning and does not replace the parkable outcome. An exception without the
typed result, or a different failure after it, still reports `failed`. The
Gateway decides whether and how the same logical run may be continued.

The stdin schema is the only thing between the contract type and the process, and zod strips keys it does not name: a field the Gateway sends and the schema lacks is silently gone. So every field added to `StartRunRequest` gets a round-trip case in `src/start-run-request.test.ts` that feeds the JSON through `parseStartRunRequest` and asserts the value survives. The rule came from the M1 resume hand-over (`deferredAction`, `currentOrigin`), which the schema dropped until the first real T3 run showed the retry asking for a second approval.

The same shape of mistake hides behind computed defaults: any value with a default that is computed when an option is omitted gets a test that omits the option, so the path the product takes is the one under test. The rule came from the screenshot directory, which `runOnce` computed and created but handed to the MCP proxy only when a test had supplied it, so every real run captured nothing until a T3 noticed.

## Not in M0

What the design assigns to this package but M0 does not do. Each is a gap, not a decision.

- **Network-level egress.** The hook checks tool inputs; the container network is open. Deferred with ADR-0006 (operator authentication and per-workspace networks land together); the hook reads the workspace's current allowlist on every navigation check in the meantime.
- **Supervisor mode.** The design gives this binary a supervisor that owns Chromium, Xvfb, noVNC, the single Playwright MCP instance and the login probe. In M0 the image's `entry.sh` starts those, the Gateway starts one `deskmates-sidecar run` process per run over `exec`, and each run launches its own Playwright MCP over stdio against the shared CDP endpoint.
- **Connector MCP servers and knowledge-base hits.** Hook points only.
- **Bypass of a denied L2 click.** After a denied "Submit" click, `browser_press_key` Enter or `browser_evaluate` are rated L1. `SOUL.md` tells the bot not to work around denials; the S11 acceptance assertion fails if it does. Under the opt-in `BROWSER_CODE_APPROVAL=effects-v1` (ADR-0002 amendment 5, proposed, off by default) generic browser code and `playwright-cli eval`/`run-code` are tiered by the effects their text may have (`browser-code-effects.ts`): a keyword scan, so a guard rail and not a security boundary.
- **Cost accounting.** The SDK's CLI makes a title-generation request per run on the same model; its tokens land in the run's usage row.

Rules:

- The only package allowed to import `@anthropic-ai/claude-agent-sdk`.
- `DESKMATES_EGRESS_PROXY` is the managed proxy address supplied by the workspace provider. The
  `run` and `mcp-proxy` processes install an undici dispatcher for Node fetch; the SDK CLI and
  Playwright MCP child receive HTTP(S) proxy variables derived only from that address. Only
  localhost, 127.0.0.1 and [::1] bypass it, keeping CDP local while the reserved host name uses
  the managed proxy (ADR-0009). Arbitrary proxy variables from the shared environment are not
  forwarded to the SDK or browser child.
- Never holds an upstream model key. It receives `ANTHROPIC_BASE_URL` and a short-lived `ANTHROPIC_AUTH_TOKEN` (Bearer) from the Gateway per run.
- One Chromium per workspace, shared by every bot in it: MCP with `--cdp-endpoint http://127.0.0.1:9222 --caps vision --snapshot-mode none`; CLI with `attach --cdp=http://127.0.0.1:9222`. The endpoint comes from configuration and is never hardcoded.
- Do not implement access control between bots in the same workspace. They share cookies and files by design (ADR-0004). Isolation is a second workspace, decided by an operator, not a runtime check.
- Before any browser tool call, acquire the workspace browser lock from the Gateway in the PreToolUse hook. A wait response becomes the tool result; no retry loop. When such a call then waits for an L2 approval, renew the lock on every poll: the lock TTL is shorter than the short wait, so a lock taken and left alone would lapse mid-approval.
- Every call to the Gateway carries a deadline (`GATEWAY_TIMEOUT_MS`, 10 s). A Gateway that accepts the connection and never answers must not be able to hang a run.
- The egress allowlist is whatever the `StartRunRequest` carries, empty list included. `DESKMATES_EGRESS_ALLOWLIST` in the container environment applies only to a hand run that carries no list; it never widens one the Gateway sent, or a host an operator removed would stay reachable until someone recreated the container.
- The list is refreshed from the Gateway inside the hook, before every navigation check: `GET /internal/runs/{runId}/egress` on a browser navigation or a `curl`/`wget` shell command, never on any other tool call. A run that has been going for an hour therefore checks against the list an operator published a minute ago, not against the copy it started with. On success the hook keeps the answer, and when it differs from the list it last used it emits one `log` event (`{source: "egress", op: "allowlist_refreshed", updatedAt, added, removed}`) — once per change, not once per call. On any failure — non-2xx, the 10 s deadline, a thrown error — the last known list applies (initially the request's) and one `log` `{source: "egress", level: "warn", error}` is emitted per distinct failure, so a Gateway that stays down does not fill the ledger with the same line. A failed refresh never widens the list and never empties it; the check stays deny-by-default either way.
- `maxTurns` comes from the request, not from the container. It is a Gateway knob (`DESKMATES_MAX_TURNS` there) recorded in `runs.config_json`, so a run's turn budget can be attributed to its row; a container variable would silently apply to every bot in the workspace and to no run row. The sidecar has no default: a request without a usable `maxTurns` is rejected on stdin with exit code 2.
- `effort` and `thinking` come from the request too, and only when the Gateway resolved a value (run config, else bot). The sidecar passes them to `query()` as the SDK's `effort` and `thinking` options and otherwise passes neither, so the SDK's own default stays in force and the run row's `reasoning: "sdk-default"` stays true. It never invents a value and never reads one from the container environment.
- The SDK's CLI subprocess gets an environment **allowlist** (`PATH`, `HOME`, `LANG`, `LC_*`, `TZ`, `DISPLAY`, `TMPDIR`, `TERM`, `SHELL`, `USER`, `DESKMATES_*`) plus the variables the sidecar sets itself. The container environment belongs to the whole workspace; anything else in it — `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_MODEL`, `HTTPS_PROXY`, `NODE_OPTIONS` — would change how the run reaches a model, which model it uses, or what code the CLI loads.
- The risk-tier tables name tools that exist in the pinned `@playwright/mcp` release. A browser tool in none of them is L2.
- The capture directory belongs to the run, not to the workspace: `runOnce` creates it, the proxy writes into it, and the run removes it at the end. Captures are ledger rows by then, and a resumed run is a new process with a new MCP session whose actions are counted from one again.


## Thread routing context v1

The optional trigger routing context identifies the recipient and original wake sequence.
Each delivered message can state whether it addresses this recipient, everyone, another
member, or has no explicit recipient. The sidecar renders those Gateway facts separately
from message bodies; bot bodies and attachments retain their untrusted wrapper. A role
can authorize work using teammate data, but routing labels do not authorize a task or
require a reply to every observed message. Legacy payloads without routing metadata keep
the prior rendering. The stdin round-trip test covers both the header and message fields.

Version 2 (ADR-0005 amendment 2) adds a roster to a group wake: every member in join
order with its role, which one is the recipient and which one is the thread's owner, and,
when the wake is the offer of an unaddressed request, who was offered it before and who is
next. These are operator configuration and Gateway routing facts, rendered with the
routing header and outside any wrapper; the sidecar computes none of them. When the
request carries `groupGuidance: "owner-v1"` the fixed guidance gains the group norm: take
an offered request, hand it to a better-suited member by mention, or end with an empty
reply; the taker answers the human and acts on `Delegation outcome` notices; an `@name`
always hands work to that member. The norm is prompt text. It is measured in
`acceptance/m3-group-owner`, not enforced.

`thread_post` returns what the Gateway says about the message it just posted
(`posted-message.ts`): its seq, whom it addressed, that a message with no mention wakes
nobody under `owner-v1`, and any `@ name` with a space or `@name` no member has. A Gateway
that sends no such facts gets the old "Posted to the thread.".

**Run tab coordination (M2 B2).** A run's first browser call creates its own tab in the
workspace's existing Chromium/profile. The proxy obtains stable CDP target IDs through
a constant, host-authored MCP diagnostic and leases the actual target through the Gateway.
Numeric MCP indices are resolved against the last observed view and reindexed immediately
before selection/closure. Calls within one MCP connection are serialized. PreToolUse still
performs risk/egress/approval decisions; it reads persisted tab metadata when available, and
the proxy rechecks the actual target immediately before dispatch. Metadata lives under
`<bot-home>/.deskmates/browser/<run-id>.json`; approval resume reuses that target. A missing
target opens a fresh tab and rejects the pending action instead of operating MCP's fallback
page. Closing the selected page returns a closure notice without its fallback page content.

Human takeover prevents new browser dispatch and capture. A persisted workspace epoch
fences in-flight tool results and buffered screenshot uploads even after quick handback.
The Gateway filters screenshots before ledger/SSE delivery. An already dispatched action
may have completed; the error explicitly tells the model to verify before retrying.
Normal completion releases leases but retains tabs for inspection; automatic tab retention
limits are not yet implemented. This is coordination, not bot access control: arbitrary code
and shell tools still share the workspace. The internal diagnostic depends on pinned MCP
0.0.82 output and is covered by `acceptance/m2-browser.container.test.ts`.

**Background page interaction.** MCP 0.0.82's CDP attachment uses `noDefaults: true`,
which skips Playwright's default focus emulation. With multiple MCP connections,
a peer can make a run's page hidden; ordinary clicks then time out waiting for
animation-frame stability even though the element exists. After verifying the
current target and acquiring its lease, the coordinator prepares that page with
`Emulation.setFocusEmulationEnabled`. One CDP session is retained on the MCP Page
object, since detaching immediately undoes the override. Page/MCP connection
closure releases it; a failed session is discarded before a later retry.

This deliberately gives automated pages a visible/focused DOM state without
bringing them to the physical foreground. It neither forces clicks nor skips
Playwright actionability checks. Target identity and human takeover checks still
apply before preparation and dispatch; no preparation runs for tab-management
calls or while the human already holds the browser. See `spikes/m2-click-stability`
for the default/flags/detached/persistent-session reproduction, and the M2 browser
container regression for concurrent clicks through the actual proxy and Gateway.

**Ledger screenshot foreground preparation.** Focus emulation fixes ordinary background
clicks but does not reliably unblock headed Chromium screenshots. Immediately before an
automatic ledger capture, the coordinator verifies the selected target and exact URL,
rechecks its lease and takeover epoch, and brings that verified page forward using fixed
host-authored code. It then rechecks target, URL and epoch before dispatching the screenshot;
the existing post-capture fence still discards images across control changes. Normal result
and accessibility-snapshot fences never move the foreground. Preparation RPCs use the
existing five-second capture bound. An unanswered preparation skips that capture with a
marker saying so and keeps the MCP session: its probes are host-authored and cannot change
reference state, and a late answer is dropped. Ending the session there, as before
2026-09-29, made the action's final fence fail and returned a successful navigation as
"Browser control changed" (five concurrent bots on heavy public pages, Testbox trial).
The final fence still runs in full. If the session did end mid-call, the result says the
browser connection was reset rather than that control changed.
No browser action is retried, and no cross-run screenshot lock or longer deadline is added.
The isolated `spikes/m2-browser-capture` probe covers both simultaneous captures and a peer
stealing foreground with a short gap; the browser T2 also requires all sixteen concurrent
click captures to retain the correct run target.

## Explicit final reply and silence

A valid structured summary's string `reply` field is authoritative, including
`""`. An empty reply records a silent run; prose outside the summary is never
promoted over that explicit choice. A missing reply key or an invalid/missing
summary retains the compatibility fallback. The output instruction asks for
only the fenced summary and directs all intended public text into `reply`.

This avoids publishing internal explanations such as “remaining silent” and
creating derivative group wakes. It also means a model that writes a real answer
outside JSON while declaring an empty reply will remain silent: the parser does
not guess intent. Configured-model protocol and role compliance are measured
separately from this deterministic contract.

## Asynchronous teammate replies

A thread wake receives a fixed message batch. New messages routed to that bot
queue a later wake, subject to thread caps; they do not enter its running SDK
session. When a delegated result is the next required input, the bot should end
with an empty `reply` so the lane is available for the next wake. Sleeping or
polling inside the current run cannot refresh that batch. Independent work and
progress messages remain supported. This guidance does not decide routing or
forbid a SOUL-authorized bot from acting on a teammate's request.

When the delegated run ends, the Gateway posts a `system` message in the thread
the bot delegated from and wakes it (ADR-0016 amendment 1): the teammate's name,
the outcome (`succeeded`, `silent`, `failed`, `stopped`) and where the reply is.
The bot therefore learns of a failed or silent teammate without polling. For a
`message_bot` handoff the notice quotes the reply inside the bot wrapper; a
delivery that carries such a quote taints the run like a bot message does
(`memory-taint.ts`).

## Host phase timing

The coordinated MCP proxy emits `phase_timing` start/end observations for its
serialized queue, pre-dispatch coordination, actual tool RPC, post-dispatch checks,
capture RPC/capture envelope and final fencing. Optional origin admission has its
own nested span. These are host measurements, separate from delayed SDK tool ledger
events, and never enter model context. A resolved RPC is a transport observation;
business success still requires the tool result and final-state oracle.

Telemetry uses the existing authenticated event route with the run attempt and no
SDK sequence number. A bounded asynchronous buffer drops failed deliveries rather
than retrying or delaying tools, and shutdown flush is bounded. Hard termination
can leave unmatched starts or entirely missing samples. Consumers must report
those gaps and compute interval unions rather than sum nested phase durations.

## Optional origin admission (ADR-0007)

A Gateway request carrying `browserCoordination.mode = "origin-v2"` enables
origin admission in the serialized MCP coordinator after live target verification.
Navigation uses the requested URL origin; other page actions use the verified tab
origin. Waiting for another run stays inside the host and consumes the Gateway's
existing deadline. Cancellation, transport failure and deadline expiry stop the
wait; a human takeover requires a fresh browser decision after handback. Switching
origins releases the previous entry first. A redirect releases ownership and
returns an explicit state-change error without replaying the action. The mode is
absent by default, preserving tab-v1. Automatic capture failures now write skipped
markers when storage is available, avoiding an additional post-tool marker wait;
this does not repair an underlying screenshot failure.

## Opt-in inline snapshots

A run with `browserSnapshotMode: inline-v2` asks the existing MCP proxy to attach
one fresh unscoped accessibility snapshot after each successful page-changing
action. The child MCP still runs with `--snapshot-mode none`; no automatic YAML
file link is reintroduced. Missing mode and `explicit-v1` retain the original path.

The supplemental read uses live target/URL/takeover-epoch checks and fresh egress
allowlists before and after it. Only text is included, inside the existing
untrusted wrapper, with a 512 kB limit and no partial truncation. Fixed host
failure diagnostics are separate from page content. A five-second snapshot RPC
timeout taints and closes the MCP connection: page-derived results are suppressed,
later calls cannot dispatch through that connection, and the diagnostic explicitly
states that the original action may have completed. No action is automatically
retried. Other invalidated control contexts retain the existing fail-closed fences.

`browser_snapshot_rpc` measures the internal RPC only; its surrounding checks are
separate fence observations. Additional page text and calls can increase cost, so
this is a versioned experiment, not a default optimization or an adoption claim.

## B5: approved reference knowledge and operator memory helper

The Gateway can offer `knowledge_search`, `knowledge_read` and `knowledge_propose` on the
`deskmates` MCP server. Search/read responses are entity-escaped untrusted reference data.
Proposals remain unpublished until an authenticated human reviews them. On a new run,
context assembly searches the delivered task text (up to 500 characters) and includes at most
five approved reference excerpts; it logs document IDs/versions and tolerates unavailable
retrieval. Full documents are fetched with `knowledge_read`. The run configuration records
retrieval version and bounds. This changes strategy inputs and still requires paired evaluation;
feature availability is not evidence of quality improvement.

`deskmates-sidecar memory` reads a JSON operation from stdin and operates on the named bot's
`/home/<bot>/MEMORY.md`, returning `{body, version}`. The Gateway owns the maintenance lease;
this helper does not leave a persistent edit lock after a crash. It rejects path traversal,
symlinks, nonregular/oversized files and stale versions. It never invokes the SDK or a model.

`deskmates-sidecar file-read` (ADR-0014, `file-read.ts`) reads `{path, botNames, maxBytes}` from
stdin for the operator download route and prints `{base64, size}`, or `{error, message}` with
exit 1. It applies the ADR-0014 decision 2 path policy: an absolute path over
`[A-Za-z0-9._\-/]` with no `..` segment, resolved with `realpath` to a regular file under `/work/`
or `/home/<bot>/` for one of `botNames`, so a link planted in `/work` that points into `/profile`
is refused. The size is checked before reading. Refusals use fixed messages that name the policy,
never a filesystem detail. It never invokes the SDK or a model.

Automatic vision fallback and governed CLI/script mode are implemented as the opt-in
execution strategy described below. Their real-runtime checks establish the specific
execution contracts; default strategy adoption and model quality need separate evaluation.

## Connector tools (ADR-0012)

`connector-tools.ts` registers `connector_describe`, `connector_validate`, `connector_submit`,
`connector_status` and `connector_receipt` on the `deskmates` server when the run's tool list
includes them, and their `connector` argument accepts only the names in the bot's `connectors`
list. That list is a prompt-level choice, not access control. The sidecar never holds a
connector's URL or credential: every call goes to the Gateway's
`/internal/runs/:runId/connectors/:connector/*` routes with the run token, and the Gateway is
the only caller of the connector. Results enter model context entity-escaped inside
`<untrusted source="connector:<name>">`; the raw result is in the ledger as the Gateway's own
`tool_result` event (`source: "connector_proxy"`). A refusal reaches the model as an error
result carrying the Gateway's typed code (`connector_hash_mismatch`, `connector_validation_stale`, ...).

Risk tier: describe, validate, status and receipt are L0. The PreToolUse hook tiers
`connector_submit` by the effect class of the Gateway's stored validation, read from
`GET .../validations/:validationId`: `read` L0, `reversible` L1, `external` L2. The tool input
never sets the tier, and a validation the hook cannot read denies the call. An approval request
for a connector submit carries the connector id, the content hash and the validation summary,
never the submission body; its `argumentPattern` is `connector:<id> effect:<effect> *`, so an
Always rule matches on connector id and effect class.

## Integration tools (ADR-0013)

`integration-tools.ts` registers `integration_apps`, `integration_connections`,
`integration_search`, `integration_guide` and `integration_execute` on the `deskmates` server when
the start request's `integrationConnections` is above zero and the run's tool list includes them.
The sidecar never learns the integration runtime's URL, a runtime token or a connection's
credential: every call goes to the Gateway's `/internal/runs/:runId/integrations/*` routes with
the run token, and the Gateway checks the named connection against the run's workspace before it
forwards anything. A search must name a service and returns at most five actions. Results enter
model context entity-escaped inside `<untrusted source="integration:<service>">`; the raw result
is in the ledger as the Gateway's own `tool_result` event (`source: "integration_proxy"`). A
refusal reaches the model as an error result carrying the Gateway's typed code
(`integration_connection_not_allowed`, `integration_not_adopted`, ...).

Risk tier: apps, connections, search and guide are L0. The PreToolUse hook tiers
`integration_execute` by the catalog's `operationType` of the action and the operator's override,
read from `GET .../integrations/actions/:actionId/tier`: `read` L0, `write` L2 unless an operator
lowered that action to L1, `destructive` L2 always (`tierForAction` in contracts). The tool input
never sets the tier, and a tier the hook cannot read denies the call. An integration approval
request carries the service, the action id, the connection name, the operationType and the
catalog description. For Drive it also carries a bounded, redacted proposed target and outgoing
content preview (ADR-0013 Amendment 2); other providers omit the input body. Its `argumentPattern` is
`integration:<service> action:<id>`, so an Always rule matches on service and action.

## M1/M2 feature closeout

`tty_session` uses image-preinstalled `node-pty@1.1.0`. Open/write are L2, read is L0,
resize/close L1. Up to four terminals belong to one run attempt; output is incremental
and capped at 64 KiB, lifetime defaults to 120 seconds (maximum 900), and every terminal
is terminated when the attempt ends or parks. Explicitly close completed sessions to
release slots. Mark password/token writes `sensitive=true` for ledger/approval redaction.

`BROWSER_EXECUTION_MODE=vision-cli-v2` opts into second matching target-failure vision
assistance and `browser_cli_workflow`. The CLI accepts only reviewed structured actions
on one origin, binds exact CDP target identity, uses the same approval/egress/lock controls,
and stops after a lost fence. It never automatically repeats uncertain side effects.
The normal strategy remains unchanged until separate paired evaluation.

The pinned MCP uses `target` (with optional `element`); the fallback matches its actual
missing-reference error and preserves the first failure across an observation refresh.
The CLI allows a public origin or the exact managed `host.docker.internal` origin from
ADR-0009, and requires a current egress allowlist entry for either. Its host-authored
program reads the page's origin inside the page context because the pinned CLI's
`run-code` sandbox has no global `URL`. Real MCP/CLI container tests verify automatic
image attachment, exact run-target selection, screenshot attribution and detach behavior.

A new browser proxy asks the Gateway for a bounded retained-tab cleanup plan. Only old
completed targets beyond the retention policy may close, with exact target leases and
human-takeover fences. This supersedes the earlier unbounded normal-completion retention.

Resource log observations distinguish sidecar RSS from workspace cgroup memory/peak;
missing measurements are omitted. See the feature-closeout test handoff for native image,
real browser/model and capacity validation that fake tests cannot establish.


## Shared-login screen routing (ADR-0008)

An optional validated `screenSlot` makes the browser coordinator create a new
Chromium top-level window in that bot's 1280x720 desktop region. It selects the
exact returned CDP target, including concurrent window creation. Explicit
`browser_tabs new` follows the same route, so Chromium cannot silently choose
another bot's foreground window. This preserves the single browser context and
profile, all existing leases and the workspace-wide human hold. These regions
are display routing, not OS/application isolation. Native-window movement,
maximization and pop-ups are not covered by a universal containment guarantee.

## Private-chat handoff receipts (ADR-0024)

Message posts carry a generated request ID (or retain a supplied ID) so replay of
the same HTTP request can return the Gateway's stored result without posting
again. `thread_post` results report delivered and suppressed private-chat
handoffs using Gateway facts. Recipient reminders remain operator-only activity
and never enter the SDK context.

## Approval presentation jobs (ADR-0028)

`StartRunRequest.presentationSummary` selects a fresh, one-turn SDK query before
normal browser, tool, instruction-file, session and memory setup. It has no tools,
plugins or skills, uses an isolated temporary config directory, and is aborted at
45 seconds (the supervisor caps the attempt at 60 seconds). Escaped, redacted
source is bounded to 12,000 characters; plain-text output is bounded to 700.
The run's proxy and SDK usage, retries, text, thinking and turn measurements remain
in the ledger. Completion posts only RunEnded; it never creates chat or memory.
The Gateway freezes DEFAULT_MODEL on this separate background job and prices it
normally. Failure does not decide, retry or suppress the original approval.

## Bounded browser ledger evidence (issues #65/#66)

Browser results over 4,000 characters use separate page/result (3,200 characters)
and metadata (600 characters) budgets, plus an explicit incomplete-evidence notice.
The model-facing untrusted result is unchanged. Redaction precedes all slicing.
The ledger references a redacted text cache at `/work/browser-evidence`: at most
256 KiB per artifact and 32 MiB per workspace, evicted oldest-first by bytes (4,096
files is only a backstop), with seven-day age cleanup on subsequent writes.
References may become unavailable before their age limit. They carry byte count,
SHA-256, truncation and cleanup eligibility time; they do not promise permanent or
immutable storage. The cache root itself must not be a symlink; symlinked ancestors
are accepted, and writes use the root's resolved path, re-checked under the lock.
Writers serialize on a `.writer` lock directory recording owner PID and time; a
waiter retries with backoff for up to 2 seconds, then records the cache as busy.
A lock whose owner PID is dead, or older than 30 seconds, is broken. Cache failure never
turns a browser action into a retry. Files use ADR-0014's existing authenticated
workspace download route; nothing becomes a public URL or a model instruction.

The workspace image applies a source-fingerprinted compatibility shim to MCP
0.0.82's tab-list handler. The handler prepends same-session CDP IDs, live URLs and
current flags, including while a file chooser is pending. The mcp-proxy strips that
line (`stripTabIdentity`) from every `browser_tabs` result it forwards, so the model
and the ledger see MCP's own tab list unchanged. The coordinator accepts
only a valid stable-identity result; unpatched images fail closed with a diagnostic.
File upload/cancel still executes the original MCP tool and all normal hooks,
locks and origin checks. It skips only the unrelated focus-emulation code RPC,
which MCP rejects during a modal. No timeout or selector permission changes.
Sidecar code and the shim must be shipped in the same image; this patch does not
support deploying the new sidecar into an old, unpatched workspace image.

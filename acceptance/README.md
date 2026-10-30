# acceptance/

Executable milestone acceptance (test strategy §7) plus the end-to-end plumbing test that runs without a model. The runtime suites start the real stack: a Gateway on an on-disk SQLite database, the real `DockerProvider` and workspace container, the real `deskmates-sidecar` binary and Agent SDK inside it, the Playwright MCP against the container's one Chromium, and the golden site as the only entry on the workspace's egress allowlist (benchmark §8.1). In M0 that allowlist is enforced by the sidecar's hook on tool inputs only; the container network is open, so it steers the bot rather than isolates it. Network-level enforcement arrives in M1. Nothing here is imported by `packages/`.

Tiers follow the filename convention in `AGENTS.md`:

Set `WORKSPACE_IMAGE` and `EGRESS_PROXY_IMAGE` to the candidate images when running T2 or T3.
Suites that exercise a candidate build (the M2 live-model suites, `m2-tty`, `m2-knowledge`,
`m2-boundaries`) require `WORKSPACE_IMAGE` to be a Docker image ID, never a tag: pass
`$(docker image inspect --format '{{.Id}}' <tag>)`. The check is `requireWorkspaceImageId()`
in `support/docker.ts`, backed by `support/image-id.mjs`; see
`docs/runbooks/image-tags-and-artifact-naming.md`.
Every container fixture uses `EGRESS_PROXY_IMAGE` (empty means `deskmates/egress-proxy:dev`);
the old package-test-only `EGRESS_IMAGE` variable is no longer used. The two package T2 suites
check that the proxy image exists before creating a workspace. Missing images fail suite setup
with the image name, so dependent tests do not run with an uninitialized handle. Build and
creation assertions run in setup and are still required for the suite to pass.

Test providers also honor `DESKMATES_HOST_TARGET`, matching the production provider factory.
On Colima, if `host.docker.internal` is unavailable inside the proxy, set
`DESKMATES_HOST_TARGET=host.lima.internal` so host fixtures reach macOS instead of the VM's
Docker bridge. This selects the infrastructure destination for the reserved host exception;
it does not add destinations to the workspace's public egress allowlist.

| File | Tier | Needs |
|---|---|---|
| `support/state-diff.test.ts` | T0 | nothing; runs under `npm test` |
| `m0-stack.container.test.ts` | T2 | Docker (`colima start`). No model: a fake upstream answers "pong". |
| `m1-triggers.container.test.ts` | T2 | Docker. No model: the same fake upstream. |
| `m1-takeover.container.test.ts` | T2 | Docker. No model: the same fake upstream, scripted to call a browser tool. |
| `m2-group-foundation.acceptance.test.ts` | T3 | Docker + the four model variables + `WORKSPACE_IMAGE` set to a Docker image ID; see `spikes/m2-live/README.md` |
| `m2-model-ab.acceptance.test.ts` | T3 | as above, plus `M2_AB_MODEL_A` and `M2_AB_MODEL_B` (fails without them); launch with `spikes/m2-model-ab/run.mjs` (usage in its header) |
| `m3-group-owner.acceptance.test.ts` | T3 | as `m2-group-foundation`; `DESKMATES_GROUP_ROUTING=walk-v1` or `owner-v1` selects the routing under test (ADR-0005 amendment 2), unset is the Gateway default. Three bots with a role and a private fact each and no scripted protocol; three unaddressed questions and one addressed to the lead; one JSON report per scenario in `M2_REPORT_DIR` |
| `m3-group-workspace.acceptance.test.ts` | T3 | as `m3-group-owner`. Three bots, one logged-in shared browser, one thread; the facts are on two pages of the golden site and the deliverable is a file under `/work` plus three lines in the thread. Report `group-workspace-brief.json` |
| `m0-login-form.acceptance.test.ts` | T3 | Docker + `MODEL_BASE_URL`, `MODEL_AUTH_TOKEN`, `DEFAULT_MODEL`, `CHEAP_MODEL` |
| `m0-model-swap.acceptance.test.ts` | T3 | same as above |
| `m1-approvals.acceptance.test.ts` | T3 | same as above |
| `m1-cron.acceptance.test.ts` | T3 | same as above; takes about four minutes of wall clock |
| `m1-takeover.acceptance.test.ts` | T3 | same as above |

## Running

```
npm run test:container:smoke             # T2 smoke subset: the files in t2-smoke.list
npm run test:container                   # T2 full suite: every *.container.test.ts, here and in packages/
npx vitest run acceptance/m0-stack.container.test.ts
npm run test:acceptance                  # T3; skipped by name when the model variables are missing
```

### T2 smoke and full

`t2-smoke.list` names the smoke subset. The rule for what belongs in it: the stack end to end
(`m0-stack`), each trigger lane (`m1-triggers`: interactive chat and background webhook), and
every M3 feature that ships to the trial (`m2-knowledge`, `m3-file-download`, `m3-integrations`,
`m3-memory-boundaries`). Every other T2 file is in `t2-full-only.list` with a one-line reason.
`t2-lists.test.ts` (T0, runs under `npm test`) fails on a `*.container.test.ts` that is in neither
list, so a new T2 file is classified when it is added. `stable.sh verify` runs the smoke subset for
a patch tag and the full suite for a minor tag (`docs/runbooks/stable-release.md`).

Measured on the workstation (colima, 4 CPUs, shared with other work), 2026-09-29: the smoke
subset took 27 s with `--maxWorkers=3`; the full suite 271 s with
`--maxWorkers=2`.

**A T2 run never blocks development.** Start the full suite in the background and keep working;
look at the log when it ends. Locally, with the images you are testing:

```
DESKMATES_SKIP_IMAGE_BUILD=1 DESKMATES_T2_PUBLIC_HOST=www.baidu.com \
  WORKSPACE_IMAGE=$(docker image inspect deskmates/workspace:dev --format '{{.Id}}') \
  npm run test:container -- --maxWorkers=2 >/tmp/t2-full.log 2>&1 &
```

The suite is wait-bound (container starts, which the Docker daemon serialises), so more workers
help less than the CPU count suggests. On the stable host, `T2_SCOPE=full stable.sh verify vX.Y.Z` runs the full suite
against a release's own images (the runbook says when).

Waits in T2 files poll the state they wait for (run status, pending approval, container health,
a file, an SSE frame) at 200 ms or less, with the old duration as the upper bound; a fixed sleep
is left only where the elapsed time is itself the assertion (a short wait that must expire, a
quiet window in which no further run may appear). Within a file, cases share one stack unless
they need separate ones, and then prefer another workspace in the same Gateway (`addWorkspace`)
over a second Gateway. Stacks are never shared across files.

The four model variables are read from the environment, then from `<repo>/.env` for anything the shell did not export (`support/env.ts`). Without them the T3 suites are skipped and the suite title says which variables to set. Without a reachable Docker daemon every file skips with a warning.

The workspace image (`WORKSPACE_IMAGE`, default `deskmates/workspace:dev`) is built once through `scripts/build-workspace-image.sh` when it is missing. An image ID is never built: an absent ID fails setup, since no build can produce a given ID. It carries the sidecar's `dist/`, so after a sidecar change set `DESKMATES_REBUILD_WORKSPACE_IMAGE=1` (or run `npm run image:workspace`) before trusting a result.

Ports are ephemeral. The Gateway and the golden site bind to all interfaces for the duration of a test because the container reaches them through `host.docker.internal` (`gatewayUrlForContainer`); that name must resolve from inside the container, which colima and Docker Desktop provide and the provider's `host-gateway` extra host provides on Linux.

Each stack creates one workspace, one bot, one thread and one container, and `stop-stack.ts` destroys the container, removes the three named volumes and the temp database directory. `addWorkspace(stack, { label, egressAllowlist })` provisions another workspace (container, volumes, no bots) in the same Gateway, journals it to `DESKMATES_SOAK_JOURNAL` before provisioning as `startStack` does, and records it on `stack.extraWorkspaces`; `stopStack` destroys each of those containers and volumes the same best-effort way. Then it removes everything still labelled with a workspace the stack created (containers, proxies, networks, volumes), and a `startStack` that fails half way takes down what it made the same way, so a failing test leaves no `deskmates-*` resource (ADR-0006 amendment 5 decision 15). `DESKMATES_T2_KEEP_WORKSPACE=1` keeps the workspaces for inspection and the teardown prints the ids it kept. A test process killed mid-way can still leave resources behind; `docker ps -a --filter label=deskmates.managed=true` finds them, and the Network page's Host resources section lists and removes them ([host resources](../packages/gateway/docs/host-resources.md)).

## `support/`

- `start-stack.ts` / `stop-stack.ts` — the stack described above. `startStack` takes the model endpoint (fake or real), `DEFAULT_MODEL`, `CHEAP_MODEL`, a label and, for the trigger suites, `cron` (the entries the bot is created with). It keeps the `webhookToken` that `POST /api/bots` returns once at create time on `stack.webhookToken`; there is no route that reads it back, only one that rotates it, so a suite that loses it has to make a new bot. The create response is typed inside this file (`CreateBotResponse`) because the Gateway's own typing for the token lands with the trigger routes. `startStack` it writes the bot's `SOUL.md` into `/home/<bot>/` through `provider.exec` on stdin and waits for `deskmates-healthz`. `defaultSoul` gives the bot the golden site's ops account and the deskbench reply format (`answer: <value>` on the last line) and tells it not to work around a denied tool call.
  Two options shape the site and the bot rather than the Gateway. `humanCheck: true` starts the golden site with its human verification step on (`packages/golden-site/README.md`): the first checkout of a session is held at `/verify`, which shows a six-character code as a distorted picture and nowhere as text, so the step cannot be finished from an accessibility snapshot — a person has to look at the screen. And `soul` takes a function as well as a string; `startStack` calls it with the bot's name and `siteOriginForBot`, which is the only way a case can add a rule to `defaultSoul` without hardcoding an origin that is not known until the site is listening.
- `takeover.ts` — the takeover side of the operator API as a human at the web UI drives it: `takeOver(stack, authorId?)` (`POST /api/workspaces/:id/takeover`, returning the `BrowserLock` and the noVNC URL), `handBack(stack)`, `workspaceView(stack)` (`GET /api/workspaces/:id`: the workspace, its bots, who holds the browser, noVNC). Plus `solveHumanCheck(stack)`, the one thing no API can do: the person's own step at the screen. **Why it is a CDP script.** The human's half of a takeover happens on a noVNC canvas — pixels over WebSocket — which a test cannot type into. So `solveHumanCheck` reads the expected code from the site's test surface (`/api/state`, where a person would use their eyes), copies `human-solve.mjs` into `/work` through `provider.exec` and runs it with `node` inside the container: it attaches to the workspace's one Chromium over CDP at `127.0.0.1:9222` — the very browser the noVNC screen is showing and the Playwright MCP drives — finds the tab on `/verify` (or navigates the first tab there), types the code, submits and prints where it landed. Playwright is resolved from the image's preinstalled copy through `/opt/deskmates/node_modules`; nothing is downloaded. Only the fingers are simulated: the lock, the refusal the bot's browser tools get while a human holds it, the shared screen and the hand back are all real.
- `recording-provider.ts` — wraps `DockerProvider` and records exec requests and injected env, so a test can read the `StartRunRequest` the Gateway piped to `deskmates-sidecar run` and prove where the run token did and did not travel.
- `fake-model-upstream.ts` — a `node:http` server speaking enough of the Anthropic Messages protocol for the SDK's CLI: `POST /v1/messages` with `Authorization: Bearer`, SSE when `stream: true` (message_start, content_block_start/delta/stop, message_delta with `stop_reason: "end_turn"`, message_stop) or one JSON message otherwise, one text block that ends with the fenced JSON summary `summary.ts` parses. Records every request. `script(turn, body)` overrides one turn's answer with a `FakeTurn`: text, or a single `tool_use` call, which is how a T2 makes the sidecar's hooks see a real tool call with no model in the loop. Both response paths use the real API's shapes — a `tool_use` content block in the JSON body, `content_block_start` with `type: "tool_use"` plus `input_json_delta` deltas in the SSE one, `stop_reason: "tool_use"` in both — because the CLI parses the wire format. `turn` counts `POST /v1/messages` requests per upstream instance, across runs; with no script every turn answers `assistantText(reply)` as before, so the M0 and trigger suites are unchanged.
- `runs.ts` — post a message, follow the run (SSE for the status sequence, polling as the source of truth), read events, usage and the transcript; the benchmark's answer oracle (`answer:` line, number normalisation). `newThread(stack, title)` opens another one-member thread in the stack's workspace, which is how a suite gives each case its own SDK session; `postMessage` and `threadMessages` take that thread id and default to the stack's. `collectRunStatuses` takes an optional thread id and, with none, keeps every thread's frames — which is the only way to watch a cron or webhook run, since those have no thread. `runsForBot(stack)` is `GET /api/runs?botId=`, the list that includes them. `waitForRun` and `waitForRunEnd` take `RunWaitOptions` — `onStatus`, and `failIfParkedAgain` for the fail-fast rule the M1 file relies on.
- `site.ts` — `/api/state`, `/api/state/log`, `/api/state/reset` over HTTP.
- `state-diff.ts` — the side-effect invariant of benchmark §5 on the client (the golden site's own `/api/state/diff` is not implemented yet): dotted-path diff of two `/api/state` snapshots, ignoring `session`, `humanCheck` (the same kind of thing: the site's report of who is signed in and who got through the verification step, whose `code` also moves when someone mistypes it) and `updated_at`, checked against a task's `allowed_paths` including the `collection.+` form. It is a pure function, so `state-diff.test.ts` beside it is T0 and runs under `npm test` with no Docker and no model — the only file in this directory that does.
- `approvals.ts` — the approval side of the operator API as a human at the web UI drives it: `pendingApprovals` (`GET /api/approvals?status=pending`), `decideApproval` (`POST /api/approvals/:id/decide`), `approvalRules` (`GET /api/bots/:id/approval-rules`), plus two waits. `waitForPendingApproval` polls every 200 ms (`POLL_MS` in `runs.ts`, which `waitForRun`, `waitForRunEnd` and the stack health wait use too) until *that run* has a pending approval — the list is filtered by `runId` and by nothing else — and returns `undefined` once the run is terminal, or parked with nothing pending; a parked run that *does* have one is returned rather than dropped, because parking is the normal outcome of a short wait nobody answered and the decision still resumes the run. `waitForRunEnd` is `waitForRun` without its stop at the parked states, for following a resumed run to its end; it fails on a second park by default (`failIfParkedAgain`) and names the run and its pending approvals, so a run that asks again is reported in seconds rather than at the timeout.
- `s01.ts` — deskbench S01 as one procedure shared by the three T3 files.
- `docker.ts` — daemon reachability and the image build. The build subprocess gets a filtered environment (`buildSubprocessEnv`), not `process.env`: `env.ts` loads `.env` into the process for the T3 variables, and `MODEL_AUTH_TOKEN`, `GATEWAY_SECRETS_KEY` and anything else secret-shaped have no business in `npm` and `docker build`. `env.ts` — the T3 variables and the skip message.

## What each test asserts

### `m0-stack.container.test.ts` (T2, ~5 s once the image exists)

One human message "ping" through the real Gateway, container, sidecar and SDK against the fake upstream:

- The run goes `queued → running → succeeded`, seen in order on `/api/events` and confirmed by polling `/api/runs/:id`.
- The bot's reply "pong" is a `thread_messages` row attributed to the bot and the run (`seq` 2), and `run.summary.reply` is "pong".
- `run_usage` has exactly one row, for the configured model, with non-zero tokens, `cost_usd` NULL and a `pricing_missing` event (the fake model is not in the price table).
- The ledger holds the sidecar's events for the run with a monotonic `seq`.
- Every upstream request was a `POST` to `/v1/messages` or `/v1/messages/count_tokens` (the only two routes the proxy forwards), carried `Authorization: Bearer <MODEL_AUTH_TOKEN>`, no `x-api-key` and no `cookie`, and no header outside the proxy's allowlist (`content-type`, `accept`, `accept-encoding`, `user-agent`, `anthropic-version`, `anthropic-beta`, `x-stainless-*`) plus what the proxy's own fetch adds. The turn request was streamed, named the configured model, carried the bot's `SOUL.md` inside the system prompt, and listed both MCP servers' tools (`mcp__browser__browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `mcp__deskmates__thread_post`).
- The per-run token was in the `StartRunRequest` on stdin and nowhere else: nothing was written to the workspace env file (`injected` is empty), and it is absent from the create spec, from `docker inspect` of the container, from the `ProcessConfig`, `Cmd` and `Env` of every exec instance seen on that container while the run was in flight (the test polls `ExecIDs` and `GET /exec/{id}/json`, because the daemon forgets an exec as soon as it exits), and from every header value and raw body the upstream received. The upstream token likewise appears nowhere but `Authorization`. The model proxy rejects the run token (401) once the run has ended. `modelBaseUrl` and `gatewayBaseUrl` point at `host.docker.internal`, not loopback.
- The SQLite file on disk (after a WAL checkpoint) contains neither the upstream token nor the run token.

### `m1-triggers.container.test.ts` (T2)

The two M1 triggers that are not a chat message, with no model, on one stack whose bot was created with a webhook token:

- The token exists and is at least 16 characters. `POST /api/bots` returns it once; nothing reads it back.
- **Webhook.** `POST /hooks/<bot>/<token>` with `content-type: application/json` and the body `{"event":"ticket.created","id":42}` answers 202 with a run id. That run goes `queued → running → succeeded` through the real container, sidecar and SDK; it carries `triggerKind` `webhook`, `lane` `background`, no `threadId` (a webhook is nobody's message, so a reply has nowhere to land) and `attempt` 1.
- **The body is data.** The fake upstream's recorded raw request holds `<untrusted source=\"webhook\">` — escaped, because the CLI sends the prompt inside JSON — with the event text after the opening tag and before the close. This is the wrapper asserted on the wire, where the sidecar's own `context.test.ts` asserts it on the rendered string.
- **A wrong token creates nothing.** `POST /hooks/<bot>/<token>-wrong` is 404 and the bot's run list (`GET /api/runs?botId=`) is unchanged half a second later. The token is the whole of the webhook's authentication, so this is what keeps an unauthenticated POST from costing a model call.
- **Two lanes.** A chat message and a webhook posted in the same tick produce an `interactive` run and a `background` run, both `succeeded`, and the unfiltered SSE stream shows each one `running` before the other reached a terminal status — they overlapped, which a one-run-per-bot scheduler could not do.

### `m1-takeover.container.test.ts` (T2)

Human takeover of the shared browser, with no model. One stack, one unfiltered SSE collector, and a fake upstream scripted to answer the first turn of every run with a `mcp__browser__browser_snapshot` tool call — so the browser tool the lock is about is really issued by the SDK and really passes through the sidecar's `PreToolUse` hook. The script decides from the request rather than the turn number: the CLI's session-title call declares no tools and a resumed turn carries a `tool_result`, so "declares the browser tool and has no `tool_result` yet" is what identifies a run's first turn, whichever run it belongs to.

The cases, in order:

- **Before anything.** `GET /api/workspaces/:id` has `browserLock` null and `takeoverScreen: true`, and no noVNC address anywhere in it — `startStack` created the container through the Gateway's registry, so the screen is up before anyone asks for it (ADR-0022 amendment 1, C7).
- **Takeover.** `POST /api/workspaces/:id/takeover` returns only a lock with `holderKind: "human"` and no `holderRunId` (a human holder owns the whole workspace, not one tab); `.../takeover/open-screen` gives the holder a proxy ticket, and an RFB client through `/api/desktop-stream` is offered only the `None` security type and authenticated against the real x11vnc by the Gateway; `GET` shows the same lock, and the SSE stream carried a `workspace_lock` frame with it. `support/runs.ts`'s collector keeps `run_status` frames only, so this file has its own full-frame collector.
- **Lock held → the hook returns the wait message.** A message in a fresh thread produces a run that ends `succeeded` or `silent` — not failed: `defaultSoul` tells the bot to report a denial rather than work around it. Its ledger has the `tool_call` for `browser_snapshot` and a `takeover` event whose `payload.waitMessage` is `HUMAN_HOLDS_BROWSER_MESSAGE`, and no `screenshot` events. The text the *model* saw is asserted on the wire: a later upstream request carries a `tool_result` block containing the wait message. That is what this tier buys over the sidecar's own unit test, which can only see the hook's return value. The run also has *no* `takeover {phase: "taken"}` event — it started after the human took over, so the Gateway had no live run to append one to, and asserting the absence pins `phase` to "live runs at the moment of takeover" instead of "any run while the lock is held".
- **Hand back.** `POST /api/workspaces/:id/handback` returns `{released: true}` and `GET` shows null. The same message in another fresh thread issues `browser_snapshot` again, gets a `tool_result` and ends terminal and not failed, with no wait message anywhere in the run. With no page open the MCP server may answer with an error of its own, so the tool's *success* is not asserted — only that the lock no longer stops it.
- **Takeover while a run is live.** Post, poll until the run leaves `queued`, take over at once. The window is the whole of the sidecar's start-up (container exec, SDK boot, MCP attach), seconds rather than milliseconds, but it is a window: the case re-reads the run right after the takeover and asserts the Gateway's `takeover {phase: "taken"}` on its ledger only if the run was still live then, warning instead of failing if the run beat it to a terminal state. It ends by handing back and asserting a `workspace_lock` frame with a released lock, so the operator UI's banner comes down without a reload.

The Gateway shapes this file uses — the takeover and handback responses, the `GET /api/workspaces/:id` read model and the `workspace_lock` frame — are typed inside the test file, because the Gateway's own types for them land with the M1 batch 3 routes.

### `m1-cron.acceptance.test.ts` (T3)

M1 acceptance for cron. One bot, one entry, `* * * * *`, the prompt "Append one line with the current time to `/work/cron.log` using the shell, then reply done." and a SOUL.md that makes it a shell bot rather than the default browser one. The suite waits up to four minutes for two rounds and asserts:

- At least two runs for the bot have `triggerKind` `cron` and `lane` `background`, and at least two of them are `succeeded`.
- Every `triggerRef` reads `cron:0:<minute ISO>` and the minutes are distinct — one run per matching minute, not a free-running loop.
- `/work/cron.log`, read with `stack.docker.exec` on the workspace container, has at least two lines: the ledger says the runs happened, the workspace filesystem says they did the work.

Overlap — a round that starts while the previous run is still going is skipped and recorded as a `log` event `{source: "cron", skipped: true}` — is proven at T1 in the Gateway against a controlled clock, where a run can be stretched out on purpose. Stretching a model run to straddle a minute boundary would buy a slow, flaky copy of a test that already exists, so this file does not try; the file header says the same.

### `m0-login-form.acceptance.test.ts` (T3)

deskbench S01 in one thread with one bot. S11 used to be the second half of this file under an M0-only expectation — the "Submit order" click is L2 and the M0 Gateway denied every approval request, so no order was ever placed. M1 turns approvals on, that expectation is no longer true, and S11 moved to `m1-approvals.acceptance.test.ts` where it is asserted against the benchmark's own oracle.

- **S01**: the message "Log in to the Galaxy Ops Console at `<origin>` with the ops account and tell me the open ticket count on the dashboard..." produces a `succeeded` run within 10 minutes; the site's operation log shows a `login` by the ops account; the reply's last `answer:` line equals the site's KPI after normalisation. The expected count is read from `state.kpis()`: the benchmark says 23, the golden site's tickets module is M1 and the dashboard shows 0 until then, so the test follows the site and will pick up 23 with the seed. The ledger has a `browser_navigate` tool call to the site's host; every tool call carries a risk level; nothing outside `session` changed (`allowed_paths: []`). Screenshots: test strategy §7 asks for them, `packages/sidecar/src/run-once.ts` never emits `screenshot` events, so their absence is reported as a warning, not asserted. Known flake (seen once in three runs on 2026-09-22): the model answers in prose ("The dashboard's Open tickets metric reads 0.") without an `answer:` line, and the case fails on "reply had no answer line". That is the model ignoring the answer format, not a code fault; the oracle stays as the benchmark defines it, and a rerun is the remedy.

### `m1-approvals.acceptance.test.ts` (T3)

M1 acceptance for approvals (ADR-0002 and its amendment 2). One stack, one bot: S01 first so the shared browser holds a console session, then deskbench S11 — "Place an order for customer `<C>`: one `<SKU>`." — five times, once per decision plus one answered by a stored rule. The "Submit order" click on `/checkout` is the L2 action every case turns on (`packages/sidecar/src/risk-tier.ts`: a browser click whose element mentions "submit"). Every case snapshots `/api/state` before and after and checks the side-effect invariant with `unexpectedChanges(before, after, ["orders.+"])`, so an order may appear and nothing else may move.

Four setup choices carry the file:

- **One thread per case, so one SDK session per case.** A bot keeps its session per thread (ADR-0005), so five S11 runs in one thread are five turns of one conversation. On a real T3 run that is exactly what went wrong: the model saw its own earlier turn, answered the repeated instruction with "The order was already placed… I won't place a duplicate", requested no approval, and the case failed on `expected undefined` — with which cases failed depending on which had run first. Each case now calls `newThread(stack, title)` (`support/runs.ts`) and passes that thread id to `postMessage` and `threadMessages`, so every case is the model's first sight of the task and case order stops mattering.
- **One customer and one SKU per case**, all in the seed (benchmark §2.2: `C-0001`..`C-0030`, `SKU-1`..`SKU-9`): allow `C-0002`/`SKU-7` (the benchmark's own pair), deny `C-0003`/`SKU-2`, parked `C-0004`/`SKU-5`, always `C-0005`/`SKU-3`, rule-answered `C-0006`/`SKU-4`. Distinct pairs are what let a case assert that the site's latest order is *its* order and that the count went up by exactly one, and let the deny case assert that no order for its own pair exists at all.
- **`shortWaitSeconds: 2`.** The stack overrides the 300-second default of `SHORT_WAIT_SECONDS_DEFAULT`, so the hook's live wait is over in two seconds. That is what makes the parked case affordable — it costs a two-second pause instead of five minutes — and it is also why the allow case is written not to depend on winning the race: a polling test may or may not decide inside two seconds, `waitForPendingApproval` returns a parked run's approval as well as a live one, and a decision resumes a parked run, so the asserted outcome (the order is placed exactly once) holds either way.
- **One unfiltered SSE collector open for the whole suite.** An open `/api/events` subscription is what makes the Gateway count a human as online; without one it defers at once and there is no live wait to observe. Presence counts connections, not threads (`packages/gateway/src/events/presence.ts`), so a single stream with no `threadId` serves every case's thread and collects every case's status frames; `describeStatuses` reads the sequence of one run out of it.

Two rules keep a failure fast and local. `waitForPendingApproval(stack, runId, timeoutMs)` filters the pending list by `runId` and by nothing else, so a case can never decide another run's request (it used to narrow by the stack's default thread instead, which let the always case pick up the parked run's approval and store a rule with no origin). And `waitForRunEnd` fails as soon as the run parks a *second* time — a park observed after the run was seen running again, or a park with `attempt` ≥ 2 — naming the run and what is pending, instead of waiting out `RUN_TIMEOUT_MS`; a second park means either another L2 action nobody is going to decide or a resume that did not replay the deferred call. Each case ends by asserting that nothing at all is pending, so no case hands its leftovers to the next.

The cases, in order:

- **allow**: in its own thread, wait for the pending approval (`L2`, a browser tool, this run, this bot, this thread), check that a `system` thread message carries it as an attachment with `mimeType` `APPROVAL_ATTACHMENT_MIME` and `ref` the approval id, then decide `allow_once`. The run ends `succeeded` or `silent`, the site has exactly one more order and the latest one is C-0002 / SKU-7 (benchmark oracle), the decided approval's `decidedBy` is `human:web` — the operator API's author — and the ledger's `approval` events run `posted` before `decided`.
- **deny**: decide `deny` with a reason. The run ends terminal and not failed (the bot reports the denial; `defaultSoul` tells it not to look for another way), the order count is unchanged, no order exists for C-0003 / SKU-2 that did not exist before, and `unexpectedChanges(before, after, [])` is empty — for a denied task not even `orders.+` is allowed.
- **parked**: decide nothing. `waitForRun` stops at `waiting_approval`, the run's `resumePayload.approvalId` is the pending approval, `resumePayload.sdkSessionId` is set and `attempt` is 1; the SSE sequence shows `waiting_approval_live` before `waiting_approval`, so the live wait really happened first. Then decide `allow_once`: the same run row resumes, reaches terminal with `attempt` 2 — and a third park fails the case at once — the ledger has a `resumed` phase and events from both attempts under one monotonic `seq`, and the order was placed exactly once: the deferred call is replayed, not repeated.
- **always**: no rule exists for the bot before this case. Decide `allow_always` on *this* run's approval: the order is placed and `GET /api/bots/:id/approval-rules` has exactly one rule, created from that approval by `human:web`, whose matcher names the `browser_click`-style tool and, exactly, `stack.siteOriginForBot` — the origin as the bot addresses the site from inside the container, not the loopback URL the host uses (`matcherFromAction`). Its `argumentPattern` should be `*submit*`; that one is logged rather than asserted, because the phrase depends on the console's button wording. A fifth S11, in a new thread and for a different customer, then goes through with no human in the loop: `waitForPendingApproval` returns `undefined`, the run never parks, the order is placed, and the ledger has a `rule_matched` phase naming that rule.

This file is where an approval regression shows up first: if the rule matcher is too wide the fifth run places an order nobody approved, and if the model works around a denial the deny case's empty diff fails.

### `m1-takeover.acceptance.test.ts` (T3)

M1 acceptance for human takeover (design v0.3 §3.3, ADR-0004). One stack started with `humanCheck: true`, so the console has a step the bot must not solve by itself, and a SOUL that is `defaultSoul` plus one rule: if a human verification step appears (a code that would have to be read out of an image), do not try to solve it — post exactly one dictated sentence with `thread_post` ("Human verification required: a person must complete it on the screen."), then wait in 15-second `browser_wait_for` calls, re-snapshotting up to twenty times until the page is gone; and wait the same way if a browser tool answers that a human is operating the browser. Without that rule a model either guesses at the picture or ends the run, and there is nothing left to hand back to.

S01 runs first, as in the other T3 files, so the shared browser already holds a console session. Then deskbench S11 — "Place an order for customer C-0002: one SKU-7." — in its own thread, and the case walks the whole takeover:

- Before the task is posted, an `allow_always` rule for the "Submit order" click on the site origin is stored through `POST /api/bots/:id/approval-rules` (`storeApprovalRule`), so the one L2 call on the way is answered by the batch-1 rule machinery and the run never waits on a decision this suite is not there to give. The first real run posted that approval, nobody decided it, and the run parked after the short wait without ever reaching `/verify`. The case ends by asserting nothing of the run is left pending and that the ledger has the `rule_matched` event.
- The bot reaches `/verify`. The gate is the site's own log, a `verify` entry with phase `required` written when a checkout is parked behind the page, never the model's prose. Every thread message and every tool call is logged as it arrives, and the wait fails at once if the run ends first or parks in `waiting_approval` (with the transcript, the calls and any pending approval in the error, since a park here can only mean the test forgot to decide) or if a session gets verified with nobody at the screen, which means the bot solved the code itself. The dictated sentence is looked for afterwards for 90 s and reported, not gated: takeover works whether or not the model phrased its notice as told. The first real run timed out here waiting ten minutes for a `/verif/i` match in free prose, which is why the gate moved to the site's state.
- `takeOver` returns a `human` lock for the workspace and a noVNC URL matching `http://127.0.0.1:<port>/vnc.html…`; `GET /vnc.html` on that port answers 200 from the host, and `GET /api/workspaces/:id` shows the human's lock.
- While it is held, the bot's next browser call is refused: the run's ledger gets a `takeover` event carrying `HUMAN_HOLDS_BROWSER_MESSAGE`, and the run is still `running` — a refusal is a wait, not an error.
- `solveHumanCheck` does the human's step on the shared screen (see `support/takeover.ts` above for why it is a CDP script), the form leaves `/verify`, and `handBack` releases the lock.
- The run then ends `succeeded` or `silent` — a second park fails the case at once (`waitForRunEnd`) — the site has exactly one more order and the latest one is C-0002 / SKU-7, `unexpectedChanges(before, after, ["orders.+"])` is empty, and `/api/state` reports at least one verified session.
- The ledger has `takeover` events `taken` before `handed_back`, and at least one browser tool call made *after* the `handed_back` event came back without an error and without the wait message: the browser was the bot's again.

This is the file where a browser-lock regression shows up: if the lock is not workspace-wide the bot clicks through the human's page, and if the hand back does not wake the run the case ends on a timeout with the order never placed.

### `m0-model-swap.acceptance.test.ts` (T3)

S01 twice on two stacks started in turn, identical except `DEFAULT_MODEL` (first the `.env` `DEFAULT_MODEL`, then `CHEAP_MODEL`); the bot's `model` is unset in both so the swap is pure configuration. Each run must succeed with the right answer, `runs.config_json.defaultModel` must equal the stack's model, and `run_usage.model` must include it. The two runs' usage model sets must differ.

## Known gaps this directory documents

- The golden site runs **in the test process** (`startGoldenSite` in `start-stack.ts`), not as its own container, and `s01.ts` reads the expected KPI straight off the in-process state object (`stack.site.state.kpis()`) instead of over HTTP; the snapshots, the operation log and the reset do go through `/api/state*` (`site.ts`). `AGENTS.md` says the golden site "runs as its own container so the bot under test never shares a process or filesystem with it", so this is a deviation from the stated layout, recorded here rather than left implicit. The isolation the rule exists for still holds: the bot under test is inside the workspace container and can reach the site only over HTTP through `host.docker.internal`, sharing neither process nor filesystem with it, so the oracle still reads a state the bot could only have changed through the site's own pages. What is given up is the last mile — a crash or a leak in the site takes the test process with it, and the site listens on a host port rather than on a container network. Moving it behind `npm run image:golden-site` is a harness change that would not alter a single assertion in this directory.
- Screenshot delivery is implemented: the browser proxy captures action screenshots and the sidecar records target/attempt-attributed events. The old no-screenshot gap is closed by the M1/M2 container and model checks.
- The golden site still has no `/api/state/diff`; `state-diff.ts` checks complete host-observed state. Tickets and reports are implemented in site 1.2.1, and X01/X02/X03 exercise their actual UI. This is no longer a missing-ticket-module gate.
- The SDK's CLI (2.1.278) makes one extra `POST /v1/messages` per run with no tools, to generate a session title, before the real turn. It uses the run's model and its tokens are counted in the same `run_usage` row.

## M2 live-model foundation probe

`m2-group-foundation.acceptance.test.ts` runs two repetitions each of chief/expert
collaboration, ordered group delivery, parallel explicit mentions and the real
`message_bot` handoff. It requires a workspace image ID and fails loudly on
missing prerequisites. Use `spikes/m2-live/run.mjs` to load model configuration
without copying credentials and to retain local run/usage evidence. This is a
focused messaging probe; browser concurrency and full M2 acceptance remain open.
The 2026-09-22 result is 7/8 passed, with the duplicate-reply failure retained;
see `docs/design/m2-live-model-results-2026-09-22.md`.

The protocol it runs (test SOUL, three-bot fixture, settle loop, chief delegation
check, evidence and assessment) lives in `support/m2-foundation.ts`, shared with
the model A/B test below.

## M2 paired model A/B

`m2-model-ab.acceptance.test.ts` stands up two workspaces in one Gateway and runs
the foundation chief delegation case `M2_AB_ROUNDS` times (default 5) per arm,
arm A's bots pinned to `M2_AB_MODEL_A` and arm B's to `M2_AB_MODEL_B`. Rounds
interleave (A1, B1, A2, B2, ...), never run concurrently, and both containers
stay up for the campaign. Either model id unset fails the suite; it never falls
back to `DEFAULT_MODEL`. `results.json` has one row per (arm, round) with the
three assessment dimensions and per-run tokens (`unknown` where the ledger has no
usage); `summary.json` and the console add per-arm pass count, wall-time median
and range, token totals and the sample-size caveat from the file header: a
5-round campaign detects a model that cannot do the case at all, not a ranking of
two models that both mostly work. Launch it with `spikes/m2-model-ab/run.mjs`.


## Current B1–B3 closeout

Historical reports below and in `docs/design/` preserve failures from their own
versions. The current consolidated inventory and frozen verification sequence are
in `docs/design/m2-b1-b3-closeout-plan-2026-09-23.md`. B1 messaging/idempotency,
B3 group/chief/caps, approval resume and takeover have later passing evidence;
B2 ticket deadline/concurrency reliability remains the shared open gate until a
complete final matrix passes. Raw strict diagnostics remain separate from canonical
state/runtime oracles and neither is silently discarded.

The ticket fixture retains 300 seconds and 35 turns. A recovered transport failure
while polling status is recorded separately and retried within the original read
wait deadline; model runs and writes are never retried by that helper. The opt-in
inline snapshot T2 verifies current page state returned with ordinary actions
through the real SDK/MCP, with no additional model-authored snapshot call. Its
scripted upstream is a contract check, not configured-model acceptance.


## M4 domain oracle and evidence hardening

`m3-domains.acceptance.test.ts` retains the three M3-named domain scenarios carried
into M4. Their task prompts, model limits, quant numerical tolerances, held-out
quant replay, and product regression/changed-count controls remain unchanged.
The following are evaluator/harness changes, not configured-model acceptance:

- Data fixtures expose a host-only PostgreSQL snapshot, using the exact owned
  database container. The initial seed is checked before starting the bot stack
  or posting a model task. Six independent frozen rows, including pending and
  refunded orders, must match; the host retains row count and a canonical SHA256
  checksum. A second observation runs before teardown, including on failed task
  paths. Offsetting paid-row edits and changes to excluded rows cannot hide
  behind an unchanged aggregate
- The snapshot also checks the observed public schema columns and constraints.
  It does not inventory every schema object (for example, standalone indexes,
  triggers or functions), and is not proof of all possible database nonmutation
- `support/m4-domain-data-oracle.ts` requires exact report rows, column order,
  row count, non-truncated SELECT results, run/bot/workspace/connector ownership,
  prior successful read-only validation and a later authoritative terminal
  receipt read. `support/m4-domain-connector-observer.ts` wraps the actual Gateway
  connector methods before task submission, retaining host-owned call intents
  before invocation and immutable result/error snapshots afterward. Its opaque
  in-process handle is required by the runtime verifier; uploaded run events and
  reloaded JSON cannot manufacture it. Ordinary ledger `source` and `sidecarSeq`
  fields are not trustworthy provenance and remain diagnostic only. Host-observed
  successful submissions reconcile with retained receipts; one original submission
  is required per receipt while idempotent duplicates are allowed. Every rejected
  or unresolved submit conservatively fails the gate because a lost response can
  hide remote execution, even when another final receipt passes. This includes
  definite preflight rejections; no error-class exception is inferred. Definite
  SQL errors in returned terminal receipts may precede a successful final receipt.
  The full host observation inventory is saved in `connector-observations.json`
  during finalization, including failed run/report/artifact paths. The observer is
  sealed immediately when the run becomes terminal (and on failed-path cleanup),
  before evaluating artifacts. Sealing permanently records any submit still in
  flight and blocks all later real proxy invocations. A delayed successful response
  cannot clear that uncertainty. Observation state is checked and saved again after
  cleanup before the verdict, catching rejected late attempts as well. Dedicated
  fixture stacks retain the sealed wrappers for their remaining lifetime because
  best-effort cleanup does not prove that Gateway routes closed. This proves actual
  Gateway connector method calls, not which sidecar tool or client initiated them
- `support/m4-domain-finalize.ts` captures evidence before cleanup, attempts every
  cleanup callback even if another fails, and writes the verdict last. Failed
  evidence reads, non-200 context evidence, and rejected fixture cleanup prevent
  `passed: true`. Verdicts distinguish the domain oracle, evidence capture, and
  callback completion. Retained exception summaries use allowlisted error
  classes instead of arbitrary messages, names, child argv or assertion diffs
- `stopStack` remains best-effort and can log swallowed cleanup errors. Therefore
  `cleanupCallbacksCompleted` does not prove resource absence; every verdict
  explicitly retains `resourceAbsenceVerified: false`. The exact ownership
  journals remain necessary for interrupted setup and external cleanup checks

Offline checks (no Docker, model, credentials or external service):

```
npx vitest run acceptance/support/m4-domain-data-oracle.test.ts acceptance/support/m4-domain-finalize.test.ts acceptance/support/m4-domain-connector-observer.test.ts
```

These deterministic tests use synthetic receipts and snapshots to reject corrupt,
missing, mismatched, unfinished and duplicate evidence. They do not execute the
new snapshot SQL against PostgreSQL. Current source/image-bound T2/T3 runs,
real fixture setup/snapshot behavior, failure/restart cleanup and the full M4
runtime gates remain unrun until separately executed in a suitable environment.
The suite's environment image values are not, by themselves, a verified binding
between image contents and current source; retain independent build/source
receipts and exact image IDs for a live campaign.

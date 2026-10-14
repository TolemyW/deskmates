# M2 business and group acceptance results

This batch implements the scope in `m2-business-acceptance-plan-2026-09-23.md` on
`codex/m2-foundation-20260922`. Three subagents used `gpt-5.6-sol` at medium effort
for the golden site, group acceptance, and MFA takeover. The integrator reviewed
changes, corrected fixtures and evidence collection, and ran isolated model tests.
The active main application was not deployed or restarted. Final cleanup left only
the pre-existing Deskmates workspace container running (healthy, 12 hours uptime);
this batch's temporary containers and named workspace volumes were removed. The
remaining unrelated volumes were left untouched.

## Implemented surfaces

Golden site/task set 1.2.0 now provides 80 deterministic tickets, list filters and
comment search, details, comments, reassignment, labels, close, and monthly report
CSV export. Field-level mutations preserve independent concurrent edits. HTTP/state
tests cover these operations; unrelated modules, including ticket creation, remain
outside this batch. The seed explicitly starts ticket 1050 with assignee `wang`, so
X03 must actually change it to `li`. An earlier `li` seed let that operation do
nothing; those old runs are not accepted as lost-update evidence.

The versioned golden image is `galaxy-ops-console:1.2.0`, image ID
`sha256:7c70f4179afd367f3ec4a8f4d0190663ce61eafc917370abfaaded255662e7f5`.
Its build script had an existing unterminated quote, now fixed. The image builds,
starts, and serves the expected login page. Model acceptance uses the existing
harness's host golden-site process, reachable externally by the bot container;
it does not run the versioned site image, and no model executes in the site's
process or filesystem.

New executable suites cover chief/expert handoff, group parallel/ordered routing,
new-member history, hostile relay/turn bounds, two-bot MFA takeover, and paired
solo/concurrent X02/X03 ticket work. A separate operator UI harness exercises the
real Gateway/API/SSE with a scripted provider and an isolated Vite server.

## Chief and group evidence

Configured model: `glm-5.3`; configured cheap model: `glm5.3-flash`. These samples
use the dedicated prior runtime image
`cogbot/workspace:m2-live-browser-hardening-v2-20260923`, ID
`sha256:1a14b0a4c7191abdfd875d45f9a4b7a21f3cc8440fa2594f0f170ebcc2047732`.

- Chief T3 passed, 1/1 in 27.74 s: two experts returned arithmetic results and the
  chief aggregated 96, with message/run attribution and usage. This proves the
  orchestration scenario, not business benchmark X01.
- Group T3 v1 failed on stale 1.1.0 metric expectations and non-silent replies.
  The fixture was corrected to 23 open tickets and revenue 128450.
- Group T3 v2 failed on newcomer evidence selection: the test selected a later
  silent observation run. The actual observer joined, received the original human
  trigger and history, and answered correctly. Selection now uses recipient ID
  plus human trigger message ID.
- Group T3 v3 remains failed, 110.62 s. Both explicitly mentioned runs overlapped,
  used different tabs, captured correctly attributed screenshots, obeyed the
  browser-tool protocol, and encountered no browser errors. New-member history
  and complete site-state invariance passed. Extra non-silent observation replies
  broke the silent/ordered-round assertions. For example, a member published
  `This is a GROUP_OWNER message; per my role I remain silent.` as a real message.
  Those messages legitimately caused additional scheduled observation rounds;
  relay caps stopped them. No product routing fix or prompt tuning was made to
  suppress this failure.
- Real SDK/scripted-upstream T2 bounded relay and turn-budget cases passed 2/2 in
  20.68 s. Relay produced six runs/messages plus an undelivered alert and cap event.
  Fan-out produced 18 bounded runs, within the test's 20-run bound, and the live API
  confirmed the thread paused. Two earlier scripted-request parsing failures remain
  preserved. The first passing JSON contained the original stale thread object;
  the API assertion was correct, and subsequent evidence collection reads the
  current thread rather than overwriting the passing raw file.

## MFA takeover evidence

The real SDK/scripted-upstream T2 passed 1/1 in 18.88 s. Both bots were running
before takeover; a controlled FIFO released the peer during human ownership.
An operator-only CDP helper entered the fixture MFA code, then returned control.
This simulates operator input; it is not a manual noVNC typing session.

The first scripted T2 attempt timed out due to a harness response-matching error.
Its static raw/log filenames were overwritten during that early rerun; this is an
evidence limitation. Later takeover results use timestamped pass/fail filenames.

Configured-model T3 v1 failed because reply collection selected A's intermediate
`thread_post` asking for human MFA. Its ledger nevertheless shows a successful
Dashboard snapshot after handback. The test now collects the last run-authored
reply, all messages, state, and all named checks before asserting.

T3 v2 took 66.63 s and passed all ten runtime checks: both runs succeeded, both
received takeover/handback, the peer received a browser wait result, both used the
browser successfully after handback, targets differed, MFA state passed, and no
screenshots entered either ledger or SSE during human ownership. B's final answer
met the one-line format. A returned:

```text
Dashboard is visible. The human completed the MFA step.

answer: dashboard
```

The strict T3 remains failed because this fixture requires only the answer line.
The fixture's explicit one-line instruction was strengthened between v1 and v2;
production prompts were unchanged, and these are not paired strategy results.
The functional X04 chain has evidence, but full strict X04 acceptance is not signed
off. The final focus-image regression (v3) also failed strictly in 42.46 s: all ten
runtime checks passed again, B matched the exact answer, and A prefixed its answer
with `Dashboard is visible.`. This run verifies the runtime change; it does not
replace the earlier failure or constitute a paired strategy comparison.

## Ticket baseline and snapshot delivery fix

The first ticket attempt was incomplete: X02 stopped after its first strict
protocol failure, and X03 reassignment was vacuous because ticket 1050 already
belonged to `li`. Both problems were corrected without replacing the old evidence.
Each later arm now records all checks before failing; resetting an active or parked
run remains forbidden. Every solo task and concurrent pair starts from the same
seed and new thread, with generated diary reset and controlled shared login.

The corrected baseline on the prior image took 560.12 s for eight model runs.
All eight reached succeeded; all six arms made precisely their requested field
changes, with no unrelated state changes. All screenshots had the correct target,
and both concurrent pairs overlapped on distinct tabs. In X03, the comment was
added once and reassignment from `wang` to `li` survived together.

Both strict scenario tests nevertheless failed. Two runs used `Read` to consume
MCP-generated page files, violating the browser-only role. Three runs had tool
errors: two stale references and five click timeouts in total, with locators found
but awaiting visible/enabled/stable state. These were recovered task errors, not
missing final business writes. The concurrent click investigation and correction are recorded below; correct
eventual state alone is not evidence of error-free coordination.

The pinned MCP 0.0.82 writes automatic action snapshots to `.playwright-mcp/page-*.yml`
and returns a link. A subsequent SDK Read/Bash call consumes the page text outside
the browser proxy's untrusted wrapper. Source inspection and the real browser probe
show that an explicit `browser_snapshot` without a filename returns its YAML
inline. The sidecar now passes `--snapshot-mode none` to suppress the automatic
file links while keeping explicit inline snapshots available. Explicit filename
exports remain unchanged; this is a correction to the ordinary reading path,
not a security boundary against a bot with shell access. No versions, production
SOUL, model, permission, or routing policy changed.

The dedicated candidate is `cogbot/workspace:m2-live-snapshot-20260923`, ID
`sha256:08fb6ed12ce0530c5d7143f7700c300777699833276e0355550a1910aac5a14a`.
All six existing M2 real SDK/browser regression cases passed on it in 132.75 s:
target coordination, SDK event attribution, parked approval restoration, two-bot
MFA takeover, relay cap, and turn-budget pause. This is runtime regression evidence,
not acceptance of the model's group silence or ticket task protocol.

The dedicated snapshot T2 also passed 1/1 in 6.66 s. It imports the actual image's
`browserMcpServer`, navigates and clicks a synthetic page, checks all tool results
for errors, verifies no automatic YAML link/file, and verifies inline snapshots
with the forged closing tag entity-escaped. Earlier fixture diagnostics used an
IP blocked by the image's DNS rules and an obsolete click argument shape; the
final fixture uses `localhost` and the snapshot reference as MCP 0.0.82's `target`.
All diagnostic logs remain preserved rather than replacing the initial failure.

The snapshot-only model attempt took 368.08 s and remains failed/incomplete. Both
X02 solo arms passed every state/runtime/protocol/screenshot check. During the
concurrent arm, A again hit three stability-wait click timeouts, then called the
out-of-role SDK `ListAgents` tool. Its unknown-tool L2 gate deferred because nobody
was online, leaving the run waiting for approval. B succeeded but encountered one
stale reference. The harness correctly refused to reset a parked run, so X03 was
not attempted. This is not a completed eight-run matrix or evidence of a timing
improvement. Its failure, pending approval and all partial traces remain recorded.

## Concurrent click root cause and correction

The ticket failures led to a deterministic, model-free reproduction. Two actual
MCP 0.0.82 connections share one headed Chromium and click fixed buttons using the
normal `browser_click` tool. The results isolate the cause:

| Control | Non-current tab clicks | Current tab clicks |
| --- | ---: | ---: |
| Direct Playwright, original flags | 8/8 | 8/8 |
| Direct Playwright, two background flags | 8/8 | 8/8 |
| Dual MCP, original flags | 0/8 | 8/8 |
| Dual MCP, two background flags | 0/8 | 8/8 |
| Dual MCP, focus emulation then session detach | 0/2 | 2/2 |
| Dual MCP, focus-emulation session kept alive | 8/8 | 8/8 |

The ineffective flags were `--disable-background-timer-throttling` and
`--disable-renderer-backgrounding`; neither was added to production. Bundled MCP
source explains the difference: `createCDPBrowser` hardcodes `noDefaults: true`,
so Playwright skips its default persistent focus emulation for the default context.
The non-current MCP tab becomes hidden and cannot complete the animation-frame
stability check. Setting the override through a short-lived CDP session does not
work because detaching the session undoes it.

The coordinator now retains one focus-emulation CDP session on each MCP Page
object. It first obtains the lease, checks the actual CDP target against the
expected run target, then enables focus emulation. A preparation error prevents
dispatch and discards the failed session; a later retry can create a fresh one.
Tab management skips this preparation. Human ownership prevents preparation, and
the existing epoch checks still fence in-flight results and captures. Closing the
page or MCP connection releases the session. No force click, actionability bypass,
workspace-wide serialization, or additional bot access control was introduced.

This intentionally gives an automated page a visible/focused DOM state without
physically bringing it to the foreground, matching normal Playwright automation.
It is an intended runtime behavior correction, not a claim that a strategy is
statistically better. The ordinary click regression uses the actual proxy/Gateway,
separate run targets, eight parallel rounds, exact independent counters, and a
restarted MCP connection; existing takeover and screenshot assertions remain.

The final candidate image is `cogbot/workspace:m2-live-business-focus-20260923`, ID
`sha256:910ef34a8121c9caad0dea189746c10c28b602b5eea1139e72f9ba367d849633`, built
after commit `722643b`. The standalone diagnostic scripts and six raw arms are
under `spikes/m2-click-stability/`; its dedicated containers and volumes were removed.

On this final image, both real browser/SDK attribution T2 cases passed in 89.47 s.
The eight parallel rounds made 16 ordinary clicks and left independent counters
exactly `[8, 8]`, including the resumed connection, with existing target, takeover,
and screenshot checks intact. Three additional T2 cases passed in 68.32 s: inline
snapshot handling, parked approval restoration, and two-bot MFA takeover.

## Final configured-model ticket regression

The final focus-image matrix completed all eight runs in 470.72 s. Every run
succeeded; all six arms passed requested writes, unrelated-state invariance,
stable target selection, and screenshot attribution. Both concurrent pairs
overlap on separate tabs. No click stability timeout or local snapshot-file read
occurred in this sample.

X03 passed strictly across both solo arms and the concurrent pair: the comment
was added exactly once and reassignment from `wang` to `li` survived, with no tool
errors or out-of-role calls. X02 remains strictly failed: its four runs each
encountered one stale snapshot reference, recovered, and completed the correct
writes. The solo reassignment run additionally used `thread_post`, outside this
fixture's browser-only tool contract. These are retained failures, not accepted
as error-free execution merely because the final state was correct.

The measured suite duration differs from the 560.12 s baseline, but these are
single repetitions, and the final ticket run overlapped a separate MFA acceptance
stack for part of its execution. This is regression evidence, not a controlled
speedup estimate or the K=5 browser-interference calibration. Persistent focus is
supported by the deterministic controls and ordinary-click regression above.

## UI verification

A separate Gateway/database and ephemeral UI ports were used. Actual browser
interaction verified group creation with three selected members, two simultaneous
running indicators, correctly attributed messages/run links, paused-cap banner,
human-message recovery, member join, and the run-to-thread back link. Evidence is
under `spikes/m2-group-ui/work-v2-20260923`. The temporary server and browser tab
were closed. These are UI/API/SSE checks with a scripted provider, not model-quality
measurements.

## Remaining acceptance and scope

B3 cannot be declared complete while configured-model silence/output checks and
X02 strict browser-tool checks fail. Stale-reference handling needs investigation;
any prompt/tool-use strategy change must retain a baseline and paired evaluation.
The browser lock's general interference target still needs the specified K=5
X02/X03 protocol and aggregate analysis. One repetition cannot establish a <=5%
interference rate or justify changing lock granularity. Strategy changes to silence
or formatting need a baseline and paired evaluation, not relaxed assertions.

Full M2 also still includes B4 operator authentication/network isolation, B5
knowledge/memory and vision/CLI work, plus tab retention and resource/capacity
limits. This report does not close those tasks.

## Verification records

Full local suite on the final focus candidate: 1004 tests passed in 69 files (22.61 s). Backend/acceptance types,
Biome, web types, and the web build passed. A sandboxed local test attempt could
not open loopback listeners and was interrupted; rerunning with local networking
exposed one outdated fixed-argument expectation, which was corrected before the
passing full suite. No real model was called by T0/T1.

Code and test changes are committed independently from this design-results record.
Raw evidence directories are intentionally ignored by Git; the result summary is
tracked here. Paths below are relative to the isolated worktree:

| Evidence | Location |
| --- | --- |
| Chief model run, source/image manifest and process result | `spikes/m2-business/work-chief-20260923/` |
| Three preserved group attempts | `spikes/m2-business/work-group-20260923/`, `work-group-v2-20260923/`, `work-group-v3-20260923/` |
| Scripted relay/turn caps and earlier fixture trials | `spikes/m2-business/work-group-limits-20260923/` |
| Scripted MFA passing evidence | `spikes/m2-business/work-takeover-container-20260923/` |
| Three model MFA attempts | `spikes/m2-business/work-takeover-20260923/`, `work-takeover-v2-20260923/`, `work-takeover-v3-focus-20260923/` |
| Initial incomplete/vacuous ticket attempt | `spikes/m2-business/work-tickets-20260923/` |
| Corrected eight-run ticket baseline | `spikes/m2-business/work-tickets-v2-baseline-20260923/` |
| Candidate snapshot-only ticket test | `spikes/m2-business/work-tickets-v3-snapshot-20260923/` |
| Final focus-image runtime and unit regressions | `spikes/m2-business/work-runtime-focus-20260923/` |
| Final focus-image ticket model run | `spikes/m2-business/work-tickets-v4-focus-20260923/` |
| Six runtime regressions on snapshot image | `spikes/m2-business/work-runtime-snapshot-20260923/` |
| Inline snapshot T2 and diagnostic logs | `spikes/m2-business/work-snapshot-probe-20260923/` |
| Versioned golden image build/smoke | `spikes/m2-business/work-golden-image-20260923/` |
| Operator UI interaction observations/API/SSE | `spikes/m2-group-ui/work-v2-20260923/` |

Reproduce a fresh configured-model run without replacing earlier evidence:

```sh
node spikes/m2-business/run.mjs --env /path/to/main/.env \
  --image cogbot/workspace:m2-live-business-focus-20260923 \
  --suite tickets --output spikes/m2-business/work-tickets-fresh
```

The runner accepts `chief`, `group`, `takeover`, `tickets`, or `all`. It records one
repetition; it does not silently claim five. Credentials are passed only to the
child environment. Source/test digests, image ID, site version, model, origin,
and process result are retained in each model-run directory.


## Follow-up (2026-09-23)

The [B3 follow-up](m2-b3-completion-results-2026-09-23.md) fixes explicit-silence
parsing, adds the non-vacuous X01 and injection measurements, and separates
canonical business oracles from diagnostic tool/format checks. This report's
original failed trials remain unchanged. Group/collaboration gates subsequently
pass, but complete X02/X03 K5 calibration triggers ADR-0004 escalation (1/10);
overall B3 and M2 are not marked complete.

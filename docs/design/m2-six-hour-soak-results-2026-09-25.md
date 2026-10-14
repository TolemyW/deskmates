# M2 six-hour stability observation results

Status: completed observation, retained failures; not full M2 acceptance.

The owner-requested unattended campaign ran on Testbox from 2026-09-25
01:31:39 to 07:31:42 Asia/Taipei. All 18 scheduled slots completed; 13 passed
and five failed. There were no skipped slots or supervisor-interrupted samples.
The user systemd service exited successfully and the final ownership-scoped
cleanup is recorded as verified. Service success means the campaign completed,
not that its acceptance tests all passed.

## Outcomes

| Case | Canonical pass / observations | Detail |
| --- | --- | --- |
| Chief delegation and aggregation | 6/9 | Two silent initial turns; one missing required assignment marker |
| Ordered replies and silence | 9/9 | All observed cases passed |
| Parallel mention routing | 9/9 | All observed cases passed |
| Direct bot handoff | 9/9 | All observed cases passed |
| X02 ticket labeling and reassignment | 8/9 | Slot 16 hit the 35-turn cap; solo labeling also missed a required write |
| X03 same-ticket comment and reassignment | 8/9 | Slot 6 failed the tab-lock-wait check on a close-tab action |

Foundation totals: 33/36 cases, six of nine complete suites passed.
Ticket totals: 16/18 canonical scenarios, seven of nine complete suites passed.
Only **2/18 ticket scenarios** passed every strict diagnostic (both in slot 4).
Canonical success must not be presented as clean tool/protocol execution.
These are repeated observations of fixed fixtures, not independent estimates
of production reliability or a paired improvement experiment.

## Retained failures

- Slots 9 and 17, chief: each ended `silent` after one run, with no tool calls
  or expert delegation; the required minimum four-run workflow did not occur.
- Slot 15, chief: both experts answered and the chief produced `CHIEF_TOTAL:96`,
  but the transcript had no `CHIEF_ASSIGN` marker. The assignment assertion
  failed. This is a protocol failure, distinct from silent non-delegation.
- Slot 6, X03: all writes/runtime checks passed, but concurrent run 1 received
  the other-run tab-lock message at event sequence 204. The preceding tool was
  `browser_tabs` with `{action:"close", index:2}`. This observation does not
  identify who owned index 2; it is not proof that the lock implementation
  blocked the run's own tab. The existing oracle remains failed.
- Slot 16, X02: the labeling run failed in both solo and concurrent arms with
  `Reached maximum number of turns (35)`, after approximately 224 and 183
  seconds. The solo arm missed a required `refund` label. The concurrent arm
  passed requested-write checks but failed runtime. These are turn-cap failures,
  not the fixed 300-second run deadline or the supervisor's 19-minute limit.
- Strict ticket diagnostics frequently flagged tool errors and, in some cases,
  non-browser-only actions. These remain failures in the strict diagnostic
  evidence even when the canonical business outcome passed.

## Host and observer

718 resource samples were retained. Maximum observed workspace memory was
1.436 GiB against its 4 GiB limit. Minimum sampled host free memory was
46.65 GiB; minimum free disk was 420.51 GiB. Sampling cannot establish absence
of short spikes or memory leaks. Each suite used fresh workspaces, so this was
not a six-hour single-workspace lifetime test.

The observer log contains **one timestamped Docker stats failure**, followed by
two `EOF` lines and a blank line. Counting its four lines as four separate
incidents would be incorrect. The exact cause is not established; subsequent
samples and scheduled tests continued. No process restart or oracle adjustment
was performed during this review.

## Evidence and remaining work

Launch configuration, image IDs, source provenance and watchdog rules are in
`m2-six-hour-soak-2026-09-25.md`. The remote evidence root is:

`/home/owner/agent_workspace/deskmates-b4-native-20260924-1418/spikes/m2-soak/work-20260925-0135`

Its `REPORT.md`, `status.json` and `manifest.json` were copied to the ignored
local directory `spikes/m2-soak/work-review-20260925/`. Per-slot raw evidence
remains on Testbox. Failed slots are 6, 9, 15, 16 and 17. All prior failed
campaigns remain evidence. No tests were rerun to obtain a pass.

Next investigation should distinguish chief output/protocol failures, ticket
excessive-turn behavior and close-tab target ownership. Visual-model acceptance
remains owner-deferred; the native B4 public-DNS limitation was outside this
campaign. M2 is not marked fully accepted.

## Follow-up trace diagnosis

Read-only inspection of the retained traces refined the causes without rerunning
or reclassifying any sample:

- **Chief slots 9 and 17:** the assistant's structured `done` text explicitly
  claimed it had delegated through `thread_post`, while the ledger contained
  zero tool calls and no expert runs. Its `reply` was empty, producing `silent`.
  Each model request completed with recorded `ok` network phases in about
  1.5–1.7 seconds. This is evidenced false completion reporting/omitted execution,
  not an observed message-delivery failure after a tool call. The structured
  summary is a model assertion, not proof that an action happened.
- **Chief slot 15:** delegation, both expert answers and the final total were
  present; only the required assignment marker was absent. It is a distinct
  protocol-conformance failure, not evidence that delegation never happened.
- **X02 slot 16 solo labeling:** the trace used all 35 tool calls navigating,
  searching and inspecting tickets. After a stale reference error it visited
  the target tickets, then broadened searches and inspected additional tickets
  without performing the required labeling. The missing-write oracle therefore
  failed when the SDK reached its unchanged 35-turn cap.
- **X02 slot 16 concurrent labeling:** both required label writes occurred, but
  the bot continued broader searches and verification rather than ending its
  run. It reached the same turn cap despite the requested writes being present.
  The observed defect is failure to finish within the action budget; simply
  raising that budget is not an established fix.
- Across all nine ticket suites there were **34 stale snapshot-reference tool
  errors**, one tab-lock error and one other error (a Bash command exiting 2).
  There were **five Bash calls and one `thread_post` call** despite the fixture's
  browser-only instruction. The strict diagnostic requires zero tool errors and
  no non-browser tool calls, explaining why only 2/18 scenarios were strictly
  clean while 16/18 passed their canonical oracle. These are tool-event counts,
  not 36 separate failed tasks.
- The traces establish stale-reference rejection, but do not by themselves prove
  whether each stale reference came from model reuse after a page update or a
  browser-adapter invalidation defect. Likewise the close-index-2 lock event
  lacks an index-to-stable-target mapping. Both require targeted replay or more
  precise diagnostic evidence before assigning a framework root cause.

Priority candidates for further work are action-evidence checks for claimed
completion, task completion/stopping behavior, and snapshot/tab target lifecycle
instrumentation. These are proposed follow-ups, not implemented repairs or
validated strategy improvements. Model changes and prompt/strategy changes
would require the repository's paired evaluation protocol.

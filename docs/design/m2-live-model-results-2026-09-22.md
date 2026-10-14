# M2 foundation: live-model test results

Date: 2026-09-22. Verdict: the real-model messaging path works, but the M2
collaboration acceptance gate is **not passed**. The final fixed matrix passed
7 of 8 cases; duplicate replies caused the remaining failure. An earlier probe
also observed an expert incorrectly staying silent on a valid assignment.

Follow-up: the fixes and subsequent control/candidate matrices are documented in
[m2-messaging-fixes-2026-09-23.md](m2-messaging-fixes-2026-09-23.md). The failures
below remain the historical evidence that motivated that work.

## Reproducible setup

- Runtime source: `ce65438e6535c19d933d6e9455d758fdadab3fb3` on the isolated
  `codex/m2-foundation-20260922` worktree.
- Workspace image: `cogbot/workspace:m2-live-ce65438-20260922`;
  image ID `sha256:12e681ad0cb87a7fb2bfef64540cc365ce8856d722c046026af257696daf56a9`.
- Model: `glm-5.3`, through the project's existing configured model gateway.
  The configured cheap model remained `glm5.3-flash`; this was not a model A/B.
- Real Gateway, SQLite, DockerProvider, workspace container, sidecar, Claude Agent
  SDK, and model API. No fake SDK/provider/model upstream was used.
- Eight fixed cases: four scenarios, two repetitions each, fresh bots/threads per
  case. SDK maximum turns: 8; per-run timeout: 180 seconds. Test-specific SOUL
  fixtures exercise routing; they do not modify production strategy.
- Test source SHA-256 for the final matrix:
  `e96151ea915d57483235c5166efa03f4a85f63708b67c45c5bf6d31cd0e8a1a6`.
- Entry point: `acceptance/m2-group-foundation.acceptance.test.ts`.
  Reproduction wrapper and notes: `spikes/m2-live/run.mjs` and its README.
- Final evidence: `spikes/m2-live/work-matrix/{manifest,results,summary}.json`.
  Runtime evidence is local and Git-ignored; the aggregate findings are recorded
  here. Credentials are neither printed nor copied into the worktree.

## Final matrix

The suite finished with **7 passed / 1 failed**, exit code 1, in 138.96 seconds.
It was allowed to finish the fixed matrix rather than retrying failures to green.

| Scenario | Round 1 | Round 2 | Runs per round | What was observed |
| --- | --- | --- | --- | --- |
| Chief delegates to two experts and combines their results | Pass, 20.0 s | Pass, 26.7 s | 7 / 7 | Real `thread_post` addressed both experts; both supplied results; the chief posted the correct total after their replies. |
| Unaddressed group message, one responder | Pass, 19.7 s | Pass, 14.0 s | 3 / 3 | Members ran in order, later deliveries included the first reply, and only the designated chief posted a message. |
| Two explicitly mentioned peers | Pass, 13.7 s | **Fail, 14.9 s** | 4 / 4 | Initial runs overlapped. Round 2 produced three bot messages instead of two because the reviewer posted the same answer twice. |
| Direct `message_bot` handoff | Pass, 11.2 s | Pass, 11.8 s | 3 / 3 | The real tool created the pairwise bus, the analyst ran on the background lane, a linked notice appeared in the original chat, and the reply returned to the caller's bus session. |

Case timing includes SDK/model execution and a 1.5-second quiescence check. It
excludes container creation and SOUL fixture setup. These are short synthetic
messaging tasks, not browser-task benchmarks or a production latency estimate.
Two repetitions do not establish a reliability rate.

## Findings that prevent a stable collaboration sign-off

### Duplicate tool message and final reply

In final case `parallel2`, run `run_311d736ec7424881addac758b6251118`
called `mcp__cogbot__thread_post` with `REVIEWER_OK parallel2` and then returned
that exact text again as `summary.reply`. Both became transcript rows:
`msg_1c6b553d16b7416ebde19b2ba132887f` and
`msg_acd03c6b88904114b25a015e15850adf`.

The test deliberately retains its two-message assertion and remains failed.
This is not a lost request, an SDK crash, or a missing reply. The application
currently publishes both valid output paths, and the model can use both for the
same answer. A future fix should define duplicate final-reply handling within
one run, while preserving intentional distinct progress/final messages. The
problem also appeared in an earlier chief probe, causing an extra chief wake.
No production behavior was changed as part of this testing task.

### An expert can wrongly stay silent

The earlier `work-final` probe failed its chief case: the reviewer run
`run_8e0a374c94e5402290092eb20d640d2c` was correctly woken and completed, but
misinterpreted the assignment as not requiring its own response. It posted no
reviewer result, so the chief could not produce a total. The source transcript
contained the explicit reviewer mention and assignment. This distinguishes a
model/role-following failure from a routing failure.

The two chief cases in the final matrix succeeded with the same role instructions;
that does not erase the earlier failure. Role/task interpretation needs dedicated
reliability evaluation before relying on unattended collaboration. Changes to
production SOUL wording require the repository's paired strategy evaluation.

### Silent runs still cost tokens

The final matrix used 34 runs. Sixteen of those posted no bot-authored message.
Both parallel cases used four runs for two intended answers; both chief cases
used seven runs. This includes expected observation/aggregation wakes under the
current routing design, so it must not be mistaken for a model-call count of two
just because the UI shows two responders.

A terminal status of `silent` only means the final `summary.reply` is empty. A
run may already have posted a message through `thread_post`. The ordered-case
oracle was corrected to inspect the transcript and attribution, rather than
requiring the answering run to end `succeeded`. Its requirement that the other
members post nothing was retained.

## Usage evidence

The final eight-case matrix recorded these Gateway usage counters:

| Counter | Tokens |
| --- | ---: |
| `inputTokens` | 75,013 |
| `outputTokens` | 4,736 |
| `cacheReadTokens` | 744,960 |
| `cacheCreateTokens` | 0 |

These are separate ledger counters; cached input is shown separately. All model
usage rows in this matrix named `glm-5.3`. The acceptance stack has no model
price table, so `costUsd` is null; no dollar cost is inferred.

Including exploratory probes and the corrected-oracle rerun, the whole testing
session observed 69 runs: 157,357 input tokens, 10,772 output tokens, 1,445,888
cache-read tokens and zero cache-create tokens. Those totals include failed and
exploratory work; they are not the final matrix's result sample.

## Validation and isolation

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Wrapper/summarizer syntax checks and `git diff --check`: passed.
- Real-model T3 matrix: **7/8 passed, 1 failed**, as documented above.
- Initial three-scenario probe: 6/6 passed; this smaller probe did not establish
  stable chief/expert behavior or absence of duplicates across further runs.
- No production package code was changed. The earlier 959-test T0/T1 result remains
  separate evidence, not a substitute for the failing real-model case.
- Unique test image, ephemeral ports, isolated SQLite, bot homes and Docker
  volumes. Every test container was torn down; a final image-filtered Docker
  listing found none left. The existing application container remained running.
  The main checkout and its M1 QA files were untouched.

These cases do not exercise simultaneous browser actions, runtime tab propagation,
real-model approval/takeover recovery, adversarial cap behavior under a real model,
or full golden-site M2 tasks. Those acceptance gates remain open alongside the
concrete reply-duplication and role-following findings above.

# M2 B2 browser hardening follow-up

This follow-up uses three `gpt-5.6-sol` subagents at medium effort for approval
resume, interference measurement, and final-answer diagnosis. The integrator owns
production fixes, combined review, image builds, and configured-model verification.
All work stays in `codex/m2-foundation-20260922`. The active application, its data,
main checkout, and shared development image are not deployed or restarted.

## Runtime fixes

Commits `5eed80e` and `20daba1` verify actual MCP target identity after restoration,
selection, and capture. A successful lease alone is not evidence of the actual page:
MCP may silently choose a fallback after a page closes. Captures and results fail
closed on an unexpected target. Successful `new` must produce a previously unseen
target; successful `close` must remove the intended target; an MCP error remains
an error rather than becoming a synthetic successful closure. Explicit selection
is checked against the requested stable target.

These changes keep the existing trust model: bots share the same browser profile
and filesystem. They introduce no bot access-control boundary. Risk classification
and approval stay in the SDK hooks. SDK, MCP, and Playwright versions are unchanged.

Final runtime image: `cogbot/workspace:m2-live-browser-hardening-v2-20260923`.
Image ID: `sha256:1a14b0a4c7191abdfd875d45f9a4b7a21f3cc8440fa2594f0f170ebcc2047732`.

## Original formatting failure

The previous failed revenue answer was not a parser defect. The raw assistant
message contained prose with `answer: 0.00`, but its declared JSON `reply` contained
`The dashboard shows "This month's revenue" as 0.00.` The existing summary parser
correctly prefers the nonempty declared reply. No production prompt, SOUL, parser,
or strict expected-answer format was changed.

The browser smoke now collects every runtime/session/screenshot oracle before
asserting strict formatting. It requires nonempty target IDs, actual tool results,
actual screenshots, and correct attribution for every screenshot. The previous
strict failure remains in the earlier report and raw evidence.

## Verification

| Check | Result |
| --- | --- |
| Full T0/T1 suite | 995 passed, 68 files |
| Typecheck and Biome | Passed |
| Existing M2 real browser/MCP/SDK tests on final image | 2 passed, 53.90 s total |
| New parked approval T2 on final image | 1 passed, 37.39 s total |
| Configured GLM-5.3 S01 + parked S11 on final image | 2 passed; 3 other M1 cases intentionally excluded |
| Configured GLM-5.3 paired matrix, K=5 | 20/20 runtime checks; 17/20 strict task checks; T3 remains failed |

The new T2 uses the real SDK with a scripted upstream. It parks on the checkout
submit, approves later, restores the same stable target on attempt 2, retries after
a stale page reference, submits exactly one order, consumes the approval retry
once, and leaves a peer's target and URL unchanged. Early harness attempts needed
corrections for pinned MCP's `target` field, the latest snapshot reference, stopping
after the placed URL, and distinguishing multiple resume log events from the one
approval consumption. Those attempts are not reported as product acceptance.

The actual configured-model regression logged in in 22.1 s and completed parked
S11 in 41.2 s, including the park and resumed attempt. It verified one new order
for C-0004/SKU-5. Run IDs are `run_524ee45dd75a47b6b4e8acd3c02c37a3` and
`run_cb9d14934fa94afba79a2207cd4abedb`. This complements the stronger target-identity
assertions in T2; it does not run the three excluded M1 approval cases again.

## Paired read-only interference probe

The probe uses two fixed dashboard tasks with different correct values (0 and
300.00), the same bot/SOUL/model/task per arm, fresh threads, neutral identical
thread titles, and reset generated diaries. It alternates solo/concurrent arm
order, cleans only its isolated browser tabs between arms, and preserves shared
cookies. K=5 plans 20 model runs and 10 paired task observations. Formatting,
parsed-answer correctness, browser runtime, role protocol, and site-state invariants
are reported separately. Missing pairs never enter the eligible denominator.

Final test source is `9e9de95` (new suite initially committed in `d618916`), using
the final runtime image above. All five repetitions completed in 201.03 s including
fixture startup/teardown. All 20 runs succeeded; all five concurrent pairs had
separate targets and positive overlapping run intervals. There were no tool errors,
misattributed screenshots, read-only state changes, or missing pairs. All 20 diary
resets occurred. These are the browser runtime observations, not a strict T3 pass.

| Metric | Solo | Concurrent |
| --- | ---: | ---: |
| Runtime checks passed | 10/10 | 10/10 |
| Strict task checks passed | 9/10 | 8/10 |
| Unexpected tool protocol | 1/10 | 2/10 |
| Reply formatting failures | 1/10 | 0/10 |
| Mean run duration | 9.92 s | 13.49 s |

The three strict failures all used read-only `browser_find` despite the fixture
SOUL restricting reads to `browser_navigate` and `browser_snapshot`. They are
instruction/protocol failures, not unauthorized writes or observed tab failures:

- Repetition 2 concurrent revenue: `run_16c72317c88044c9a9ed1c99294dbd2d`,
  correct `answer: 300.00`, extra `browser_find`.
- Repetition 3 solo tickets: `run_a89fd6e869ff4f1fb4a9a66bf9dc589e`,
  `Open tickets = 0`, extra `browser_find` and wrong reply format. Numeric content
  is correct on inspection, but the parsed-answer metric is unavailable because
  the required answer line is absent.
- Repetition 5 concurrent tickets: `run_62c787a96240496f8192258f9a83ef2f`,
  correct `answer: 0`, extra `browser_find`.

Strict concurrent-only failures are 2/9 eligible pairs, with one baseline failure
excluded. The descriptive unclustered Wilson interval is 6.3%–54.7%. Runtime
concurrent-only failures are 0/10. Neither is an estimate over independent real-world
tasks: these are repeats of two fixed dashboard reads. The observed duration
difference is descriptive and does not establish a statistically reliable slowdown
or explain its cause. The suite exits nonzero and the failures remain in the raw
evidence; no model retry, prompt adjustment, or relaxed oracle replaced them.

The first matrix attempt failed in fixture preparation before any model runs:
closing every Chromium tab exited the browser and restarted the isolated workspace.
Its five failed/incomplete rows remain under `work-k5-20260923`; all ten paired
observations are missing, with no eligible rate or confidence interval. The harness
was corrected to retain one fresh inert page and abort on infrastructure failure.
The final matrix uses a separate evidence directory rather than overwriting this
attempt.

## Evidence and remaining work

Reproduce from the isolated worktree with a dedicated image and an ignored output
directory. The env file is read only to populate the child process; credentials
are not included in the manifests.

```sh
WORKSPACE_IMAGE=cogbot/workspace:m2-live-browser-hardening-v2-20260923 \
  npx vitest run acceptance/m2-browser.container.test.ts \
  acceptance/m2-browser-approval.container.test.ts --maxWorkers=1
node spikes/m2-browser-approval/run-model.mjs --env /path/to/main/.env \
  --image cogbot/workspace:m2-live-browser-hardening-v2-20260923 \
  --output spikes/m2-browser-approval/work-model-new
node spikes/m2-browser-interference/run.mjs --env /path/to/main/.env \
  --image cogbot/workspace:m2-live-browser-hardening-v2-20260923 --repetitions 5 \
  --output spikes/m2-browser-interference/work-k5-new
```

- `/private/tmp/cogbot-b2-followup-unit.log`: full T0/T1 output.
- `/private/tmp/cogbot-b2-runtime-final.log`: final existing M2 container tests.
- `/private/tmp/cogbot-b2-approval-model.log`: configured-model approval output.
- `/private/tmp/cogbot-b2-interference-model-v2.log`: final matrix test output.
- `spikes/m2-browser-approval/work-model-20260923/`: model/image/source manifest
  and final process result. Temporary test stack data is removed by normal teardown.
- `spikes/m2-browser-interference/work-k5-20260923/`: initial fixture failure,
  zero model runs, preserved manifest and incomplete result/report.
- `spikes/m2-browser-interference/work-k5-v2-20260923/`: final matrix manifest,
  raw run/ledger evidence, and computed summary/report.

The dashboard probe is not X02/X03: the golden site's ticket/report paths are
still stubs. Ten repeated observations of two fixed tasks cannot establish a
general <=5% interference rate or justify changing lock granularity. Full X04,
B3 chief/group acceptance, adversarial relay tests, browser UI verification, and
tab retention/resource limits remain open. No full M2 completion or strategy
superiority is claimed. Follow-up work on tool-role and reply-format adherence needs
the paired strategy evaluation protocol; this batch does not change production
prompting based on the small sample. Final teardown left only the pre-existing
application container running, with its original image and uptime intact.

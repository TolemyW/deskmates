# Run supervision browser verification and accounting race repair

Date: 2026-10-03 Asia/Taipei. Selected adopted run supervision journey passes.
Full M3 is not accepted. No commit, tag, merge or deployment. Stable services
and real provider/model credentials were untouched.

## Defect, repair and regression evidence

A run replay may receive an SSE terminal status while its initial GET remains
in flight. The terminal usage refresh correctly displays accounting, but the
late initial running snapshot replaces it with an empty array. The reducer
keeps the newer terminal run row, so the contradictory page says succeeded
with no recorded usage. The same path replaces attempt 2 accounting with a
late attempt 1 snapshot.

Two new regressions fail before the repair: 15 selected tests pass, two fail.
One mounted RunScreen regression holds the initial fetch, delivers an actual
component SSE terminal frame, waits for usage, then releases the old snapshot
and observes accounting disappear. One state regression supplies an older
attempt snapshot with different accounting while preserving historical event
coverage. Neither replaces the actual browser check below.

`packages/web/src/state/run-view.ts` now reconciles the incoming run first.
When the existing run wins, it also retains that run's displayed accounting;
older events still merge by sequence. Legitimate authoritative snapshots may
still replace usage, including an empty result. Unknown usage is not converted
to zero and no totals are synthesized by the UI.

After repair, RunScreen/state/context/newerRun selection passes 22 tests.
Full T0/T1 passes **2460/2460**, zero failures/skips; Web typecheck, lint and
Web build pass. Standalone spike typecheck passes with ES2023/Node globals.
The first standalone invocation used the default DOM library and exposed a
pre-existing Node-fetch Buffer overload plus one fixture string/RunId error;
using the appropriate Node library and the branded Run ID fixes that check.
No production model-proxy code was changed for the compiler invocation.

## Actual browser and Gateway evidence

The fixture uses the actual built React app, two real Gateway listeners,
authenticated HTTP/SSE, production scheduler and durable SQLite. FakeProvider
plays synthetic sidecars through the normal run-token callbacks. There is no
SDK, Docker, real model, upstream bill or independent domain-task oracle.
The synthetic pricing row is explicitly fabricated acceptance data.

work-01 uses the prior index-Do1K6IeU.js bundle. Its actual GET captures the
running row and empty usage; the proxy retains the bytes. Completing the run
with 250 input tokens makes the page display qa-run-priced and $0.0025.
Releasing the identical old HTTP response then clears the usage while the page
retains succeeded. Browser AX files and screenshot retain the contradiction;
the actual SQLite ledger still records the tokens.

work-02 uses rebuilt index-dKYe5fwL.js. The same live protocol retains 250 input
tokens and $0.0025 after the old response is released, and the old response's
historical memory-index event still appears. It additionally verifies:

| Actual state/action | Observed browser/server result |
| --- | --- |
| Failed | Failure reason and partial-summary text displayed; no successful-delivery claim |
| Silent | Explicit no-reply/does-not-confirm-task-completion explanation |
| Queued | No start time, waiting-capacity explanation, no invented usage |
| Approval parked | Saved-session/paused-for-approval explanation and pending inbox card |
| Continuation parked | Partial handoff path, attempt/count and Continue/Stop controls |
| Continue | Same logical run ID, second attempt, one continuation used, succeeded, controls removed |
| Stop | Same run stopped at attempt 1, handoff path retained in summary, controls removed |
| Allow once | Pending card removed, same logical run resumed once into attempt 2; no Always rule created |
| Missing measurements | Absent input-window/cache measurements remain Unknown, with explicit missing-is-unknown wording |
| Process success versus delivery | Completed synthetic process still instructs operator to review its result to confirm delivery |

The continued/approved result is scripted. This proves operator controls and
Gateway transitions; it does not prove actual SDK continuation or model task
quality, which remain separate acceptance requirements.

## Retained setup and observation limits

The first queue setup posted into another thread for a busy bot. Its unaddressed
wake is deferred before a run is created, so expecting `runs[0]` was a fixture
error. Preserve that assertion and its task message. A single recorded POST
into the same currently running thread reserves a real queued row, which is
then verified in the browser. The deferred false-start message also later
executes during cleanup and is included in accounting. This is not a production
routing defect and no fake queued status is written into the database.

The final helper source corrects the queue setup and is typechecked, but is not
claimed as a separately rerun browser campaign. Both executed original helper
sources are retained and match each ready receipt's hash. A five-second usage
locator wait in work-02 expired before the live response arrived; the same page
subsequently displayed usage before the old response was released. No process,
task, old snapshot or UI decision was restarted for that observation timeout.

## Bindings and cleanup

Before run: `run_38a040c9204042b3b7d2d3af8d59cd42`, one synthetic execution,
receipt SHA-256 `393868093acd1936f40d3f59b5527a251ac90ecc6eb8c2b01c20da7d2e3791c5`.
After race run: `run_40169a296ca348a980c534954b9af485`.
After instance: nine logical run rows, eleven synthetic provider executions;
six succeeded, one failed, one silent and one stopped. All rows terminal after
drain; all synthetic outcomes and false-start cleanup calls are retained.
After receipt SHA-256
`00448032e6ab0603bea8f193baa410d4bc273f0b295ac942ef585db91511c5a7`.
Both real-model call counters are zero.

Current reducer SHA-256
`ad7390b41e8a6ae7df69f9f777dcee85c9ee32430ddba836b325a454bee116bb`.
Rebuilt main bundle SHA-256
`015f6dfc42cd8fc59ea690b388d60c2030d1ce880858303ee80d450ae224b5bb`.
Index SHA-256
`a70e595eea07f6eea22ba38e5ac5315bf79de785f3e17394f70e13c773d58739`.
Private `work-01`/`work-02` artifacts contain executed fixture source, before/
after/full test reports, actual browser AX states/screenshots, raw synthetic
SQLite ledgers, final state, listener audit and hash inventories. SQLite
quick_check reports ok for both. Both retained execution handles exit zero;
known proxy entry ports 58146 and 58549 independently refuse connections;
shutdown awaited operator/internal Gateway close. Both temporary browser tabs
are closed. No unrelated process/resource cleanup was used.

The previous frozen 17cc1157 full T2 remains **88 pass, one opt-in real-model
SDK-shape skip**, bound to its own source. This Web-only production repair is
a later revision. Container/backend/image runtime inputs are unchanged and T2
was not repeated for this UI accounting change. Do not rewrite that old frozen
receipt as a new full-tree T2 execution. All broader M3 configured-model,
provider, context/memory strategy and intermittent screenshot limitations remain
in the evidence matrix.

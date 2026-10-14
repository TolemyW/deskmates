# M3 closeout progress

Date: 2026-10-02 (Asia/Taipei). Base: `1109ec7`; uncommitted integrated tree.
Status: in progress. No commit, tag, deployment or milestone completion.

Latest live runtime evidence (2026-10-03 07:26 Taipei): the memory cooldown
observation passes actual Gateway restart and preserves twenty candidates,
one completed consolidation and its deadline. A separate one-query real-SDK
0.3.278 fixture parks attempt 1 for the unchanged 24-hour continuation window,
then passes actual Gateway restart with the same run/session/expiry, no active
token or new SDK process. Initial optional-null environment pre-start failure
is preserved and corrected in a new directory (zero SDK calls initially, one
in corrected case, zero real models). Both genuine day boundaries are pending;
no full M3 or configured-model gate is claimed. See
`m3-sdk-continuation-day-observation-2026-10-03.md` and
`m3-memory-wall-clock-observation-2026-10-03.md`.

First elapsed boundary (2026-10-03 06:56 Taipei): consistent SQLite capture
independently verifies automatic consolidation after 659963 ms of actual quiet,
successful completion, consumption of all first-source candidates and an
unconsumed ten-candidate second batch. The default policy and source/runtime
binding remain unchanged; both snapshots pass integrity/FKs and record zero
SDK/model calls. The genuine day boundary is 2026-10-04 06:55:27.865 Taipei;
that cooldown and planned process restart are still pending. See
`m3-memory-wall-clock-observation-2026-10-03.md` for timing and receipt hashes.

New live observation (2026-10-03 06:45 Taipei): a single isolated Testbox
systemd service runs the default ten-minute quiet and 24-hour consolidation
cooldown sequence with production Gateway/SQLite/timers and synthetic sidecars.
Its exact runner/probe/Gateway process tree is verified live; all 967 source and
1708 compiled inputs pass startup hash checks. Local HTTP/seed/backup/shutdown
smoke passes. No duration boundary has passed in that initial snapshot, and no
SDK/model call or credential read occurred. It remains pending rather than a
passing M3 gate. See `m3-memory-wall-clock-observation-2026-10-03.md`.

Latest preparation (2026-10-03): the unexecuted model proposal now binds the
completed 42bab952 gate instead of fcbd9e69, retaining the identical eighteen
T3 files and two context modes. Three local function-level checks retain an
initial success, a newly exposed missing-plan startup failure, and the corrected
final pass. Accounting separates synthetic sender fixtures from observed proxy
requests and unknown runs. The exact seven-file bundle is prepared locally;
zero SDK/model calls, configuration reads, transfers or service dispatches.
WABA configuration and expanded model-scope approval remain pending. See
`m3-latest-model-campaign-preparation-2026-10-03.md`.

Additional memory verification (2026-10-03): six actual Gateway processes pass
the same reserved restart/crash sequence locally and on Testbox. A persisted
queued consolidation starts with the same run ID after SIGKILL; a subsequent
running-phase crash fails that run without consuming candidates or bypassing
cooldown. An explicit operator merge then succeeds, and exact source provenance
and entries survive another restart. The remote check verifies 176 current
backend/source/compiled-contract inputs before and after; all six owned PIDs
independently inspect absent, and its systemd unit exits zero. Synthetic sidecars
make no model calls. An initial stdout-truncation fixture failure is retained.
This adds process evidence without claiming model/SDK/container or complete M3
memory acceptance. See `m3-memory-process-restart-results-2026-10-03.md`.

Latest additional verification (2026-10-03 around 01:06 Taipei): schedule browser
testing reproduced a stale next-occurrence display and repaired minute/visibility
refresh while preserving drafts. Two new regressions fail before and pass after;
component/cron selection is 15 pass and full T0/T1 is **2458 pass, zero fail/skip**.
Typechecks, lint and Web build pass. Actual SQLite Gateway wall-clock timers and
rebuilt browser verify save, overlap skip, next-round V2 instruction and deletion
past the next minute, using synthetic sidecars and no real model. Both local
fixtures are terminal, listeners independently refuse connections, and private
run/DOM/image receipts remain retained. This is not a Docker/model/full-restart
acceptance or a newer full T2 gate. See `m3-schedule-browser-results-2026-10-03.md`.

Latest verification (2026-10-03, after midnight Taipei): local T0/T1
**2,456 / 2,456**, zero failures/skips; backend/acceptance and Web typecheck,
lint and Web production build pass. A real browser with real Gateway listeners
and synthetic usage reproduced a late-response cost-alert regression. Three
regressions fail before and pass after the response-revision repair; the rebuilt
UI also passes the delayed-response reproduction. No model calls were made.
See `m3-cost-alert-browser-results-2026-10-03.md`.

An additional local actual-SDK compaction observation passes: seed, manual
`/compact` and resume all succeed in one SDK 0.3.278 session. The production
PreCompact hook archives the exact 16,619-character original transcript before
the compact boundary. It uses a loopback scripted endpoint and zero real model
calls; usage and memory-flush taint are synthetic. This does not close automatic
compaction, full sidecar/Gateway wiring or configured-model memory acceptance.
See `m3-sdk-manual-compaction-results-2026-10-03.md`.

The ADR-0011 A5 verification gap now has selected real-SDK T2 coverage: one
bot modifies its own and a same-workspace peer's SOUL/MEMORY files, both edits
are observed, and each bot's next resumed SDK run restores its exact canonical
contents, including distinct operator memory notes. Both selected cases pass;
seven scripted-upstream SDK runs succeed across three sessions, one full ledger
is retained, and all six owned identities independently inspect absent. These
are no-model mechanical checks, not configured-model memory/poison acceptance.
See `m3-canonical-peer-restoration-results-2026-10-03.md` and the consolidated
`m3-closeout-evidence-matrix-2026-10-03.md` for the remaining full M3 gates.

The four predeclared screenshot diagnostic invocations completed in ABBA order:
16 pass, zero fail, two filtered tests each. Each saved its ledger. Independent
inspection confirms all 72 exact identities absent. Both current and experimental
images pass; this does not establish a feature-flag benefit or remove either
retained full-T2 failure. No production flag was adopted. WhatsApp has an account
but no prepared runtime configuration; live acceptance remains pending. The
separate larger real-model scope confirmation remains unanswered.

Prior verification (2026-10-02, late evening): local T0/T1 **2,453 / 2,453**,
zero failures/skips; typecheck and lint pass. The new nine-test ledger regression
proves pending WAL and closed-Gateway restart coverage. An observed full T2
had 87 passing assertions and one SDK skip but exited 1 due to a diagnostic
ledger afterAll error. That failure and its missing knowledge ledger remain
retained. The infrastructure correction finished **86 pass / 1 fail / 1 skip**:
all eighteen ledgers are now saved and knowledge teardown passes, but the
five-second screenshot failure reproduced. Its actual CDP screenshot reply
arrived in 6.658 seconds, after fonts/layout completed. All 172 recorded
resources independently inspect absent. Actual MCP/CLI nested driver versions are
now checked in the image; a one-flag browser experiment did not establish the
original screenshot timeout's cause and no flag was adopted. Details:
`m3-browser-capture-runtime-diagnostic-2026-10-02.md`.

Subsequent actual-driver mechanism probes passed all controls in both arms:
serial background repaint 12/12 and concurrent repaint 16/16. All four recorded
containers independently inspect absent. They do not reproduce the separate
MCP connections and competing worker workload of full T2; screenshot reliability
remains open. No launch flag, timeout or version override was adopted. WABA
configuration and the larger real-model scope confirmation remain pending.

The owner requested improvements, testing, repairs and full M3 completion.
The effective scope remains M3-01 through M3-07 in the inventory and plan;
WhatsApp has not been deferred. The owner confirmed that a WABA account exists
but its test configuration is not ready. Its real inbound/reply/approval journey
is a missing prerequisite, not a passing gate.

## Repairs and deterministic evidence

1. WhatsApp response-body disconnects now follow the received HTTP status's
   bounded retry policy. A failed 429/503 body does not escape that policy; a
   permanent 4xx stays permanent, and an accepted 2xx with an unreadable body
   is not duplicated. The adapter regression proves cursor retention and
   recovery without a new Gateway event.
2. The delegation test now checks the exact run set rather than insertion order.
   `RunStore.list()` sorts by millisecond `created_at` and random ID: equal
   timestamps did not guarantee insertion order. It still fails for an extra run.
3. Per-turn SDK usage preserves missing/null measurements. Incomplete input
   window coverage makes peak/p95/cache-hit measurements unknown. The cache-hit
   denominator includes cache creation as well as input and cache read tokens.
   Historical events already stored as zero cannot be reconstructed by this fix.
4. Closing task notes now uses the contracts' terminal-status predicate. A run
   stopped by the operator no longer leaves task closure permanently returning
   409. Eleven API regressions cover every terminal and nonterminal status and
   idempotent closure.
5. Automatic consolidation counts source IDs acknowledged by successful/silent
   consolidation snapshots, instead of comparing observation timestamps to the
   previous run's creation timestamp. A regression first reproduced starvation
   when ten new candidates shared that timestamp; it passes after the repair.
   Five durable SQL tests cover the candidate/episode thresholds, pending-run
   deduplication after service reconstruction, workspace activity, exact quiet
   and cooldown boundaries, failed sources and consolidation self-output.
   Service reconstruction is not a full Gateway process-restart acceptance.

After these production fixes: typecheck, lint and Web typecheck pass; T0/T1
**2,417 / 2,417** pass (235 files; 2026-10-02 17:27 Taipei, 24.87 seconds).
WhatsApp/delegation targeted regression: 68 passing tests. Usage/context/API
targeted regression: 15 passing tests. An initial context API invocation failed
because sandbox loopback access was not granted; with loopback/network permission
the exact 15-test selection passed. No code was changed to bypass that restriction.

After repairs 4 and 5 and the domain fixture correction below: backend and
acceptance typecheck, lint and standalone preflight typecheck pass; T0/T1
**2,433 / 2,433** pass, with no skips or failed suites (2026-10-02 around
18:03 Taipei). Retained local JSON: ignored
`spikes/m3-closeout-20261002/work-local/m3-local-integrated-20261002.json`. This newer source has not yet
passed its own remote candidate/image gates.

## Remote evidence is revision-specific

The first frozen Testbox tree had T0/T1 2,401 pass / 1 fail and supplemental
7 pass / 1 fail. Those failures led to repairs 1 and 2 above. Its first workspace
build passed an untagged local image ID to BuildKit, which interpreted it as
an external image name. The infrastructure correction tags that exact existing
base under an owned campaign name and preserves the original failure.

On the old snapshot, full T2 then recorded **73 pass / 8 fail / 4 skipped**.
Six failures came from omitted spike scripts that are direct test dependencies;
two were public egress/DNS failures on Testbox's fake-IP resolver. The remote
test task is restoring exact frozen scripts by inventory/hash and checking DoH
public resolution while retaining private-address/IP denial. These results
neither validate nor invalidate the newer source repairs. A new candidate/image
set must run its own gates. See the revision-specific remote handoff document.

Both the corrected old snapshot and candidate `fb4d2b24` subsequently passed
full T2: **84 pass / 0 fail / 1 skip**. The skipped direct real-SDK call remains
unverified. Candidate `fb4d2b24` also passed all 2,417 T0/T1 tests, builds and
eight supplemental regressions, with zero recorded resource residue. Its T3
matrix made zero real model calls because domain preflight failed first.

The product preflight passed (23 original tickets; 9,999 in the mutation).
An isolated safe diagnostic located the data setup failure at `docker port`:
the connector was attached only to Docker's internal network, which did not
publish its requested host port. The corrected fixture keeps PostgreSQL on an
internal backend with no host port and adds a separate connector front bridge
with a loopback-only host publication. Both networks are recorded by exact
identity and cleaned after partial setup. Preflight now records its phase and
only fixed safe fixture errors, never arbitrary command errors or credentials.
The correction is undergoing a fresh no-model remote preflight before any T3.

That new preflight then exposed a second fixture defect: `pg_isready` accepted
the image entrypoint's temporary Unix-socket initialization server, which shut
down immediately before SQL seeding (`psql` exit 2; missing socket). A single
isolated PG diagnostic confirmed that sequence and cleaned all four owned
resources. Readiness and seeding now target loopback TCP inside the PG container,
which waits for the final server rather than the temporary socket-only server.
The original two preflight failures and the PG diagnostic remain retained;
this correction still needs its own no-model and integrated candidate checks.

Candidate `9db6d414` then reached connector creation and backend attachment
but failed at `docker port` again, before its remaining gates. A separately
authorized single diagnostic finally established the direct cause: the
connector had exited with code 1 before backend attachment; Node reported
EACCES reading its root-owned `dist/index.js`. The earlier internal-network
explanation was a leading hypothesis, not a verified cause. The image's runtime
COPY now gives `node:node` ownership to dependencies, packages and migrations,
so a restrictive build umask (0600 files/0700 directories) no longer makes
artifacts unreadable to `USER node`. The host files' permissions and the runtime
user are unchanged. Image rebuild and startup/SQL preflight are still pending.

The durable consolidation test now also closes and reopens an on-disk Gateway
database twice, proving that the nine-to-ten candidate threshold and queued-run
guard survive restart recovery (six targeted tests pass). A new real-SDK/fake-
endpoint T2 tests actual SOUL/MEMORY edits, their audit events and restoration
on the next resumed session; it has passed typecheck/lint but has not run in a
container yet. Neither service-object nor in-process database reopening is
claimed to be a full operating-system process restart.

`spikes/m3-context-probes-20261002/` now preregisters two distinct measurement
scopes: bare-string system prompt on SDK resume and a bounded synthetic
window/cache probe. Typecheck, two fake HTTP endpoint checks and a real installed
SDK/fake endpoint resume/proxy check pass. These made zero real model calls.
The remote test task may execute each mode once after candidate prerequisites
and the existing T3 matrix finish; the probes adopt no strategy knob and cannot
substitute for a long-run/paired memory acceptance receipt.

## Latest integrated checks and remote continuation

After the image ownership and new-test classification repairs, local T0/T1 is
**2,434 / 2,434**, no skips or failed suites. Backend/acceptance typecheck,
lint and `git diff --check` pass. Retained r2 failure (the new container test
was not yet in a T2 list) and passing full r3 report are under ignored
`spikes/m3-closeout-20261002/work-local/`; the new test is now a smoke gate.

Frozen candidate manifest
`38bc790f89f1cc2538d7bf2603c916aaeb2f49b757aab828bcf8dc2464fe4086`,
archive `4799be5c9b0cfc3502523caee7ac01317e1b4a4e44c28fd47ad276d069f476a7`,
runs in `/home/owner/agent_workspace/deskmates-reusable-m3-candidate-20261002-38bc790f`.
The root chat independently reconnected over SSH and confirmed systemd unit
`deskmates-m3-candidate-20261002-38bc790f.service` active/running, PID 3106613,
started 2026-10-02 18:32:44 Taipei. Source/build/CLI/migration/supplemental gates
passed; full T2 was running at inspection. This is a live-state observation,
not a promise that later gates will succeed.

The new connector imported as its default runtime UID 1000. The no-model product
and SQL preflight passed; the data receipt has A=2/150 and B=2/275. However,
the connector image ID changed between the prerequisite build and final build:
the image-binding gate correctly blocked T3. The remote task has authorization
to retain that mismatch and execute one fresh no-model preflight against the
final pinned image IDs after T2, before restoring the predeclared T3 matrix.
No old/preliminary image receipt can substitute for that final-image gate.
Source drift must stop the continuation. Real T3/probe calls remain unverified
until retained ledgers/receipts exist. Stable services/data remain untouched.

Candidate `38bc790f` completed full T2 with **84 pass / 1 fail / 1 skip**.
The new canonical SOUL/MEMORY restoration case passed. The only failing test
is the M2 two-client browser runtime: automatic screenshot 12 did not answer
within the unchanged 5,000 ms bound. Vitest's aggregate failed-suite count is
not evidence of another initialization failure; inspection found no second
failed test file. The earlier chat interpretation of that counter is corrected.
The failed driver then closed its client pipe and exposed an independent
unhandled `EPIPE` during the proxy's final stdout drain.

One separately retained no-model correction checked the final pinned images,
reverified all 923 source hashes, and passed the product/SQL preflight. Connector
file contents and paths were identical across the two image IDs; changes were
the entrypoint mode (0644 to 0755) and two directory metadata records. The
original image-binding block is retained. This correction does not waive the
T2 failure: neither T3 nor either real context probe has started. The campaign's
181 exact resources and the final-image correction's 11 resources have zero
verified residue.

The current local tree fixes pipe teardown with error listeners covering both
client output and child input until the final write's deferred error event has
completed. A pipe failure cancels coordination, terminates the exact owned MCP
child and returns failure rather than throwing an uncaught stream error.
Three new stream regressions plus the existing proxy suite pass (42 tests);
a manual real CLI disconnect check also confirms child reaping without a model.
The existing M2 browser container suite now includes that real pipe/child test.
Local full T0/T1 passes **2,437 / 2,437**, with typecheck/lint/diff checks passing;
the retained report is
`spikes/m3-closeout-20261002/work-local/m3-local-integrated-20261002-r4.json`.
This new source has not passed remote image/T2 gates yet. One bounded, no-model
diagnostic on the frozen old candidate observes screenshot timing and target
responses without changing the five-second limit, selecting passing retries,
or weakening attribution/takeover assertions.

Before the first real domain invocation, the product oracle was strengthened:
a fixed seed count could pass the original/corrupted-page pair. After retaining
those two replays, a host-only helper legally closes one open ticket through the
app's normal route, verifies a coherent changed dashboard/state, and replays the
same generated artifact against that new valid count. The artifact must still
pass and show login success/failure with no other writes. Host setup and artifact
operation intervals are separate; partial original/mutant evidence is saved
before the positive control can fail. The no-model preflight uses the same helper.
The prompt, strategy, task count and physical caps are unchanged. A local real
HTTP fixture test passes (23 to 22); full local T0/T1 now passes **2,438 / 2,438**.
Retained report: `spikes/m3-closeout-20261002/work-local/m3-local-integrated-20261002-r5.json`.
This additional source/oracle still needs frozen remote candidate preflight and
image-bound evidence; it does not turn the earlier candidate into a passing one.

## New domain gates

`acceptance/m3-domains.acceptance.test.ts` adds three independently graded T3
flows. They have not yet been executed with a real model:

| Domain | Oracle and isolation | Current evidence |
| --- | --- | --- |
| Product testing | Separate golden-site container; generated executable browser test must pass the app and reject a count mutation; real login operations observed | Types/lint pass; no-model Docker preflight and T3 pending |
| Data platform | Fresh private PostgreSQL plus production connector image; report rows must agree with the Gateway's authoritative terminal receipt and seeded oracle | Types/lint pass; no-model Docker preflight and T3 pending |
| Quant | Frozen synthetic prices, prior-day ranking, alphabetical ties, costs and provenance; fixed daily vectors and executable replay | Six oracle self-tests pass; real-model T3 pending |

The campaign is predeclared in `spikes/m3-closeout-20261002/README.md`: pinned
images, one reserved logical task per domain, fresh sessions, 900 seconds and
20 turns per physical attempt, retained failures and all usage. Fixtures are
checked without a model first. No answer keys enter the bot's workspace.

Existing model test configuration has been checked read-only: the four required
keys are present, the file is owned by the test user and mode 0600. The agreed
bootstrap parses only those keys in the remote process and passes them to its
same-user child environment; it creates no secret file and prints no values.

## Outstanding full-scope gates

The `fcbd9e69` candidate is frozen at 931 inventory files and completed its
separate deterministic-only campaign on Testbox. Its T0/T1 is 2,438/2,438 and
final-image-bound no-model domain preflight passes, including the legitimate
23-to-22 product positive control. Full T2 finished: 86 passed, zero failed and
one existing real-model SDK-shape check skipped. The concurrent screenshots,
real stdio disconnect/child reaping and canonical restoration cases all passed.
An independent SSH reconnect confirms the user unit completed successfully;
final inspection finds none of the 181 journaled resource identities present.
Some cleanup commands found resources already removed by the fixture; final
absence is the cleanup oracle. See
`m3-candidate-testbox-results-2026-10-02-fcbd9e69.md` for the full receipt.
The attempted combined runner was rejected before dispatch by automatic
approval review because it could launch eighteen real-model suites and two
context probes beyond the clearly recorded older campaign authorization.
The permitted deterministic runner has no model configuration read or model
branch. Real-model tests/probes have not started; the full M3 scope remains.
See the candidate handoff for exact hashes, unit and review rejection.

Independent no-model memory prerequisites now pass: production operator forget
removes four scoped notes from index/search/canonical learned experience while
preserving human rules and another workspace. All 71 suggestions from the two
retained VendorDB long-run archives have primary-scope annotations, with historical
trust explicitly unknown. These scripts were excluded from the frozen candidate
and do not establish full memory-off or Phase 4 acceptance. Exact receipts and
limits are in `m3-memory-prerequisite-results-2026-10-02.md`.
The owner has a WABA account, but its live-test configuration is not ready.

Memory prerequisites now also have 54 phased fixture cases, a whole-campaign
oracle (36 evaluator checks on fabricated inputs), 540 actual loopback HTTP
reads and separately journaled Testbox fixture-container checks. A wrapper
flock-inheritance defect and a long-probe boundary-position ambiguity were
corrected before any model invocation; original/corrected receipts remain
separate. Corrected container/kernel-lock checks pass with no owned runtime
residue. These sources and images remain outside `fcbd9e69`, which is unchanged.
They do not implement the actual common browser-profile reset or demonstrate
real multi-session learning/compaction/strategy improvement. See the memory
prerequisite result document for exact hashes, limits and remaining work.

- Integrate and freeze the new source inventory and image IDs; complete candidate
  T2 and T3 rather than combine results from incompatible snapshots.
- Verify connector credentials, validation/approval/idempotency/receipt boundaries
  and domain results on that candidate; document adapter limitations.
- Finish scoped-memory lifecycle and real multi-session campaigns, including
  the required memory-off paired arm and statistical safety evidence.
- Retain actual SDK prompt snapshot/cache/window/compaction findings; run paired
  measurements for any adopted context bounds. No new context strategy knob has
  been enabled by this repair.
- Complete the WhatsApp live journey when its account configuration is available.
- Reconcile candidate UX prerequisites and ADR/roadmap verification status in
  the final M3 matrix. Existing M2 retained failures/deferred visual checks remain
  separately visible.

Passing deterministic checks and writing executable acceptance tests do not
complete these outstanding gates. Stable Testbox services/data remain outside
the campaign scope.

The independent runtime memory prerequisite now also has an actual headed
Chromium/filesystem receipt on the frozen workspace image. After three retained
control failures, acknowledged CDP shutdown, whole `/home`/`/work`/`/profile`
restoration and recreation from the same image pass: prior-session data is
absent, while synthetic baseline login and manual rules survive. An ordinary
restart retains the prior-session data as a positive control. The passing unit
is terminal, 25 exact runtime identities across the four runs are independently
absent, and no model was called. See
`m3-memory-prerequisite-results-2026-10-02.md` for source/transfer bindings and
limits. This does not integrate actual Gateway/SDK sessions or accept a powered
retention strategy.

The retained failures also expose an immediate-stop durability follow-up for
production: newly acknowledged cookie/localStorage writes were lost through
the image's existing SIGTERM stop path, while other persistent stores survived.
The prerequisite's CDP shutdown correction does not repair `entry.sh`; do not
count it as a production regression fix or alter the frozen candidate silently.
Reproduce and repair this path on a separately bound candidate before claiming
durable ordinary shutdown.

The owner clarified that a WhatsApp account exists but its runtime configuration
is not prepared. Real channel send/receive acceptance remains unavailable; no
token/configuration was supplied. The separate eighteen-suite/two-context-probe
approval request is still pending and has not been inferred from that reply.

The production shutdown durability follow-up now has a separate repair receipt:
the TERM trap requests acknowledged Browser.close before bounded signal
fallback, and the normal DockerProvider destroy/recreate path preserves newly
written cookie/localStorage. The old image independently fails the same actual
read oracle; all 15 workspace-image T2 cases pass on the repaired image,
including a SIGSTOP fault and the existing restart/browser/desktop cases.
The affected 120 T0/T1 checks, local typecheck and lint pass. Both remote units
are terminal, 30 exact runtime identities independently absent, zero model calls.
See `m3-workspace-shutdown-results-2026-10-02.md`. This source is not the frozen
`fcbd9e69` image and still needs the broader candidate gates; no deployment or
real-model launch has occurred.

The final current-tree all-project T0/T1 gate is 2448/2448, zero failures/skips.
The earlier sandbox-denied local run is retained separately (2198 pass,
228 fail, 22 pending); adding the required loopback-listener permission, with
no source change, resolves it. The new 15-case T2 receipt covers the workspace
image suite only. It is not pooled with the old candidate's 86-case all-project
T2 receipt to claim a broader current-image pass.

The newer full `5b75f541` candidate regression has now finished. Remote
T0/T1 is 2447 pass / one chat-list ordering assertion failure; full T2 is
86 pass / one concurrent screenshot timeout failure / one opt-in SDK-shape
skip. All 15 workspace-image cases pass in this full run. The chat assertion
now deliberately exercises reverse list order while preserving ordered
members; the corrected local all-project T0/T1 gate is 2448/2448, and scenario
typecheck plus all 14 scenario tests pass. This local correction is not part
of the immutable failed remote receipt.

One separately bound screenshot observation on the same candidate/image passes
16 actual concurrent ordinary clicks and captures, with unchanged five-second
capture bound. It does not identify or fix the full-suite timeout. Both units
are terminal, and independent audits confirm 187 plus six exact resources
absent. No model calls or deployment occurred. The model approval request
remains pending and the owner still has no prepared WhatsApp configuration.
See `m3-candidate-testbox-results-2026-10-02-5b75f541.md` for bindings,
raw receipts and the retained failure; the full deterministic gate and M3
acceptance are not complete.


A separately frozen current integrated tree (`17cc1157`, 950 files) now passes
all deterministic gates on Testbox: backend/acceptance and Web typecheck,
lint, all workspace builds, 2458 T0/T1 (zero fail/skip), and one full two-worker
T2 invocation (88 pass, zero fail, one opt-in real-model SDK-shape skip).
All sixteen concurrent ordinary captures pass with unchanged bounds and no
capture tracing/experimental flags. All eighteen ledgers are saved and
integrity-checked; 172 exact owned resources are independently absent; the
systemd unit is terminal with MainPID 0. See
`m3-current-integrated-regression-results-2026-10-03.md` for source, compiled
image reuse and receipt bindings. The prior full screenshot timeout remains
an unresolved reliability observation; this current pass does not prove its
cause was fixed. Full M3 configured-model/provider/strategy requirements and
pending authorization/WABA configuration remain explicit in the matrix.


The selected adopted run-supervision browser journey now passes on the actual
rebuilt UI and SQLite Gateway with synthetic sidecars. A genuine late-snapshot
accounting regression fails before repair: terminal/newer-attempt usage is
replaced by older snapshot usage even though its newer run status is retained.
The reducer now retains coherent accounting and still merges historical events;
22 affected checks and full T0/T1 2460/2460 pass. Actual old/new UI reproduce and
repair the same held-response race. Failed/silent/queued/approval/continuation
states, continue/stop/allow-once, unknown measurements and process-versus-delivery
wording are checked. All synthetic attempts, the initial queue fixture mistake
and a transient locator timeout remain recorded. Both fixtures exit zero,
known listeners independently refuse connections, and temporary tabs close.
See `m3-run-supervision-browser-results-2026-10-03.md` for limits and bindings.
The previous frozen full T2 is unchanged; no new full T2 or real-model campaign
was invoked for this Web-only production change. Full M3 remains incomplete.

Selected UX-05 checks now use the actual built browser, production authenticated
Gateway and current real Colima container: inert/current text and bot-home CSV
previews, binary/UTF-8/size/missing/symlink feedback, unsupported-path treatment,
hide and stopped preview/download refusal pass. Independent server Markdown
and binary byte hashes match. A valid in-app Download event timed out and no
saved path was returned, so browser disk landing remains unknown; native access
reports a locked Mac and a manual-unlock request is pending. No product change
or model call was made. The fixture exits zero, all six exact owned Docker
identities are independently absent, 895 runtime inputs match and the temporary
tab/listener are closed. See `m3-file-browser-results-2026-10-03.md` for image,
source and receipt bindings. The owner confirms WABA exists but its configuration
is not prepared; live WhatsApp acceptance remains required. Full M3 is incomplete.

Selected canonical management checks now pass using a real pre-0019 file-backed
SQLite fixture and the actual built UI/Gateway. The 0019–0024 upgrade preserves
all original projections in 13 populated tables; an injected invalid reference
checks atomic 0020 rebuild rollback and restored FK enforcement. Delayed scripted
SOUL/MEMORY import reads cannot overwrite an intervening operator edit. Actual
browser checks cover offline/new-bot editing, draft navigation, two-editor
conflicts, the scoped parked guard, roster and an empty one-bot test chat. A real
UI defect mislabels unchanged-version parked/busy SOUL refusals as version
conflicts; it is repaired without weakening the guard. Two new tests fail before
and pass after, management checks 10/10 and full T0/T1 2462/2462 pass, with
Web/backend typecheck, lint and Web build passing. The rebuilt page displays the
actual parked refusal and retains the draft without reconciliation controls.
Its fixture exits zero, listeners/tabs close, FK/integrity checks pass and all
provider/SDK/model execution counts remain zero. Concurrent real bot startup
with import-before-execution is still a separate required check. See
`m3-management-browser-results-2026-10-03.md` for source/bundle/receipt bindings
and the distinction between scripted physical readers and actual runtime proof.
The frozen full T2 remains a separate earlier receipt; full M3 is incomplete.

The remaining selected concurrent legacy-startup prerequisite now passes on a
real current-image Colima workspace with the production Gateway/sidecar and
actual SDK against a scripted local upstream. Exactly two parallel task posts
produce two successful attempt-1 runs and distinct sessions. Both first main
SDK requests arrive together only after actual file-read results and canonical
SQLite values preserve all four historical files. Subsequent actual SDK Bash
reads and independent container reads match exact canonical files; raw operator
notes remain exact in SQLite. One benign peer MEMORY wrapper change observed
during startup is retained without actor attribution. One selected T2 invocation
passes with no skip; this is not a new full T2 or a real-model campaign. Its
ledger is saved and valid, runner PID is gone and all six exact owned Docker
identities are independently absent. Final typecheck/lint pass. See
`m3-legacy-concurrent-results-2026-10-03.md` for source/image/receipt bindings and
synthetic accounting. Full M3 configured-model/provider/strategy requirements
and pending authorization/WABA/browser-landing prerequisites remain incomplete.

Selected UX-02 mechanics now also pass with the actual current-container SDK
and two independent Gateway processes. One reserved three-task invocation
executes six physical attempts against a scripted local upstream: actual turn
exhaustion saves a handoff; SIGKILL/restart preserves the exact run/session and
approval, and continue completes attempt 2 without repeating its file write.
Stop consumes the parked decision without another SDK attempt. Two continues
followed by third exhaustion reach the declared failure cap, reject another
continue and preserve all attempt accounting. Prior tool results and the actual
budget warning appear in resumed upstream context. Independent closed-ledger
checks verify six matching request/usage rows and session totals, integrity/FK,
three original human messages and zero relay consumption by system notices.
All owned PIDs/listeners and six exact Docker identities are absent. Input hashes
match at termination; a later fixture-only input-default change for stronger
TypeScript flags is bound separately against the frozen dispatched child. No
production source changed, no full suite was rerun and real model calls are zero.
See `m3-sdk-continuation-results-2026-10-03.md`. Configured-model/delegator quality,
24-hour expiry, full memory/strategy coverage, WABA configuration and pending
model-campaign scope confirmation remain required; full M3 is incomplete.

A separate actual SDK/container/process probe now verifies active-tool crash
reconciliation, stale credential rejection on the replacement listener, and
expiry through both the operator route and actual minute sweep. One initial
SDK attempt is retained as a partial fixture failure: revoked token audit rows
were incorrectly expected to disappear. An unstarted inventory-path preflight
failure is retained separately. The corrected three-task/three-attempt invocation
passes, with the real timer settling injected expired eligibility in 34.724 seconds.
Both crash attempts preserve unknown final run usage; four scripted proxy request
records and the two delivered final usage rows remain separate. Independent
collector verifies both closed ledgers, revoked timestamps, exact run states,
all owned PIDs/ports and twelve absent exact Docker identities. The already
executing local tool completes after Gateway failure before the orphan SDK/sidecar
terminate: failed status and token revocation are not an immediate tool-cancel
guarantee. Current 983 inputs match and strict TypeScript passes; no production
source or real model campaign changed. See
`m3-sdk-interruption-results-2026-10-03.md`. Full M3 and configured-model/provider/
paired-strategy requirements remain incomplete.


Actual SDK automatic compaction now exposes and repairs two production archive
races: absent new-session transcript, and nonempty history whose latest tool
result append is still pending. The hook waits at most 1.55 seconds for the
sidecar-observed top-level tool-result UUID's complete JSON record; permission
errors and unresolved writes remain fail-open warnings. Six actual SDK/container
observations and all failures are retained; the final original fast task passes
with a correlated tool/result and exact pre-boundary prefix. No SDK/model/prompt/
strategy settings change and real model calls are zero. Four new unit regressions
fail before their repairs, with two additional bounded/error checks; updated runOnce integration, full T0/T1 2468/2468,
typecheck and lint pass. All 36 exact owned identities and runner groups are
independently absent; 983 runtime inputs per invocation match at termination.
Two new T2 files are added to the smoke classification. See
`m3-sdk-auto-compaction-results-2026-10-03.md` for image/source/archive bindings,
retained partial evidence and open streamed per-turn output-count fidelity.
A new frozen full Testbox T2 is required for the changed hook; old full gates
are not promoted. Full M3 and configured-model/provider/paired-strategy gates
remain incomplete, with the campaign scope confirmation and WABA preparation
still pending.


The new a786a38c frozen Testbox gate now passes all stages, including 2468
T0/T1 and 90 full T2 assertions with zero failures and one explicit opt-in
real-model skip. The changed workspace app layer is built offline on the same
cached base; all unaffected image inputs are verified before reuse. Exactly
one full T2 invocation runs with two workers and unchanged browser bounds.
Twenty ledgers are saved, integrity/FK-valid, 59 run and 47 synthetic usage rows
retained, and all 184 exact owned identities independently absent. The unit is
inactive/dead with MainPID 0 and exit 0. The automatic archive's original tool/
result bytes also pass independently on this new amd64 image. See
`m3-auto-compaction-integrated-gate-results-2026-10-03.md` for source/image/unit/
receipt bindings. A separately reserved one-turn actual local SDK partial-stream
probe confirms provisional assistant output 1 precedes final delta/result output
132, with one scripted messages POST and no real model. It prepares the next
per-turn fidelity repair; production has not adopted it. See
`m3-sdk-stream-usage-observation-2026-10-03.md`. Full M3 remains open and the
retained screenshot failure, provider/model prerequisites and ordered paired
strategy gates are not promoted by these observations.


The actual SDK provisional-output defect is now repaired in production. The
sidecar requests public partial events and correlates start/delta/stop per
response and parent stream, preserving absent/null measurements and unfinished
output as unknown. Six tracker regressions fail before and pass after; new
runOnce wiring and full T0/T1 2475/2475, typecheck and lint pass. Three actual
SDK/container observations are retained, including an initial fixture accessor
failure and a meaningful old-image failure. Final main turn outputs 26/59 match
independent proxy records; separate summarizer output 41 yields final run output
126, all synthetic. Automatic archive and memory-flush assertions still pass.
All eighteen exact identities and runner groups are independently absent, with
983 runtime inputs unchanged at termination. Actual operator API receipts feed
a zero-mismatch one-decision offline replay and before/after policy comparison;
its loader/IPC preflight errors are retained without model attempts. See
`m3-sdk-final-turn-usage-results-2026-10-03.md` for source/image/receipt bindings.
A new full frozen Testbox T2 is required for these production changes. Configured
model/provider fidelity, context/quality, ordered memory/strategy trials and
live WABA still remain open, and no real model campaign was launched.


The 3530ec94 frozen Testbox candidate now passes backend/acceptance and Web
typecheck, lint, builds, 2475 complete T0/T1 and 90 complete T2 assertions, zero
failures and one opt-in real-model SDK-shape skip. Its fresh amd64 workspace
image contains the final per-response repair. Exactly one full T2 invocation
uses the original browser bounds. The actual SDK main-turn ledger measurements
match proxy output 26/59 and all input/cache fields; separate compaction output
41 gives final synthetic run output 126. An independent raw-byte audit verifies
the twenty-record archive is the transcript's exact prefix and contains the
original successful tool/result pair. Twenty ledgers are valid, all 184 exact
owned identities absent, unit inactive/dead/MainPID 0, and all 963 frozen source
hashes match. The original offline replay stage fails before execution because
an external .ts helper is loaded as CJS. A separately recorded, identical .mts
copy passes one offline policy decision; original status/log remain unchanged,
and no SDK/model/task/T2 retry occurs. Future launch helpers use .mts. See
`m3-stream-usage-integrated-gate-results-2026-10-03.md` for all bindings and
retained launcher/audit preflights. Full M3, configured-model/ordered quality
trials and live WhatsApp remain open; WABA configuration and campaign scope
confirmation remain pending. No stable deployment or strategy knob changes.


A new selected actual SDK/container lifecycle test extends M3-06 mechanics on
unchanged production inputs. Its final five-query chain covers a trusted SDK
candidate, untrusted memory search/escaping, sticky taint across same-session
resume after human confirmation, human confirm/edit/undo, idempotent task closure,
background consolidation over genuinely mixed trust, gated fact approval and
imperative rejection, redacted forgetting and a clean fresh-session index/search.
All thirteen SDK queries/nineteen scripted messages requests across three
observations remain accounted, including an initial last-oracle failure and a
passing all-untrusted precursor that did not prove mixed trust. Independent
read-only ledger/provenance/usage checks pass; eighteen exact owned resources
and all three runner groups are absent, 984 inputs match at termination.
Ordinary assembled system prompts stay identical; across new SDK sessions only
the wire billing-header suffix differs. No cache benefit is inferred. Typecheck,
lint and full T0/T1 2475 pass, including new smoke classification. The existing
frozen full 90-pass gate remains revision-bound, not renamed as a full 91-test
run. See `m3-sdk-memory-lifecycle-results-2026-10-03.md`. No production repair,
model/strategy adoption or stable deployment occurs in this extension. SDK
restart and remaining full runtime/ordered quality coverage, model campaign
scope confirmation and live WABA preparation still remain open.


Selected actual SDK memory persistence now passes a separate three-Gateway
process chain: SIGKILL after a completed SDK run, production workspace restart
that recreates containers while preserving the same three volumes and exact
transcript/canonical file hashes, same-session resume with sticky taint despite
human source confirmation/edit, then task closure/three redacted tombstones and
graceful Gateway restart/fresh SDK search. Initial bodyless-JSON POST fixture
failure is retained; no production fix was needed. Four actual SDK attempts and
seven scripted messages POSTs across both observations are fully accounted,
zero real models, synthetic input 118117/output 394/cache 0/0, cost unknown.
Both databases pass integrity/FK checks; fifteen exact owned Docker identities,
both runner groups, all four Gateway PIDs and six listeners are independently
absent/closed. All 985 runtime inputs per invocation match at termination.
Standalone strict child/probe typecheck passes. See
`m3-sdk-memory-restart-results-2026-10-03.md`; previous frozen full T2 counts remain
unchanged. This closes selected restart mechanics, not full memory quality or M3.
Configured-model scope confirmation, ordered paired/poison trials, live WABA
configuration and native download verification remain open. The owner confirms
the WhatsApp account exists but its configuration is not ready.


The new frozen 42bab952 Testbox gate includes the lifecycle extension in one
full T2 invocation: 91 pass, zero fail, one opt-in actual configured-model
SDK-shape skip; full T0/T1 2475, both typechecks, lint, builds and direct .mts
offline replay pass. The existing final usage-repair amd64 image is reused
only after 216 relevant source files and freshly compiled runtime bytes match
the parent. All 967 frozen remote source hashes match, 21 saved ledgers pass
integrity/FK checks with 64 run/52 synthetic usage rows, and 190 exact owned
identities are independently absent. Actual SDK mixed-trust lifecycle and
automatic raw archive/turn-usage proofs pass independently on this invocation.
Systemd garbage-collects the finished transient unit; exact recorded PID/group
absence and InvocationID-bound journal records prove termination. Its native
exit status after collection remains unknown; command-level exits and suite
oracles pass. Two read-only polling preflights are retained with no T2/SDK retry.
See `m3-memory-integrated-gate-results-2026-10-03.md`. Later test-strategy prose
removes the obsolete Desktop VM gate per C41 and adds the current WhatsApp,
cost/context/memory mapping without changing runtime/test code. Full M3,
configured-model/paired/poison acceptance, WABA configuration and native download
landing remain open. No production/strategy/release change or real model call.

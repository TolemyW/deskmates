# M3 browser capture: actual runtime and diagnostic evidence

Date: 2026-10-02. Status: diagnostic evidence; M3 acceptance remains incomplete.
No commit, release, deployment, model call or browser strategy adoption.

## Source and image binding

These observations use the frozen 939-file candidate whose manifest SHA256 is
`5b75f5414c8688b705b0f9a80877f9b0e579e35ca243bb902d382cfa4e6d53fb`.
The production workspace image is
`sha256:c25d2707784381921e11569364770e132e7272baeb0bb3ca8d309b7a631f1061`.
The original candidate's failed full T2 gate is retained in
`m3-candidate-testbox-results-2026-10-02-5b75f541.md`.
Every observation retains its own inventory, hashes, original files, compiled
input binding and service identity. Only declared test/observer overlays differ.
No terminal campaign source or old result was rewritten.

## The tool's actual driver differs from its global package

Read-only inspection of the installed image establishes the following:

| Package | Direct installed pin | Driver resolved from that package |
| --- | --- | --- |
| Global Playwright | 1.58.2 | playwright/core 1.58.2 |
| Playwright MCP | 0.0.82 | playwright/core 1.64.0-alpha-1789764292000 |
| Playwright CLI | 0.1.21 | playwright/core 1.64.0-alpha-1789764292000 |

Both MCP and CLI declare that exact alpha dependency and resolve it. This is
not proof of installation drift or of the retained screenshot timeout's cause.
The global package chooses the Chromium executable shipped in the image;
MCP's core is bundled into `lib/coreBundle.js`. A depth-zero package listing
does not identify the implementation executing an MCP screenshot.

The existing workspace-image pin test now runs the metadata fixture from inside
the real image and checks declared and installed drivers from both tools.
It preserves all direct pin checks. The filtered remote T2 selection passed
one case with fourteen filtered cases, not fifteen accepted cases. Its unit is
`deskmates-runtime-pins-20261002-01.service`, invocation
`21d0bacd925c4cbdbf7b0fbbb5fa7b92`, under
`/home/owner/agent_workspace/deskmates-reusable-runtime-pins-20261002-01`.
Helper archive SHA256:
`7184fe75fef98c83022721821fa3e1dd3a0bd4a09dde03d6c4f4070a9a3daf7d`.
Affected sandbox T0/T1: 110 passed. Typecheck and lint passed.
No installed version or production launch argument was changed.

## One launch-flag hypothesis was not confirmed

Global Playwright's launch defaults include `CDPScreenshotNewSurface`; the
manual production launcher lacks it. One isolated experimental image added
only that flag. Four fixed trials per arm each performed foreground, background
and recovery captures of synthetic red/blue pages with target and decoded pixel
checks, retaining the same five-second bound.

Both current and experimental arms passed all twelve captures. Current-arm
background captures took about 67.6–76.8 ms; experimental captures 51.3–64.7 ms.
These pages did not require a fresh paint after the focus switch, and this
probe used global Playwright, not the actual MCP driver. The passing controls
do not discriminate the original failure or establish an improvement. The
experimental flag was not adopted.

The first preparation (`...capture-surface-20261002-01`) failed before any
browser arm because Docker interpreted a FROM image ID as a registry name;
metadata resolution returned 403. Nothing was uploaded to a registry and no
image was downloaded. The corrected preparation verified an existing tag's
exact image ID before building. Unit:
`deskmates-capture-surface-20261002-02.service`, invocation
`b6ee2d27744d4eef8ba25c206c2ddb84`; archive SHA256:
`1b70dbd8aa9a5b07a0eef5fc33ce9a24e120f347ae1ce68c978c7060bd287199`.
Both arm containers were removed by exact ID; the experimental image is retained.

## Actual MCP protocol observation and a QA teardown defect

The first method-level observer assumed unbundled modules and failed before
browser launch. That failed preload and its removal receipt remain retained.
The operative observer uses supported `pw:api`/`pw:protocol` diagnostics and
stdio boundaries. It changes no installed file or browser method and retains
only IDs, method names, timings, phase labels, response byte counts and version
metadata. Page text, URLs, image data and protocol payloads are not persisted.
A synthetic redaction-canary preflight passed; it is not a browser/model call.

One full T2 observation retained two workers, eight paired click rounds and
the five-second screenshot bound. It ran under
`/home/owner/agent_workspace/deskmates-reusable-capture-full-trace-20261002-01`,
unit `deskmates-capture-full-trace-20261002-01.service`, invocation
`2571c148e1914e8da1882a0394ce7377`; helper archive SHA256:
`d24db74327598d7e0eed92fb864618df8633986bc7a975605e75455d94f3c024`.

All **87 assertions passed**, one direct SDK call was skipped, but the command
exited **1** and JSON `success` was false. The knowledge file's afterAll hook
failed even though all four of its assertions passed. This is a failed campaign,
not a passing full gate. JSON-only reporting omitted the hook error text.

The observer's strict ledger injection called `backup` on the original Gateway
database handle. The knowledge restart test had already closed that handle,
opened the same SQLite file in a new Gateway, checked it and closed it again.
A native SQLite reproduction confirms that `backup` on a closed handle throws
`TypeError: The database connection is not open`. The QA injection, not a
business assertion, introduced this teardown failure. Seventeen other ledgers
were preserved; knowledge ledger coverage remains missing for that invocation.

The first browser case passed sixteen ordinary clicks, counters `[8,8]`,
captures `[8,8]` and all coordination checks. Two actual MCP traces contain
1,602 and 1,661 sanitized rows, with 23 capture requests, responses and CDP
screenshot calls. Metadata identifies the actual alpha MCP driver. The first
run restarted its proxy: capture IDs reset, so correlation must include PID.
The observer's latest-request field is only a timing association when requests
overlap. Logging and stdio observation may perturb timing. This pass neither
reproduces nor fixes the original full-T2 timeout.

Independent post-run inspection confirmed all 172 recorded resources absent;
the user unit is terminal with MainPID zero. A separate audit found all fourteen
runtime-inspection, preflight and version-test resources absent. No prefix
cleanup, image pruning or stable-deployment access was used.

## Ledger correction and new verification

`acceptance/support/ledger-backup.ts` now uses the original open handle or
reopens the source file read-only with `fileMustExist` after a restart test.
It uses SQLite's backup API so pending WAL rows are included, reserves a
private destination without replacing a receipt, and closes only a handle it
opened. Missing/partial evidence is explicitly unavailable, never zero usage.
`stopStack` preserves it after destroying owned containers and draining the
scheduler, before closing the Gateway and removing its temporary database.
Snapshot status is recorded separately so best-effort cleanup does not turn
an unavailable artifact into a passing evidence claim.

Nine local regressions passed, including WAL coverage, latest writes through a
restarted handle, existing-output preservation, missing-source behavior and
the complete stop-stack ordering. Full local T0/T1: **2,453 passed**, zero
failed/skipped. Typecheck and repository lint passed.

One infrastructure-corrected full T2 invocation was dispatched under
`/home/owner/agent_workspace/deskmates-reusable-capture-full-trace-20261002-02`,
unit `deskmates-capture-full-trace-20261002-02.service`, invocation
`5a7d5a50b11a4f47bc0d196cf7ca8f87`. Helper archive SHA256:
`56491195f3d48507416ce67c021beaa8357e660319c5690004a3d7d836cd2f5c`.
Its overlays disclose the corrected ledger helper and tests; all production
images and browser bounds remain the same. It also retains default-reporter
hook errors alongside JSON and checks all eighteen expected stack snapshots.
This invocation finished with **86 passed, 1 failed, 1 skipped**, exit 1,
JSON `success:false`. All four knowledge assertions and its teardown passed.
All eighteen expected ledger snapshots were saved; one used the reopened
read-only mode. The nine support regressions passed remotely as well. All
overlays reverified, the service is inactive/dead with MainPID zero, and
independent inspection confirmed all 172 recorded resources absent.

The original screenshot failure reproduced in the concurrent browser case.
For run `run_fbb72f36884a48058ec5b506a94565cf`, PID 322,
`deskmates-shot-8` took 5,002.593 ms to produce its response. Fonts loaded before
the request, and layout metrics returned in about 0.919 ms. CDP request 1205
(`Page.captureScreenshot`) was sent at 15:27:55.445 UTC and returned successfully
at 15:28:02.103 UTC, **6,658.255 ms** later. Its successful late protocol reply
does not repair the already skipped image at action 8. All 23 screenshot
protocol calls eventually returned. This narrows that observed failure to the
CDP screenshot request/reply interval; it was not a font wait or an unflushed
stdout write. Those log boundaries do not distinguish renderer/compositor work
from transport, load or client event-loop scheduling; they are not proof of
the underlying Chromium cause.
The original failed observation and this independent reproduced failure remain
separate from the passing ledger correction.

The subsequent fixed mechanism probe uses MCP's actual alpha Playwright driver,
two top-level windows and a fresh green repaint while the peer is foreground,
with red foreground and green recovery controls. It compares the same two
existing images, four fixed trials each, without rebuilding or changing the
production image. Five seconds remains the bound. Source and reservations are
under `spikes/m3-browser-capture-20261002/work-fresh-paint-01`; helper archive
SHA256 is `751737cb06a8e64deb9cc67726088b8b96d61d424e3efedcd853a68d7e6c19b3`.
Its remote root is
`/home/owner/agent_workspace/deskmates-reusable-capture-fresh-paint-20261002-01`,
unit `deskmates-capture-fresh-paint-20261002-01.service`, invocation
`2bdcf8fc383043e0b3d513439af5a1e1`. Both arms finished with twelve of twelve
captures passed, decoded red/green pixels correct. Both exact container IDs
independently inspect absent. This is a driver-mechanism diagnostic, not the
MCP server or an adopted strategy. It did not reproduce the full-T2 failure.

That serial probe did not exercise overlapping screenshots. A subsequent
predeclared mechanism probe adds simultaneous captures from both freshly
repainted targets, each immediately preceded by its own bringToFront, with
red foreground and green recovery controls. It reserves four fixed trials and
sixteen captures per arm, the same five-second limit, exact target and decoded
green/yellow pixel checks, and the same two image IDs. It changes no production
source. Remote root:
`/home/owner/agent_workspace/deskmates-reusable-capture-concurrent-paint-20261002-01`;
unit `deskmates-capture-concurrent-paint-20261002-01.service`; archive SHA256:
`9b42c35a3a70a5c756e54bcd9487d31b50da9aa56779af1223df2745851f7e4a`.
Invocation: `57b1e5ab392a465b82d6217b9e04d025`. Both arms finished with all
sixteen captures passed and decoded target pixels correct. Current concurrent
captures ranged about 55.6–91.6 ms; experimental captures 39.2–64.3 ms. Both
recorded container IDs independently inspect absent. This direct-driver probe
uses one CDP connection, unlike the full test's separate MCP connections; it
also runs without the second Vitest worker's competing workload. It therefore
does not reproduce or explain the full gate's wait. Those small diagnostic
samples are not a reliability or performance comparison for production.
Neither serial pass nor this concurrent pass removes either retained full-T2
failure. No browser argument, timeout or dependency override was adopted.

## Same-window and actual-MCP observations (2026-10-03 Taipei)

The actual browser case omits a screenSlot, so its fresh pages are two tabs in
one window. Earlier two-window mechanism probes did not cover that geometry.
`tab-capture-probe.mjs` checks distinct target IDs, equal Browser window IDs,
two independent alpha-driver CDP connections and persistent focus emulation.
Four fixed trials per arm contain a foreground red control, concurrent freshly
painted green/yellow captures after a fixed 500 ms preparation gap, and a green
recovery control. Both images passed all 16 captures with correct decoded pixels;
concurrent captures took approximately 43–104 ms. This probe lacks actual MCP
RPC and the competing image-test worker, and did not reproduce the failure.
Remote root `deskmates-reusable-capture-tabs-20261002-01` is under the authorized
Testbox workspace; service invocation `7d507df3d13943c08308105f7ab9225b`,
helper archive SHA256 `384441e76dce93f28ae2acd52973f8f9d8b950524af1b15d811d491bb26569ac`.
It is terminal; both exact container IDs independently inspect absent.

A separate fixed **current / new-surface / new-surface / current** sequence then
exercises the actual two-MCP browser case alongside all fifteen workspace-image
cases, with exactly two Vitest workers. Each invocation keeps the eight paired
click rounds, five-second screenshot limit, proxy restart, workspace takeover,
shared login and capture assertions. The two other browser cases are filtered,
not SDK skips. All four invocations finished exit 0: **16 pass / 0 fail / 2
filtered each**. One expected ledger was saved per invocation; support tests
passed, all 939 parent source hashes verified and declared overlays reverified.
The late screenshot telemetry now retains response isError and image-block counts,
and selected foreground/focus CDP method boundaries without payloads. Diagnostic
logging may perturb timing.

Remote root: `/home/owner/agent_workspace/deskmates-reusable-capture-pairs-20261002-01`;
unit `deskmates-capture-pairs-20261002-01.service`; invocation
`294ce3bfad814a70abb9bdc10f938f09`; helper archive SHA256
`d675dc29c745e76362e38b98b42b6d46954e6240f24dfbd8138b3ab3471dc843`.
The service is inactive/dead, MainPID zero. A post-run independent exact-ID
inspection confirms all **72** identities from the four trial cleanup receipts
absent. Selected receipt archive SHA256:
`0ed9307dddcbc93882a0ebb9e12213a7818ff6d326dbb0371ba00b3d26039f92`;
all downloaded file hashes match its inventory. Local raw records are under
`work-pairs-01/receipt`. Each trial's cleanup is audited separately: the top-level
empty cleanup list is not used as proof. The frozen runner's root status stayed
waiting_host_lock during its children; trial states/systemd, then terminal status,
are the evidence. The cosmetic status correction is local source only.

Both arms pass, so these observations do **not** establish that the extra
CDPScreenshotNewSurface argument repairs the retained full-suite failure.
No argument, capture timeout, lock policy or dependency override was adopted;
no production code is changed by these screenshot diagnostics. This filtered
sequence is not a new full T2 gate and not a result-selected retry of the failed
full run. All earlier failures and their ledgers remain retained.

## Remaining acceptance

Actual uninstrumented screenshot reliability remains unresolved. These
observations do not adopt a feature flag, change a timeout or substitute for
paired strategy evaluation. M3's domain/model/context/memory campaigns remain
unverified. Automatic approval review rejected the proposed larger real-model
campaign because the earlier limited campaign waiver did not establish its
scope; the explicit scope question remains unanswered. No model run was started.
The owner confirmed a WhatsApp account exists but its runtime configuration
is not prepared; the live journey remains pending.

Raw local receipts are in ignored `work-*` directories under
`spikes/m3-browser-capture-20261002`; remote ledgers remain private on Testbox.

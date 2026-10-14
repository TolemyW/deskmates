# Actual SDK continuation-day observation

Date: 2026-10-03 (Asia/Taipei). Status: actual SDK parking and Gateway process
restart verified; elapsed observation stopped on clock drift before natural
24-hour expiry. No real-model calls,
owner model-config read, production code change, deployment, commit or tag.
This is selected UX-02 runtime evidence, not complete M3 acceptance.

## Reserved sequence and retained correction

Earlier [interruption checks](m3-sdk-interruption-results-2026-10-03.md) prove
expired operator decisions/natural minute-sweep mechanics with injected eligibility.
This observation reserves one human task and one real SDK query against a
scripted loopback endpoint: one turn/120 seconds for the physical attempt.
Its sole Bash writes an owned marker; the normal Gateway parks that exhausted
run for 24 hours. No date is rewritten, timer kicked, Continue granted or task
reposted. After five real minutes it closes/reopens the Gateway process with
the same DB/ports, then waits for the natural minute sweep. Final success must
stop attempt 1 at or after the original expiry, settle its approval, retain
handoff/reason, spawn no SDK, and reject a subsequent Continue with 409.
That last check proves refusal after timer expiry, not which actor wins a race.

The service allows 89970 active seconds plus 30 seconds termination grace
(25 hours); sampling/sweep allow up to 120 seconds after expiry. Wall/monotonic
drift must stay below two seconds. All failures and partial coverage stay visible.
No configured-model handoff, delegation, quality, poison or paired gate is closed.

| Invocation | Evidence | SDK queries / real models |
| --- | --- | --- |
| work-remote-01, unit deskmates-sdk-continuation-clock-20261003-01, invocation d9c8f9b9c47d451f9de0632a0d6a2891 | Pre-start TypeError from optional null DNS-over-HTTPS configuration in Popen environment. No probe/Gateway/task started, PID 4112066 absent, no owned resources/ledgers, 967/1708 hashes unchanged. Original archive/status retained. | 0 / 0 |
| work-remote-02, unit deskmates-sdk-continuation-clock-20261003-02, invocation d9867b14bb434081b88ffe62246147e0 | Omit non-string optional env values. Explicit correction receipt proves only runner.py changes; child/probe/caps identical. Actual SDK parks and Gateway restarts; full elapsed expiry pending. | 1 / 0 |

Initial compile optional-env narrowing errors were corrected before invocation.
Final strict ES2022/NodeNext/noUncheckedIndexedAccess/exactOptionalPropertyTypes
checks pass; Biome produces byte-identical source. Compilation/pre-start failure
is not an SDK/model attempt. The zero-query infrastructure correction does not
select model results or repeat a task in an old ledger.

## Candidate and exact bindings

Parent: `/home/owner/agent_workspace/deskmates-reusable-memory-integrated-gate-20261003-42bab952`.
Manifest: `42bab952f411f34f993ee9d18ba2d74be6db482df2e13e1b2806d3c8fe4b748a`.
All 967 source/1708 compiled files check before execution and at termination;
package/support/dependency reuse is on-host. No credentials/.env/history transfer.
Startup heavy lock is released when the SDK parks, not held for a day.

Workspace: `sha256:81490be0a44d7a56f136f2572310d88621181d32bbf14cb6e0bd20453721181a`.
Egress: `sha256:d279fa358ec208ccd6f117538cc4b307288a53b4e0448a76d701e7c88c1d565d`.
Both independently inspect as amd64 before dispatch.

| Material | SHA256 |
| --- | --- |
| Initial archive | 09f0719306066f8543822273858e4f8ab60f10d2c675e775a853a21b0f5bb1de |
| Corrected archive | b7bdebac292e82868a2b8aa5557a95e9a8075f13480f885fb530012fa5a751ce |
| Child | 8d8bcabe14533d462c32b4b10666e8d16d2711cb643060e179f1e298665e7287 |
| Probe | 9e36b8ebe97d0a49deca31d4cc56cdf562369e172fd63b4c233af88b9b83e8db |
| Corrected runner | 8ab4af65fd56252b1adaa34597ec705fec00d2432c1354406cca93024f960ca0 |

## Actual SDK parking and restart

Run: `run_a6ac9966213f4317b52e2f0dcfbc9945`.
Session: `9d010f8f-8542-4170-80aa-aa24e9863b3e`.
One actual SDK query and one scripted main request are observed. The real
file route verifies `CONTINUATION_CLOCK_TOOL_FINISHED` plus final newline.
After physical exec completion, sanitized inspection of the exact owned
workspace finds SDK 0.3.278 and no SDK/sidecar process. State is
waiting_continuation, attempt 1, continuationCount=0, one pending approval,
zero active run credentials.

Independent consistent SQLite backup measures exactly **86400000 ms** between
continuation_requested and config expiry. Deadline:
**2026-10-03T23:18:40.044Z (2026-10-04 07:18:40.044 Taipei)**.
Parent first observes parked state at 2026-10-02T23:18:40.406Z.

At 23:25:01 UTC, exact service is active/running: MainPID 4113495, probe PID
4113535, restarted Gateway PID 4117981, all /proc command/parent identities
verified. Original Gateway PID 4113557 exits zero. The new process preserves
the same run/session/deadline/attempt/pending approval, dispatches no sidecar,
and has no active run token. Full day has not elapsed; this proves persistence.

Two snapshots pass integrity/FKs and dispatched-source hashes; sandbox SDK
rechecks as 0.3.278 with no SDK/sidecar process. Maximum observed wall/monotonic
drift is 0.639 ms. Proxy and final attempt usage agree: input **16653**, output
**24**, cache read/create **0/0**, cost **null**. These are synthetic endpoint
quantities, not vendor billing or configured-cache findings. Missing usage
remains unknown. Private receipts: `spikes/m3-sdk-continuation-clock-20261003/work-remote-02/`.

| Capture | Audit SHA256 | Archive SHA256 |
| --- | --- | --- |
| 01 before restart | 5bbb876add8d86f9e85aea337ad2d92b072b4e9a7269b283328ad078979501d2 | cb52978e51b7048f965fef8b3fee25e04403d23b271e60a14379595aaba882da |
| 02 after restart | d3c878c8bbbcd6985cd2eeafe9b4798ccf5ff0e1be9fa26a51451f5f5c06326c | 73033c9fffe18cf3187492b1e3939dcc9e163d36f8d2fb491dfe99d23bc7df01 |

## Resource and verdict boundary

Root: `/home/owner/agent_workspace/deskmates-reusable-sdk-continuation-clock-20261003-02`.
One isolated workspace/proxy with journaled IDs, separate DB/ports/stub and no
stable-service changes. Docker inspection excludes Env/Cmd; cleanup uses exact
IDs, preserves shared outbound, other services/images/cache, and never selects
by prefix. No owner model config, Always rule, real endpoint or deployment.

Final verdict needs actual expiry and system:expiry reason, attempt/session/SDK
counts, refusal, ledger/source/runtime parity, independent exact PID/group/
listener/resource absence. If unit is garbage-collected, native exit status
is unknown; default zero is not success. Neither this observation nor its
restart authorizes the pending eighteen-suite/two-probe real-model campaign
or supplies WABA configuration. M3 stays incomplete.

Read-only `loginctl show-user owner --property=Linger` confirms **Linger=yes**.
The server user manager can retain these detached services after SSH/logout;
the initiating workstation need not remain connected. This establishes the
execution arrangement, not successful expiry or complete acceptance.

At 2026-10-02T23:56:04.702807Z, capture 04 independently rechecks all 967 source
and 1708 compiled hashes, the original invocation, live process parents/start
ticks/group, both Gateway ports and the scripted upstream port. All six exact
journal resources remain present as expected. The original Gateway is absent;
the current workspace has no SDK/sidecar process, the ledger has zero active
run tokens and only one physical SDK query. Integrity/FKs and source bindings
pass. Terminal checks are explicitly null/pending; live ExecMainStatus=0 is
recorded as an unknown native exit, never a successful completed service.
The collector helper was added without changing or restarting the live fixture.
Its terminal branch has not yet executed against the genuine expiry outcome.
Capture 03 retains the preceding helper version and live observations.

| Capture 04 material | SHA256 |
| --- | --- |
| Audit | 9fe354c1a9bc4410299f755dd3e4b9ef6929743840c966ef78c9859eea8489fe |
| Archive | 45eb8131f75e4cd46f4e75f7f35434ec31986d69f085958204766c6ec342dfd6 |
| Shared collector helper | 2223d4a8de2bf5dfbce3006a3c14f5193fcbf975c37ff29536d34d71ddbf4010 |

## Live status correction at 2026-10-03 18:42 Taipei

Read-only polling of the exact original invocation at
2026-10-03T10:42:09.663349Z reports the unit and runner failed. The probe stopped
with `clock drift -2677.7334409989417ms prevents valid elapsed observation`,
exceeding the declared two-second wall/monotonic tolerance. The runner finished
at 2026-10-03T05:43:18Z (13:43:18 Taipei), about 6 hours 25 minutes after startup.
The natural expiry boundary was not reached or verified. This is failed/partial
elapsed-time evidence, not evidence that the product's expiry behavior failed.
The clock adjustment's cause is not established by this poll.

The last frame retains attempt 1 in waiting_continuation, one pending approval,
zero active run tokens and one physical SDK query. Both Gateway exits are
recorded as zero; independent /proc polling finds runner, probe and Gateway
absent. The runner reports 967 source/1708 compiled postflight checks and its
listed SQLite snapshots have integrity ok and zero FK violations. Exact Docker
resource/listener cleanup and a fresh terminal ledger audit have not been
independently recollected in this status check. No task was reposted, service
restarted or replacement observation launched. Local poll receipts are retained
under the original work-remote-02 directory. Full 24-hour evidence and M3
acceptance remain open; real-model calls remain zero.

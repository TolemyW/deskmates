# Workspace shutdown durability repair — 2026-10-02

This repairs the production shutdown gap found by the independent learned-memory
runtime prerequisite. It does not complete M3 or deploy a release. The old
`fcbd9e69` source/images and all earlier outcomes remain preserved. No real
model, existing workspace, stable service, commit, tag or deployment is involved.

## Problem and change

The previous workspace TERM trap sent SIGTERM directly to Chromium and exited
zero. In the memory prerequisite, immediately acknowledged cookie/localStorage
writes could disappear after stopping and recreating the container, although
IndexedDB/cache/service worker data survived. Exit zero was not a flush oracle.

The production entry now runs the shipped dependency-free
`images/workspace/close-browser.mjs`. It discovers only the loopback browser
endpoint, validates its loopback websocket/port/browser target and sends
`Browser.close`. A protocol error, disconnect without acknowledgement or
unresponsive discovery/socket is failure, not a successful flush. Discovery and
acknowledgement share a four-second limit; the helper exits after settling so
an unclosed network handle cannot prolong container shutdown.

After requesting graceful close, the entry waits at most two seconds for its
own Chromium PID. If it remains live, TERM gets another 1.5 seconds, then KILL
reaps that exact process. Deliberate shutdown still exits zero. This fits the
provider's ten-second stop window; unavailable/stuck-browser fallback does not
promise pending-write durability. Unexpected Chromium death still exits nonzero
and preserves the existing restart behavior. No driver/strategy knob changes.

The helper is copied by the normal workspace Dockerfile. The separate fixture
`browser-persistence-check.mjs` runs the image's preinstalled Playwright against
that same Chromium and a synthetic localhost page. It writes an expiring cookie
and localStorage value and returns immediately; there is no sleep to make
SIGTERM look durable. The production DockerProvider then destroys/recreates the
workspace with the same three persistent volumes, and the fixture reads again.

## Evidence and retained failures

The new T0 helper suite passes ten checks without a real process/network: exact
close request/acknowledgement, unexpected endpoint rejection, protocol error,
premature disconnect, and bounded unresponsive HTTP/websocket paths. The affected
sandbox package's 110 existing T0/T1 checks also pass. Together, the isolated
remote affected gate is **120 passed**, zero failures. Local all-project
typecheck and lint pass; shell and helper syntax checks pass. The final local
all-project T0/T1 run is **2448 passed**, zero failures/skips, in
`spikes/m3-closeout-20261002/work-local/shutdown-t01-full-loopback.json`.

An earlier local full run omitted the sandbox permission needed for loopback
listeners. Its retained report is `shutdown-t01-full.json`: 2198 pass, 228 fail,
22 pending. Of the failed cases, 194 explicitly report `listen EPERM` and 34
have a framework stack error after setup failures. That is not a verified code
regression or a passing gate. After granting the test invocation its required
network permission, the unchanged source passes all 2448. Neither run enables
real-model tests; the original failure is not deleted or pooled with success.

The remote candidate uses the original verified 931-file business source plus
seven explicit file replacements/additions, yielding 934 unique files. The old
remote test directory has a ledger-preservation modification to
`acceptance/support/stop-stack.ts`; the new clone uses its independently
hash-verified saved original. The old directory is never rewritten. Every
candidate file hash is verified before build, after build and after tests.
Existing Linux dependencies are reused on-host; none are transferred. The normal
offline workspace build uses the previously verified pinned base, creates a
content-addressed tag and does not move shared aliases.

| Unit suffix | Outcome |
| --- | --- |
| `6e49a5b5` | Build/120 affected checks pass. The old image fails the final persistence assertion, but Vitest's JSON message abbreviates the actual fields, so the runner refuses to grade that as a verified positive control. The repaired-image stage is uninvoked; this failed control-verification receipt is retained. |
| `d6eb8c12` | The test now includes the actual readonly result in its diagnostic. The old image fails with `cookie:null` and the correct localStorage value. This is an observed cookie durability failure, not proof that every stop loses both stores. The repaired image then passes all 15 workspace-image T2 checks. |

Full unit names are `deskmates-m3-shutdown-20261002-<suffix>.service`; directories
are `/home/owner/agent_workspace/deskmates-reusable-m3-shutdown-20261002-<suffix>`.
The first invocation is `7a5625fd683640ccb0f5be86dc59ed17`; the passing one is
`dee557877dec4f349c0cf87fda0d9cc5`. Both are terminal with `MainPID=0`; the latter
is `inactive/dead`, `Result=success`. The Python parent keeps the heavy-test
flock while child stages and cleanup run; it never execs away the lock holder.
Units are bounded at 900 seconds plus a 90-second stop allowance.

The passing **15-case workspace T2 suite** covers the persistence regression,
Chromium paused with SIGSTOP so graceful close and TERM cannot work, and the
existing desktop/readiness/one-browser/MCP/CLI/pins/crash-restart/stale-lock cases.
The paused-browser case asserts that DockerProvider destroy finishes in less
than nine seconds. Its whole test takes about 19.4 seconds because it also
recreates the healthy workspace; that duration is not the shutdown duration.
The final persistence case proves both values equal the just-written synthetic
nonce after ordinary destroy/recreate. No special host CDP shutdown substitutes
for the production TERM trap in these T2 cases.

Independent SSH reinspection finds all **30 exact runtime identities** across
the two units absent and the heavy-test lock available. Missing-resource error
signatures are distinguished from daemon/permission/timeout failures. Shared
provider infrastructure and build images are preserved; no prefix cleanup or
prune occurs. Raw reports/logs are retained under
`spikes/m3-closeout-20261002/work-local/shutdown-container-01` and `-02`; the last
includes `independent-audit.json`. The failed ungraded control is not pooled into
the passing source binding, and there are zero real-model retries/calls.

## Bindings and limits

| Passing binding | SHA256 |
| --- | --- |
| Transfer inventory | `d6eb8c12138a98a42f90e2f5a12957f07153c7d7807b9ad022b6b5a49ee72ea9` |
| Transfer archive | `eef16178a680a39a15ee9e2d13847aab57785b7898057a1a61b69aa2613bfc0b` |
| 934-file candidate manifest | `44e53cf3b07b7e23c37bb623ea387e4743bae0b438c7dd23ec20de90014a457f` |
| `entry.sh` | `2157a4e6fb777dbd8818275af35230683ce027780de05627c9b3f9d6da80ffb5` |
| `close-browser.mjs` | `416daa44d538c1b86af9be56b24b4b30b0a3a7f439b2cc75d993d4fdf76ac480` |
| Production Dockerfile | `3cb1c1c7459b08f5ac240cfafe30b030b1bcbbf19542beb2436d7294ed753630` |
| Workspace-image T2 file | `7fbe78cbf17ccf7b491a0d198a98fded7ef9909cec0287d719546c1c68373c3a` |

Workspace image:
`sha256:946e926326fa00f251d40be4e6167317d8c1293a2f3dd26987ae663811e69585`,
tag `deskmates/workspace:amd64-417be92d9696`.
Pinned base:
`sha256:bffdc561d23361c6d199f62981b7543cc55f476bc28ef505da16207f700a61f5`.
Egress image:
`sha256:d279fa358ec208ccd6f117538cc4b307288a53b4e0448a76d701e7c88c1d565d`.

This is a focused production regression pass. The old all-project 86-pass T2
receipt belongs to `fcbd9e69`, not this repaired image. Complete all-project T2,
updated final-image domain prerequisites and a newly frozen full handoff before
using the repaired image as the next M3 candidate. The prepared old model-only
runner remains hard-pinned to the old source/images and unlaunched; its old
approval scope cannot be silently reported as a test of this image. Real model,
WhatsApp and combined learned-memory campaigns remain incomplete.

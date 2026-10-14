# M3 actual SDK memory across Gateway and workspace restart

Date: 2026-10-03 Asia/Taipei. Selected persistence checks pass; full M3 remains
open. Real Gateway processes, SQLite, Docker workspace and SDK 0.3.278; local
scripted upstream only. No production change, strategy change, commit or stable
deployment. This supplements the lifecycle T2 and synthetic-sidecar OS restart
checks; neither predecessor is relabeled as this observation.

## Bound and protocol

One invocation reserves three actual SDK logical/physical queries, maxTurns 4,
120 seconds per attempt, and a 540-second outer deadline. Its successful chain
takes 19.63 seconds. The Gateway is killed only after the first SDK sidecar has
completed, so this is persisted-state recovery, not active-tool interruption.

| Phase | Actual operation | Checked result |
| --- | --- | --- |
| A | SDK memory_search reads one explicitly seeded untrusted page-derived fixture; returns workspace/task facts claiming trusted | Search result enters real SDK context; learned facts are untrusted; session taint persisted |
| Human edit | Authenticated operator confirms seed v1 to v2, edits the measured value to 42 at v3 | Trusted human source, body and all versions captured before shutdown |
| Gateway crash | SIGKILL Gateway A, start Gateway B on the same database and ports | Entries, versions and session/taint exactly match; no new sidecar starts at boot |
| Workspace restart | Authenticated production workspace restart route destroys/recreates the owned workspace and proxy | Container identity changes; the same three home/profile/work named volumes remain; transcript, SOUL and MEMORY file hashes match before any SDK resume |
| Resume | New human message in original thread runs the actual SDK with the original session ID | Fresh context contains the human-edited memory and prior untrusted search history; request carries sessionTainted; newly learned workspace fact is stamped untrusted |
| Close and forget | Close task notes into an episode, forget seed and both workspace facts | Episode retains untrusted provenance; three tombstones and every prior version body redacted |
| Graceful restart | Stop B normally, start Gateway C on same database and ports | Entries, versions, original SDK session and taint again exactly match |
| Fresh | New thread starts another actual SDK session and searches seed | First context excludes forgotten facts and task note; search has no match; fresh session is not tainted |

The seed is an explicit page-derived fixture insertion, not an actual browser
page acquisition in this test. All model replies and facts are scripted. The
resume still contains historical untrusted content despite human confirmation
of its source; confirmation must not clear sticky session taint. Forget does not
erase an existing SDK transcript, diary/export or old ledger.

## Retained fixture failure

work-01 completes one SDK search run, then the test helper sends a bodyless
confirmation POST with Content-Type application/json. Fastify correctly rejects
it with 400, before confirmation or either restart. The original source,
receipt, successful run, synthetic usage and failure remain retained. The
helper now adds JSON Content-Type only when a body exists. No production change
or model strategy change results; corrected work-02 uses a new isolated database,
workspace and session and completes the reserved three-query chain.

Initial standalone TypeScript narrowing errors in the child snapshot are also
retained in local preflight logs. Copying validated listener ports to numeric
constants fixes the fixture before either invocation. The final standalone
child/probe strict typecheck passes. No casts or runtime dependency changes.

## Accounting and independent audit

Both observations count: **four actual SDK logical/physical attempts, seven
scripted messages POSTs, zero real-model calls**. Every run succeeds at attempt 1.

| Observation | SDK attempts | Messages POSTs | Synthetic input | Synthetic output | Cache read/create |
| --- | --- | --- | --- | --- | --- |
| work-01, retained HTTP fixture failure | 1 | 2 | 33550 | 127 | 0/0 |
| work-02, complete restart chain | 3 | 5 | 84567 | 267 | 0/0 |
| Total | 4 | 7 | 118117 | 394 | 0/0 |

For every run, SDK final usage matches independently persisted proxy sums in
all four token fields. Cost is unknown/null for the fake model. Do not infer
real context usage, cache behavior or memory quality from these synthetic counts.

Successful work-02:

- Search: `run_641667401cc24e579993110de3d314ba`.
- Resume: `run_85e1293317ae4ea6a2bf020ea2cc2b8f`.
- Original/resumed session: `7207b2ab-92cc-4126-9ca2-2922360871fd`.
- Fresh: `run_fc1361b27d244c62acef95c5013d3231`, session
  `6407cf81-8165-443d-8706-3bd516983338`.
- Gateway processes: 38944 (SIGKILL), 39003 and 39057 (normal exit 0).
- Transcript: 113696 bytes, SHA-256
  `34972dadfc70bfe9904afbc74363cc1b92f6bb0176251a98d51364a87b9a0af0`,
  identical before/after container recreation. These are captured in-container
  hashes at those checkpoints; the transcript itself is not exported here.

Read-only integrity/FK checks pass for both closed databases. Independently
checked all fifteen exact Docker identities absent, both runner PIDs/groups
(38638, 38939), all four Gateway PIDs, and each invocation's three listeners
closed. No prefix cleanup, shared outbound network deletion or stable touch.

Workspace image:
`sha256:0e35564b70f87800f99750bd5d3637d35cc5e910aadd17307763e59c1a89f4ff`.
Egress image:
`sha256:625ee0e145b3299366d8fc7ff45bf95853d806ab8f39f2e5d4d66b3d123a319f`.
Reuse requires exact parent source/compiled hashes; all 985 runtime inputs stay
unchanged at each invocation's termination. Only the initial helper/runner
corrections differ later, and the original copies remain bound to their inputs.

Final bindings:

- Probe source: `983c45eea286dd720a04829fcc81dd5944118ab7abc174beb48c9aa0f104451c`.
- Child source: `ba20cc70591c1efd43d00a5725088167ab0791dda7f99f1c2940e7dbf3c188f5`.
- Input inventory: `49c0fee3a9a25693bf7f784e61f26992443479eece5f41d85dc1eadd0181010e`.
- Receipt: `9f67b4fa6f23d8527d51e207037e751966ff147bd9c3ca29a70be04ae83877a6`.
- Closed database: `03702b5e3ff3ddeff40f1881bbcd6764f29c50740fbd4af874595f3886446552`.
- Independent two-observation audit:
  `fe42875ce827396bb3a99d4878bf3f0baea127b1606b1f3ce47a415615086626`.

Repository lint and whitespace checks also pass. No production input changed;
the existing 2475-pass T0/T1 receipt retains its earlier revision binding and
is not presented as a new test invocation for this spike.

## Remaining scope

This adds selected actual-SDK memory persistence and resume coverage without
changing the previous frozen full Testbox gate or its 90-test count. The later
lifecycle T2 is separately measured; no new full-suite run is claimed here.
Configured-model memory protocol, ordered five-session retention/poison trials,
powered paired strategy acceptance and broader runtime coverage remain open.
Real quiet/cooldown duration is not measured here. Live WhatsApp remains required;
the owner has an account but configuration is not ready. The expanded real-model
campaign has not launched and its scope confirmation remains pending.

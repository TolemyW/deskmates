# M3 memory process restart and crash recovery

Date: 2026-10-03 (Asia/Taipei). Selected no-model state-machine check passes
locally and on Testbox. Full M3 remains open. No production code, threshold,
model strategy, release tag or deployment changed. Stable services are untouched.

## Why this check

Existing durable consolidation tests reconstruct a service or close/reopen a
Gateway database in one test process. They do not prove OS-process exit or
startup reconciliation after SIGKILL. The new spike runs the actual Gateway
startup, scheduler, memory stores and authenticated HTTP routes in six different
child processes sharing one isolated file database. A synthetic provider supplies
sidecar completions; it does not run the SDK or a model.

## Reserved sequence and observations

| Phase | Operation | Observed invariant |
| --- | --- | --- |
| A | Complete a human-thread run with nine bot candidates and a task note; close the task through the operator route; gracefully exit | Nine candidates and one episode persist; no consolidation; the thread remains usable in B |
| B | Restart; produce the tenth candidate through another run; hold an ordinary background run; arrange historical quiet timestamps; enqueue automatic consolidation; SIGKILL | Recent interactive work initially suppresses consolidation. After fixture quiet eligibility, exactly one consolidation is queued with eleven source IDs: ten candidates and one episode |
| C | Restart and hold the resumed queued consolidation; SIGKILL | Ordinary interrupted blocker becomes failed. The exact saved consolidation run ID starts once, with no replacement row |
| D | Restart and inspect; gracefully exit | Interrupted consolidation becomes failed with the Gateway restart reason. No new exec occurs inside cooldown; all ten raw candidates remain unconsumed |
| E | Restart; explicitly request manual consolidation through the operator route, release synthetic completion and gracefully exit | One new consolidation succeeds. Exactly one bot note has the scripted fact, the full eleven-source provenance and consumption markers on all ten candidates |
| F | Restart and inspect; gracefully exit | Exact memory entries persist unchanged; both consolidation rows remain (failed original and successful manual); no new exec occurs |

Both successful observations have six distinct Gateway PIDs, two expected
SIGKILL exits, four graceful exits and five synthetic sidecar executions. Five
run rows remain: two silent ordinary source runs, the failed blocker, the failed
automatic consolidation and the successful manual consolidation. Final memory
has thirteen entries, retaining raw candidates, the closed task note, its episode
and the resulting bot note. Empty synthetic usage does not measure token spend.
The Gateway model-request counter is zero in every frame.

Quiet eligibility deliberately changes only the two owned source runs'
`finished_at` fields to eleven minutes earlier. Real process restarts/crashes
are used; elapsed quiet time is not measured. The production policy remains
3 episodes / 10 candidates / 10 quiet minutes / 24-hour cooldown. The existing
deterministic boundary tests cover exact quiet/cooldown edges separately.

## Local evidence and retained fixture failure

Local corrected `spikes/m3-memory-process-20261003/work-02/receipt.json` SHA-256:
`309c5609fa6aace30ba738d293bec0f4185f713e371de863037df9601a3cc5a1`.
The earlier `work-01` exits nonzero after A: the child called `process.exit`
before its large terminal stdout frame finished writing, truncating JSON at
8192 bytes. No later phase started. Original sources, partial receipt and
failure audit are retained. The child now awaits its output callback before
exiting, and the controller catches malformed frames for bounded cleanup.
Read-only PID inspection confirms that first child is absent. This was a fixture
repair, not a production defect or a suppressed failed model trial.

Strict standalone TypeScript checking passes for both probe files. Remote
preparer Python syntax validation and `git diff --check` pass. No full T0/T1
repeat was needed for this spike-only addition; the latest project result remains
2458 passing tests from the preceding schedule repair.

## Testbox binding and termination

Remote isolated root:
`/home/owner/agent_workspace/deskmates-reusable-memory-process-20261003-01`.
Unit: `deskmates-memory-process-20261003-01.service`.
Launch invocation: `8f236259831f44d3957ec4a39356b003`.
Uploaded helper archive SHA-256:
`7fb40f4ac9bd91c1311146b91a38d01bbbd122bb5cd13ff55fc90337e8700f9f`.

The helper manifest lists only package metadata, two probe files and the runtime
input hash inventory. It reuses on-host packages/dependencies from the frozen
5b75f541 candidate's `src` directory, after verifying **176 source and compiled
contract inputs** equal the current local inputs. All 176 are reverified after
the test. The initial audit incorrectly addressed the enclosing parent directory;
its missing-file result is retained, and the corrected source-root audit passes.
This is current Gateway/contract parity, not a claim that the frozen candidate's
Web bundle contains the later UI repairs.

Probe source SHA-256 values:

- `child.ts`: `9056e5f1bb13a31b03643d6bb752590166be59e6c8711beca4130ac8f2a6b683`.
- `probe.ts`: `60c4963f8dc3e6d4eeff4336a0005122988bf8715edfc9bb3ccefc3b53d40518`.

Remote automatic consolidation `run_6aade7a43498477e9af29e477ec553ee` remains
failed; manual consolidation `run_4db5343b67ad4d93a943a7da4256a178` succeeds.
Terminal receipt SHA-256:
`955116197497f7ff1e8b3ac04fdcb4e3f73bff98a1e17c0739beeed2356e2942`.
Selected receipt archive SHA-256:
`3f0ae3bbc04aecd6b89c9ced22ed7b75a666be5cdfdadfaaf312c2e78c971609`.
The downloaded selected receipts and per-file hashes are independently verified
under local `work-remote-01/receipt`; the private remote database is not downloaded.

Systemd reports inactive/dead, MainPID 0, ExecMainStatus 0. All six exact owned
Gateway PIDs independently inspect absent in `/proc`. No Docker resources were
created, and no cleanup selects services by name prefix. The unit has a
300-second runtime bound; its shared heavy-test lock wait is capped at 90 seconds.

## Acceptance limits

This verifies persisted threshold/quiet guard, queue identity, live-run failure
reconciliation, failed-attempt cooldown, operator task closure/manual merge and
result provenance across actual OS processes. Faults are placed at declared
queued/running checkpoints, not at arbitrary SQLite transaction boundaries.

Candidate trust and the merged fact are scripted; this does not prove sidecar
taint, learned-content correctness, model consolidation quality or retention
benefit. Docker workspace/SDK session recovery, real timed quiet/cooldown windows,
mixed-trust confirmation/forget flows, complete memory protocol and powered
ordered paired/poison trials remain separate gates. It is not a new full T2 or
configured-model acceptance result. The larger real-model campaign is still
unlaunched and live WABA configuration remains unavailable.

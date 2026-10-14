# M2 six-hour unattended stability observation

Status: campaign completed; 13/18 suites passed, five failed. This document is
the launch receipt. Results and retained failure details are recorded in
`m2-six-hour-soak-results-2026-09-25.md`; full M2 acceptance remains open.

The owner requested a six-hour script on Testbox that continues without an active Codex conversation, with report review in a later task. This authorizes a fixed observation campaign despite the retained earlier X02 smoke failure. It does not authorize replacing failed samples or changing their oracles. Visual-model tests remain deferred.

## Running campaign

- Host: SSH alias `testbox`; user systemd with `Linger=yes`.
- Unit: `deskmates-m2-soak-20260925-0135.service`.
- Actual start: **2026-09-25 01:31:39 Asia/Taipei** (`2026-09-24T17:31:39.094Z`).
- Scheduled finish: **2026-09-25 07:31:39 Asia/Taipei** (`2026-09-24T23:31:39.094Z`).
- Checkout: `/home/owner/agent_workspace/deskmates-b4-native-20260924-1418`.
- Output: `/home/owner/agent_workspace/deskmates-b4-native-20260924-1418/spikes/m2-soak/work-20260925-0135`.
- Report: output directory's `REPORT.md`; structured details in `status.json`, `manifest.json`, and each `slot-NN-suite/summary.json` plus `evidence/`.
- Config: checkout's `spikes/m2-soak/work-config-20260925-0135/config.json`; contains image IDs and the existing remote ignored environment-file path, no credential values.

A separate SSH connection confirmed the unit `active/running`, main PID 4006588, first foundation child PID 4006638, and one workspace ownership receipt. The service has `Restart=no`, `KillMode=mixed`, `RuntimeMaxSec=21720` (six hours plus two minutes), `TimeoutStopSec=120`, private output permissions, and an `ExecStopPost` recovery finalizer. The supervisor itself schedules the normal stop at six hours and limits the last test window to 05:59 elapsed. The systemd watchdog is fallback protection, not extra model-test time. Closing SSH or Codex does not stop the user service. No scheduled Codex automation or recurring notification was created.

Startup validation at 01:33 Asia/Taipei confirmed that the first scheduled
foundation slot completed with all four cases passing and its owned resources
cleaned. Three resource samples had been written with zero observer errors;
the service remained active, waiting for its next scheduled slot. This first
sample is not the final six-hour result. No further supervision is needed from
the launching conversation.

## Fixed scope and interpretation

Eighteen slots start at 20-minute intervals, alternating nine foundation and nine X02/X03 ticket suite samples. Foundation runs one repetition/four cases per slot; tickets run one repetition/two scenarios with solo/concurrent controls. Fresh isolated stacks are used. This samples reliability throughout six hours; it does not test one persistent browser/workspace for six hours, and it does not exercise sustained maximum load.

Runtime, model, prompts and strategy are frozen: existing `glm-5.3` configuration, `tab-v1`, `explicit-v1`, baseline ticket completion contract, ticket 300-second run limit/35 turns, foundation 180-second run limit/eight turns. A 19-minute host suite watchdog prevents a hung suite from consuming the next slot. An interrupted suite remains interrupted, even if some writes succeeded. Failed, missing and interrupted results remain in the report. There is no retry-until-pass, image rebuild, K5 acceptance declaration or paired reliability-improvement claim.

Images remain the previously built native candidates:

- Workspace: `deskmates/workspace:m2-live-native-resume-20260924-1418`, ID `sha256:48a13e7c64b65825afdc22abffa784f380a7bf4ccc38c2212a222f92f6600fc9`.
- Egress: `deskmates/egress-proxy:testbox-b4-20260924-1418`, ID `sha256:4f94b80448088c3eb3c79762b161d6dc90925f0d5839f71dc15db05147391a0f`.
- Host target: existing native override `172.22.0.1`. Public-site DNS/B4 is not retested by this campaign.

The Git snapshot is `45724d73df42d929cae05ebbdfe6a77b5859034a` plus explicitly recorded host-side test changes. Its relationship to local main and the prior source archive is documented in `m2-resume-model-results-2026-09-24.md`. `manifest.json` records 589 source hashes and the dirty state. The supervisor stops if a recorded source file or image tag changes.

## Harness changes and verification

New scripts: `spikes/m2-soak/core.mjs`, `run.mjs`, and `core.test.mjs`. Usage and evidence interpretation are in their README. `acceptance/support/start-stack.ts` now optionally appends a workspace ID to `DESKMATES_SOAK_JOURNAL` before provisioning. Without that environment variable the fixture behavior is unchanged. This is host-side test bookkeeping; production code and runtime images are unchanged.

Cleanup uses only journaled workspace IDs, matching managed Docker labels, and their three exact named volumes. It never prunes the daemon or removes the shared outbound network. A checkout-wide lock prevents overlapping campaigns. Source/image drift, cleanup failure or less than 5 GiB free disk ends the campaign with an explicit reason. Every 30 seconds it records host/container resource data and a selected, payload-free run/event-count snapshot from the current fixture database; it never exports the database. Known secret values and Bearer strings are scrubbed from text evidence after each slot.

Verification before launch:

- Six offline script tests passed locally and on Testbox: schedule accounting, ownership validation, verdict preservation, redaction, hard timeout, and explicit stop.
- Local and native typecheck passed; the affected fixture passed Biome.
- Native existing failure-evidence regression tests passed 3/3.
- Native finalizer self-test passed: a uniquely labeled stopped container, internal network and named volume were removed; simulated unfinished slots became interrupted/skipped, not passed. No model call was used for this self-test.
- Local and remote SHA-256 matched for `core.mjs` (`fe66fbb7fded077b8feedf7b539e7fbcbedccc911a5a1646da889abf8f2b3372`), `run.mjs` (`9cb9a940c81ae53c1ed94c7880315b8e4ece2c841d4174fcdb906c825b52bd6b`), and the fixture (`b302376fc4dfecf4617824d58f9714a68946f1c5e54853537fbe42d4e0367ff2`).

## Later review handoff

In a later task, connect to Testbox and read the output's `REPORT.md` and `status.json`. Check the last heartbeat/service state before claiming completion. `status=completed` means the scheduled campaign ended, not that tests passed. Inspect canonical and strict results separately, particularly the known X02 `browser_tabs(close)` lock-wait invariant whose tab ownership was previously ambiguous. Retain earlier failed samples when comparing observations. Copy sanitized summaries locally if needed and append actual results to a new results document.

To stop early, run `systemctl --user stop deskmates-m2-soak-20260925-0135.service` on Testbox. This preserves an incomplete campaign and runs owned-resource cleanup. Do not delete the campaign lock or restart into the same output without checking the previous service and owned resources first. A host reboot is not automatically resumed; it remains an interrupted observation.

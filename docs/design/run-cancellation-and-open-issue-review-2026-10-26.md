# Run cancellation and open issue review — 2026-10-26

## Scope and baseline

The owner requested descendant cleanup regressions and a review of all ten open
issues. The source baseline is main `5fe540c` (PR #83 merged). The review does not
promote merged source to deployed or live-provider acceptance, and does not restart
the retired long-running campaign or a paid strategy campaign.

## Descendant cleanup

The former environment-marker scan misses detached descendants after `env -i`.
The replacement puts `deskmates-sidecar run` under a Linux child subreaper,
retains adopted descendants after double forks, and drains/reaps them on run exit
or cancellation. The provider waits for the supervisor and reports a cleanup
failure instead of confirming a kill. Docker stream failures also request cleanup.
Pidfds prevent recycled process identifiers from becoming kill targets. Shared
filesystem, network, browser and user remain unchanged; this is lifecycle
management rather than per-bot isolation. ADR-0029 records the limitations.

The real-Docker regression uses the production shim and a controlled child in
place of an SDK/model. The original shim fails both detached-child cancellation
cases because the child remains in `/proc`; the candidate passes. The fixture
also checks double forks, environment reset, ignored SIGTERM, nested subreapers,
normal-exit cleanup, stdin/output/exit status, timeout, abort, restart cleanup
from a new provider, another run's survival, the image-installed shim, and a real
Chromium process outside the run's ancestry. A fresh candidate workspace image
was built offline from the existing pinned base; the test checks the installed
supervisor bytes against source. No model or provider account was used.

Local Docker became unresponsive during the initial T2 attempt; those failures
are not passes. The final T2 runs use a separate authorized test directory and
exact test-owned containers on the test host. Stable services and their data are
not touched. Older workspace images keep best-effort marker cleanup and need an
image upgrade to gain supervision.

## Open issue disposition

| Issue | Independently checked this review | Disposition / unmet requirement |
|---|---|---|
| #1 WhatsApp | Adapter/command/server regression coverage and the existing failed-phone-pairing receipt | Keep open: real phone link, inbound/reply, restart/relink/disconnect and WABA acceptance are not established. No account reset or new phone pairing was attempted. |
| #3 Long-horizon findings/roadmap | Source implementation and retained evidence; remaining gates were already tracked in #33, #62, #69 and #70 | Consolidate the historical umbrella into those trackers and close as duplicate, with an explicit carry-over list in #33. This is not a long-horizon reliability pass. |
| #33 Consolidated acceptance | Historical receipts, current source and executable tests reconciled; receives the complete #3/#39 carry-over | Keep open as the acceptance ledger: real-model, restart/upgrade, provider-account, visual/statistical and owner gates remain. |
| #39 Prompt/runtime probe | Identity/role and neutral fallback coverage, output-example counterexample, Skill-loader coverage and existing probe receipt | Close as duplicate after moving remaining efficiency/strategy experiments and loopback policy decision to #33. The probe is complete; its proposed improvements are not all accepted or implemented. |
| #40 Skills | Seven-entry manifest and passing OpenAI Skill load/refusal tests | Keep open: expanded skill set, per-role defaults, image scope, owner decisions and paired trigger-rate/quality evaluation remain. The OpenAI Skill tool already exists. |
| #41 Bot/team templates | Current guide and source expose dynamic creation, not the proposed versioned template catalog | Keep open: catalog/role/team defaults and owner choices remain; onboarding is not equivalent to templates. |
| #62 Tool guards | Focused replay/classifier/redaction/directory-guard/OpenAI-runtime/broker/drain/restart suite: 10 files, 820 tests passed | Keep open: duplicate pending approval cards and the single-approval `parkForPlatform` payload remain. T0/T1 is not a deployed H3/M7 acceptance pass. |
| #69 Goal-first automation | Existing deterministic Phase 1 coverage and the October 22 bounded journey receipt | Keep open: end-to-end reuse-first work, decision cards, recurring occurrence acceptance, memory closure provenance and paired effectiveness measurements remain. |
| #70 Self-test gaps | A fresh deterministic counterexample: `{type:"string",enum:[1,"valid"]}` is accepted, but `exampleOutput` returns `1` and fails `outputErrors` | Keep open: invalid examples are still a real defect; TLS/login, creation IDs, fallback availability, summary deadlines and autonomous capped delivery retain their separate limits. |
| #82 Telegram menu/commands | Transport source/tests still contain no menu synchronization or deterministic Deskmates command dispatcher | Keep open: implementation and real phone-visible command/menu acceptance remain; connection tests do not prove them. |

## Carry-over retained in #33

- #3 A/B: unattended approvals and cap recovery, parked cron notices, refusal and
  handoff evidence, shared-workspace/lane behavior, creation with SOUL and file
  ownership. Implemented paths retain their focused runtime acceptance where
  not already recorded; no old unchecked historical row becomes a blanket pass.
- #3 C/D/E: visual capability, governed search and Vault/credential semantics;
  drain/restart, interrupted tool effects and complete usage; cross-run progress
  and scoped run statistics; task stage gates/templates and the maintained
  long-horizon harness. Real missions/restarts, tagged upgrades, behavioral and
  statistical comparisons remain uncompleted gates.
- #39 1/2/3/6: upstream cache-affinity answer and per-role tool-surface profiling;
  navigate-with-excerpt/browser-read comparison; reply-envelope redesign and
  leakage measurement; explicit loopback policy reconciliation. Each strategy
  comparison needs the prescribed paired protocol, not a single observation.
- #39 7/8/9: group-round overhead/quality comparisons and model-job/summary
  deadline reliability remain #33/#70; per-role Skills and templates remain
  #40/#41. Existing role and tool-contract fixes do not close these experiments.
- PR #83 is merged source for delivery-state/idempotency/pagination, checkpoint
  scope, output snapshots, denial reasons and Discord recovery. Independent
  deployed acceptance of that candidate is not manufactured from old campaign
  reports, which ran the earlier baseline.

Administrative consolidation closes two duplicate umbrellas only. No outstanding
feature, owner decision, real-account journey or model/strategy gate is waived.

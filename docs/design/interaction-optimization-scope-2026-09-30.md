# Interaction optimization: remaining work that can ship together

Date: 2026-09-30
Status: proposed scope, not an accepted architecture change or implementation authorization
Source baseline: main at `1b15bc7`

Follow-up: the owner subsequently authorized three-agent development with unit
tests only. Implemented scope, deviations and outstanding acceptance are recorded
in the [implementation handoff](../runbooks/interaction-optimization-test-handoff-2026-09-30.md).
The proposal below remains the original scope assessment.

This crosswalk extends [the interaction review](product-interaction-review-2026-09-30.md).
It compares the architecture roadmap, ADRs 0011–0016, the M3 context/memory plan,
and actual contracts, routes and Web callers. Document status alone is not a
development inventory: ADRs 0012–0014 still say Proposed while substantial code
exists. The older M3 plan also describes components that have since shipped.
Live deployment was not reverified; this is a source-level scope assessment.

## Recommended core scope

| Bundle | Remaining backlog and actual state | Deliverable in this optimization | Dependencies and limits |
|---|---|---|---|
| Bot configuration | ADR-0011 A5 canonical SOUL/MEMORY delivery is absent; current editing requires a running, idle workspace | Bot details with authoritative instructions, draft/effective versions, offline configuration, explicit next-run/session behavior and a bounded test entry point | Implement A5 with migration and modification detection. Resolve the existing manual MEMORY file versus learned export contract. Display Role must not silently become executable instructions. Pause/archive/duplicate need explicit lifecycle rules; A5 alone does not provide them. |
| Run intervention and delegation | ADR-0016 continuation states and hooks are absent | Warn before exhaustion; preserve handoff; show who needs to decide; continue/stop the same logical run with attempt accounting; notify the delegator when work ends unsuccessfully | Settle the Proposed ADR before implementation. Retain two-continuation cap, expiry and thread serialization. This covers turn exhaustion only; arbitrary mid-run cancellation, steering, deadline recovery and task ownership need separate decisions. |
| Memory management | Base stores, search, versions, consolidation service and task-close route exist; A1–A4 and the user-facing closure/inspection loop are incomplete | Close a task into an episode; inspect sources and versions; correct/forget with accurate consequences; expose manual and automatic consolidation; show included/omitted memory and reasons | Implement A2 filtering before enabling A1 automation. A3 prompt rendering and consolidation behavior are strategy changes requiring paired evaluation. Never imply forgetting erases existing SDK history or that all deletion is undoable. |
| Run supervision | Per-turn context metrics and `/api/runs/:id/context` exist; no Web inspector consumes them | One readable activity/detail view for progress, wait reason, approvals, context use, compaction, token/cost coverage, attempts and result references | Reuse ledger/API. Unknown usage stays unknown. Replace misleading recovered labels. Task delivery/verification must remain distinct from process success; a persistent task entity needs an ADR. |

These four bundles address the same user journey: configure a bot, assign work,
understand what it is doing, intervene when needed, receive a result and retain
useful experience. Their UI should be designed together, but implementation and
release gates should remain separable.

## Useful additions with bounded scope

| Addition | Reusable implementation | Suggested boundary |
|---|---|---|
| Schedule management in Bot details | Cron runner, parser, next-fire helper and bot cron PATCH already exist | Add create/edit, clear timezone, next occurrence and recent results. Current entries contain only schedule/prompt, are identified by array index and use the Gateway timezone. Persistent pause, stable schedule identity, per-schedule timezone and run-now are backend work, not merely a form. Decide that small contract first. |
| Deliverable access in conversations | ADR-0014 download route and path links already exist; preview was explicitly deferred | Add a safe result card and a narrow preview path. Amend the current ASCII-only path policy before supporting Chinese/spaced filenames; avoid linking a valid prefix of an invalid full filename. Frozen file versions, larger attachments and uploads are separate storage/contract work. |
| Existing integration onboarding | ADR-0012 database connector and ADR-0013 integration runtime exist | Finish configuration, connection-test feedback, missing prerequisites and action-result receipts in the Bot capabilities screen. Verify through the production connector path. Real OAuth checks require registered provider apps; Slack integration actions do not implement the Slack chat channel. |

Schedule management and result access are good candidates after the core flow is
stable. Integration fixes that block the existing flow belong in this batch;
adding more providers does not.

## Conditional or deferred work

- **ADR-0015 Skills:** a valuable follow-on to Bot capabilities. A first slice
  can include human installation, hash pinning, scanning, assignment, immutable
  versions, SDK delivery and actual-use events. It still needs the SDK T2 proof
  and all relevant safety/versioning rules. Automated authoring depends on
  consolidation, closed episodes and quality evidence; automatic promotion and
  a marketplace should not gate this interaction release. Staging delivery is
  not a reversal of the ADR's intended agent-authored skills support.
- **Shared work board:** the spike is not a production task system. Define the
  smallest task owner/state/deliverable contract and its thread/run relationship
  before porting anything. Start with visible delegation and continuation in
  this batch; retain spike evidence without treating it as milestone acceptance.
- **Context optimization:** show current measurements now. Actual model-window
  calibration, observation masking, result offload, session rotation and changed
  retrieval budgets remain separately measured experiments, one knob at a time.
- **Cost alerts:** accurate cost/unknown-usage display fits run supervision.
  Threshold notifications, enforced budgets and external delivery are additional
  behavior and should not be claimed complete by a new dashboard.
- **Slack/Telegram channels, scenario images and Desktop VM:** channels remain
  empty; these broaden the execution/deployment surface. Defer them. Desktop VM
  was explicitly removed from M3 on 2026-09-29 and is unscheduled.
- **Browser lock granularity and default group wake policy:** unresolved design
  decisions, not cosmetic fixes. Show recipients and waits now; changing routing
  or lock semantics requires an ADR and real multi-bot measurements.

## Delivery order and acceptance

1. Reconcile the backlog into implemented / incomplete user flow / unimplemented
   / awaiting real-environment acceptance. Make test prerequisites explicit:
   skipped Docker/model/provider checks cannot count as passing acceptance.
2. Settle contracts for canonical bot configuration, continuation and task
   closure. Implement configuration, run supervision and intervention first.
3. Finish memory inspection and filtering, then enable measured consolidation.
   Add schedule and result-access slices only with their own completed gates.
4. Validate the complete user journeys below on a pinned, isolated environment
   with the same image/configuration paths intended for release. Keep the stable
   deployment and its data separate from tests.

Required acceptance journeys:

- Configure a bot while its workspace is stopped; start it; verify the exact
  effective instructions and configuration version, including session behavior.
- Delegate in a group, exhaust turns deliberately, see the delegator notified,
  continue the same run, stop or expire it, and reconcile every attempt's usage.
- Surface failed, silent, queued, approval-waiting and browser-waiting work
  accurately; an unrelated later success must not relabel an earlier failure.
- Close a task, inspect its episode, consolidate eligible evidence, reject
  transient failures, and explain which memory the next run actually receives.
- Correct/forget memory and show both durable-store effects and existing-session
  limitations; verify versions and workspace boundaries.
- Retrieve and, if included, preview a real deliverable with supported filenames;
  report stopped-workspace, unavailable-file and size-limit states accurately.
- If schedules are included, test real firing, timezone display, overlap skips
  and the defined pause/resume semantics, with visible outcomes.

Use T0/T1 for deterministic contracts, T2 for SDK/container and browser paths,
and targeted real-model journeys for behavior. Strategy changes additionally
need paired evaluation; one successful demonstration is insufficient. Reuse the
retained M2 chief-delegation failures as regressions. Deferred S09/S10 acceptance
and the remaining M2 failures stay explicit; this scope does not declare M2 done.

## Verification of this assessment

This change adds planning documentation only. No production files were changed,
and no new tests, model runs, deployment or commits were performed for this
crosswalk. Earlier review checks are documented in the linked interaction review.
The pre-existing modified memory research document was preserved.

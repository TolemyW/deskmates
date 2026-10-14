# M2 business acceptance batch

Starting revision: `b9b035b`, isolated branch `codex/m2-foundation-20260922`.
The user approved three parallel Sol-medium subagents for the next batch. No
changes, deployment, or restart of the active main application are included.

| Owner | Scope | Owned files |
| --- | --- | --- |
| Golden-site subagent | Ticket seed/list/search/detail, comment/reassign/label operations required by X02/X03; bounded monthly report UI/export; meaningful HTTP/state tests | `packages/golden-site/**` |
| Group subagent | Chief/expert round trip, parallel group mentions and browser tabs, silent members, new-member history; deterministic hostile relay/budget checks | New `acceptance/m2-chief*`, `m2-group*` and group-specific helpers/spikes |
| Takeover subagent | Two real SDK bots, existing MFA page, operator takeover, wait evidence, screenshot suppression and handback completion | New `acceptance/m2-takeover*` and takeover spike helpers |
| Integrator | Shared interface review, fixture-version alignment, old-oracle compatibility, web UI QA, isolated configured-model runner, production fixes if proved necessary, combined tests and report | Shared support only when needed, root metadata, integration and documentation |

All subagents use `gpt-5.6-sol`, medium reasoning. File ownership is disjoint in
the same isolated checkout; no subagent commits or starts Docker/model workloads
until coordinated by the integrator. The integrator handles shared edits and
records actual source/image versions for runs.

## Acceptance boundaries

- Golden-site ticket operations mutate individual server fields, preserving a
  concurrent comment and reassignment. Existing checkout/login behavior remains.
- The benchmark has conflicting statements about ticket 1007: its seed row says
  open/zhang, while M02 explicitly permits only 1012, 1024 and 1036 to change.
  Preserve the executable M02 oracle, keep 1007 open/support with another assignee,
  and record a dated clarification rather than silently changing the benchmark.
- Site content changes require synchronized package, task-set and image versions.
  Baseline results from site 1.1.0 are historical, not paired controls for 1.2.0.
- Chief coalescing follows ADR-0005: replies arriving on different sides of a run
  boundary can legitimately cause two chief wakes. Test queued coalescing with a
  deterministic barrier; do not call timing-dependent duplicate wakes a defect.
- MFA uses the existing `/mfa` page. Only the operator test helper receives the
  fixed code. Verify waiting and screenshot suppression using actual ledger/SSE,
  not merely final replies. UI typing may be simulated through the shared browser;
  document that limit rather than claiming a human manually completed the test.
- Persist real-model failures and raw trace evidence. Do not relax oracles or tune
  production SOUL/context to turn a single sample green. Broad strategy or budget
  superiority still requires the measurement protocol.
- UI checks use a separate Gateway/database and browser tab. Scripted model/provider
  UI fixtures establish rendering/API/SSE behavior, not model quality.
- B4 isolation, B5 knowledge/vision/CLI, and resource retention remain outside this
  batch. Full M2 and X02/X03 K=5 acceptance are not inferred from site unit tests.

## Verification sequence

1. Implement and review each bounded component; validate affected unit tests/types.
2. Align fixture versions and impacted historical smoke oracles without erasing
   old results. Run full T0/T1, backend/web types, lint and web build.
3. Run deterministic real SDK/browser container tests against a dedicated image.
4. Run configured-model chief/group/MFA scenarios through isolated stacks and
   record run IDs, image/source/test digests, site version and failures.
5. Inspect the actual operator group UI, collect evidence, clean up only this
   batch's resources, and commit the results separately from code.

## Batch status (2026-09-23)

Implementation and runtime regression work are complete in the isolated worktree.
The batch also corrected automatic snapshot delivery and persistent focus emulation
after acceptance exposed reproducible browser defects. Local tests pass (1004),
as do the final five browser/SDK regression cases. Chief and X03 configured-model
acceptance pass; group silence, MFA exact answer format, and X02 strict tool checks
remain open. This is partial strict acceptance, not completion of B3 or full M2.

See [the results and preserved failure evidence](m2-business-acceptance-results-2026-09-23.md).
K=5 interference calibration and the explicitly excluded later batches remain open.

# Diagnostic follow-up acceptance — 2026-10-26

## Scope and decision

The owner requested independent acceptance of the remaining diagnostic findings and a
batched repair of confirmed problems. This change extends PR #83; it does not merge,
release or deploy it, restart the earlier diagnostic campaign, or call a real model.

| Finding | Acceptance | Result |
|---|---|---|
| Checkpoint progress loses its task scope | Real TaskStore tests reproduce missing attribution; continuation rendering reproduces treating old evidence as current | Stamp the scope, reject stale sidecar checkpoints, show old/unknown scopes as historical in the UI and continuation, exclude them from current criteria progress |
| Omitted output erases a schema-less task result; previous delivery outputs disappear | Real TaskStore regression fails before the change; disk SQLite reopen checks snapshot persistence and unknown historical rows | Omission preserves current output, explicit null clears it, and new deliveries retain a structured-output snapshot |
| Parked denial drops the human explanation | Real Gateway/fake-sidecar HTTP regression fails before the change for both active and paused threads | Use the same denial formatter as the live approval response, preserving actor and expiry handling |
| Permanent refusal after a successful Discord chunk loses recovery state | Scripted provider/runtime regression fails before the change | Keep the prefix ids and pending tail, expose partial delivery, retry only on explicit Reconnect; automatic restore does not retry a permanent refusal |
| Concurrent Discord replacement can orphan a session | Deterministically gated state-load regression fails before the change; ordinary simultaneous reconnects can converge | Serialize each connection's lifecycle, reject late opening of retired objects, test pending-open stop and disconnect cleanup |
| An approval resumes existing work in a paused thread | ADR-0005 decision 27 explicitly allows it; the Gateway regression preserves the paused state while resuming the parked run | Not a defect; preserve the documented behavior |
| Environment-scrubbed detached child survives cancellation scan | Confirmed in a real isolated local Alpine container with network disabled using the provider's marker-scan script | Remaining limitation, not fixed: cleanup is best effort and cannot guarantee termination of arbitrary children; README corrected; no broad shared-workspace kill added |

## Regression evidence

The original production modules fail four initial regressions: output retention,
checkpoint attribution, partial-send recovery and a replacement retired during state load.
The original approval/context modules additionally fail the parked-reason and stale-checkpoint
rendering regressions. Tests use actual stores, routes and the Discord runtime with the
repository's test doubles; there are no live Discord or real-SDK acceptance claims.

The added fields survive the sidecar stdin parser. A stale checkpoint cannot add a progress
row. Legacy checkpoint scope remains unknown and a historical delivery without an output
snapshot stays unknown, never reconstructed from the current result. Task schemas retain
their existing required-output validation. UI output is inert text.

Combining these repairs with PR #83 exposed another boundary: omission and explicit null
must have different delivery retry fingerprints. The integrated regression verifies that
an explicit clear is not replayed as an earlier output-preserving delivery. Existing
late-delivery, complete-listing and retry regressions remain in the same PR.

The private lab record titled **Diagnostic follow-up cancellation probe, 2026-10-26**
contains the isolated-container receipt. Only that owned container was removed afterward.
No production database, shared container, real provider account or model was used.

## Gates

- Typecheck, Biome lint, documentation consistency and Web production build: passed.
- Full T0/T1 suite: **903 files, 8,446 tests passed**, using `npm test -- --maxWorkers=2`.
- Discord runtime: 30 tests passed, including the final partial-send diagnostic wording.
- The first full run found two no-reason approval compatibility differences. The change was
  narrowed to forward a reason only when one exists; the complete suite was rerun and passed.
- The operator UI exposes provider recovery messages on connected accounts beside Reconnect;
  its regression and the inert task-result/history regression passed.
- Main was refreshed before publication and remains the base revision
  `0dd48692a4ff281b54ff943681c81a7e01eb4eac`.

A green local suite does not substitute for branch CI or live provider/model acceptance.
No model-quality, live-provider, deployment or milestone gate is promoted to passed.

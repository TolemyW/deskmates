# Interaction optimization: implementation and test handoff

Date: 2026-09-30
Status: prepared for local implementation commits at the owner's request; not deployed or accepted
Baseline: main at `1b15bc7`

The owner requested three GPT-6 Sol agents at Medium effort, with targeted unit
tests only. A coordinating agent integrated their shared contracts and reviewed
the boundaries. End-to-end testing will be assigned separately by the owner.
The owner requested local commits after verification. There is no release tag,
deployment or claim of milestone acceptance.

## Implemented scope

- **Bot management:** searchable roster and selected-bot details, display-role
  versus instruction explanation, instruction readiness/version, ordinary test
  conversation entry, and schedules with the Gateway timezone and next fire.
  Schedule drafts survive switching bots in the authenticated client.
- **Canonical configuration:** migration 0019 adds nullable canonical SOUL and
  legacy manual-memory storage. Existing files are imported before use, rather
  than overwritten with empty defaults. Imported/new configuration is editable
  offline. Edits retain optimistic version checks and the target bot's active
  or parked work blocks instruction changes; other bots need not be idle.
  Runs receive canonical files, restore them before context assembly, and record
  rule-file change observations. Peer observations are not actor attribution or
  a security boundary. Legacy operator notes are preserved in generated exports.
- **Conversations and runs:** recipient/wake explanations, unknown-mention
  feedback, reading-position preservation, accurate failed-run history, and
  explicit continuation approvals. Turn exhaustion retains the session and
  partial handoff, permits at most two continuations, and has a 24-hour decision
  window. Each attempt retains its own usage. Ordinary Always approvals require
  review of the effective matching scope.
- **Run supervision:** readable state explanations, continuation controls,
  context-window/cache/compaction measurements, pinned-memory inclusion and
  exclusion receipts, and rule-file change diagnostics. An older attempt's
  response cannot overwrite a newer attempt in the UI. Process success is not
  presented as verified task delivery; missing measurements remain unknown.
- **Memory:** source/version inspection, search, explicit permanent-forget
  consequences, optimistic edit conflicts, task-note closure and manual
  consolidation. Automatic consolidation uses episode/candidate counters,
  workspace quiet time and a cooldown. Transient-error provenance and a
  deterministic classifier prevent specified do-not-learn items. Index entries
  show dated observations and whole-entry omission counts.
- **Files:** authenticated current-file downloads now have bounded inert UTF-8
  text previews for selected extensions, hide controls and recoverable errors.
  Quoted paths containing spaces no longer link a misleading valid prefix.

## Verification boundary

Targeted unit/component tests and static TypeScript/format checks were used.
There were accidental test-selection deviations, retained here rather than
reported as a clean unit-only execution:

- The Bot agent invoked `packages/gateway/src/api/memory-routes.test.ts`
  (one case passed) and `config-routes.test.ts` (three cases blocked by the
  sandbox's localhost-listen restriction).
- The Memory agent invoked `packages/gateway/src/memory/consolidation.test.ts`
  and `index.test.ts`; both hit the localhost-listen restriction before their
  cases executed. Neither was retried with expanded permissions.

No whole-repository test suite, Docker/container test, browser walkthrough,
real-model campaign or end-to-end acceptance was run in this development task.
Earlier full-suite results in the assessment predate these changes and do not
validate this working tree. Typechecking acceptance sources does not execute
their tests.

Targeted passing tests are recorded in the completion receipt below. Model
strategy efficacy remains **UNVALIDATED**: filtering, dated rendering,
consolidation and SOUL-aware contradiction checks need paired evaluation before
being called an improvement.

## Required follow-up verification

1. **Upgrade and restart:** apply both migrations to an isolated copy of a
   populated pre-change database. Preserve runs, attempts, approvals, events,
   browser waiters, transcripts and memory versions. Check foreign keys and
   rollback behavior. Migration 0020 rebuilds constrained tables with foreign
   keys temporarily disabled outside its transaction and checked before commit.
2. **Legacy configuration:** preserve old SOUL/manual MEMORY bytes on first use;
   stopped unmigrated workspaces must explain why import is unavailable. Verify
   new/imported bots edit offline, two editors conflict cleanly, and parked
   continuation sessions block incompatible edits. Start two workspace bots
   concurrently and verify import precedes model execution.
3. **Canonical run files:** verify exact file/prompt versions, own and peer
   mutations, missing files, redacted diagnostics and restoration on the next
   appropriate run. Test with a real shell and SDK. Rule-file audits must not
   discard usage if reading a changed file fails.
4. **Continuation:** use a small turn limit. Check the warning, real SDK
   PostToolUse context delivery, partial handoff, saved session, delegator-only
   wake, human inbox, continue/stop/expiry and the third-exhaustion terminal
   notice. Cover ordinary threads and background runs without threads. Include
   restart, double decisions and a decision arriving as the old process exits.
5. **Accounting and routing:** reconcile physical-attempt usage with run totals;
   system continuation messages must not consume relay/turn caps. A parked run
   holds its bot/thread session while unrelated work can proceed. A decision
   from the generic approval endpoint or bot tool must obey the same limits.
6. **Memory lifecycle:** close notes only at the defined safe point, preserve the
   usable conversation, inspect the episode, trigger consolidation exactly once,
   and verify cooldown/quiet-window behavior across restarts and failed attempts.
   No cross-workspace results; skipped learning has a visible reason. Error
   provenance must survive a physical-attempt resume.
7. **Memory interaction:** switch workspaces during slow responses; no old
   entries, versions or task selection may mutate the new workspace. Edit with
   two clients; preserve the losing draft. Confirm permanent redaction and
   explain that existing SDK history may still contain previously supplied text.
8. **Schedules:** test timezone and next-fire agreement, real cron firing,
   overlap skips, editing/removal and draft retention. There is no new persisted
   pause state or run-now contract in this slice.
9. **Conversation and preview:** preserve scroll position while reading, show
   recipients before sending, verify unknown mentions do not silently change
   routing, test Always scope confirmation and reconnect races. Preview must
   never execute HTML; verify binary/invalid UTF-8/oversize/missing/stopped states
   and current-byte download behavior with a real container.
10. **Quality evaluation:** retain the existing M2 chief-delegation failures as
    regression cases. Run the strategy comparison protocol independently of
    interaction acceptance. Keep deferred visual-model acceptance explicit.

## Remaining scope and limits

The completion audit against the original scope proposal found development
gaps, not just pending acceptance. Do not report the whole proposal as done:

- The bounded capability-test entry is an ordinary conversation link; there is
  no dedicated bounded test workflow or structured capability result.
- Schedule editing and next-fire display are implemented, but recent schedule
  outcomes are not displayed in the schedule editor.
- Existing integration onboarding was not changed in this implementation.
  Provider configuration prerequisites, connection-test feedback and action
  receipts remain incomplete; the API-key form still submits no provider
  `values` such as a required `baseUrl`. This is distinct from adding new
  providers, which was explicitly deferred.

- No full task-owner/dependency/deliverable-version data model or production
  shared work board; no arbitrary mid-run steering/cancellation feature.
- No Skills lifecycle, new external chat channels, new provider integrations,
  browser-lock redesign, bot archive/duplicate lifecycle or per-schedule timezone.
- The current 120/80 index allocation can still starve task notes. Counts refer
  to the pinned index, not all memory supplied through files or session history.
  Canonical experience exports can also contribute to context; bounding or
  deduplicating that content remains a separate measured strategy change.
- File previews are source text, capped at 256 KiB; downloads retain their
  existing path policy and 1 MiB limit. Unicode/spaced paths remain unsupported
  by the download contract. Files are current bytes, not immutable artifacts.
- The test-conversation entry opens a normal conversation; it is not a bounded
  automated capability certification. Display readiness means instructions are
  present, not that real-provider/browser behavior has passed acceptance.
- Untouched pre-existing changes in the memory research document belong to the
  owner. They must not be bundled into an implementation commit accidentally.

## Targeted test receipts

These are separate targeted executions; counts are not a combined whole-suite
result, and repeated files must not be added together as unique coverage.

| Area | Files under `packages/` | Passing cases |
|---|---|---:|
| Bot management and delivery | `web/src/screens/management.test.tsx`, `bot-schedules.test.tsx`, `path-links.test.ts`, `workspace-file-preview.test.tsx` | 40 |
| Memory contracts | `contracts/src/memory.test.ts` | 60 |
| Consolidation policy | `gateway/src/memory/consolidation-trigger.test.ts` | 1 |
| Memory edit version check | `gateway/src/memory/versions-expected.test.ts` | 1 |
| Learning provenance | `sidecar/src/memory-taint.test.ts` | 11 |
| Memory components | `web/src/screens/learned-memory.test.tsx` | 8 |
| Canonical file preparation/audit | `sidecar/src/canonical-files.test.ts` | 7 |
| New operator client methods | `web/src/api/interaction-client.test.ts` | 3 |
| Run progress component | `web/src/screens/run-context-panel.test.tsx` | 3 |
| Attempt-aware view reconciliation | `web/src/state/newer-run.test.ts` | 2 |

The preview component's four cases were rerun after adding a hide control and
the current-file-version explanation.

Runtime/chat agent receipts:

- Eight selected files, 123 cases passed: `contracts/src/run.test.ts`,
  `gateway/src/api/validate-run-ended.test.ts`, `gateway/src/db/migrate.test.ts`,
  `sidecar/src/turn-warning.test.ts`, `sidecar/src/start-run-request.test.ts`,
  `web/src/screens/chat-pane.test.tsx`, `web/src/screens/mention-textarea.test.tsx`,
  `web/src/state/thread-view.test.ts`.
- `gateway/src/approvals/continuation-decision.test.ts`: 3 cases passed.
- `gateway/src/ledger/usage.test.ts`: 6 cases passed, including cumulative
  usage reporting on a background-run continuation.
- `web/src/screens/approval-card.test.tsx`: 2 cases passed.
- `web/src/screens/run.test.tsx`: 11 in-process component cases passed.
- `sidecar/src/context.test.ts`: 17 cases passed, including matching system
  guidance across thread starts/resumes and empty canonical instruction fallback.
- Completion audit: `gateway/src/threads/remove-member-continuation.test.ts`
  passed 1 in-memory SQLite case. Member removal now rejects a run parked at
  `waiting_continuation`; after it is stopped, removal succeeds. The scheduler
  capacity view also retains an approved continuation waiting for a physical
  attempt, rather than dropping it from `waitingRunIds`. Backend typecheck
  passed after these two status-list changes.

The isolated database tests use in-memory SQLite; component tests use fake API
and stream dependencies. These do not exercise a deployed Gateway or real SDK.

Final coordinating-agent checks passed: backend `npm run typecheck` (including
compilation, not execution, of acceptance sources), Web typecheck, targeted Biome
check over all 81 modified/new package source files, and `git diff --check`.
The root working tree was uncommitted when these checks ran. They establish a reviewable
development result, not release readiness.

## Five-minute local smoke check (2026-09-30)

At the owner's request, the coordinator reran bounded local checks at
03:13–03:14 UTC, within the five-minute target:

- Backend/contracts/sidecar: 14 selected files, 206 cases passed (2.04 seconds).
  Coverage includes continuation decisions and membership protection, migration
  preservation, usage accounting, canonical files, context, request validation,
  memory filtering, consolidation eligibility and version conflicts.
- Web: 14 selected files, 109 cases passed (4.47 seconds), covering management
  and one-bot entry, conversations, mentions, schedules, memory, approvals,
  run details/context, file previews and attempt-aware state reconciliation.
- Backend and Web typechecks passed. Acceptance sources were compiled only.
- Web production build passed (2.00 seconds); `git diff --check` passed.

These 315 passing cases are a fresh targeted execution, not additional unique
coverage to add to the earlier receipts. No listening Gateway, real browser,
container, real-model request or end-to-end test was used. The development gaps
and pending acceptance listed above remain open.

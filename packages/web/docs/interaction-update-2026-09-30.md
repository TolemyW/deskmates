# Interaction development update (2026-09-30)

Bot management now separates the searchable roster from one bot's settings and
provides a normal test-conversation entry. Imported/new SOUL and manual notes
can be edited while the workspace is stopped; a legacy bot needs its first file
import before that is possible. Schedule editing uses the existing Gateway
timezone and create/update/remove contract, not a new pause or run-now action.

Run details explain progress and waits, expose continuation decisions and show
recorded context measurements, pinned-memory receipts and rule-file observations.
The learned-memory page supports search, version inspection, version-checked
edits, explicit permanent forget, task-note closure and manual consolidation.
Changing durable memory does not erase already supplied SDK history. Task-note
closure produces an episode; it does not archive the conversation.

These working-tree changes have targeted unit coverage, not end-to-end acceptance.
See `docs/runbooks/interaction-optimization-test-handoff-2026-09-30.md` for the
verification boundary and remaining scenarios. The milestone topic files (M0, M1,
M2, B5) describe their original delivery scope.

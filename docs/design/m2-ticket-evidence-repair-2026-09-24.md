# Ticket acceptance evidence after a status-read failure

The X02/X03 acceptance test previously recorded `waitErrors` only after retrying rejected waits through `GET /api/runs/:id`. If that fallback read also failed, the original wait error and current run/site state were absent from `ticket-workflows-results.json`; teardown then removed the test database.

The test now stores settled wait errors before any fallback read. If a subsequent run, event, or site HTTP read fails, it adds an explicitly diagnostic in-process snapshot before teardown: status and event ordering for the started runs, and the six relevant tickets and ticket operations. Event payloads, run configuration, sessions, unrelated site state, and the raw database are excluded. Known runtime secrets are removed from retained strings. The failing read still throws; the canonical HTTP/state oracle, fixed deadlines, prompts, and `unsafeToReset` guard are unchanged. The diagnostic snapshot cannot make a case pass.

Offline regression coverage injects a failed fallback status read and checks that the original wait failure and diagnostic snapshot survive. It also checks the snapshot's data selection and secret redaction. `npm run typecheck`, the three focused tests, and Biome checks passed. No real model run was used to validate this harness repair.

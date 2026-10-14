# Optional origin coordination prototype (ADR-0007)

`BROWSER_COORDINATION_MODE` defaults to `tab-v1`. An isolated Gateway may opt into
`origin-v2`; the mode is recorded in each run and passed to the sidecar with that
process's existing wall-clock deadline. A matching sidecar image is required.
Migration `0011` adds a FIFO queue per workspace and HTTP(S) origin, with one
pending/held entry per run and a renewable 120-second TTL. The authenticated
`/internal/runs/:runId/browser-origin` endpoint supports acquire, renew and release;
body run IDs cannot select a different run. Queue waits consume the configured run
limit. Human takeover preempts grants; terminal and parked runs release entries.
The ledger records admission transitions and wait duration. This is scheduling
within a shared workspace, not access control between bots. The prototype remains
opt-in until ADR-0007's paired calibration and regression gates pass.

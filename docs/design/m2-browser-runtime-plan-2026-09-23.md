# M2 B2: shared-browser runtime

Starting revision: `2160b84`, isolated `codex/m2-foundation-20260922` worktree.
The active main application and its images, ports and data are not deployment targets.

## Delivery

Wire the F2 Gateway tab leases into the real browser path. Each run lazily creates
its own tab in the existing workspace Chromium and retains its stable CDP target
identity across an approval resume. MCP's numeric tab indices are display positions,
not lease identities. No extra Chromium, profile copy, bot permission layer or
origin lock is introduced.

1. Verify the pinned MCP protocol against a dedicated real browser. Record how to
   create a selected tab, obtain CDP target IDs and retain shared cookies.
2. Add a per-run MCP coordination component. It serializes calls within one MCP
   connection, resolves indices against stable IDs, and checks the Gateway lease
   before dispatch and capture. The PreToolUse hook remains the approval/egress
   policy point; it reads tab metadata for approval origin and acquires/renews
   the existing lease without moving it. Hooks can run ahead of an in-flight action,
   so only the serialized proxy switches stable targets. The proxy resolves the first lazy tab and revalidates the actual target at dispatch,
   closing the gap between hook approval and browser execution.
3. Preserve the run's tab metadata on its bot home volume so resumed processes
   return to that tab. A missing/closed tab must never silently redirect a normal
   tool call to another bot's current page. Completion releases leases; tabs are
   retained for operator inspection, as the existing persistent browser does.
4. Stop captures and image delivery during human takeover, including a takeover
   after the hook but before dispatch/capture. Gateway ingestion independently
   suppresses screenshot events while takeover is active. In-flight actions
   cannot be undone; their results must not claim no side effect occurred.
5. Add deterministic tests for target mapping/reindexing, contention, resume,
   closure, failures, same-session ordering, screenshot numbering and takeover.
   Run isolated real Docker/SDK tests and configured-model shared-environment
   checks, with source/image IDs, failures and limitations recorded.

## Verification boundary

Browser ownership is coordination inside one shared trust domain. Bot-authored
code can still use the shared shell and browser directly; these changes are not
access control. Risk classification and L2 approval remain in the SDK hook.

Real checks live under `spikes/m2-browser/` and `acceptance/`. Use dedicated image
tags, ephemeral ports and independent volumes. Preserve failed evidence. Do not
claim X02/X03's K=5 interference calibration or all M2 acceptance from a smoke
run; any unexecuted milestone gate remains explicitly open in the results.

## Implementation follow-up

Runtime implementation: `4938dc0`. Results and unexecuted acceptance gates are
recorded in [m2-browser-runtime-results-2026-09-23.md](m2-browser-runtime-results-2026-09-23.md).

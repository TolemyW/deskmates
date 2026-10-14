# M1/M2 feature closeout: independent test handoff

Test branch: `codex/m1-m2-feature-closeout-20260923`, based on `8d4f551`.
This branch also includes the preceding Web interaction fixes. It is not deployed to the shared development instance. See the development result document for the final commit and completed checks.

## Isolation and stop rule

Use a separate checkout, database, ports, workspace names, image tags and Docker resources. Do not restart or reconfigure another tester's Gateway, browser, containers or model settings. Build the workspace image from this branch: it now preinstalls pinned `node-pty@1.1.0`; an older image cannot execute the new terminal tool. Apply migrations through normal Gateway startup against a disposable database (new migration 0013).

Run each scenario once against its stated oracle. Record the first failure with run/attempt IDs, trace and expected/actual behavior. Reproduce only that failure; do not run model loops until green. Development fake tests and a Web build have already been performed, so prioritize these real integration boundaries. Never classify a model-quality experiment as accepted from one successful example.

## Configuration and evidence

- `WORKSPACE_MAX_CONCURRENT_RUNS=2`: physical sidecar attempts per workspace, including an ended/parked process until it exits. This is a conservative default, not a measured capacity claim.
- `BROWSER_EXECUTION_MODE=baseline-v1`: default; `vision-cli-v2` enables automatic vision guidance and the governed CLI tool. The strategy is opt-in pending paired evaluation.
- `BROWSER_RETAINED_TABS=20`, `BROWSER_TAB_RETENTION_HOURS=24`: keep fresh completed targets up to the count; select expired or excess targets oldest first, at most 20 per new proxy startup. No background cleanup daemon runs when no bot uses the browser.
- Run configuration records these knobs, `ttyVersion`, and `resourceObservationVersion`.
- Resource observations appear as run `log` events with `source=resource_observation`. `sidecarRssBytes` is the host process only; workspace cgroup current/peak includes Chromium and all children. A cgroup peak is container-lifetime, not a run-specific allocation. Missing cgroup fields mean unavailable, not zero.

## Real terminal (T2, then one bounded model scenario)

1. Verify the new image resolves `node-pty` locally without a runtime download.
2. Invoke `mcp__deskmates__tty_session` to open an interactive command in `/work`. Open/write are L2 and must follow the existing approval hook; read is L0, resize/close L1. Exercise Enter, Ctrl-C, resize and a command that waits for input. Verify incremental output rather than replay of old output.
3. Create more than 64 KiB output; verify bounded output and `droppedCharacters`. Try four sessions and reject a fifth until one is explicitly closed. Finished sessions retain their final output until read/close and still require explicit close to release their slot.
4. Let the session deadline expire; verify the shell/process group stops and the output reports `timedOut`. End, fail and park a run with an open terminal; verify cleanup. A new run attempt cannot use an old session ID. Approval parking intentionally ends terminals; do not silently replay a write into a new terminal.
5. Mark a sample password write `sensitive=true`; verify its raw value is absent from approval payload, tool ledger, echo and final summary. Verify ordinary writes remain reviewable and differing full inputs do not reuse the same exact-action Always fingerprint. Use fake credentials only.
6. Attempt a direct curl/wget to a denied public domain; expect the normal hook/network denial. Terminal access remains the same shared workspace trust boundary as shell access; private networking and database protocols are outside this batch.

## Browser strategy and retention (T2 before T3)

1. With `vision-cli-v2`, cause two matching target lookup failures, including a snapshot refresh between them. Verify a fresh screenshot and coordinate-tool guidance appear only after the second failure. A different target, successful action, navigation or takeover must reset/fence the behavior. No failed action is automatically replayed.
2. Start on a verified run tab, approve a short structured CLI workflow. Verify the preinstalled `playwright-cli` attaches to the same CDP browser, resolves the exact target, performs the bounded steps, and returns wrapped observations. Verify its final screenshot is in the run ledger and not a base64 string in model text.
3. Save a reviewed JSON workflow under `/work/scripts`; execute with its full steps and SHA-256. Mutate the file, use a symlink/path escape, change the origin, or point a goto outside the allowlist: dispatch must fail before an effect.
4. Take over during attach and between workflow steps. Later steps must stop; ambiguous in-flight failure says the action may have completed and directs inspection, never automatic retry. Revoke egress and exercise origin lease loss. Verify screenshot suppression after epoch change.
5. With 25 fresh completed targets and retention count 20, only the oldest five are candidates. With three expired targets, all three are candidates. Preserve active, parked, current, unrelated human/unattributed targets, targets leased or reused by another run, and the last page. Take over during cleanup and verify it stops. Retry after a lost close acknowledgement; already-missing exact targets can be audited without numeric-index closure.
6. Compare baseline and `vision-cli-v2` in a separate paired evaluation using the existing measurement protocol. Record task/model/config/latency/tokens and uncertain effects. Do not change the deployment default in this test handoff.

## Capacity and operator surfaces

1. At cap 1, hold a first process after posting its terminal/parked outcome, queue another run in the workspace and start one in a different workspace. Only the other workspace starts until the first process exits. Verify one capacity wait event, capacity API state, and a resumed attempt cannot escape the physical cap.
2. Observe memory with 1 and 2 concurrent real model sessions in the disposable workspace. Record sampled workspace current memory, container peak, sidecar RSS, throughput, model and workload. Stop on OOM or deadline. Use those measurements to recommend a cap; do not infer safe sizing from fake tests.
3. Open `#/costs`. Mix two bots, two models, priced and unpriced usage, and multiple days; verify inclusive UTC date filters, distinct run counts and token/cache totals. Partial cost must say it is only the known portion; no price must remain unknown. The day is the run creation day; cross-midnight resumed usage remains attributed to that run.
4. Open `#/manage`. Edit SOUL, navigate away/back with a dirty draft, provoke a version conflict, and verify local text survives. Successful saves advance `soulVersion` and reopen future SDK sessions. Edits are refused while the bot has parked runs or workspace processes are active. Test role/context behavior once with the actual SDK.
5. Create/delete an approval rule; removal has an explicit UI confirmation. Change an existing workspace egress list; verify removal confirmation and real proxy enforcement. Check unauthorized operator requests cannot access the new endpoints.

## Knowledge and memory governance

1. Propose, approve and edit knowledge. Paginate beyond 25 records; inspect immutable old bodies, reviewer and source run. Migration preserves the current approved version of pre-existing documents; it cannot invent metadata for historical files never previously indexed.
2. Create one orphan version file and retain several referenced historical files. Explicit cleanup removes the orphan only. It must not remove current/history references or arbitrary files outside the version directory.
3. Finish a run with memory suggestions. Review the source run/bot, apply using the current memory hash, and verify append+status. Repeat the review: no duplicate append. Reject another suggestion and verify no MEMORY change.
4. Race apply/reject and concurrent memory edits; stale versions fail, and a failed metadata update rolls the file back. Interrupt around file/DB boundaries in a disposable workspace and inspect recovery evidence; cross-container filesystem and SQLite are not one crash-atomic transaction.
5. After applying a suggestion, reopen the memory editor to see the current content; an already-open dirty draft is never silently overwritten. Verify all new operator routes require the deployment credential.

## Remaining milestone acceptance and M3 boundary

This development batch does not replace the existing B1–B3 and B4–B5 handoffs, overnight approval recovery, live network-isolation tests, long-duration runs, or paired model reliability evidence. Use their existing oracles rather than reopening fixed defects without a reproduction.

The user explicitly deferred private HTTP/HTTPS services, database/TCP protocols and connector work to M3. Public HTTP/HTTPS is the supported egress scope here. Connector MCP implementation, Slack/Telegram and alternate sandbox providers are not claimed complete.

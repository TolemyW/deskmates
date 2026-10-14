# Preserve SDK turn exhaustion across a duplicate exit error

Date: 2026-10-01. Status: targeted unit and real-SDK original/fixed checks passed.
This fixes an implementation gap in accepted ADR-0016; it does not change its
continuation policy or prove completion of the stock scenario.

## Evidence and correction

Stock budget-16 run `run_50399b0f0e79402b87c9f7e39ebce2c7` ended `failed` with
`Claude Code returned an error result: Reached maximum number of turns (18)`.
It retained SDK result usage. Reading pinned SDK 0.3.278 `readMessages` shows
that it enqueues a structured error result and may subsequently replace a
subprocess-exit exception with that result's text. It trims nonempty error
strings and joins them with `; `.

`runOnce` had already received `error_max_turns`, its session and usage, but
the catch block set `ended.error`, skipping the later exhaustion/handoff path.
Consequently ADR-0016's continuation request never appeared. A regression test
reproduced `failed` instead of `turns_exhausted` before the fix.

The catch block now preserves the typed exhaustion result only if:

- a structured `error_max_turns` result with `is_error` was actually received;
- its normalized error text is nonempty;
- the thrown `Error.message` exactly matches the SDK's duplicate-result form.

The exception remains a redacted warning event with
`preservedResult: error_max_turns`. An exception alone, or an unrelated error
after the result, still fails. Session, usage and bounded handoff saving follow
the existing ADR-0016 path. No automatic approval rule or continuation cap changed.

## Verification

- The new regression failed before the correction and passed afterward.
- Targeted `run-once.test.ts`: 89 tests passed.
- Affected sidecar T0/T1: 41 files, 887 tests passed. A first sandboxed invocation
  failed only because the loopback proxy test could not bind (`listen EPERM`);
  rerunning with authorized loopback networking passed.
- Root `npm run typecheck` passed; changed-file Biome checks passed.
- The two fresh real-SDK probes below used the same model, task and one-turn
  limit. Neither task POST was repeated. A continuation was allowed only after
  inspecting the exact expected local file, at most once.

| Image | Real outcome |
| --- | --- |
| Original v0.2.18, `sha256:270a722a76b93f7ed4d4a6e465079dc411ca94c4a1c85023fec2a602f7592fe8` | Wrote the file, then failed on attempt 1; no continuation state |
| Corrected, `sha256:9f33e37e233d321fc3b03007c83d792d8b4119a250d92a97a39524ec6325ed33` | Wrote the file, parked, resumed the same run/session, succeeded on attempt 2 with the required completion reply |

Original logical run: `run_696929b29cde485f8ed9fbbf7b01ab25`.
Corrected logical run: `run_843b76d2bea946f3af5931ba6b202df8`.

| Physical attempt | Input | Output | Cache read | Cache create |
| --- | ---: | ---: | ---: | ---: |
| Original 1 | 3,148 | 37 | 13,312 | 0 |
| Corrected 1 | 3,149 | 37 | 13,312 | 0 |
| Corrected 2 | 2,378 | 460 | 14,336 | 0 |

Both probe workspaces were destroyed and an exact-workspace container query
returned no remaining containers. The stable release was not changed. This was
an isolated test image, not a tagged deployment or a full release gate.

Host receipts, source inventory and ledgers:
`/home/owner/agent_workspace/deskmates-reusable-stock-supervisor-20261001`.
All 1135 transferred regular source files matched their recorded hashes. The
source is v0.2.18 plus the scoped correction and probe; no actual credentials,
Git history or workstation dependencies were transferred. Existing host model
credentials entered only child process environment memory.

Reproduction: [`continuation-probe.ts`](../../spikes/stock-supervisor-20261001/continuation-probe.ts).
Compact receipt: [`probe-summary.json`](../../spikes/stock-supervisor-20261001/probe-summary.json).
The subsequent stock controller pilot uses this corrected image and reports its
workflow/quality outcomes separately, preserving the original budget-only failures.

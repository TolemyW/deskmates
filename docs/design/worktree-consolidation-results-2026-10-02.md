# Local main consolidation, 2026-10-02

## Scope and result

The owner requested consolidation onto `main` before cleaning the local development
environment. The preceding read-only audit covered 70 registered Deskmates worktrees
and 70 local branches, with no stash entries. Its baseline was `c3393f0`; the fetched
`origin/main` was `78c3a47`. No remote push, deployment, branch deletion, worktree
removal or ignored-state backup is part of this operation.

Two independently developed branches contained missing committed work:

| Source branch | Source commits | Imported commits |
| --- | --- | --- |
| `codex/agent-loop-spike-20260922` | `4d3226f`, `ac6c5f4` | `eb75373`, `6dc6896` |
| `codex/m1-independent-qa-20260922` | `7533cd5`, `d483a88`, `d55ca5a`, `000a663` | `e2a61fb`, `ba12f92`, `f4bb591`, `cd61afb` |

The source commits were cherry-picked to preserve each independent implementation
and design record. Five untracked agent-loop files were also recovered: the
AskUserQuestion deployment report, GLM/Flash latency report, latency script and
results, and deployed-tool exclusion probe. Executable package paths were updated
for Deskmates; the dated reports and measurements retain their historical scope.

Three pending main drafts were byte-identical to `delegation-outcomes` WIP commit
`54887b0`: the memory research addition, DeepSeek thinking report and DeepSeek probe.
They are now included. Other final source blobs in that WIP were represented in
main history; its older handoff status wording does not replace the newer main text.
The recovered memory-hook section is a proposal, not implemented product behavior.

The release/T2 draft branch (`agent-a541...`), memory draft branch (`agent-a5d...`)
and release UI branch (`agent-afa...`) contain split or integration variants of
changes already present in later main commits. Restoring those trees wholesale
would replace newer implementation. Six dirty historical worktrees also contained
source variants whose exact blobs were absent from main history. Their original
patches, base revisions, hashes and disposition are preserved in the
[recovery manifest](../../spikes/worktree-recovery-20261002/manifest.json).

## Recovered correctness fix

The old testkit draft exposed a real contract mismatch: main's fake treated
`allowedTools` as an availability filter. The installed Agent SDK 0.3.278 declaration
states that it auto-allows named tools, while `tools` selects available built-ins.
Commit `dbba91d` separates those behaviors and keeps MCP availability and explicit
hook decisions intact. Five regression assertions failed before the fix; afterward
all 29 fake SDK tests pass. Current effort/thinking fields and other newer shapes
are retained.

The historical draft's extra default timeout/cancellation and complete init-tool
catalog changes remain archived proposals. This integration does not claim they
are verified or apply them to current testkit.

Commit `47faacf` adapts the recovered QA and probes and preserves the source drafts.
The QA price tests now use authenticated `combined-test` injection, and screenshot
expectations use the current directory prefix. Their original behavioral assertions
are unchanged.

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, 651 files |
| `npm test` | Pass, 222 files / 2,344 tests |
| Fake SDK regression suite | 29/29 pass; five failing assertions reproduced before correction |
| Independent M1 QA typecheck and tests | Pass, 15/15 |
| Agent-loop spike typecheck and deterministic verification | Pass, 16/16 |
| Recovered latency TypeScript probe | Standalone strict typecheck passes |
| DeepSeek and deployed-tool JavaScript probes | `node --check` passes |
| Whitespace check | `git diff --check` passes before commits |

The first repository test invocation hit sandbox `listen EPERM` on localhost and
was stopped. The successful rerun allowed local listeners; no real model or Docker
was used. The portability experiment used its pinned dependencies already present
in the old worktree through a temporary ignored symlink, removed afterward. Its
[16-case report](../../spikes/worktree-recovery-20261002/portability-report.json)
is saved; worker databases remain ignored.

No container, deployed-system, real-browser, real-model or end-to-end acceptance
suite was run. Historical experiment results do not establish current deployment
acceptance or a measured strategy improvement.

## Cleanup boundary

The code and selected source drafts are recoverable from main. This is not a backup
of ignored worktree contents: raw test receipts, SQLite databases, packet captures
and credentials are intentionally excluded. The manifest lists ignored preservation
candidates. Keep or separately back up those directories before removing worktrees.
The audit classifications in the manifest describe the pre-integration snapshot;
they are not blanket deletion approval. No original worktree was modified.

# QA agent artifact handoff: synthetic collector gate

Date: 2026-09-26. This checks artifact collection only. It does **not**
establish a Deskmates run origin, execute Java, validate a QA test, or pass the
private Defects4J grader. Both QA cases remain `needs_adaptation`.

The evaluator-only [collector](../../spikes/reusable-tasks/defects4j/agent-bundle/collect.py)
starts from the raw buggy bundles documented in the [projection review](defects4j-agent-bundle-review-2026-09-26.md).
It verifies the private bundle receipt, issue hash and exact buggy Git tree,
then extracts an independently captured worktree tar under a 512 MiB input and
expanded-size cap. Python's tar `data_filter` rejects unsafe extraction, and
every `.git` path from the candidate is discarded. The collector creates its
own empty-template Git repository with system/global config, hooks and
fsmonitor disabled; it never runs a Git command against an agent repository.
The candidate's project tree is compared to that fresh baseline, preserving
added, modified and deleted files in `full-source.patch`.

The frozen test-only allowlists are `src/test/java/` for Lang-1 and `src/test/`
for Cli-1. `test-only.patch` is generated from those paths, checked on a fresh
baseline, applied and staged there, then compared with the exact allowlisted
A/M/D path/status set. Production paths (`src/main/` for Lang and `src/java/`
for Cli) remain in the full patch and are separately reported as
`production_constraint_status: requires_review`; they are not silently dropped
or automatically scored as agent failure. Other project paths are also listed.
`reproduction.md` and files under `evidence/` are copied as data only under
bounded sizes; nothing is executed. A missing on-disk note is reported as a
fact, since a future real run may contain a reproduction in Gateway messages.
All collection errors exit 3 with structured evaluator `unknown` and
`agent_failure: false`.

On Testbox Linux, the [synthetic controls](../../spikes/reusable-tasks/defects4j/agent-bundle/offline-controls.py)
used only scoped public raw-source bundles, both transferred with matching
SHA-256: Lang tar
`a442dc924cb15d9a27d18e24dbeeba47d2521b3bc64b77f25f1b00f6a8177a4e`,
Cli tar `df9cac1f67526dd510bceba8437ff23e65959d79256ca73e3cd9b5c5905f1817`.
The isolated remote root is
`/home/owner/agent_workspace/deskmates-reusable-evals/qa-agent-handoff-20260926/`.
The collector SHA-256 is
`523cabf743a4a623a428275a1dc1373b605c199f81bc333ed72d9add57b2be2e`;
the synthetic-control script SHA-256 is
`c691ab7bd0329f75d958911b2bf9a4c2b007ff00bc51d5f45786ff84509c4afa`.

| Synthetic case | Observed collector behavior |
| --- | --- |
| Lang mixed | Captured one added, one modified and one deleted original test path, plus a separate modified production source path. `full-source.patch` was 49,735 bytes; `test-only.patch` was 49,181 bytes. The reproduction note and `evidence/proof.txt` were retained. An agent-owned `.git/config` clean filter and pre-commit hook attempted to create a marker; the marker was absent. Receipt SHA-256: `121646e2427ad5ae833aae31f9328e27376b90e2e666ffafec8be8da0d39669c`. |
| Cli empty | Both patches were empty, test artifact status was `empty`, and no on-disk reproduction note was present. This is an artifact observation, not a QA verdict. Receipt SHA-256: `a7c626f8778fd037c50e7b99263e4bc1325a0ee1bc756bbb39836945a8265ee8`. |

Both receipts say `origin_verified: false`, `agent_outcome: null`. The remote
`outputs/controls-summary.json` SHA-256 is
`41684f9290f3a578658924aa3899c05f8d28a64c89abe9cc33189f68ae9bf0b4`.
An additional missing-input negative check returned exit 3 with
`outcome: unknown` and `agent_failure: false`, leaving no output artifact.
This run created no model session and did not invoke Java. Synthetic content
must not be presented as a Deskmates attempt.

Next gates: a trusted Gateway/volume capture receipt with terminal-run binding;
an isolated no-credentials, no-private-mount, network-denied candidate Java
execution environment; and private buggy/fixed grader replay after QA's
reference controls establish semantics. A candidate test patch and any
production constraint require independent review. None of those gates was
performed here.

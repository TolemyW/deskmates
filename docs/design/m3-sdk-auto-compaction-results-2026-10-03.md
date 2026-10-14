# M3 actual SDK automatic compaction and archive repair

Date: 2026-10-03 Asia/Taipei. Selected real SDK/container mechanics pass after
repair. Full M3 is not accepted. No real model, commit, tag or deployment.

## Defect and final behavior

Actual SDK 0.3.278 can invoke PreCompact before its transcript file exists. A
nonempty file is also insufficient: its latest tool-result append may still be
pending. The original hook fails with ENOENT; an availability-only first repair
can report success while preserving only an earlier prefix.

The production sidecar now remembers the latest top-level SDK tool-result
message UUID before any screenshot wait. PreCompact reads until its complete
user-role JSON record appears. Missing/empty/pending-tail files share bounded
retry delays of 50, 100, 200, 400 and 800 ms (1.55 seconds total). Other I/O
errors fail immediately. A watermark that remains unpersisted, permission error or copy
failure emits the existing warning and allows compaction to proceed. Subagent
hooks do not inherit the main-thread watermark. No message is added to model
context; prompt, SDK version, context limit, approval and memory trust rules
are unchanged. This is archive mechanics, not a retention strategy.

## Reserved runtime observations

`acceptance/m3-auto-compaction.container.test.ts` runs the production
SQLite Gateway, DockerProvider, sidecar and actual SDK in a real Colima workspace.
A loopback scripted Anthropic-protocol upstream reports 195000 synthetic input
tokens on its first tool response; the SDK itself automatically compacts. No
`/compact` or context-limit override is used. The final task is a single local
Bash marker write, without a deliberate delay. Each invocation reserves one
logical/physical attempt, four turns and a 120-second run deadline.

All six invocations are retained under ignored
`spikes/m3-auto-compaction-20261003/work-01` through `work-06`:

| Work | Outcome | Meaning |
| --- | --- | --- |
| 01 | T2 fails; run succeeds; 2 message requests | Initial fixture misses the SDK URL's `?beta=true`, so high usage and compaction are not exercised |
| 02 | T2 fails; run succeeds; 3 requests | URL corrected; actual automatic boundary and memory flush occur, but production archive fails ENOENT. Summary retains tools, exposing a second fixture classifier mistake |
| 03 | Earlier prefix T2 passes; 3 requests | Old-image two-second tool-delay diagnostic archives 14 records without the original tool result; not full preservation evidence |
| 04 | Earlier prefix T2 passes; 3 requests | Availability-only repair and original fast task; saved 20-record archive happens to contain the tool result. Stronger correlation assertion was added later |
| 05 | Stronger T2 fails; run succeeds; 3 requests | Same availability-only image archives nonempty earlier history; matching tool result absent. Raw archive bytes were not exported before assertion; ledger/error/test-source evidence remains |
| 06 | Stronger T2 passes; 3 requests | Final watermark repair, original fast task, complete original tool/result pair and matching byte prefix |

These are six SDK attempts and seventeen scripted messages requests, zero real
model calls. They are not result-selected real-model retries. The scripted
summary itself contains the marker, so its presence afterward proves no recall
quality. Synthetic token counts, cache zeros and null prices are not endpoint
usage or cost measurements.

## Final proof and binding

Work-06 exits zero (9.20-second Vitest duration), one pass, zero fail/skip.
Run `run_cfb696dbd23a45d8a2a67b46c9a93e7f`, attempt 1; session
`c4a641a9-3e13-4ce7-9e74-b57330b1d9d4`. One actual automatic boundary follows
one archive and one production memory-flush event, without an archive/flush
warning. The archive has 110921 characters and 20 records, including the exact
Bash tool use and its correlated successful original tool result. Its complete
bytes match the final SDK transcript's pre-boundary prefix. Independent reads
verify the local file's exact marker contents.

The operator context route reports two main response turns, peak/p95 input
195000, one automatic boundary (synthetic pre/post counts 195148/710), context
section sizes and harness prompt SHA-256. Three proxy requests include the
separate summarizer, whose system prompt differs; this does not establish a
bare-string prompt change on resume.

Pinned final arm64 workspace image:
`sha256:96797dbb5fd3c78c06207afe6a6f16e00a670524fa5204f558c1781fb0be3ed9`,
tag `deskmates/workspace:arm64-0fd0a1eaad68`, built offline from unchanged cached
base `sha256:8054bcc19792afeb20df906d887a24731cd9334108069aafc23546fc154aac27`.
Existing aliases and stable services were preserved. Egress image is unchanged
`sha256:625ee0e145b3299366d8fc7ff45bf95853d806ab8f39f2e5d4d66b3d123a319f`.

SHA-256 bindings:

| Artifact | SHA-256 |
| --- | --- |
| Final hook source | b24500cf6196d70a096e164320a74ea5d0efbd847b9cf0835c5f8dfe8be3a1e9 |
| Final run-once source | 4848c77c6bce77046f03d172fd2fb07d21c00e9acda9c195859912563a5278b5 |
| Final dispatched T2 source | d15b4aa7746c1a5910cbc4c6f5e697535d0d28b2e914e97788c01c38a84eaab5 |
| Archive | 1cba3b43ca82073c9eec413d73d490c41adfb36ba1d2924aa6aace8d633ca65c |
| Final SDK transcript | 8dc480459084837f4641260ce54edb2ad6419a1bcf86125ddb4b7da122bd8261 |
| Closed run ledger | d591087d74c826fb0cac04ff9168adf80e7ce34bade03472733dd70b00e3d680 |
| Independent six-invocation audit | b487b308a1190d3863b2bed278c613804db9410c58b599b1f7f2fd5f7bbd2628 |

Each invocation binds 983 source/compiled/runtime inputs unchanged at its
termination. Intentional subsequent revisions are listed separately, never
attributed to an earlier image. The collector verifies all six closed ledgers,
foreign-key/integrity checks, absent exact runner PIDs/process groups and all
36 exact owned Docker identities. Signal-zero checks target only owned groups;
a denied sandbox process enumeration was replaced by that read-only check.

## Regression gates and limitations

Two availability and two pending-tail/partial-JSON regressions fail before
their respective repairs and pass afterward. Two additional bounded/error
cases preserve fail-open behavior. The existing runOnce
archive integration test now simulates an SDK result emitted 200 ms before its
file append, verifying actual callback wiring. Missing/permission/fail-open
behavior stays covered. Latest full T0/T1: **2468 pass, zero fail/skip**;
backend/acceptance typecheck and lint pass. Both new automatic-compaction and
concurrent legacy-import T2 files are classified in the smoke list. An initial
root test invocation without loopback sandbox access failed with EPERM, and a
subsequent classification failure exposed the missing list entries; both are
retained separately from product failures.

The new frozen a786a38c full Testbox gate passes 2468 T0/T1 and 90 T2
assertions, zero failures, with one opt-in real-model skip; twenty ledgers and
184 absent exact owned identities are independently audited. See
`m3-auto-compaction-integrated-gate-results-2026-10-03.md`. The older 17cc1157
gate's 88 passes remain bound to its older hook/image. No screenshot bounds, browser strategy or lock rules were
modified, and its retained intermittent screenshot failure remains unresolved.

Another actual SDK observation remains open: streamed assistant envelopes have
provisional output usage (1 in this fixture), while proxy final message_delta
and final run usage contain larger output counts. A separate actual SDK stream probe confirms assistant output 1 arrives before
final delta/result output 132; see
`m3-sdk-stream-usage-observation-2026-10-03.md`. Production per-turn output
fidelity needs separate reconciliation; these receipts do not claim complete context
accounting. Configured-model window/cache/prompt/quality checks, powered paired
memory trials and live WhatsApp are still required. The larger real-model
campaign has not been authorized or launched; WABA configuration is not prepared.

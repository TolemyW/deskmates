# M3 offline acceptance hardening

Date: 2026-10-03. Source base: a3df29e27bd4c9797cd3fbf9382580c4b27733cb,
with the previously reviewed replay/equity patch preserved. At the time of the offline validation, this change set was
unpublished; no paid model request, Docker installation, deployment, push,
merge or security change occurred during that validation. The owner subsequently
authorized submission and moved remaining gates to M4; see
`m3-owner-scope-closeout-and-m4-backlog-2026-10-03.md`. WhatsApp live testing is deferred by the
owner until a stable version; historical matrices retain their original scope.

## Quant executable acceptance

The previous quant acceptance reran a submitted executable with its original
correct JSON output still present. A no-op executable could exit successfully
and pass by leaving that artifact untouched. The acceptance now removes the
output before **each** replay, verifies regeneration, rejects timeouts/nonzero
exits, and retains preparation/execution/raw-output evidence before validation.
The original model output remains separately captured. It runs the same exact
source on the original input and a withheld changed-price fixture. Independent
hand-worked positions, returns, turnover, compounding, drawdown and input hashes
must match, and neither input nor program may mutate during execution.

The replay fixture changes rank ordering, day count and dates and ends with a
recovery, so final loss is not maximum drawdown. Its independent generic
CSV-derived verification yields total return -0.15901733501401594 and maximum
drawdown 0.234077718592. Original results remain -0.275687030996 and
0.275687030996. The 1e-9 numerical tolerance and task semantics are unchanged.
Only CSV data enters the workspace; oracle values remain evaluator-side.

Independent review caught an ambiguous minimum-return tie in the initial
withheld fixture. It was removed by keeping B unchanged on the last two dates;
no production backtest or user result was involved. The original draft's
passing copied-reference tests did not prove that tie interpretation. A local
intermediate text replacement also produced two focused test failures before
the expected row was corrected. Final independent generic computation and all
15 quant tests pass. These include nine new regression checks; they do not
claim a real model generated the passing executable.

## Memory evaluator completeness

The 13 existing tracked memory prerequisite sources were restored from the
pinned commit with verified Git blob hashes. There is no combined campaign
runtime driver in that subtree. The original evaluator self-check reproduced
36 checks over 108 fabricated campaign inputs. The hardened oracle passes 42:

- A started query must have a fresh SDK session ID
- Unknown store, action-observer or long-boundary coverage cannot leave the
  protocol verified
- Parked/not-started sessions remain incomplete even when IDs are present
- The existing exact rule/store/outcome checks remain intact

The new conditional numerical screen requires the frozen whole reservation
inventory and order, all family/variant definitions, and unique run/thread/SDK
identities across campaigns. Missing, duplicate and unreserved trials prevent
paired comparison. All terminal task failures stay in the results. It reports
first-1/3/5 whole-campaign all-success rates and separate poison-store,
exposure-action and later-session-action counts. Its self-check passes 18
fabricated checks. A changed plan cannot silently reuse an old frozen digest.

### No statistical or strategy acceptance claim

The new screen always returns `statisticalGatePassed: false` and
`fullM3Acceptance: false`. Independent review found an existing methodology
mismatch: measurement §4.2 requires page-cluster standard errors, while
`compareResults` uses case-level clusters. Nonce variants of three poison
payload templates do not establish independent samples. Displayed case-level
confidence intervals, power planning and zero-event bounds are conditional.

The caller must explicitly freeze a planning MDE target. Conservative-MDE and
zero-events-in-both-arms restrictions are labelled proposed stricter screens,
not silently adopted canonical rules. Canonical safety rejects increases;
one-sided drop-MDE planning does not certify power for a two-sided gain test.
The old 54-case corpus still has only three short and three long cases. More
nonce copies or fabricated inputs cannot satisfy powered acceptance.

## Remaining bounded runtime-driver implementation

This is a plan, not an implemented or executed driver:

1. **Freeze input and ownership.** Build an immutable host-only campaign plan
   containing exact source/image/fixture/knob hashes, case and cluster identities,
   arm order, legal dependency-preserving session order, K, limits and all reserved
   task identities. Keep private answer keys outside bot containers. Establish
   independent case clusters and poison modalities before freezing a paid run.
2. **Integrate existing reset primitives.** For each independent case/arm/repeat,
   create one owned Gateway workspace and preserve its database outside the reset
   baseline. Before every session in both arms, prove the prior run terminal and
   no active sidecar, acknowledge browser shutdown, stop the workspace, restore
   exact owned `/home`, `/work` and `/profile` volumes with the existing whole-tree
   helper, and recreate the writable layer. Never reset a live or shared unrelated
   workspace. Keep the baseline archive mounted only into the stopped-volume helper.
3. **Integrate retention and fresh delivery.** The off arm forgets its own learned
   entries through the production operator API; both arms regenerate canonical
   learned exports from their retained Gateway database. Preserve human rules and
   host transcripts/confirmations. Create a new thread, verify no `resume`, audit
   pinned/search/export/diary/profile/transcript surfaces, and reserve exactly one
   task POST. Never retry an uncertain POST or substitute a new task for failure.
4. **Run scripted SDK integration first.** Add real-container T2 cases using a
   local scripted upstream for on/off × five ordered sessions, interruption during
   reset, incomplete evidence, lost task response, poison coverage and cleanup.
   Verify actual SDK/session/proxy observations rather than fabricated flags.
   Docker is presently unavailable in this cloud workspace; these tests cannot be
   certified by the existing unit/selfcheck results.
5. **Audit every terminal receipt.** Export all physical attempts, events, model
   requests, usage, store versions, compaction archives and exact resource IDs.
   Derive oracle coverage from those artifacts, not caller booleans. Unknown usage
   stays null. Run the independent whole-campaign screen without dropping failures.
   Stop on any unsafe cleanup/ownership mismatch or ambiguous query submission;
   retain partial output and mark remaining reservations not started.
6. **Add a separately approved budget mechanism before paid queries.** Existing
   maxTurns and Gateway deadlines bound a physical sidecar attempt, not total
   requests, tokens, dollars or retries across five-session campaigns. The Gateway
   proxy has no hard campaign spending cap. Soft cost alerts cannot supply one.
   A fail-closed evaluator-side request gate must reserve a conservative per-request
   cost before forwarding, enforce agreed model/input/output/request ceilings,
   count auxiliary SDK calls, prevent parallel oversubscription and stop if price
   or usage accounting is unknown. Use an approved provider quota if a conservative
   bound cannot be proven locally. Keep credentials in memory and require explicit
   paid scope/budget approval before configuration reads or model launch.

Even K=5 on the existing 54 definitions represents 540 arm-campaigns and 2,700
session queries before within-query turns, SDK auxiliary requests or recovery.
That corpus is still not a powered full acceptance set. Do not inherit the old
six-call waiver, eighteen-suite proposal or four-hour deterministic watchdog as
permission for this campaign. No proposed run is launched by this document.

## Validation boundaries

- Full final T0/T1: 2,615 passed, 2 failed, 2 unhandled environment errors, exit 1.
  Both remaining failures are unchanged all-interface gateway-base-url tests
  blocked by uv_interface_addresses in this sandbox; full suite is not green
- Quant focused tests: 15/15, including independently recomputed replay input
- Original memory oracle: 36 checks / 108 fabricated campaigns
- Hardened memory oracle: 42 checks / 108 fabricated campaigns
- Conditional decision self-check: 18 fabricated checks
- Strict standalone memory TypeScript, root typecheck and root lint checked on
  final source; see retained local gate logs for exact exit statuses
- Live T3, real-container T2, cluster-aware inference, PDF/image poison trials,
  combined runtime reset and paid model capability remain unverified

Machine-readable local source manifests, reproducible patch and retained command
logs are produced alongside this receipt. Full-tree results remain revision-bound;
no old green container result is relabelled as current M3 acceptance.

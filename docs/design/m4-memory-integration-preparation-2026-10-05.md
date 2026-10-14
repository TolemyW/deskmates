# M4 memory integration preparation and statistical campaign design

Date: 2026-10-05. Status: source slices integrated; runtime adapter incomplete.
Runtime and statistical gates remain unpassed. Natural 24-hour soak is removed
as an M4 gate by the owner's instruction; historical observations remain intact.

## Source and input provenance

The saved checkout began clean on branch `work` at
`153240e` (verified v0.3.0 deployment record). The initial preparation made no
commit, publication or deployment. Existing memory oracle, decision screen,
reset preflight, context control and actual SDK lifecycle/restart fixtures were
inspected. That initial saved source did not contain the reviewed 31-file offline M4
patch. A subsequent read-only Git/connector check pinned remote main to
`0ec78bb1a9591120b334b857de720b659e9c615a`, two commits ahead. Its four changed
files are documentation only: proposed ADR-0022, tenant/auth design and test plan,
and the design index. No production/test/dependency/AGENTS file changed. Tenant
auth is explicitly proposed, not implemented; existing operator-token behavior
remains authoritative. The working branch and local HEAD were not changed.

The required input is `deskmates-m4-parallel-handoff.tar.gz`, Library file
`libfile_a26ec2ad66288191b6a41703204ed925`, resolved version 0, reported size
197,222 bytes. The current Library skill's materialization helper was obtained
in this environment. Both local transfer attempts failed with `download failed`,
including the broader-network retry. No archive bytes exist at the intended
consumer path `/workspace/m4-input/deskmates-m4-parallel-handoff.tar.gz`; readability
and SHA-256 could not be verified. This was the initial missing-input blocker.
No signed URL is retained here and no shared parent filesystem is assumed.
No further Library download was attempted.

The owner subsequently authorized one draft integration PR for the unsubmitted
code. Reviewed source input `b8a31c219ffdaf36123d2556eaf871a0be157776`, with real
parent `6bf09f1a7a0d98fcfe2fdc9c04e7e01923250c9c`, supplied all 31 original paths.
It was cherry-picked onto actual main `0ec78bb` as `c98abe6`, resolving the source
blocker without rewriting the core. The protocol in
`acceptance/support/m4-memory-driver.ts`, durable `m4-memory-journal.ts` and
fail-closed `m4-memory-budget.ts` are preserved. Their MemoryRuntimeAdapter
interface still requires baseline freeze, campaign creation, stopped reset,
retention, fresh query preparation and bounded execution. This component port
does not implement that complete interface or invent successful runtime receipts.

## Implemented and executable now

`spikes/m4-memory-integration-prep-20261005/gateway-memory-port.ts` supplies a small
operator-side port against current production Gateway routes/stores. It checks
workspace/bot identity and all workspace runs (including parked/queued runs),
requires existing canonical human files, snapshots before forgetting, verifies
entry identity/content has not changed, uses authenticated forget, checks
tombstones/version redaction, creates a fresh empty thread with no SDK session,
and recomputes canonical exports and pinned indexes for **every** bot in the
shared workspace. Human rules, pending confirmations and old ledger rows remain.
It adds no bot ACL and does not import the SDK into the Gateway.

This is a port, not a driver: its caller must hold an exclusive workspace lease,
journal intents durably and bind it to the actual reset/query state machine.
It cannot submit a task or spend model money. In-memory snapshots and hashes
are not durable-attempt evidence. Its result explicitly reports runtime and
statistical gates false. Tests also build the production start payload, verify
the absence of a prior SDK session/old trigger text, exercise authenticated
run-token search, and reject run-token access to old operator transcripts.
Actual SDK query and physical file/profile reset remain unverified.

Follow-up hardening rejects a mismatched operator app/Gateway context, and
requires that a verified fresh thread has the selected bot, no messages, no
prior runs and no SDK session. Five additional separate-listener tests use the
actual operator/sandbox compositions, including two real loopback HTTP listeners.
They verify exact search IDs, memory-on/off export and forgetting, wrong listener,
missing/wrong credential class, other-run and revoked-token rejection, absence
of side effects on denials, and untouched other-workspace memory. These remain
T1 tests with a fake provider; they do not imply tenant or Docker isolation.

`sampling-plan.mjs` computes planning sensitivity and rejects manifest labels
that split a shared page/scenario/template dependency across independent clusters.
It reports missing buckets, never certifies independence or acceptance, and has
no model/network/execution branch. It always reports authorized budget zero and
existing stock budget unavailable.

## Required real runtime plan, in order

1. With the reviewed core now available, bind source, SDK/image digests,
   fixtures, strategy and price table. Adapt this port to its existing interfaces instead
   of introducing a second campaign core. Reconcile every mutation/query with
   durable reservation, fsync and recovery semantics. Fault-test crashes before
   dispatch, after dispatch/before acknowledgement, torn records, duplicate
   attempts, unknown usage and concurrent reservations. Never replay an uncertain
   task POST automatically. Preserve failed and incomplete attempts.
2. Build/obtain trusted source-bound workspace, egress and fixture images in an
   approved environment. This environment has Docker 28.4.0 but no images; no
   build or container execution was performed. Do not weaken seccomp, namespace,
   capabilities or egress rules to fit the host. Use exact owned-resource IDs,
   bounded resource/time limits and verified cleanup; preserve other services.
3. Run the combined flow first against the local scripted model provider using
   the actual sidecar/SDK, Gateway scheduler/proxy and production memory writes.
   An actual SDK against a scripted provider is T2, never real-model ability.
   Positive control: ordinary restart retains deliberately planted canaries.
   Both arms: quiesce all lanes/background consolidation; acknowledge Chromium
   close and stopped process; restore all `/home`, `/work`, `/profile` baseline
   trees from a host-only archive; recreate the writable layer; compare complete
   file/profile inventories. Gateway DB stays outside the restored trees.
4. Off arm: durably snapshot then forget all its learned entries through the
   operator API. On arm: preserve learned state. Re-export every bot's canonical
   memory from the Gateway after common reset. Preserve SOUL/manual notes in
   both arms. Verify run-token search, index and exported files, pending draft
   inaccessibility, all bots' diaries/transcripts/scratch state, browser storage
   and old task transcript access. A fresh thread alone is insufficient.
5. Reserve one physical query before task submission. Observe the production
   StartRunRequest and actual SDK options: absent `resume`, new thread/run/SDK
   session, fresh provider container, no old context. Keep complete proxy/store/
   action/boundary trace coverage and hash-bound artifacts outside the bot's
   mount. Require chronological real compaction/rotation between early constraint
   and answer for G-LONG; re-expose that constraint within each physical session.
6. Only after parent approval of a new memory budget, run the bounded smoke,
   then independently approve a variance/corpus pilot and a frozen powered
   campaign. Stop on unknown prices/usage, unresolved attempts, timeout, poison
   coverage gaps or budget reservation failure. Count consolidation, SDK helper
   calls, cache input/output and physical retries in the same monetary envelope.
   No ambient credential setup, OAuth, secrets access or reuse of the stock budget.

## Sampling unit, dependence and inference proposal

Follow `measurement-2026-09-20.md` section 4 and the memory plan's Phase 4 rule:
positive paired 95% lower confidence bound in each duration bucket, pass^k not
worse, structural G-XWS and rule override exactly zero, and no increase in
injection/cross-session attack success. The existing case-level comparator and
conditional screen cannot certify these clustered memory conclusions.

One observation is a whole ordered five-session campaign. Pair retention-on/off
on the same case/repeat; never pair individual sessions as independent outcomes.
Use K=5 for pass^1/pass^3/pass^5. Randomize arm order within predeclared blocks;
preserve reveal -> mutate/delete -> probe dependencies inside each chain.
New workspace/DB baseline per case/repeat/arm prevents carryover. Fix model,
knobs, fixture, sources and session limits, and record served model/time blocks.

Declare page/scenario/template dependency keys before outcomes. Transitive
shared dependencies belong to the same cluster; changing a nonce does not create
a new sample. A shared engine/fixture limitation limits external generalization
even with many page clusters. Balance independent clusters within short/medium/
long buckets. Average repeats/cases within the declared weighting scheme, then
resample **whole paired clusters** or use a prespecified cluster-robust estimator.
Retain all reserved failures in the denominator; missing protocol coverage stops
the verdict, rather than selecting complete cases. Freeze weighting, practical
effect, interval method, simultaneous-claim treatment and stopping rule before
querying. Report per-bucket and aggregate effects, pass^k, costs and fingerprints.

For executable sensitivity, with SD `s` of the paired cluster means and target
effect 0.10, use `ceil(((1.96 + 0.842) * s / 0.10)^2)` independent clusters per
bucket (two-sided alpha .05, nominal power .8, normal approximation). This is not
measured power. Do not divide `s` by sqrt(K) again. Small-cluster t correction,
unequal weights, multiple claims and pilot uncertainty require simulation before
freezing a real sample size. A pilot used to choose size is excluded from the
confirmatory outcomes; no favorable early stopping or outcome-selected retries.

| Assumed paired cluster SD | Clusters per bucket | Sessions, 3 buckets × K=5 × 2 arms × 5 sessions | Hypothetical ceiling at $0.10/session |
|---|---:|---:|---:|
| 0.25 | 50 | 7,500 | $750 |
| 0.50 | 197 | 29,550 | $2,955 |
| 1.00 | 785 | 117,750 | $11,775 |

These include one case per cluster and exclude additional poison strata,
consolidation or correction attempts; each must be budgeted explicitly. They
demonstrate why the current 3-short/3-long prerequisite set cannot establish
powered acceptance. No assumption here is an adopted threshold or budget.

## Poison coverage

Predeclare HTML, PDF and image delivery separately; attacks must reach the
actual browser/PDF/image observation path. Cover override, forged authority,
scope promotion and stale/deleted payloads; verify both immediate unsafe action
and later-session effects, including every reachable learned/file store.
Payload presence alone is different from execution; unknown observer coverage
is not zero. Use matched clean/never-revealed controls and retain all outcomes.

For zero events in n genuinely independent attack clusters, exact marginal
one-sided 95% upper bound is `1 - .05^(1/n)`; at n=30 it is 9.503%. Although the
exact formula reaches below 10% at 29, keep the existing protocol minimum of 30.
Thirty nonce variants of three templates do not establish 30 independent trials.
A proposed six-stratum simultaneous bound (two arms × three modalities) using
Bonferroni needs 46 independent clusters per stratum for below 10%; shared arm
pairs do not become 92 independent attacks. Bounds with nonzero events need a
different exact interval, not the zero-event formula. Modalities, dependence,
and multiplicity must be frozen and reviewed before any statistical safety claim.

## Bounded budget proposals for separate parent approval

Current authorized memory spend is **$0**. The existing **$3 US-stock campaign
remains reserved for stock**. No paid/model call was made by this work.

- Scripted-provider T2: $0 model spend, bounded one case/arm, five sessions each,
  20 turns and 900 seconds maximum per physical session. This validates plumbing.
- Real smoke proposal: at most 10 physical sessions (one paired chain), total
  new ceiling $1, only if source-bound proxy enforcement can reserve at most
  $0.10 per session including auxiliary calls. Otherwise do not launch. This is
  not statistical acceptance; an exhausted cap remains a failed/incomplete row.
- Variance pilot proposal: 3 independent clusters per bucket, one case each,
  K=5, two arms, five sessions = 450 sessions; illustrative $45 ceiling at the
  same enforced cap. Three clusters/bucket are weak variance evidence; use an
  uncertainty-conservative variance envelope and approve expansion separately.
- Confirmatory campaign: choose and freeze the cluster sample size only after
  corpus/dependence review and simulation. Obtain a new explicit ceiling and
  immutable price table. A session-cost assumption is not a provider guarantee;
  ensure request-level input/output/cache limits and reserved worst-case cost
  before every upstream request, or stop. Never equate an SDK cost estimate or
  token report arriving after completion with a hard spending limit.

## Validation and remaining gates

The preparation now has six passing Gateway port tests, five passing separate-
listener tests and four passing dependency-free statistical-planning tests.
Forty existing memory/governance/operator-auth tests also pass: 55 total.
The spike's strict TypeScript check, root lint and whitespace checks pass.
The earlier root typecheck remains applicable to unchanged production sources.
The new tests exercise 31 pending confirmations to ensure preservation checks
cover more than the first page. See the spike README for exact commands.
This validates component code only; Docker/SDK/model tests were not run.

The exact core source is now available. Still required: wire the component port
to the existing protocol; actual adapter-level durable attempt/budget fault
tests; actual combined reset/forget/export/fresh SDK T2;
real provider accounting and bounded model smoke; independent frozen corpus;
cluster-aware per-bucket inference and power; HTML/PDF/image poison observations;
actual long-boundary evidence; complete real campaign receipts and cleanup.
No natural 24-hour requirement remains. No runtime/statistical pass is claimed.

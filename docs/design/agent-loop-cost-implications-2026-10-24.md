# Agent loop cost: implications for Deskmates and run observability — 2026-10-24

Status: proposal. The proposed changes are not adopted or implemented by this document.
Gateway changes below need an ADR amendment first (ADR-0032, ADR-0046); strategy changes
need the paired protocol of
`measurement-2026-09-20.md` and an owner-authorized budget. No paid campaign is authorized by
this document.

Origin: the private literature/vendor review dated 2026-10-24, "The loop has settled;
the money goes to caching and forking". Editorial review on 2026-10-26 checked the
primary abstracts and vendor documentation linked below; no paper was independently
replicated. The repository observations in section 3 were rechecked against main
`2806d20`. The historical diagnostic in section 2 was not rerun. Vendor results
remain self-reported, and paper results retain their task/model/budget scope.

Evidence labels used here:

- **code**: inspected in this repository, with a path and the revision above.
- **measured**: from recorded Deskmates usage (the 2026-10-24 self-improvement diagnostic on
  v0.7.12, 29 runs).
- **external**: a result reported by a linked primary paper or vendor, not a Deskmates result.
- **inference**: this document's judgment; to be checked before it drives work.

## 1. External evidence and its limits

1. **Harness effects depend on the experiment (external).** [Harness or Model?][S1]
   found same-model differences of -1.25 and +1.25 percentage points on its paired
   coding slice, with intervals spanning zero. Observed-usage cost per solved task
   differed by 1.2 to 1.6 times, but 58 missing usage records left the Opus billed
   ordering unresolved (ratio bounds 0.7 to 2.3). This is not evidence of equivalence.
   Counterevidence matters: [the GAIA scaffold study][S2] reports a within-model
   difference up to 28 points. [The component study][S3] varies 176 matched settings
   and finds model- and context-budget-dependent effects. No universal accuracy
   or cost ranking follows from these studies.
2. **Cache categories affect cost (external protocol).** [The cache documentation][S4]
   distinguishes read/write usage and TTLs. Reuse depends on identical prefixes,
   cache lifetime and provider isolation. Its API-workspace boundary is distinct
   from a Deskmates workspace. Token share alone does not establish money share;
   use each upstream's usage semantics and the configured historical prices.
   This proposal adopts no universal input/output ratio or cache-write cost share.
3. **Account for related work together (inference).** A task may include several
   runs, delegates, verifiers and background jobs. A new branch may reuse an
   eligible shared prefix; starting a session does not itself prove a cold write
   [S4]. Record provenance and observed usage rather than charging every fork a
   presumed cache rebuild.
4. **Multi-agent benefit is task-dependent (external).** [Equal-budget multi-hop
   reasoning experiments][S5] favor or match single agents within that setting.
   [Scaling Agent Systems v3][S6] reports relative changes from +80.8% on decomposable
   financial reasoning to -70.0% on sequential planning. Neither settles real
   Deskmates teamwork. [Anthropic's research-system report][S7] gives roughly 15x
   chat token use for its multi-agent system; chat is a different baseline from a
   single agent. These are not interchangeable multipliers. Parallel reads,
   serialized integration and merge-point verification are candidates to evaluate.
5. **Completion and stopping can disagree (external).** In [S1], 22 of 81 runs
   cancelled at the wall-clock ceiling had already produced a passing patch.
   That motivates measuring incomplete execution and existing outputs separately;
   it is not a pass for our completion or cancellation behavior.
6. **Report variability and unknowns (external).** [The token-consumption study][S8]
   reports up to 30-fold same-task variation and self-prediction correlations no
   higher than 0.39 in its coding experiments. Use observed distributions and
   coverage flags; the numerical bounds are not predictions for our deployment.

## 2. Historical diagnostic counters (measured)

Recorded usage in the 2026-10-24 diagnostic, including failures and background jobs:

| Model | Input | Output | Cache read | Cache create |
|---|---:|---:|---:|---:|
| glm53-internal | 322,609 | 67,583 | 5,405,184 | 0 |
| deepseek-v4.1-flash-internal | 593 | 3,674 | 5,888 | 9,152 |

These are the retained operator diagnostic totals, checked against the dated
"Self-improvement diagnostic results — 2026-10-24" report. Of 29 runs, 26 have
complete usage coverage and three have partial coverage. The source receipts are
private operator evidence; this document does not claim a new independent replay.
For the default model, the recorded input side to output is about 85:1, and cache
reads are about 94% of the recorded input side. These ratios describe available
counters, not complete spend or a current-production distribution. Two limits matter:

- Recorded default-model cache creation is **zero**. That does not establish that
  every upstream write was reported or free; availability and counter provenance
  need verification before comparing cache-write spend.
- These models use an internal gateway and its configured price table. Public
  vendor prices cannot substitute for those effective rates or a vendor invoice.

## 3. Where Deskmates stands

| Review finding | Deskmates today | Gap |
|---|---|---|
| Price token kinds separately | `packages/gateway/src/ledger/pricing.ts` prices input, output, cache read and cache create separately (code) | No separate cache-write TTL rates. `model-proxy/response-usage.ts` can parse optional thinking usage; end-to-end coverage needs verification. Thinking may already be included in output [S9], so a separate cost must not double-count it |
| Interrupted streams cost money | The model proxy marks cancelled requests with `timing.cancelled()` (`packages/gateway/src/model-proxy/model-proxy.ts`) (code) | The proxy already aborts upstream work on client loss and preserves captured usage where available. Audit partial/missing coverage; do not infer zero spend from absent counters or an aborted stream |
| Account by loop tree | Runs record `trigger_kind` and `trigger_ref`; for `thread_message` the ref is a message id and `thread_messages.run_id` names the run that posted it (code) | Some links are derivable; complete task/branch attribution and cross-run roll-ups need an explicit lineage audit. An approval resume is an attempt of the same logical run, not automatically another run |
| Frozen model policy | ADR-0023 freezes the run's allowed model configuration (code) | Retain permitted fallback and requested/served-model attribution; this proposes no new mid-run router |
| Serialized integration | ADR-0038 supplies a soft directory guard; ADR-0005 supplies a routing owner (code) | Neither is a write mutex: bots/lanes still share a filesystem and can execute concurrently. Serialized integration needs a separately specified and tested workflow; the cost multiplier remains unmeasured |
| Verification at the merge point | `automatic` approval mode puts an independent AI reviewer in front of gated actions (ADR-0002 amendment 6) (code) | It reviews risky actions, not whether a task is done |
| Stopping and completion | ADR-0052 remains proposed; bounded handoff/revision implementation exists (code) | Functional implementation does not establish completion reliability or how often outputs already pass at timeout |
| Stable cacheable prefix | The sidecar renders recent diary days and memory into the run context (`packages/sidecar/src/context.ts`) (code) | Dynamic context may change a cacheable prefix; earlier stable blocks may remain reusable [S4]. Measure actual first-request cache usage before predicting a rebuild |

## 4. Implications for run observability (ADR-0046)

The `obs` tables already carry per-request cache read and create tokens, context size and a
cache hit percentage. The review suggests moving from "how much was spent" to "why it was spent
and what it bought":

1. **Money by token kind, not tokens.** Show which kind is the largest cost item under our own
   price table.
2. **Cache rebuild observations.** Record reported misses and candidate explanations
   such as elapsed TTL, compaction, changed tool/prompt hashes or served model.
   Correlation is not a proved cause. A new run alone is not a miss; unknown
   provider policy and missing counters remain unknown [S4].
3. **Cost by tree.** Root at the thread or the task; show cost per branch, per bot, and the
   multi-bot multiplier against a single-bot chat.
4. **Distributions and coverage.** Show P50/P90 with task type, sample size and
   missing-usage counts; use the paired protocol of `measurement-2026-09-20.md`.
5. **Version as a dimension.** Every row carries the release, the sidecar image and a hash of
   `runs.config_json`, so a prompt or compaction change does not blend into old baselines.

## 5. Proposed sequence

### Phase 0: read existing authorized data, no code

Using authorized aggregate exports/operator APIs or observability views, answer:

- the money split by token kind under our price table;
- why the default model's upstream reports zero cache creation;
- the cache hit rate of the first request of a new run, against later requests (tests the
  inference about diary and memory in the prefix);
- cost per human message in multi-bot threads against single-bot chats.

Record the results in `docs/design/`.

### Phase 1: correct accounting (Gateway; ADR-0032 and ADR-0046 amendments first)

- Audit and, if justified, materialise run/attempt/delegation/task links from explicit
  provenance. Preserve unknown or multiple causal links; avoid double-counting a
  shared run or treating a resumed attempt as a distinct logical run.
- Record cancelled and interrupted requests with an estimated input count from the request body,
  marked as an estimate.
- Expose thinking usage when reported and verify whether output already includes it.
  Apply separate pricing only when the upstream contract requires it [S9].
- Split 5-minute and 1-hour cache writes in the price table if an upstream distinguishes them.

### Phase 2: observability views

Cache rebuild cost, thread and task tree cost, the multi-bot multiplier, and cost per successful
deskbench task.

### Phase 3: strategy experiments (one knob each, paired, owner-authorized budget)

Candidate order, to be revised after the baseline audit:

1. After the baseline audit, compare a stable prefix boundary for dynamic diary/memory content.
2. `@everyone` parallel wake against in-turn wake (ADR-0005 amendment 4): cost and outcome.
3. Lazy tool loading: first measure how much of the prefix the Playwright MCP and Deskmates tool
   definitions take.
4. A completion verifier before a task is marked done.

### Not proposed

- More peer-to-peer negotiation between bots.
- Harness tricks aimed at success rate without a cost-per-success measure.
- Routing to a different model in the middle of a run.

## 6. Open questions

1. Does each upstream report cache writes, and with which TTL?
2. Does each upstream report thinking tokens apart from output?
3. Does a cancelled upstream stream bill the tokens generated before the cancel?
4. Which share of default-model spend comes from background jobs (summaries, memory, presentation
   summaries) against interactive runs?

## 7. Relation to a task-level spend ledger

The review was written for a spend-ledger product that reconciles per-request estimates against
vendor daily billing and wants a task-level ledger across vendors. The Deskmates model proxy sees
each proxied request's run. Thread/task provenance needs the audit above; not every
request has a formal task. The ledger is a candidate source of linked cost data,
not an already-complete task tree. Any export follows ADR-0046's sink and payload
rules, workspace roles and human private-chat visibility. Merging this proposal
authorizes neither new data access nor implementation or experiments.

## 8. Primary sources checked on 2026-10-26

Paper abstracts and the identified revisions were read; their experiments were
not reproduced. Vendor protocol documentation and research reports describe
those vendors' systems, not the configured behavior or prices of our gateway.

- [S1: Harness or Model? (2609.11987v1)][S1] — paired coding results, missing usage and stopping.
- [S2: Scaffold Effects on GAIA (2606.08529v1)][S2] — counterevidence to a universal small effect.
- [S3: An Empirical Study of Harness Design for Coding Agents (2609.20804v1)][S3].
- [S4: Claude prompt caching][S4] — matching, TTLs and provider cache boundaries.
- [S5: Equal-budget multi-hop reasoning (2604.02460v2)][S5] — bounded task/model comparison.
- [S6: Towards a Science of Scaling Agent Systems (2512.08296v3)][S6] — task-dependent scaling.
- [S7: Anthropic research-system report (2025-06-13)][S7] — vendor-specific chat baseline.
- [S8: How Do AI Agents Spend Your Money? (2604.22750v3)][S8] — variability and prediction.
- [S9: Claude Code cost documentation][S9] — thinking/output accounting semantics.

[S1]: https://arxiv.org/abs/2609.11987v1
[S2]: https://arxiv.org/abs/2606.08529v1
[S3]: https://arxiv.org/abs/2609.20804v1
[S4]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[S5]: https://arxiv.org/abs/2604.02460v2
[S6]: https://arxiv.org/abs/2512.08296v3
[S7]: https://www.anthropic.com/research/multi-agent-research-system
[S8]: https://arxiv.org/abs/2604.22750v3
[S9]: https://code.claude.com/docs/en/costs

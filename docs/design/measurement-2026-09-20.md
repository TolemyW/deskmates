# Deskmates Change Measurement: How to Know a Change Really Made the System Better

Date: 2026-09-20
Status: draft v1, companion to architecture blueprint v0.3 and test strategy v1
Scope: answers one question: for the three kinds of change (code, strategy, model), how do we measure each so that we can say "it got better" rather than "this run went well".

---

## 0. The shape of the problem

Deskmates has three kinds of things that change behavior. They are measured differently, and while measuring one of them the other two must be held fixed:

| Change type | Examples | Nature |
|---|---|---|
| Code | Gateway scheduling, sidecar hooks, redaction, browser lock, pricing | Deterministic logic; can be tested without a model |
| Strategy | SOUL, MEMORY rules, skills, approval rules, driver switch thresholds, knowledge retrieval top-k, diary days | Changes what the model sees or is allowed to do; can only be tested with the model in the loop |
| Model and gateway | Swapping glm-5.3 for deepseek, gateway upgrade, silent upstream update | The part we do not control; can only be monitored and re-baselined |

Agent output is stochastic. Running the same task twice and getting different results is normal. So "run it once and look" has no evidential value for strategy and model changes, and for code changes it only proves nothing crashed. Everything in this document is about turning "it looks better" into "it is better, statistically and practically".

---

## 1. Research summary: what the field has already worked out

We read RAGPerf and six works around it and distilled seven principles. Each is followed by its source.

**Principle 1: Split the pipeline into components, tune each one, look end to end.** RAGPerf splits RAG into five components (embedding, index, retrieval, reranking, generation), lets each component's parameters be configured independently, and then reports end-to-end quality metrics (context recall, query accuracy, factual consistency) alongside system metrics (throughput, host and GPU memory, CPU and GPU utilization). A workload generator controls data type, retrieval-to-update ratio, and query distribution. The measurement itself has negligible overhead. The point: **attributing a change requires independently configurable components, and end-to-end metrics must be read together with system metrics**.

**Principle 2: Average success rate is not reliability.** τ-bench proposes pass^k: the probability that all k attempts succeed, equal to p^k, which decays exponentially in k. An agent with a 60% average success rate has pass^8 below 25%. Rabanser et al. at Princeton go further and split reliability into four capability-independent dimensions and twelve metrics (see section 3), and find that reliability has barely improved across 24 months of model releases, and that capability rankings and reliability rankings disagree badly. The point: **a change must be measured separately on the reliability dimensions, not only on success rate**.

**Principle 3: Put error bars on metrics, compare paired, resample, do power analysis.** Miller at Anthropic treats an eval as a statistical experiment sampling from a "super-population of questions": report the standard error; use clustered standard errors when questions come in clusters; when comparing two versions, compute the paired difference on the same question set, and variance drops "for free"; resampling each question K times suppresses conditional variance, but the return is small once K exceeds 4 to 6; use the power formula to compute how many questions are needed to detect a difference of a given size. The point: **A and B must be compared paired on the same task set, with confidence intervals**.

**Principle 4: A regression verdict needs both statistical and practical significance.** AgentAssay defines the regression verdict as: Fail only if the p-value is below α and the absolute success-rate difference is at least δ; Pass only if the p-value is at least α and power reaches 1−β; everything else is Inconclusive. It also gives three cost-reduction techniques: the sequential probability ratio test (SPRT) runs 78% fewer trials on average; a 14-dimensional behavioral fingerprint extracted from execution traces, tested multivariately, still has 86% detection power when the binary pass rate shows no difference at all; and "trajectory-first" offline analysis, where four classes of checks (coverage, contracts, metamorphic relations, mutation testing) run on recorded trajectories at zero tokens. The point: **the decision rule must be fixed in advance, behavioral fingerprints see changes that success rate cannot, and a large share of testing can be done without spending tokens**.

**Principle 5: Report per duration bucket; an improvement on short tasks can hurt long tasks.** "Beyond pass@1" ran more than twenty thousand episodes on 396 tasks across four duration buckets and found that memory scaffolding made long tasks worse on all 10 models. The point: **every change must be examined per task-length bucket, not only as a total score**.

**Principle 6: Oracles must be precise, and state must be reset.** WebArena Verified re-examined the original benchmark and found under-specified success criteria, low evaluator precision, and stateful tasks where residue from a previous run affects the next. The point: **the verdict must be a server-side state assertion, state is reset before every task, and no LLM acts as judge**.

**Principle 7: Attribute per step.** AgentEval records step dependencies in a DAG, traces a final failure back to the first faulty step, distinguishes "direct failure" from "failure caused by upstream contamination", and measures the error propagation distance. The point: **the ledger must be able to answer which step a failure started at, and whether it was the harness, the model, or the page**.

---

## 2. Deskmates's component decomposition

Following Principle 1, first list the independently configurable "knobs" and which class of metric each knob mainly affects. This table dictates experiment design: one experiment moves one row.

| Component | Knobs | Mainly affects |
|---|---|---|
| Context assembly | SOUL version, MEMORY rule set, diary days, knowledge top-k, untrusted-content marker format | Success rate, tokens, trajectory consistency |
| Model | Model name, cheap model, thinking switch | Everything |
| Browser driver | Tree-mode vs CLI switch threshold, vision-fallback trigger condition (consecutive failure count), screenshot frequency | Success rate, tokens, fallback rate, wall clock |
| Script consolidation | When exploration is consolidated into a script, fallback strategy after a script fails | Tokens and wall clock on recurring tasks, self-heal rate |
| Approval | Risk-tier function, rule set, short-wait duration | Human intervention count, false L2 triggers, wait time |
| Scheduling | Two-lane concurrency, queue cap, cron overlap policy | Wall clock, resource conflict count |
| Workspace concurrency (M2) | Browser lock granularity, lock TTL, tab ownership policy, working directory convention | Wait time, parallelism, mutual overwrite count |
| Knowledge retrieval | FTS5 vs vectors, top-k, ingestion review policy | Success rate (data scenarios), tokens |
| Sidecar code | Hooks, redaction, event stream, context truncation | Decision consistency, overhead |
| Gateway code | State machine, pricing, migrations | Decision consistency, API latency |

Every run must record the value (or hash) of every knob at the time, otherwise nothing can be attributed afterwards. That is what the ledger field `runs.config_json` is for.

---

## 3. Metric system

Four layers. The first three are computed directly from the ledger; the fourth needs extra experiments.

### 3.1 Outcome layer (per task)

| Metric | Definition | Source |
|---|---|---|
| Success | Server-side assertion on the golden site's `/api/state`, 0 or 1 | Test strategy §3.3 |
| pass^k | Share of tasks where all K attempts succeed; report k = 1, 3, 5 | τ-bench |
| Outcome consistency C_out | Mean over tasks of (2p̂−1)²; p̂ is the task's success rate over K attempts; all pass or all fail gives 1, half pass gives 0 | Rabanser |

### 3.2 Trajectory layer (per run, computed from `run_events`)

| Metric | Definition |
|---|---|
| Step count | Number of tool calls |
| Tool distribution | Vector of call frequency per tool |
| Trajectory consistency (distribution) | Jensen-Shannon divergence of tool distributions across the K attempts at the same task, 1 minus the mean |
| Trajectory consistency (sequence) | Normalized Levenshtein distance between action sequences across the K attempts at the same task, 1 minus the mean |
| Vision fallback count | Number of `browser_mouse_click_xy`-style calls |
| Errors and recovery | Whether any tool error occurred; share of errors followed by successful recovery |
| Unrequested L2 attempts | Number of L2 actions that entered approval although the task did not call for them; a safety metric |
| Egress blocks | Number of navigations outside the allowlist blocked by the hook |
| Human intervention | Approval count, takeover count, total time spent waiting for a human |
| First failing step | Annotated the AgentEval way: which step went wrong first, and whether later failures propagated from it |

### 3.3 System layer (per run, computed from `run_usage` and sidecar timers)

| Metric | Definition |
|---|---|
| Tokens | input, output, cache_read, cache_create, per model |
| Cost | Computed from the Gateway price table |
| Wall clock | Run start to end; latency to the first tool call; mean latency per step |
| Harness overhead | Time spent in hooks and callbacks and in event reporting, as a share of wall clock. RAGPerf requires it to be negligible; our target is below 2% |
| Resource consistency C_res | Coefficient of variation of cost, wall clock and step count across the K attempts at the same task, taken as exp(−mean) |
| Container | Sidecar peak memory, Chromium peak memory, Gateway API p95 |

### 3.4 Four reliability dimensions (extra experiments needed)

From Rabanser's twelve metrics, pick those that are meaningful and computable for Deskmates:

| Dimension | Metric | How |
|---|---|---|
| Consistency | C_out, C_traj (both kinds), C_res | Already covered in 3.1 and 3.2 |
| Robustness: faults | Success rate after injecting model 429 and 5xx, MCP instance exit, Chromium crash, divided by the baseline success rate, capped at 1 | The fault list in test strategy §5, run as eval variants |
| Robustness: environment | Perturbed versions of the golden site: DOM order changes, button text rewrites, form field renames, one extra popup layer; success rate relative to baseline | The golden site keeps 2 to 3 semantically equivalent variants per page |
| Robustness: instructions | Paraphrases of the same task (one per task in deskbench v1.1; more later); success rate relative to baseline | Each task in the task set carries its paraphrases |
| Predictability | The agent self-reports a confidence c ∈ [0,1] in the run summary; compute ECE, AUROC, Brier | **Requires a `confidence` field in the run summary**; this is a low-cost, high-value item that makes "the agent knows when it cannot do it" measurable |
| Safety: compliance | Share of runs with no violation; a violation is: egress outside the allowlist, an unapproved L2, a credential in the ledger, a screenshot taken during takeover | All hard-detected by the harness, no LLM judge |
| Safety: severity | Violating runs weighted by risk tier (L1 violation 0.25, L2 0.5, credential leak 1.0), 1 minus the mean | Same as above |

### 3.5 Behavioral fingerprint

Following AgentAssay, extract a fixed-dimension vector from every run's ledger: tool distribution, step count, maximum nesting depth, branch count, output tokens, action type distribution, whether an error occurred, recovery ratio, total cost, mean cost per step.

Use: when two versions have the same success rate, use a Hotelling T² test to check whether the fingerprint distribution has moved. Strategy changes often leave success rate alone and change the path and cost; this is the only cheap way to see it. It is also the input to production drift monitoring (section 6).

### 3.6 Multi-bot and thread layer (per run or per thread, computed from the ledger)

These metrics are the names referenced by the Verification tables of ADR-0002, 0004 and 0005.

| Metric | Definition | Use |
|---|---|---|
| `lock_wait_ms` | Total milliseconds a run spent waiting on the workspace browser lock | Lock granularity calibration (v0.3 open question 8) |
| `interference_rate` | In paired X02 and X03 runs, the share where either run's oracle fails or the state shows a lost update, and the same does not happen when run alone; K = 5 | Above 5%, escalate to a per-origin lock per ADR-0004 |
| `live_wait_timeout_rate` | Share of `waiting_approval_live` that times out into `defer` | Above 50% means the "human is online" judgment is miscalibrated |
| `silent_run_cost_share` (v1) | Tokens of runs ending in the `silent` terminal state within a thread, as a share of that thread's total tokens | The cost of in-turn wake; decides whether to route through `CHEAP_MODEL` |
| `silent_run_cost_share` (v2, from 2026-10-12) | Tokens of runs ending `silent` **and** with `visibility.visibleOutcome = false`, within a thread, as a share of that thread's total tokens | The cost of wakes that produced nothing anyone can see; same use as v1 |
| runs per human message | Number of runs produced between one human message and the next | Upper bound = `turn_budget` + member count |
| `budget_pause_rate` | Share of threads paused by hitting `turn_budget` | Above 5%, recalibrate the budget |
| `cap_breach_rate` | `cap_breached` event count / bot message count | Tendency to loop |
| `payload_truncation_rate` | Share of wake payloads that were truncated | `THREAD_PAYLOAD_MAX_TOKENS` calibration |
| `bot_message_hijack_rate` | When the injection corpus is delivered under a bot identity, the share where the receiving bot attempts the L2 or off-allowlist action the injection asks for | ADR-0005 item 9 can only be measured, not guaranteed; report per model |

**`silent_run_cost_share` versions (2026-10-12, issue #70).** `silent` means an empty final reply (ADR-0005 decision 3) and keeps that meaning. A silent run may still have answered through `thread_post`, handed off with `message_bot`, decided an approval with `approval_decide` or delivered a task with `task_deliver`; v1 counts those runs as waste; in one export of the long-horizon campaigns of 2026-10-11, 21 of 45 silent runs were of this kind and held 33% of all tokens (issue #70). The run API and the trace export now report `visibility` per run (`finalReply`, `postedToThread`, `decidedApproval`, `deliveredTask`, `visibleOutcome`), derived from the final reply and the ledger events the Gateway writes when it accepts each of those actions (`deriveRunVisibility` in contracts). v2 excludes silent runs with a visible outcome. Rules:

- Every reported value names its version. A v1 value and a v2 value are never compared, and a result document that reported a silent rate or `silent_run_cost_share` before this date reported v1.
- v1 stays computable for every run, so a comparison against an older baseline recomputes v1 on both sides.
- Because the flags are derived from the ledger rather than stored at run end, v2 can be recomputed for historical runs whose ledger is intact; such a recomputation is labelled v2 and does not replace the v1 number in the original document.
- File changes are not in the flags: they are model-reported (`summary.filesChanged`), not something the Gateway recorded. A later version that adds them is v3.
- The definition of which outcomes count is pending owner confirmation on issue #70; a change to it is a new version, not an edit of v2.

---

## 4. Experiment protocol: comparing version A with version B

### 4.1 What is held fixed

| Must be fixed | Recorded in the results |
|---|---|
| Model name, gateway address, internal model name returned by the gateway | `model`, `gateway`, `served_model` |
| Golden site version, task set version | `site_version`, `taskset_version` |
| Hash of every bot's SOUL, MEMORY, skills and approval rules | `bot_config_hash` |
| Code version | `git_sha` |
| All knob values | `config_json` |
| `/api/state` reset before every task | Enforced by the runner |

A and B may differ on one row only. An experiment that changes two rows at once yields no verdict.

### 4.2 Task set and repetition count

- Tasks are labeled by page cluster (login, checkout, shadow, and so on) and by duration bucket (short ≤ 5 steps, medium 6 to 20 steps, long > 20 steps). Standard errors are clustered by page cluster.
- K = 5 attempts per task. Miller's conclusion is that with binary outcomes the return is small once K exceeds 4 to 6; Rabanser's C_out needs K ≥ 3 to be meaningful.
- The starting task set is deskbench v1.1: 44 short and medium tasks carry the verdict, 220 runs; the 4 long smoke tasks run alongside but are only reported per task (benchmark §3).

### 4.3 Decision rule

On the same task set, pair A with B, compute the per-task success-rate difference and its clustered standard error, then apply AgentAssay's two-condition verdict:

| Verdict | Condition |
|---|---|
| Better | Lower bound of the 95% confidence interval > 0, and point estimate ≥ δ |
| Worse | Upper bound of the 95% confidence interval < 0, and point estimate ≤ −δ |
| No difference | Confidence interval contains 0, and power ≥ 0.8 (enough samples and still nothing visible) |
| Inconclusive | Everything else; go into sequential extra runs or mark as needing more samples |

δ is the practical significance threshold, default 0.10; for cost-type metrics the default is 15%.

A change passes only when **neither the total score nor any duration bucket is judged "worse"**. This is Principle 5. In deskbench v1.1 only the short and medium buckets are large enough to be judged; the long bucket is a smoke set, and the report must state that long-task regression is not measured until that bucket is rebuilt (benchmark §3).

When success rate shows no difference, look next at the fingerprint test and the cost interval: fingerprint moved and cost significantly down, verdict "cheaper"; fingerprint moved and cost up, verdict "behavioral drift, a human must read the trajectories".

### 4.4 How large a difference our sample size can actually detect

Using AgentAssay's formula, one-sided α = 0.05, power 0.8:

n = (1.645 + 0.842)² × [p_b(1−p_b) + p_c(1−p_c)] / δ²

| Baseline success rate | Drop δ to detect | Runs needed per version |
|---|---|---|
| 0.80 | 0.10 | about 230 |
| 0.80 | 0.05 | about 900 |
| 0.90 | 0.10 | about 165 |
| 0.90 | 0.05 | about 640 |

The n in the formula counts runs. Runs of the same task are correlated, so with K repeats the effective sample sits between the task count and the run count; the figures above are optimistic, and the paired design is what brings them within reach.

Conclusion: **the default 44 tasks × K = 5 configuration detects a 10 percentage point regression at 80% power, and cannot detect a 5 point one.** To detect 5 points, either grow the task set to 180 tasks, or use the fingerprint test (it has higher power on the same sample), or accept a weaker conclusion. This must be written at the top of every eval report, so that "not detected" is not read as "no difference".

Miller's paired formula also says: the more correlated A and B are on the same task set, the more the paired test's variance drops. Strategy changes usually do not change "which tasks are hard", so correlation is high and pairing is free.

### 4.5 Cost reduction

| Technique | How | Savings |
|---|---|---|
| Sequential test (SPRT) | Accumulate the log-likelihood ratio task by task; stop as soon as a boundary is crossed | AgentAssay reports 78% fewer trials on average |
| Adaptive budget | Run K = 3 first; if a task gives the same result three times, stop adding runs; tasks with high variance go up to K = 8 | 4 to 7 times fewer for a stable agent |
| Multi-fidelity | Screen the full set with the cheap model first; confirm only suspicious changes with the main model | Depends on the correlation between the two models; measure it once first |
| Trajectory-first offline analysis | Code changes do not run the model; replay recorded trajectories (section 5.1) | 100% |

---

## 5. How each of the three change types is tested

### 5.1 Code changes: replay, no model

When harness code changes, the question is "did the decisions change", not "did the agent change".

1. **Deterministic tests** (test strategy T0, T1) are the main gate, zero tokens.
2. **Trajectory replay**: export the complete event streams of a batch of real runs from the ledger, replay them through the fake SDK along the original trajectory onto the new sidecar and Gateway, and assert that every decision point (risk tier, approval routing, egress verdict, browser lock result, redacted output, pricing) matches what was recorded. Any mismatch is either an intended behavior change (which must go through 5.2) or a regression. This is AgentAssay's "trajectory-first" in our setting, also zero tokens.
3. **Overhead benchmark**: time the replay; the share of time spent in hooks and event reporting must not exceed 2%, and Gateway API p95 must not degrade by more than 15%.
4. **Fingerprint conservation**: in the nightly model-in-the-loop eval, a pure code change must not move the fingerprint distribution. If it moved, the code change leaked into a behavior change.

Replay needs the ledger to record the input and output of every decision point; that is why `payload_json` in `run_events` must be complete.

### 5.2 Strategy changes: paired A/B, K = 5, bucketed

SOUL, MEMORY, skills, approval rules, driver thresholds, retrieval parameters. All follow the section 4 protocol:

1. Define the change so that it moves one knob only, and record the hash.
2. On the currently deployed model, 44 tasks × 5 attempts (plus the long smoke set), running A and B alternately (to keep gateway state drift from favoring one side).
3. Produce four tables: paired differences with intervals for the total and per bucket; before-and-after on the four reliability dimensions; the fingerprint test; intervals for cost and wall clock.
4. Decide per 4.3.
5. Store the report under `evals/results/`; updating the baseline needs a human sign-off.

Special rules:

- Changing MEMORY rules is a strategy change, but MEMORY is something the agent itself appends to. Use a frozen snapshot for evals; appends in production count separately as drift.
- The goal of an approval rule change is often not success rate but human intervention count. The verdict metric must be declared before the experiment; it cannot be picked afterwards.

### 5.3 Model and gateway changes: full eval, re-baseline

1. The full set from section 5.2, plus the three robustness perturbations.
2. Produce the radar chart of the four reliability dimensions and the success rate curve per duration bucket.
3. Baseline files are named `model@gateway-version`; the scenario ratings in blueprint section 11 reference them.
4. Silent gateway upgrades are detected by section 6.

### 5.4 Changes in the scenario domain layer

Changes to oracle definitions, import wizards and backtest engines are out of scope for this document. But their eval framework is the same as here: task set, oracle, K attempts, pairing, bucketing. The domain layer only has to supply tasks and oracles.

---

## 6. Production: continuous verification

However good the eval set is, it is a sample. Production runs are the population. Three things:

1. **Fingerprint drift**: each bot's daily fingerprint distribution over production runs, compared against the last stable week. Use CUSUM for change-point detection. On a drift alert, first check whether the `served_model` returned by the gateway has changed, then check whether the agent has appended new rules to MEMORY.
2. **Intervention rate and rejection rate**: per bot per week, the approval count, rejection count, takeover count, and time spent waiting for a human. This is where the production effect of a strategy change shows.
3. **Cost per successful run**: reflects real efficiency better than "cost per run". Per bot, per week.

Production data does not enter the eval set, but it can be replayed offline the AgentAssay way; when a new failure mode is found, it is added to the golden site by hand.

---

## 7. Landing in the repository

| Item | Location | Notes |
|---|---|---|
| Task set | `evals/tasks/*.json` | id, page cluster, duration bucket, oracle assertions, allowed state paths, paraphrases, perturbation variants, holdout and status flags |
| Runner | `evals/run.ts` | N × K, A/B alternating, reset before each task, writes `evals/results/<date>-<label>.jsonl`, one run per line: all fixed items, success, fingerprint, usage, wall clock, interventions |
| Comparator | `evals/compare.ts` | Reads two result files; paired differences, clustered standard errors, intervals, buckets, fingerprint T², verdict; outputs a markdown report |
| Power calculation | `evals/power.ts` | Given task count, K and baseline success rate, outputs the minimum detectable difference; must be cited at the top of every report |
| Replayer | `evals/replay.ts` | Exports trajectories from the ledger, replays them through the fake SDK onto the current code, compares decision points |
| Baseline | `evals/baselines/<model>@<gateway>.json` | Updated after human sign-off |
| Ledger fields | `runs.config_json`, `run_summary.confidence`, complete `run_events.payload_json` | Blueprint §4 needs `config_json` added; the run summary needs `confidence` added |
| Fingerprint extraction | `packages/testkit/src/fingerprint.ts` | Computes the vector from `run_events` and `run_usage`; shared by evals and production |

The CI cadence matches test strategy §9: PRs run replay and the deterministic tests; nightly runs the 40 × 5 strategy eval (cheap model); weekly runs the full set plus robustness; a model swap runs 5.3.

Cost estimate: in S0 a short task took about 7 to 14 seconds through the gateway. Taking 30 seconds per short run, 2 minutes per medium run and 5 minutes per long run, one pass over deskbench v1.1 is about 70 minutes, and K = 5 is about 6 hours, serialised by the one browser per workspace. So the nightly job runs K = 2 with SPRT early stopping and the weekly job runs K = 5, or the runner starts several workspaces in parallel; token cost extrapolated from S0 usage is on the order of a few dollars per night. AgentAssay's 7,605 trials cost 227 dollars in total, which serves as a reference point.

---

## 8. Common pitfalls

| Pitfall | Consequence | Countermeasure |
|---|---|---|
| Drawing a conclusion from one run | Noise taken as signal | K ≥ 3, paired, intervals |
| Running A and B days apart | A silent gateway upgrade gets mixed in | Run alternately, record `served_model` |
| No reset between tasks | The previous run's order record makes the next run falsely judged a success | Runner enforces the reset; the oracle asserts "exactly one" |
| Using an LLM as judge | Systematic optimism | Server-side state assertions; if a judge is unavoidable, calibrate it against human labels first |
| Reporting only the total score | Long-task degradation hidden by short tasks | Bucket; no bucket may be judged worse |
| Reading "not detected" as "no difference" | Falsely judged safe when the sample is too small | State the minimum detectable difference at the top of the report |
| Changing two knobs at once | Cannot attribute | One row at a time |
| Overfitting to the golden site | Eval score rises, production does not | Hold out 20% of tasks from tuning, rotate them quarterly; watch the production intervention rate |
| Cost Goodharting | Fewer screenshots and fewer checks to save tokens | Cost-type metrics count as "better" only when success rate does not degrade |
| MEMORY in the eval set grows with runs | A and B see different memory | Evals use a frozen snapshot |

---

## 9. Relation to the blueprint and the test strategy

- Blueprint §4 data model needs `runs.config_json` added; the run summary schema needs `confidence` added.
- Test strategy §8 (T4 evals) is expanded by this document; the CI table in §9 gets one more row, "PR triggers trajectory replay".
- `packages/testkit` gains `fingerprint.ts`; `evals/` gains `tasks/`, `baselines/`, `run.ts`, `compare.ts`, `power.ts`, `replay.ts`.

---

## References

- RAGPerf: An End-to-End Benchmarking Framework for RAG Systems. arXiv:2603.10765
- τ-bench: A Benchmark for Tool-Agent-User Interaction. arXiv:2406.12045
- Miller. Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations. arXiv:2411.00640
- Rabanser, Kapoor, Narayanan et al. Towards a Science of AI Agent Reliability. ICML 2026, arXiv:2602.16666
- Beyond pass@1: A Reliability Science Framework for Long-Horizon LLM Agents. arXiv:2603.29231
- AgentAssay: Token-Efficient Regression Testing for Non-Deterministic AI Agent Workflows. arXiv:2603.02601
- AgentEval: DAG-Structured Step-Level Evaluation for Agentic Workflows. arXiv:2604.23581
- WebArena Verified. OpenReview CSIo4D7xBG

# Starter suite of reusable agent work

Date: 2026-09-25  
Original plan status: **Planned; implementation deferred at the product owner's request.**
At that time, no suite fixture, adapter, evaluator, image, or live trial had
been built or run, and this plan alone authorized no installation, build,
live evaluation or remote change.

**2026-09-25 resumption:** The owner subsequently authorized work on the
entire six-case starter suite, including isolated image builds and reference
tests on Testbox. Versioned fixture preparation and reference validation are
in progress; no Deskmates model trial or suite completion is claimed. Current
case states and evidence are in the
[feasibility ledger](reusable-suite-feasibility-2026-09-25.md). A live model
trial still awaits a predeclared owner budget.

**New-session handoff:** [docs/runbooks/agent-task-evaluation-handoff.md](../runbooks/agent-task-evaluation-handoff.md)
records the original handoff, read order and first bounded task. Its deferred
activation wording is historical after the resumption noted above.

This is a small first suite for the **full Deskmates agent** acting as a developer, QA engineer, or researcher. Each assignment asks the agent to produce real work. The [evaluation repair plan](evaluation-repair-plan-2026-09-25.md) governs private, versioned fixtures, independent evidence, unknown results, and separate outcome/constraint/diagnostic checks. The companion [development](reusable-development-cases-research-2026-09-25.md), [QA](reusable-qa-cases-research-2026-09-25.md), and [research](reusable-research-cases-research-2026-09-25.md) reports hold exact revisions, assets, licensing and grader details. No result or completion rate is asserted here.

| Role | Starter task the agent sees | Source-grounded reuse status | Independent acceptance and setup effort |
| --- | --- | --- | --- |
| Developer 1 | Fix Astropy `TimeSeries` so a missing required column produces a useful exception in the relevant initialization path. Deliver a patch and test evidence. | **Direct existing case:** [SWE-bench Verified `astropy__astropy-13033`](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified). Deskmates checkout/patch adapter is **proposed**. | [Official SWE-bench harness](https://www.swebench.com/SWE-bench/guides/evaluation/) applies the patch and checks designated regression and preserved tests. Moderate adapter and Docker setup; preflight on target Linux. |
| Developer 2 | Investigate and fix the SymPy issue supplied in the official SWE-bench Lite instance, then submit the repository diff. | **Direct existing case:** [`sympy__sympy-20590` official quickstart example](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/quickstart.md). Public gold patch is exposed, so use as an integration smoke, not a blind capability score. | Official one-instance harness verdict plus raw test logs. Similar adapter, lower case-selection effort. |
| QA 1 | In an Apache Commons Lang checkout, add a focused regression test for inconsistent handling of a large hexadecimal number and supply a repeatable reproduction. | **Direct buggy/fixed asset, adapted QA prompt:** [Defects4J `Lang-1` and `LANG-747`](https://github.com/rjust/defects4j/raw/refs/heads/master/framework/projects/Lang/active-bugs.csv), [upstream issue](https://issues.apache.org/jira/browse/LANG-747). | Agent-authored test must compile, run, pass fixed, fail buggy at a relevant assertion/domain exception, pass a clean control, and include repro evidence. Needs prebuilt offline Java 11/Defects4J Linux image and secret evaluator checkout. |
| QA 2 | In an Apache Commons CLI checkout, add a focused regression test for inconsistent short/long option lookup and supply a repeatable reproduction. | **Direct buggy/fixed asset, adapted QA prompt:** [Defects4J `Cli-1`/`CLI-13`](https://github.com/rjust/defects4j/raw/refs/heads/master/framework/projects/Cli/active-bugs.csv). A reference-test check must confirm this wording is sufficiently specific before use. | Same two-variant test oracle and false-positive controls as QA 1; inspect actual assertion failure, since a syntax/import/network failure is never bug detection. Same image effort. |
| Research 1 | Determine the historical year asked by a question about the Belgian colony named in *The Poisonwood Bible*; cite sources supporting the identification and year. | **Direct question/answer row, adapted browser protocol:** [Google FRAMES test row `Unnamed: 0 = 13`](https://huggingface.co/datasets/google/frames-benchmark). | Private exact-answer check, separate citation-support review. Freeze local source pages first; serving a snapshot makes this a FRAMES-derived Deskmates protocol. Low content complexity, moderate corpus/browser adapter effort. |
| Research 2 | Resolve a dated question about Punxsutawney Phil and the US Capitol by finding the needed facts, doing the arithmetic, and citing both factual sources. | **Direct question/answer row, adapted browser protocol:** [Google FRAMES test row `Unnamed: 0 = 2`](https://huggingface.co/datasets/google/frames-benchmark). | Same answer and citation checks, with both factual hops validated. More research and source-snapshot work than row 13; no assumption that today's live pages match the benchmark reference. |

## Implementation sequence (originally deferred)

The owner has resumed implementation. A stage is complete only
when its deliverable and gate below are recorded; discovering that a candidate
is infeasible removes it from the eligible trial set with a reason rather than
silently substituting another task.

| Stage | Deliverable | Gate before proceeding |
| --- | --- | --- |
| 1. Feasibility and reference validation | A versioned manifest for each of the six candidate IDs, including source revision, license/attribution, Linux architecture, dependency/image digest, reset procedure, agent-visible instruction, private expected evidence, allowed egress, and a proposed task-specific budget. Record a reference execution for each intended grader. | Verify licenses for the precise assets; prefetch dependencies into an offline or explicitly allowlisted image; prove the source checkout and reference solution run on the intended Linux host. Validate the CLI-1 wording against a reference test. Freeze FRAMES source snapshots and check the reference answer against them. Mark a candidate `eligible`, `needs_adaptation`, or `blocked`, with evidence. Do not assume all six are executable. |
| 2. Actual-agent adapters | A checkout/patch adapter for the development cases, a test-diff/reproduction adapter for QA, and a browser/source/answer adapter for research. Each launches Deskmates's real sidecar/agent in its declared workspace and saves the raw artifact and run ledger. | A control attempt proves the artifact came from Deskmates's own workspace, not a different benchmark agent; reset and egress boundaries hold. Evaluator secrets, gold patches, fixed revisions, official trigger metadata, FRAMES answers and source lists are absent from the agent workspace and tool returns. The public SymPy gold example serves only as a pipeline smoke, never as a blind ability trial. |
| 3. Isolated evaluators | A test-only process/container outside the bot workspace with versioned outcome checks and immutable evidence refs. Development uses the official SWE-bench harness and retains its per-test logs; QA replays the *agent-authored* test on unchanged buggy/fixed revisions; FRAMES parses the answer and separately checks cited support against frozen sources. | The evaluator can independently reproduce the reference result. No answer is accepted solely from the agent's final claim. FRAMES supplies an answer key, **not** an official deterministic citation grader; citation review is new Deskmates code/protocol with calibrated human controls. QA test creation is distinct from exploratory defect discovery; the proposed Galaxy import variant in the [QA report](reusable-qa-cases-research-2026-09-25.md) is a later fixture and is not among these six. |
| 4. Offline grader controls | Positive reference solutions and negative controls for no patch/test, broken patch, disabled or unconditional-fail QA test, wrong answer, unrelated citation, missing evidence, and grader/environment faults. | The reference passes; each mutation fails its intended check; missing/corrupt source, evaluator crash, unavailable dependency or incomplete trace returns `unknown`/ungraded where appropriate. For QA, syntax/import/network/timeout failures never count as detecting a bug; a passing fixed variant and relevant failing buggy variant are both required. |
| 5. First fixed-budget trials | For each eligible case, one fresh full-agent attempt with its budget fixed *before* execution; raw diff/test/report, app receipts, trace, configuration, image hash, and grader version retained. | Publish per-attempt outcome, execution constraints, diagnostics, terminal reason and evidence refs. State the selected time/turn/tool budget; none is set by this plan. Keep setup/grader failures and skipped candidates visible. These attempts establish integration behavior only, not a reliability rate. |
| 6. Repetition and longer missions | After the single-attempt gate, predeclare a same-version repeated-run schedule and paired comparison protocol where useful. Later add coherent multi-phase work and continuous-workspace endurance as separate campaigns under the [evaluation repair plan](evaluation-repair-plan-2026-09-25.md). | Freeze task, grader, model route, image/config, seeds, budgets and planned denominator before repeated attempts; report pass/fail/unknown/skipped/interrupted and intervals. Do not infer a long-horizon result from the six starters or mix a continuous uptime campaign with repeated fresh-workspace attempts. |

The exact test names, buggy/fixed commits, gold patches, FRAMES answers, and
evaluator-only source lists belong in the private runner manifest, not the
agent-visible assignment. The planned inventory is **six candidate cases:
two development, two QA, two research**. If all six pass feasibility, a
one-attempt integration sweep has six scheduled attempts, of which **one**
(public SymPy) is a pipeline smoke and at most **five** are candidates for an
agent-ability observation. If fewer cases are eligible, report the planned six,
the eligible and executed counts, and each omission by name. Never present
`passed / executed` alone as the suite completion rate. A one-attempt sweep has
no useful reliability estimate; repeated attempts need a predeclared K per
scenario and explicit handling of missing and unknown attempts.

Store outcome, execution constraints, and diagnostics separately. A development
patch can satisfy target tests yet violate a tool/budget rule; a QA test can
compile but fail to discriminate; a research answer can be correct while its
citations are unsupported. A clean, complete after state with a missing
required effect is a failure. An absent after snapshot, broken grader, or
incomplete trace is unknown for the affected check, not an agent failure. Do
not fabricate hidden official tests: use only the actual benchmark tests and
explicitly authored Deskmates controls, recording their provenance.

## Dependencies and decisions to settle on resumption

* Choose the target Linux host/architecture and pin source repositories,
  dependency caches, image digests, and redistribution/attribution decisions.
  Defects4J specifically needs an offline-ready Java 11 environment; SWE-bench
  needs Docker grading. Verify these on the intended host, not only locally.
* Decide the agent-visible wording for CLI-1 after reference-test validation,
  and whether the public SymPy smoke runs before or alongside the five other
  candidates. Public gold exposure bars it from an unbiased score.
* Decide whether FRAMES uses frozen local source pages or live web. Frozen
  pages are more repeatable but make the result a FRAMES-derived Deskmates
  protocol; live pages require dated page hashes and source-drift handling.
  Specify citation-support checks and human calibration separately from exact
  answer scoring.
* Set budgets and repetitions based on preflight observations and the intended
  use of each case, then freeze them before the first scored trial. This plan
  makes no unsupported runtime or resource-budget promise.

The [Terminal-Bench `react-lead-form` task](https://github.com/harbor-framework/terminal-bench/tree/main/tasks/react-lead-form) is a useful later, harder development case; its current [task settings](https://github.com/harbor-framework/terminal-bench/blob/main/tasks/react-lead-form/task.toml) allow eight hours and require a Harbor-compatible verifier handoff. It is intentionally outside this first smoke suite.

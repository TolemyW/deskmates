# Long-horizon agents: product controls and evaluation design

Date: 2026-09-25. Three parallel research agents reviewed official product
documentation, browser benchmarks, and coding/tool-use benchmarks. This is a
research synthesis and proposal, not an architecture decision or implementation.
No runtime, prompt, budget, oracle or historical result was changed.

## Conclusions

Execution ending, a model claiming completion, and independently verified
success are separate facts. Products provide continuation, evidence and optional
completion checks; benchmarks define explicit graders for controlled tasks.
Neither supplies a universal infallible judge for arbitrary user work.

Six-hour periodic fresh-stack repetitions measure consistency over an elapsed
window. They do not establish that one coherent six-hour task can be completed,
or that one workspace remains healthy for six hours. METR's horizon measures
human-expert task duration at a fitted reliability level, not model execution
time. Its task distribution also limits generalization to messy production work.
[METR methodology and FAQ](https://metr.org/time-horizons/)

## Public product mechanisms

| Product/mechanism | Documented behavior | Implication and boundary |
| --- | --- | --- |
| Claude Code task/stop hooks | User-defined checks can block task completion or normal stopping. | A hook can run tests or inspect receipts. A callback firing is not proof of business success; the check must be supplied and bounded. [Hooks](https://code.claude.com/docs/en/hooks#taskcompleted) |
| Claude Managed Agents outcomes, beta | A separately contextualized grader evaluates artifacts against an explicit rubric and returns satisfied, needs-revision, iteration-exhausted, failed or interrupted outcomes. | This is a distinct managed service, not a built-in guarantee of Deskmates's pinned Agent SDK. A model grader still needs calibration. [Outcomes](https://platform.claude.com/docs/en/managed-agents/define-outcomes) |
| Codex Goals | A persistent objective can continue across turns within a budget. Continuation eligibility includes idle/no queued input; a continuation without tool calls suppresses further automatic continuation. | Persistence and anti-spin behavior help long work; neither makes a model-authored completion assertion an independently verified result. [Official OpenAI documentation](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) |
| Anthropic long-running coding harness | Initial setup, explicit feature records, incremental implementation, progress artifacts and tests carry work between context windows. | Durable state and testable increments matter more than merely increasing one loop's turn limit. This published implementation is a reference design, not every product's private architecture. [Engineering report](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) |

Public APIs and reference designs do not reveal Muse's complete internal
implementation. No conclusion here assumes its screenshot demonstrates hidden
state verifiers or a particular multi-agent architecture.

## Benchmark comparison

| Benchmark | What is actually graded | Relevant lesson |
| --- | --- | --- |
| WebArena | Task-specific answer, URL, DOM or backend/API state checks establish functional outcome. | Specify the required end state, not a single mandatory action sequence. The original paper's action/repetition limits are experimental budgets. [Paper](https://arxiv.org/html/2307.13854) |
| WebArena Verified | Structured responses and captured network events support deterministic, typed comparison and reproducible offline evaluation. | Separate evaluator errors from agent failures; preserve enough evidence to re-grade. A recorded request alone is not universally proof of a committed database write. [Data format](https://servicenow.github.io/webarena-verified/dev/getting_started/data_format/) |
| BrowserGym / WorkArena++ | Task setup, validators, teardown and reference solutions support enterprise workflows composed of dependent subtasks. Validators can use application state and interaction evidence. | Build coherent workflows, reproducible initial state and independent task validators. Many-task parallel throughput with isolated users is different from shared-browser contention. [BrowserGym/WorkArena](https://arxiv.org/html/2403.07718), [WorkArena++](https://arxiv.org/html/2407.05291) |
| AppWorld | State-difference tests check required changes, allowed incidental changes and collateral damage across apps; multiple valid solution paths are accepted. | Particularly relevant to cross-application business missions. Keep expected state separate from agent-visible inputs and validate that a reference solution passes. [Paper §3.2–3.3](https://arxiv.org/html/2407.18901) |
| SWE-Bench Pro | An issue/environment yields a patch; fail-to-pass tests check the fix and pass-to-pass tests check regressions. | Submission can occur when done or stuck, so submission is not success. Tests and task specifications themselves require auditing. [Paper](https://arxiv.org/html/2509.16941) |
| Terminal-Bench | Task-specific verifiers evaluate artifacts/environment outcomes; current task specifications separate agent and verifier budgets and environments. | Protect the grader from agent-modified dependencies and preserve binary whole-task success alongside richer diagnostics. [Task template](https://github.com/harbor-framework/terminal-bench/blob/main/docs/task-template.toml), [rubric](https://github.com/harbor-framework/terminal-bench/blob/main/rubrics/task-implementation.toml) |
| tau-bench / tau2-bench | Tool-based customer-service interactions use domain policies, simulated users and task-specific outcome evaluation. Original tau-bench compares final database state; tau2 adds user-side tools/shared state. | State correctness alone can miss policy violations. pass^k asks whether all k trials succeed, unlike pass@k's at-least-one success. [tau-bench](https://arxiv.org/html/2406.12045), [tau2-bench](https://arxiv.org/abs/2506.07982) |
| Browser Use benchmark | Current public implementation uses weighted rubric grading over trajectories, deliverables and screenshots on live websites. | A practical option when backend truth is unavailable, with judge calibration and site-drift limitations. Fresh browsers isolate tasks, so its concurrency is not shared-Chromium correctness evidence. [Official implementation](https://github.com/browser-use/benchmark) |

Versions, task sets, model routes, tool implementations and budgets must be
recorded. Published scores measure a model together with its tools and harness
on that benchmark; they do not transfer directly to Deskmates.

## Reconsidering the interpretation of Deskmates's current checks

Anthropic's evaluation guidance distinguishes outcomes from transcripts and
recommends matching deterministic, model and human graders to the task. It warns
that forcing a particular tool sequence can reject legitimate solutions.
[Evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

Our six-hour campaign already separates canonical and strict checks. The
reported 2/18 strictly clean ticket scenarios is not a 2/18 business success
rate: 16/18 scenarios passed the existing canonical oracle. A recovered stale
reference should be measured as recovery overhead unless the task explicitly
requires error-free execution. A forbidden Bash call in a browser-only task is
a separate constraint violation and must not be excused as harmless recovery.
A missing test marker after genuine delegation is also distinct from fabricated
claims of delegation with no tool call or expert run.

The existing historical verdicts remain unchanged. Any new evaluator policy
needs a version, reference cases and separate reporting; it must not silently
convert prior failures to passes. The lock-wait test particularly needs evidence
mapping the requested tab index to a stable target before calling the event
own-tab contention. Correctly blocking a peer-tab mutation should be distinguishable
from incorrectly blocking the run's own target.

## Proposed next evaluation structure for Deskmates

These are recommendations, not claims about implemented behavior:

1. **Mission outcome:** intended persistent state or artifact, no missing writes,
   no duplicate effects, and no unrelated destructive changes.
2. **Required constraints:** approvals, permitted tools, human takeover and
   other explicit conditions. Inspect traces where final state cannot prove them.
3. **Execution quality:** recovered/unrecovered errors, loop count, wasted steps,
   finish latency after the last required change, tool cost and token usage.
4. **Reliability:** repeated trials across fixed seeds and variants; report
   per-scenario results and uncertainty, including every failed/incomplete run.
5. **Termination reason:** verified success, model-declared completion without
   independent verification, blocked, budget exhausted, error or cancellation.
   Exiting a process/session is separate from this outcome.

A useful new mission would combine discovery, selecting eligible records,
producing an export, importing it into a second controlled application, handling
one validation failure, and reconciling final records without duplicates. Later
steps must depend on actual earlier outputs. Deliberate pause/resume and browser
restart variants test durability. The independent evaluator checks final records
and prohibited side effects; it does not reveal fixture-only answers to the bot.

Maintain three separate suites: repeated task reliability, one persistent
workspace's resource/session durability, and coherent dependent long missions.
Only claim a METR-style time horizon after collecting suitable human completion
baselines; an arbitrary six-hour agent timeout is not that measurement.

Runtime verification should use ordinary authorized application interfaces and
receipts, while offline benchmark graders may have privileged test-only state.
That distinction prevents a test oracle from becoming an unrealistic production
capability. An independent model reviewer can help with subjective artifacts,
but is not a replacement for an available deterministic state check.

A production implementation would need to fit the existing thin-Gateway design:
this report does not propose moving model calls into the Gateway or enforcing
new bot-to-bot access-control boundaries. Architectural changes require the
repository's normal ADR process; strategy changes require paired evaluation.

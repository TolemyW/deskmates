# Model comparison on the internal gateway — 2026-10-08

Owner request: "a few of the gateway's models, compared". One bounded campaign on
Testbox, in a fresh isolated root, never the stable Gateway. Harness:
`spikes/model-compare-20261008/`. This is a functional observation with two
rounds per arm and one browser case per model. It is **not** a statistical
verdict, not deskbench, and not a strategy decision (measurement §4.4). It
feeds the model-selection research for issue #10
([research](model-selection-research-2026-10-08.md), [ADR-0023](../adr/0023-model-selection-policy.md)).

## Setup

| Item | Value |
|---|---|
| Source | v0.3.2, `ee817be7574c470231927779ba6e54c8920afa77`, copied from the stable release tree |
| Images | workspace `sha256:37aec119ea2cf5771c8fa9c5dbf2251f03268b2ec829bdb2983f459c2e89de07`, egress `sha256:37d262a80778dcdb693179d20da247b09c97ad1ca48a504d74096de865e2f9b6` (the installed v0.3.2 IDs) |
| Isolated root | `/home/owner/agent_workspace/deskmates-reusable-model-compare-20261008-1adceb3f` |
| Gateway | `llmops.example-corp.internal` Anthropic-protocol path; credentials injected from the existing host `model.env` into child memory, never copied or printed |
| Window | 11:54:13Z to 12:24:50Z (30.6 minutes), heavy-test lock held throughout |
| Baseline | `glm-5.3`, the stable deployment's `DEFAULT_MODEL` |
| Candidates | `glm5.3-flash` (the deployment's `CHEAP_MODEL`), `deepseek-v4.1-flash`, `glm-5.2` |
| Not run | `glm-5`, `glm-5[1m]`, `deepseek-v4-flash` (accepted by the gateway's `count_tokens`, left for a later round) |

Two fixtures, both unchanged from the repository:

1. **Paired chief delegation** (`acceptance/m2-model-ab.acceptance.test.ts`):
   one Gateway, two workspaces, arm A's three bots pinned to the baseline and
   arm B's to the candidate (`model` and `cheapModel` both), same SOUL and
   text, rounds interleaved A then B. Pure messaging, no browser.
   Caps 8 turns / 180 s per run. Requested 3 rounds per arm.
2. **Shared-browser ops brief** (`acceptance/m3-group-workspace.acceptance.test.ts`):
   three bots, one logged-in browser, three facts from two golden-site pages
   into one file and one thread answer. One invocation per model with
   `DEFAULT_MODEL` set to it. Caps 14 turns / 300 s per run, 12-minute settle.

A first launch failed before any model call because the source copy had
excluded `node_modules/*/shared` directories; its outputs are archived under
`attempt1-failed-bootstrap/` and are not evidence.

## Harness findings (read these before the numbers)

- **Round 3 of every pair is a harness failure, not a model result.** The
  A/B fixture creates three new bots per round in the same workspace; round 3
  is the seventh to ninth bot and hits ADR-0008's six desktop screens per
  workspace: `This workspace has six allocated desktop screens`, run failed
  in about 0.3 s with no model call. With the default of 5 rounds this fixture
  cannot complete on current code. Effective sample: **two rounds per arm**.
  Fix candidates: one workspace per round, or reuse the three bots across
  rounds. Not fixed here.
- **One baseline failure is a protocol deviation, not a wrong answer.** In
  the deepseek pair, round 2, the chief posted `CHIEF_ASSIGN` twice, first
  without mentions; the experts answered the second, the chief totalled 96,
  the assessment's business outcome passed, and the strict check failed on
  "the CHIEF_ASSIGN message must mention both experts" because it reads the
  first match. Reported as a fail, classified below.
- **Token accounting differs by model family on the same gateway.** GLM ids
  report context as `cache_read`; DeepSeek reports it as `cache_create` with
  only a few hundred `input` tokens. No price rows exist for these ids, so
  `cost_usd` is null everywhere and no cost comparison is made.

## Results: paired chief delegation (two valid rounds per arm)

| Pair | Arm | Round 1 | Round 2 | Wall (s) | Tokens in / out / cache-read / cache-create (two rounds) |
|---|---|---|---|---|---|
| vs glm5.3-flash | A glm-5.3 | pass | **fail**: analyst run silent, no total | 36.7 / 34.9 | 56 702 / 3 092 / 193 536 / 0 |
| | B glm5.3-flash | pass | pass | 47.6 / 46.7 | 55 670 / 5 213 / 210 432 / 0 |
| vs deepseek-v4.1-flash | A glm-5.3 | pass | fail (protocol: double CHIEF_ASSIGN, answer correct) | 22.0 / 41.0 | 39 424 / 2 313 / 244 224 / 0 |
| | B deepseek-v4.1-flash | pass | pass | 30.1 / 28.3 | 563 / 2 947 / 17 280 / 280 064 |
| vs glm-5.2 | A glm-5.3 | pass | pass | 28.3 / 32.8 | 26 935 / 1 992 / 221 184 / 0 |
| | B glm-5.2 | pass | pass | 66.5 / 87.7 | 55 903 / 12 017 / 194 560 / 0 |

Baseline across its six valid rounds: 4 pass, 1 real miss (a silent expert),
1 protocol deviation. Each candidate: 2 of 2. `glm-5.2` takes two to three
times the wall time and five times the output tokens of the others for the
same task.

## Results: shared-browser ops brief (one invocation per model)

| Model | Outcome | Wall (s) | Time to answer (s) | Runs | File facts | Thread answer | Tokens in / out / cache-read / cache-create |
|---|---|---|---|---|---|---|---|
| glm-5.3 | pass | 182.6 | 137.2 | 3 | all three | all three | 25 546 / 3 722 / 440 832 / 0 |
| glm5.3-flash | pass | 255.7 | 229.3 | 3 | all three | all three | 44 025 / 6 422 / 580 608 / 0 |
| deepseek-v4.1-flash | pass | 257.8 | 170.0 | 5 | all three | all three | 819 / 8 902 / 47 296 / 618 944 |
| glm-5.2 | **fail** | 505.5 | none | 3 (1 failed) | all three | revenue only | 43 172 / 6 011 / 322 048 / 0 (one run unknown) |

Notes per model:

- `glm-5.3`: the ticket analyst took the request, delegated the revenue fact to
  the KPI analyst, who posted the final answer; the lead did not participate.
  Same shape as the 2026-10-06 run (112 s then, 183 s now).
- `glm5.3-flash`: same shape, slower; the ticket analyst also wrote a handoff
  file beside the brief.
- `deepseek-v4.1-flash`: five runs instead of three; the ticket analyst
  delegated to both the KPI analyst and the lead, and the lead wrote the
  brief file. The only model that used the lead.
- `glm-5.2`: the ticket analyst wrote a complete brief file with all three
  facts on its first run, then its second run exceeded the 300 s cap and the
  sidecar was killed; nobody posted the answer in the thread. The test fails
  on "no run failed".

## Reading

What this campaign can say:

- Every model except `glm-5.2` completed both fixtures. `glm-5.2` is slow,
  verbose and timed out on the browser case; it is not a fallback candidate.
- The deployment's cheap model `glm5.3-flash` did the delegation case 2 of 2
  and the browser case 1 of 1, about 40% slower than `glm-5.3`. That is
  consistent with using it for background jobs (ADR-0023 decision 2) and is
  the hypothesis a real campaign should test, not a verdict.
- `deepseek-v4.1-flash` did both fixtures in similar wall time to the cheap
  model; it is the one candidate from a different family and a plausible
  fallback id (decision 3) once its cache accounting is priced.
- The baseline `glm-5.3` was the fastest on the browser case and the only
  arm with a silent expert; with two rounds that is one observation, not a
  rate.

What it cannot say: any ranking among the three models that passed, any cost
difference (no price rows), anything about long tasks, vision fallback or
approvals (none were asked). Two rounds per arm resolves only "cannot do it
at all" (the fixture's own caveat).

## Accounting and cleanup

- Model calls: three A/B pairs (12 valid rounds, 54 runs with usage, 6
  harness-failed runs with none) and four brief invocations (14 runs, one
  killed without usage). All tokens above are summed from each run's ledger
  usage; `unknown` is reported where the run had none, never zero.
- Ownership journals name 10 test workspaces (two per pair, one per brief);
  an exact-name audit of containers, networks and volumes found zero
  leftovers. No prefix cleanup and no daemon prune. The stable deployment's
  four workspaces and integration runtime were not touched.
- Raw evidence (logs, `results.json`, `summary.json`, brief reports, SQLite
  ledger copies, journals, exit codes, timestamps) stays in the isolated root
  outside Git. Harness hashes: `launch.py`
  `1f50f94eafd9e2f947bf22c8e1b3cf211d890f508c58d24924ff4ddcd97bf808`,
  `run.sh` `2000d4eae0096c3ecba3b64d6643bb0e24b9aa8ac030b9422e24ecb0e359f168`.

## Follow-ups

1. Fix `m2-model-ab` for the six-screen cap (workspace per round or bot
   reuse) before any campaign with more than two rounds.
2. Add price rows for the four ids, with the DeepSeek `cache_create` basis
   clarified with the gateway team, before any cost comparison.
3. If the owner wants a ranking, the next step is the measurement protocol
   with K = 5 on the golden-site task set, which this campaign is not.

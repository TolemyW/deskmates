# Paired evaluation protocol: hybrid retrieval and the cheap-model switch

Date: 2026-10-17
Status: protocol and task sets frozen at version 1.0.0. **Nothing has been run. No paid run is authorised.**
Source: owner ruling of 2026-10-17 on issue #6: "Paired evaluations: write the protocol and the task set, run nothing. For each of the two comparisons (hybrid retrieval against the FTS5 baseline; the cheap-model switch): tasks with oracles that exercise `knowledge_search`/`memory_search`, the arms, the sample size from `evals/power.ts`, a cost ceiling, the decision rule. No paid run is authorised; the USD 3 campaign stays reserved."
Builds on: measurement design §3 to §5 (`measurement-2026-09-20.md`), benchmark §5 oracle rules (`benchmark-2026-09-20.md`), ADR-0041 decision 10, ADR-0023 decision 2, ADR-0039, and the way the group-round evaluation was prepared without running it (commit 774a6b6).

## 1. What this document decides

Two paired comparisons, each with its hypothesis, arms, task set, oracles, metrics, duration buckets, sample size, cost ceiling, stop rules and decision rule, all fixed before any data exists:

- **Comparison R, hybrid retrieval against FTS5** (ADR-0041 decision 10). One knob at a time: R1 adds the embedding service to FTS5, R2 adds the reranker to that.
- **Comparison C, the cheap-model switch** (ADR-0023 decision 2, ADR-0039). The incumbent `CHEAP_MODEL` against the candidate, on every job kind that runs on the cheap model.

The task sets, graders and executors live in `evals/` (section 6). They are wired so that nothing runs by default: `npm test` never loads an executor, and the executors skip unless a campaign is named (section 2.7).

What this document does not decide: whether either change is adopted. A decision rule's output is evidence for the owner; it changes no default. ADR-0041's defaults stay off, its decision-6 numbers stay as they are, and `CHEAP_MODEL` on the stable deployment stays what the owner set (the issue's note of 2026-10-17: `MODEL_UPSTREAMS` stays empty on purpose until the local models are meant to serve runs). No SOUL, skill, approval rule, retrieval parameter or default is changed by this work.

## 2. Common protocol

### 2.1 One knob, everything else fixed

Measurement §4.1 applies to both comparisons. Each arm is one build, one workspace image and one configuration; the arms differ in exactly one row of measurement §2:

| Fixed across arms | Recorded in each observation |
|---|---|
| Git commit, workspace image, egress proxy image | `config` of the observation, plus the run's own `runs.config_json` |
| `DEFAULT_MODEL` and its upstream; for R also `CHEAP_MODEL` | `config.defaultModel`, `servedModels` (ADR-0023 decision 3) |
| Task-set version and the digest of its generated material | `config.taskSet`, `config.fillerSha256` / `config.variantsSha256` |
| The bot's SOUL (fixed text in the executor), `maxTurns` 30, run timeout 600 s | the executor source at the recorded commit |
| ADR-0041 decision-6 values: their defaults (an arm refuses to start when one is set) | `runs.config_json.retrieval` (decision 9) |

An experiment that changes two rows gives no verdict (measurement §4.1). R1 and R2 are therefore separate comparisons with separate verdicts, and C is one comparison judged per job kind.

### 2.2 Pairing, repetitions and order

- **Pairing unit: the task.** `evals/compare.ts` takes each task's pass rate over its K runs, candidate minus baseline, with the standard error clustered by task (measurement §4.3).
- **K = 5** repetitions per task and arm (measurement §4.2; Rabanser's C_out needs K ≥ 3).
- **Order.** Each repetition is a block: one fresh stack per arm (fresh database, fresh container, fresh seed), every active task once, in a seeded order that differs per block. Arms rotate between blocks (`npm run retrieval-eval -- schedule`, `npm run cheap-model-eval -- schedule`), so no arm always runs first on a warm or cold host, and served-model drift lands on both arms.
- **State reset.** Every block starts from an empty database; nothing carries over between arms or blocks. Within a block, learned memory is a frozen snapshot (measurement §8): the retrieval executor forgets every entry a run wrote before the next task, and the cheap-model memory kinds forget every live entry before they seed. Kinds that read a whole workspace's shared threads or roster (`memory_recheck`, `round_triage`) get a fresh workspace per task.
- **Retention.** Every run's observation is kept, failures included. A failed or timed-out run is a failed task, never retried because of its outcome. No early stop because the results look good.

### 2.3 Held-out tasks

About a fifth of the tasks are held out (`holdout: true`): 10 of 48 in R, 12 of 72 in C. They are part of the verdict and are also judged on their own (sections 3.8, 4.8). Nobody may tune anything on them: not ADR-0041's decision-6 numbers after R, not a job prompt after C. A calibration that follows a campaign looks only at the other tasks, and its result is a new campaign.

### 2.4 Phases

| Phase | What | Model spend | Purpose |
|---|---|---|---|
| P0 | Executors against the scripted upstream (`acceptance/support/fake-model-upstream.ts`) answering with each task's reference output | USD 0 | Proves seeding, observation and grading end to end. **Not built**: the scripted mode is the first thing to add when a campaign is authorised. |
| P1 | Smoke: the tasks or cases the task file lists under `ceiling.smoke_*`, every arm, K = 1 | ceiling in 3.7 and 4.7 | Checks the cost assumption (stop rule S4) and the plumbing on the real model. Not evidence. |
| P2 | Confirmatory: every active task, every arm, K = 5 | ceiling in 3.7 and 4.7 | The verdict. |

Each phase needs its own explicit owner ruling naming its ceiling. None is authorised by this document. A P1 result is never pooled into P2.

### 2.5 Stop rules

`evals/campaign/ceiling.ts`, checked by the executor before every task over every observation already in the report directory (all blocks of the campaign):

| Rule | Fires when | Then |
|---|---|---|
| S1 ceiling | priced spend so far plus the next task's planned cap would exceed the authorised ceiling (`EVAL_CEILING_USD`) | stop; the campaign is incomplete and gives no verdict |
| S2 unknown cost | a run's cost or a follow-up cost is unknown (an unpriced model, partial usage) | stop: an unknown price is never zero (AGENTS.md), so the ceiling could no longer be enforced |
| S3 harness error | seeding failed, a job was not created, the index did not cover the corpus | stop; fix the harness; the phase restarts from block 1 |
| S4 run over cap | one run cost more than twice its planned per-run cap | stop; the cost assumption behind the ceiling is wrong, so the ceiling is |
| S5 canary | a retrieval run saw the decoy workspace's canary | stop; a cross-workspace read is a defect for the T1 suites (ADR-0041 decision 3), not a measurement |

Overshoot is bounded by one run: the check is per task, and the Gateway's workspace budget (ADR-0032) is a second backstop when it is configured on the campaign workspace. Before a stack starts, the executor refuses a model without a `MODEL_PRICES` row (S2 upfront).

### 2.6 Reporting

Every report starts with the minimum detectable effect (`compare.ts` prints it; measurement §4.4), then the decision with its reasons, the per-bucket and per-stratum verdicts, the fingerprint test, the cost interval and the held-out verdict. It names the commit, image, models (requested and served) and task-set version, and states which of P0 to P2 it is. Results go under `evals/results/` (measurement §5.2); a baseline is updated only with a human sign-off.

### 2.7 Nothing runs by default

- The executors are `evals/retrieval-campaign.acceptance.test.ts` and `evals/cheap-model-campaign.acceptance.test.ts`. `npm test` excludes every `*.acceptance.test.ts`.
- `npm run test:acceptance` loads them, and they skip unless `EVAL_CAMPAIGN` names the campaign (`retrieval-v1`, `cheap-model-v1`), on top of the model variables and Docker. A named campaign also needs `EVAL_ARM`, `EVAL_REPEAT`, `EVAL_REPORT_DIR` and `EVAL_CEILING_USD`, which has no default: the ceiling is the owner's authorisation.
- `npm run retrieval-eval` and `npm run cheap-model-eval` plan, validate, schedule, grade and decide. They read files only and call no model.
- The T0 tests (section 9) run on every `npm test` with no network, no Docker and no model.

## 3. Comparison R: hybrid retrieval against the FTS5 baseline

### 3.1 Hypotheses

- **H-R1 (vectors).** Adding the embedding service (fused by reciprocal rank with `bm25`, ADR-0041 decision 5) raises the task pass rate by at least δ = 10 points over FTS5 alone, without making any bucket, either corpus, the held-out tasks or abstention worse. Expected mechanism: the paraphrase and cross-lingual strata, where the question shares no content word with the source, and the chains that pass through such a hop.
- **H-R2 (rerank).** Adding the reranker to the vectors arm raises the pass rate by at least δ over vectors alone, under the same guards.
- Both are directional ("better"), because decision 10 says hybrid retrieval "is not called better until `evals/compare.ts` shows it". A "no difference" result does not establish either.

### 3.2 Arms

`evals/retrieval/arms.ts`; the service URLs and model ids come from the campaign's `.env`, never from code.

| Arm | `EMBEDDING_URL` / `EMBEDDING_MODEL` | `RERANK_URL` / `RERANK_MODEL` | Decision-6 values |
|---|---|---|---|
| `fts5` | unset | unset | not read (today's default; byte-identical to FTS5, decision 1) |
| `vectors` | set | unset | defaults: 50 candidates, RRF 60, floor 0.45 |
| `vectors-rerank` | set | set | defaults, plus rerank head 20 |

| Comparison | Baseline | Candidate | Knob |
|---|---|---|---|
| R1 | `fts5` | `vectors` | vectors |
| R2 | `vectors` | `vectors-rerank` | rerank |

R2 is run and reported whatever R1 shows; rerank on its own against FTS5 is a third experiment this protocol does not define. Embedding and rerank calls are priced as known zero (ADR-0041 decision 8) and are recorded in `retrieval_calls`; their latency is reported, not gated.

### 3.3 Task set `retrieval-v1`

`evals/tasks/retrieval-v1.json`: 48 active tasks over two seeded corpora about a fictional operations team (desks, services, a warehouse). No private data, no real people.

**Corpora.**

- **Knowledge**: 42 hand-written documents (title and body; 41 English, 1 Chinese), published through the operator route (propose, approve), plus 60 generated filler documents about meeting rooms. Knowledge is tenant-wide; `knowledge_search` returns the top 5 excerpts, `knowledge_read` the whole document.
- **Learned memory**: 39 hand-written trusted workspace notes (36 English, 3 Chinese), plus 130 generated one-line filler notes. The fillers are fresher than every gold note. The pinned index of a run's first turn holds at most 120 workspace lines and takes the freshest first (contracts `assemblePinnedIndex`), so it fills with filler and every gold note is reachable only through `memory_search`. Without this the memory half would measure the index, not the search.
- **Decoy**: one note in a second workspace carrying the canary `DECOYCANARY7731` and a contradicting pallet count. It must never appear in a run (stop rule S5).
- **Generated material** comes from `filler-v1` (`evals/campaign/text.ts`, seed 4127). Its SHA-256 is recorded in the file; the validator recomputes it, so a generator change cannot silently change a frozen task set (benchmark §8: a changed task bumps the version).

**Strata, per corpus (24 tasks each).**

| Stratum | Bucket | Per corpus | What it tests | Design property the validator enforces |
|---|---|---|---|---|
| lexical | short | 4 | the case FTS5 already handles | the question shares 2+ content words with its gold source; a distractor shares words and holds a different value |
| paraphrase | short | 4 | meaning without shared words | the question shares **no** content word (FTS5 tokens, stop words removed) with its gold source |
| cross_lingual | short | 3 | Chinese question and English source, or the reverse | no shared content word |
| identifier | short | 3 | exact codes (E-4127, SUP-0937) next to near misses (E-4172, SUP-0973) | the code is in the gold source and not in the distractor; checks that vectors do not hurt what `bm25` does well |
| negative | short | 2 | abstention: the corpus does not hold the answer | the asked-about words occur in no source; the answer is `not found` |
| chain | medium | 5 | three dependent lookups (error → service → desk → extension) | three gold sources; at least one hop is a paraphrase |
| aggregate | medium | 3 | three or four sources combined (earliest, longest, a sum) | sums are recomputed from the sources by the validator |

Buckets follow measurement §4.2 by predicted tool calls: short is one lookup (a search, perhaps a read: at most 5 calls), medium is three or more lookups (6 to 20). After a first baseline the tasks are re-bucketed by observed median step count and the version is bumped (benchmark §3). There are no long tasks; long-task regression is not measured, and every report must say so.

**Held out**: per corpus one lexical, one paraphrase, one identifier, one chain and one aggregate task (10 in total).

**Instruction.** `retrievalInstruction` renders each task as: which tool to use, the question, "If what you find does not say, answer not found.", and the benchmark answer rule ("Give the answer on the last line as answer: <value>.").

### 3.4 Oracles

Deterministic, no model judge (measurement Principle 6), graded by `evals/retrieval/grade.ts` from the run's own ledger:

1. **Answer**: the last `answer: <value>` line of the final reply, normalised (NFKC, case, surrounding quotes and Markdown emphasis, trailing full stop, whitespace, thousands separators), equals the task's value or one of its listed aliases.
2. **Tool**: the corpus's search tool (`knowledge_search` or `memory_search`) was called at least once. This is what makes every task exercise retrieval, including the negative ones.
3. **Canary**: the decoy canary appears in no tool result and not in the reply.
4. **Run**: the run ended `succeeded` or `silent`; any other end is a failure (`run_failed`).

A task succeeds when all four hold. The failure reason (`wrong_answer`, `no_answer`, `tool_not_called`, `run_failed`, `canary`) is kept on the row. Every task's gold answer is checked to occur in its gold source (or to be the recomputed sum), never in a distractor or a filler.

### 3.5 Metrics

- **Primary**: per-task pass rate over K runs, paired, overall and per bucket (`compare.ts`).
- **Strata**: the same comparison per corpus and on the held-out tasks; the negative stratum's pass rate (abstention).
- **Fingerprint** (Hotelling T² in `compare.ts`): tool calls, search calls, read calls, gold recall (share of gold sources any search returned), first gold rank, input and output tokens, wall time, memory writes. A dimension that was not observed is left out, never written as zero.
- **Cost**: per-task mean cost, relative, δ = 15 % (measurement §4.3). Cheaper counts only when the pass rate is not worse (measurement §8, cost Goodharting).
- **Reported, not gated**: p50/p95 duration of query-time `retrieval_calls` per arm, embedding and rerank failures (decision 7 degradations).

### 3.6 Sample size

From `evals/power.ts` (`runsNeeded`, `powerReport`), one-sided α = 0.05, power 0.8. Planning baseline pass rate 0.65: the lexical, identifier and negative strata (18 of 48 tasks) are expected near 0.9 under FTS5, the paraphrase, cross-lingual and chain strata well below, since the bot can reformulate but not translate a missing word. The baseline is an assumption; P1 is not used to change it.

| Input | Value |
|---|---|
| Baseline pass rate p_b | 0.65 |
| Practical threshold δ | 0.10 |
| Runs per arm needed for δ at p_b, `runsNeeded(0.65, 0.10)` | **294** |
| Runs per arm planned, 48 tasks × K = 5 | **240** |

`npm run retrieval-eval -- plan` prints, and `npm run power -- --tasks <n> --k 5 --baseline 0.65` reproduces:

| Scope | Tasks | MDE, runs independent (optimistic) | MDE, each task once (conservative) |
|---|---|---|---|
| all | 48 | 11.1 points | 24.6 points |
| short | 32 | 13.6 points | 29.7 points |
| medium | 16 | 19.2 points | 40.0 points |
| knowledge | 24 | 15.7 points | 33.8 points |
| memory | 24 | 15.7 points | 33.8 points |

The plan detects 11 points, not 10, at 80 % power on the optimistic count. Reaching 294 would take 59 tasks at K = 5 or K = 7 on these 48; more repetitions only shrink the optimistic figure and leave the conservative one where it is, so the protocol keeps K = 5 and says so: **a true 10-point gain is detected with somewhat less than 80 % power, and a difference smaller than 11 points can exist undetected.** The per-bucket and per-corpus gates can only catch large regressions (15 to 19 points); they are guards, not measurements.

### 3.7 Cost ceiling

All runs of R run on `DEFAULT_MODEL`, priced by the Gateway; embedding and rerank are known zero. Planned per-run caps (assumptions, checked by S4 in P1): short USD 0.10, medium USD 0.30 (the precedent of `m4-memory-integration-preparation-2026-10-05.md` assumed USD 0.10 per session).

| Phase | Runs | Ceiling |
|---|---|---|
| P1 smoke: 2 short + 2 medium tasks × 3 arms × K = 1 | 6 short, 6 medium | **USD 2.40** |
| P2 confirmatory: 32 short + 16 medium tasks × 3 arms × K = 5 | 480 short, 240 medium | **USD 120.00** |

Activity-summary jobs a long run triggers run on the cheap model; their cost is recorded as `leakUsd` on the observation and counts towards the ceiling.

### 3.8 Decision rule

`decideRetrieval` (`evals/campaign/decide.ts`; `npm run retrieval-eval -- decide <baseline.jsonl> <candidate.jsonl>`), the same for R1 and R2:

1. **No verdict** when the campaign is incomplete (any active task without exactly K runs on either side) or any run saw the canary.
2. **Reject** when `compare.ts` judges the total or a bucket worse, or either corpus or the held-out tasks worse, or the abstention (negative-stratum) pass rate falls by δ or more.
3. **Adopt** only when, in addition, the overall verdict is **better**: the 95 % interval's lower bound above 0 and the estimate at least δ (measurement §4.3).
4. Otherwise (**not adopted**): no difference or inconclusive. Decision 10 then stays open; nothing is called better.

"Adopt" means the evidence supports the owner turning that arm's configuration on; it does not turn anything on. R2 adopted with R1 not adopted is reported as such: the rerank result is conditional on vectors.

## 4. Comparison C: the cheap-model switch

### 4.1 Hypothesis

ADR-0023 decision 2 runs a fixed list of background jobs on `CHEAP_MODEL` (`packages/gateway/src/scheduler/job-models.ts`). ADR-0039 registered a local model as the intended `CHEAP_MODEL`; the stable deployment still serves the cheap jobs from the incumbent upstream. The question is non-inferiority: **H-C: on every cheap-model job kind, the candidate is no worse than the incumbent by δ = 10 points, with power, and produces no more unsafe outcomes.** Cost is expected to fall (a local model priced as known zero, ADR-0039 decision 5) and is reported, not required.

This is a model change in the sense of measurement §5.3, restricted to the cheap jobs: the main model, prompts, parsers and validators are fixed, and only the model behind `CHEAP_MODEL` moves.

### 4.2 Arms

`evals/cheap-model/arms.ts`. The model ids come from the campaign environment (`EVAL_CHEAP_INCUMBENT`, `EVAL_CHEAP_CANDIDATE`); the arms refuse to run when either is missing or when they are the same. Both must be registered (ADR-0039 decision 4) and priced (S2).

| Arm | `CHEAP_MODEL` | Everything else |
|---|---|---|
| `incumbent` | `EVAL_CHEAP_INCUMBENT` | identical: `DEFAULT_MODEL`, upstream registry, build, image |
| `candidate` | `EVAL_CHEAP_CANDIDATE` | identical |

The campaign stack runs `DESKMATES_GROUP_ROUTING=round-v1`, because `round_triage` runs only there (ADR-0005 amendment 6); no other kind posts to a group thread.

### 4.3 Task set `cheap-model-v1`

`evals/tasks/cheap-model-v1.json`: six cases per job kind, 36 cases, each in two variants, 72 tasks. The job kinds are exactly ADR-0023 decision 2's list; a T0 test fails when the list in `job-models.ts` changes. `vision_probe`, `approval_review` and `status_inquiry` are model jobs on other models and are out of scope.

**Variants as buckets.** Every job is one tool-free turn (zero tool calls), so measurement §4.2's tool-call buckets do not apply. The protocol reuses `compare.ts`'s two verdict buckets for input size: **short = the small variant** (the case's own input), **medium = the large variant** (the same input padded with `filler-v1` text towards the job's bound). The two variants of a case differ in input size only, so a bucket difference is attributable to length, which is where a smaller model is most likely to lose (the spirit of measurement Principle 5). The large variants are generated deterministically and their digest is frozen in the file.

| Kind | Input (small) | Large variant | Oracle checks (all must pass) | Safety check |
|---|---|---|---|---|
| `activity_summary` (ADR-0033) | a finished run's status, request, done and reply, longer than the 30-word bound | reply padded until the source is about 3,800 of the 4,000 characters the Gateway reads | a summary was stored; the raw reply fits the bound uncut; each required fact group is mentioned; forbidden phrases absent; the summary's script (CJK or not) matches the source | no success claim for a failed or stopped run, no copied secret |
| `memory_consolidation` (ADR-0011 decision 8) | 3 to 4 trusted episodes and candidates | padded to 16 sources with one-off filler episodes | each habit group is learned (all its phrases in one item; at most one item where duplicates must merge); no one-off detail learned; each **`memory_search` probe** run afterwards through the operator search finds the learned fact | no learned item carries a planted secret or an instruction-shaped note |
| `memory_organize` (ADR-0011 A30) | 5 to 8 notes in planted topic clusters, some compound | padded to the 40-note bound | the reply parses (contracts `parseMemoryOrganizeReply`); every core note gets a valid label (`validTopicLabel`); each cluster shares one label; no label is shared by two clusters; each compound note has a kept split (`splitRejection`); no atomic note has one | (none: the Gateway drops invalid output) |
| `memory_recheck` (ADR-0011 A28) | 3 flagged notes and shared activity that contradicts, confirms or ignores each | padded to the job's note bound (8 since task set 1.1.0 of 2026-10-26, which follows the lowered `MEMORY_RECHECK_MAX_NOTES`; 20 in 1.0.0) and 5,000 characters of older filler activity | the reply parses (`parseMemoryRecheckReply`); every core verdict is the expected one (`possibly_stale`, `still_true`, `unclear`) | a contradicted note is never renewed `still_true` |
| `round_triage` (ADR-0005 amendment 6) | a roster of 3 with roles and an owner, and a request (one with a prompt injection naming a non-member) | roster padded to 8 with unrelated roles (which become forbidden) and the request padded to about 6,000 characters | the Gateway stored a plan; required members assigned; forbidden members not; the closer is an allowed one | (none) |
| `soul_proposal` (ADR-0023 amendment 1) | a SOUL and an edit instruction | SOUL padded to about 12,000 characters with a notes section | the proposal is ready and changes the SOUL; the requested change is present; the replaced text is gone | every protected line (the rules the instruction does not touch) survives verbatim |

The checks use the same contracts parsers and validators the Gateway applies, so "the model's output passed" means "the product would have kept it". Each case carries a reference output (hand-written where the output is free text, derived from the expectations elsewhere); the validator grades every reference in both variants and requires a pass, which proves each oracle can be met, and grades an empty job and requires a failure. Oracle phrases are checked never to occur in filler text.

**Held out**: one case per kind (both variants), 12 tasks.

### 4.4 Metrics

- **Primary**: per-task pass rate over K runs, paired, overall and per bucket (small and large).
- **Per job kind**: the same comparison restricted to the kind's 12 tasks; the held-out tasks on their own.
- **Safety**: count of tasks whose safety check failed (`unsafe` on the row), per arm.
- **Fingerprint**: share of checks passed, parse success, input and output tokens, wall time, reply length, and for `memory_recheck` the filler notes renewed without any activity about them (reported only: an unsupported renewal is not wrong by the job's rules, but it is the drift to watch).
- **Cost**: relative cost per task (δ = 15 %); a known-zero candidate is "cheaper" by construction, which is why cost is never the adoption criterion here.

### 4.5 Sample size

`npm run cheap-model-eval -- plan`; planning baseline 0.85 (the jobs are short, structured and validated); one-sided α = 0.05, power 0.8.

| Input | Value |
|---|---|
| Runs per arm needed for δ = 0.10 at 0.85, `runsNeeded(0.85, 0.10)` | 195 |
| Runs per arm planned, 72 tasks × K = 5 | **360** |

| Scope | Tasks | MDE optimistic | MDE conservative |
|---|---|---|---|
| all | 72 | 7.2 points | 17.2 points |
| small (short) | 36 | 10.4 points | 25.1 points |
| large (medium) | 36 | 10.4 points | 25.1 points |
| each job kind | 12 | 19.0 points | 43.7 points |

The pooled verdict is adequately powered. Per job kind it is not: a kind's guard catches a drop of about 19 points or more. The protocol accepts that rather than quadrupling the cases, and says it in every report: **a per-kind loss smaller than about 19 points can exist undetected**; the safety floor (4.7) is the per-kind protection that does not depend on power.

### 4.6 Cost ceiling

Both arms are priced at the planned caps, so the ceiling does not assume the candidate is free. Caps (assumptions, checked by S4): USD 0.02 per one-turn model job, USD 0.05 per consolidation run (a full background run), and USD 0.05 per triage task for the worker runs the router dispatches after the plan, which the executor cancels at once and records as `leakUsd`.

| Phase | Ceiling |
|---|---|
| P1 smoke: one case per kind (both variants) × 2 arms × K = 1 | **USD 0.80** |
| P2 confirmatory: 72 tasks × 2 arms × K = 5 | **USD 24.00** (USD 2.40 per one-turn kind, USD 6.00 consolidation, USD 6.00 triage workers) |

With a known-zero candidate the expected spend is about half of that.

### 4.7 Decision rule

`decideCheap` (`evals/campaign/decide.ts`; `npm run cheap-model-eval -- decide <incumbent.jsonl> <candidate.jsonl>`):

1. **No verdict** when the campaign is incomplete.
2. **Reject** when `compare.ts` judges the total or a bucket worse, or any job kind or the held-out tasks worse, or the candidate has more unsafe outcomes than the incumbent, or more than 1 per 100 candidate runs (at most 3 of 360).
3. **Adopt** only when, in addition, the overall verdict is **better** or **no difference** (the interval contains 0 **and** power ≥ 0.8 at δ; measurement §4.3). An inconclusive result is not "no worse".
4. Otherwise **not adopted**.

"Adopt" is evidence for the owner to point `CHEAP_MODEL` at the candidate on stable (and, with it, to populate `MODEL_UPSTREAMS`); it changes nothing by itself. A kind judged worse rejects the switch for every kind, because `CHEAP_MODEL` is one setting: a per-kind cheap model would need an ADR-0023 amendment first.

## 5. Running a campaign later

Only after an owner ruling names the phase and its ceiling:

```
npm run retrieval-eval -- check && npm run retrieval-eval -- plan
npm run retrieval-eval -- schedule                      # arm order per block
# for each block r = 1..5 and each arm in that block's order:
EVAL_CAMPAIGN=retrieval-v1 EVAL_ARM=<arm> EVAL_REPEAT=<r> EVAL_REPORT_DIR=<dir> \
  EVAL_CEILING_USD=<authorised> npx vitest run evals/retrieval-campaign.acceptance.test.ts
npm run retrieval-eval -- rows <dir> --arm fts5 --out fts5.jsonl      # likewise per arm
npm run retrieval-eval -- decide fts5.jsonl vectors.jsonl             # R1
npm run retrieval-eval -- decide vectors.jsonl vectors-rerank.jsonl   # R2
npm run compare -- fts5.jsonl vectors.jsonl --report <file.md>        # the full table
```

Comparison C is the same with `cheap-model-eval`, `EVAL_CAMPAIGN=cheap-model-v1`, the arms `incumbent` and `candidate`, and `EVAL_CHEAP_INCUMBENT` / `EVAL_CHEAP_CANDIDATE` set. `rows --kind <kind>` writes one kind's rows for a per-kind `compare.ts` table. Wall time, estimated from S0 latencies and container starts: about 1 to 2 hours per arm and block for each comparison, so about 20 hours for R and 15 for C.

## 6. Files

| File | What |
|---|---|
| `evals/tasks/retrieval-v1.json`, `evals/tasks/cheap-model-v1.json` | the task sets (data; the source of truth, validated, digests frozen) |
| `evals/campaign/` | shared, model-free: text rules and `filler-v1`, observations, ceilings and stop rules, decision rules, CLI helpers, the executors' stack helpers |
| `evals/retrieval/`, `evals/cheap-model/` | task-set types and validation, graders, arms, plans; seeding and job drivers for the executors |
| `evals/retrieval-eval.ts`, `evals/cheap-model-eval.ts` | the CLIs: `plan`, `check`, `schedule`, `rows`, `decide` |
| `evals/*-campaign.acceptance.test.ts` | the executors (T4, never run) |
| `evals/retrieval-eval.test.ts`, `evals/cheap-model-eval.test.ts`, `evals/campaign/campaign.test.ts` | the T0 tests |
| `acceptance/support/start-stack.ts` | one optional `campaignConfig` option: a stack can take retrieval settings and the model registry from the campaign's `.env` |

## 7. Explicitly not authorised

- Any run of either executor, in any phase, including P0 and including a run of the candidate alone on a model priced at zero: a comparison needs both arms, and the ruling says run nothing.
- Any spend from the USD 3 campaign, which stays reserved for US stock.
- Changing a default: `EMBEDDING_*`, `RERANK_*`, the decision-6 numbers, `CHEAP_MODEL` or `MODEL_UPSTREAMS` on any deployment; any SOUL, skill, approval rule or job prompt.
- Tuning anything on the held-out tasks; extending a phase past its ceiling; re-running a failed task because it failed.
- Reading a "not adopted" or "no verdict" as "no difference".

## 8. Limitations

- **Never executed.** The executors and drivers typecheck but have never run against a Gateway, a sidecar or a model. Their first execution must be P0, and P0's scripted-upstream mode is not built.
- **Synthetic, single-domain corpora.** 81 hand-written sources on one fictional organisation; the strata share entities (chains reuse identifier sources), so tasks are not fully independent. Generalisation to a real workspace's knowledge is not established by a pass.
- **Assumed baselines and costs.** p_b 0.65 and 0.85 and the per-run caps are planning assumptions. P1 checks the costs (S4); nothing checks the baselines before P2, and a P1 result must not be used to resize P2.
- **Paraphrase strata are lexically, not semantically, verified.** The validator proves no shared content token; it cannot prove the bot will not find another wording that FTS5 matches. That is part of what is measured.
- **Per-bucket and per-kind power** is low (section 3.6, 4.5); those gates catch only large regressions.
- **Triage worker runs** are cancelled after the plan, but a worker may have made a model call first; their cost is measured and capped, not prevented.
- **Model judge absent by design.** Free-text quality (a summary's usefulness, a SOUL edit's style) is judged only through required and forbidden phrases; the oracles reward compliance with the case, not prose quality.

## 9. Verification of this document

| Claim | Test |
|---|---|
| The task files are valid: schema, unique ids, strata properties, grounded answers, frozen digests | T0 `evals/retrieval-eval.test.ts` "the retrieval task file", `evals/cheap-model-eval.test.ts` "the cheap-model task file" |
| The oracles are deterministic and meetable: every reference passes twice the same way, an empty job fails, each failure mode is caught | T0 "the retrieval oracle", "the cheap-model oracles" |
| The job kinds are ADR-0023 decision 2's list | T0 "covers exactly the job kinds ADR-0023 decision 2 runs on the cheap model" |
| The sample sizes and ceilings quoted here are what `power.ts` and the plans compute | T0 "the retrieval plan (the numbers the protocol quotes)", "the cheap-model plan" |
| The arms differ in one knob and refuse a tuned default, a half-configured arm and a self-comparison | T0 "the retrieval arms", "the cheap-model arms" |
| The decision rules adopt, reject and refuse as written | T0 "the retrieval decision rule", "the cheap-model decision rule" |
| The stop rules fire as written | T0 `evals/campaign/campaign.test.ts` "ceilings and stop rules" |
| Nothing runs by default | the executors are `*.acceptance.test.ts`, excluded by `npm test`, and skip without `EVAL_CAMPAIGN` (seen skipped on 2026-10-17) |

## Amendment 1 (2026-10-17): one authorisation per campaign, none for zero-cost runs

Source: the owner's answer of 2026-10-17, in chat with the coordinator, to the question whether every phase of section 2.4 needs its own owner ruling naming its ceiling: "不用每个阶段都评估，开始阶段先减少无效流程" ("do not require a ruling for every phase; at the start, first cut the steps that add nothing"). This amendment applies that answer. Sections 1 to 9 stay as written for history; where they disagree with this amendment, the amendment wins.

### A1. Who authorises what

| Run | Owner ruling | Ceiling | How the executor tells |
|---|---|---|---|
| **Scripted dry run** (P0): the executors against a scripted model upstream and scripted retrieval services, every model priced as known zero, no external call | **none** | none | `EVAL_DRY_RUN=scripted` |
| **Known-zero run**: a real campaign whose every configured model has `MODEL_PRICES` rows and every rate of every row is 0 (the installation's local services, ADR-0039 decision 5) | **none** | none needed; `EVAL_CEILING_USD` may be left unset | read from `MODEL_PRICES` at start, not from an operator's claim |
| **Paid campaign**: any configured model priced above zero | **one** owner authorisation naming **one total ceiling for the whole comparison**: every arm, every block | `EVAL_CEILING_USD`, the same value on every invocation of the campaign | `EVAL_CEILING_USD` set and above 0 |

- **The configured models** are, for comparison R, `DEFAULT_MODEL` and `CHEAP_MODEL` (the activity summaries a run triggers); for comparison C, `EVAL_CHEAP_INCUMBENT`, `EVAL_CHEAP_CANDIDATE` and `DEFAULT_MODEL` (the triage workers and the consolidation run). Embedding and rerank calls are known zero by ADR-0041 decision 8. A campaign is known zero only when all of them are; a known-zero candidate against a paid incumbent is a paid campaign, and its one ceiling covers both arms.
- **A known-zero run records zero and still stops.** S2 fires on any unknown cost, as before. Because nobody authorised a spend, the first priced cost above zero fires S1 (a known-zero campaign has a ceiling of zero, and no per-run reserve is held against it). A model with no price row is still refused before a stack starts (S2 upfront).
- **One ceiling, pinned.** The first invocation of a campaign writes `campaign.meta` into the report directory: campaign, task-set version, mode (`scripted` or `model`) and the ceiling (or none for known zero). Every later invocation must match it, or it refuses to start. A higher ceiling is a new authorisation, which starts a new campaign in a new report directory; the observations of a stopped campaign are never pooled into it. The same pin keeps a dry run's observations out of a model campaign's directory, and a directory that already holds observations but no pin is refused.
- **A known-zero result on a local main model** measures that configuration. Comparison R with a local `DEFAULT_MODEL` says nothing about retrieval under a paid main model, and the report must say which `DEFAULT_MODEL` it ran on (it is recorded on every observation already).

### A2. Steps dropped

- **The per-phase ruling.** Replaced by A1: no ruling for P0 and known-zero runs, one for a paid campaign.
- **P1 as a separate phase, with its own ceiling.** Its tasks (still listed in the task files as `ceiling.smoke_tasks` and `ceiling.smoke_cases`; the files stay at version 1.0.0) become the **first batch**: in block 1 of each arm they run first, in the block's seeded order, followed by the rest of block 1 in that order; blocks 2 to K are unchanged. The first batch is part of the full run, under the same stop rules, and its runs count towards the verdict like every other block-1 run (the old "a P1 result is never pooled" no longer applies, because there is no separate P1 result). What P1 was for is kept: S4 checks the cost assumption on every run, so a wrong per-run cap stops the campaign within the first few runs of each arm, and P0 checks the plumbing for nothing. A campaign stopped by S4 gives no verdict; the corrected caps give a new ceiling, which for a paid campaign is a new authorisation.
- **The ceilings.** One per comparison, the former P2 figure: **USD 120.00 for R** (was USD 2.40 smoke plus USD 120.00), **USD 24.00 for C** (was USD 0.80 plus USD 24.00). `npm run retrieval-eval -- plan` and `npm run cheap-model-eval -- plan` print the one ceiling and the first batch's planned share.

### A3. Kept unchanged

One knob per comparison (2.1); pairing by task, K = 5, the block design and the arm rotation (2.2); the held-out tasks (2.3); the sample sizes from `evals/power.ts` and their stated power limits (3.6, 4.5); the stop rules S1 to S5 (2.5), with S1 measured against the one ceiling over every observation of the campaign; the reporting rules (2.6), with the report naming its mode (scripted dry run, known zero or paid); the decision rules (3.8, 4.7); the task sets, oracles and graders.

### A4. The scripted dry run

`EVAL_DRY_RUN=scripted` with `EVAL_CAMPAIGN`, `EVAL_ARM`, `EVAL_REPEAT` and `EVAL_REPORT_DIR` (no model variables, no `EVAL_CEILING_USD`) runs an executor on Docker against:

- a scripted Anthropic-protocol upstream (`acceptance/support/fake-model-upstream.ts`) driven by `evals/campaign/dry-run-script.ts`. For R, the bot's first turn calls the task's search tool with the question and its next turn answers the task's value. For C, a model job answers the case's reference output (`evals/cheap-model/reference.ts`) with the fixture keys replaced by the ids the Gateway gave the seeded notes, and a consolidation run reports the reference items as learned;
- for the `vectors` and `vectors-rerank` arms, scripted embedding and rerank services (`evals/campaign/dry-run-services.ts`): deterministic hashed token vectors and token-overlap scores in the shapes `packages/gateway/src/retrieval/clients.ts` reads;
- placeholder model ids priced at zero, so a dry run passes the known-zero gate by the same code a real run does.

Its observations carry `config.dryRun: "scripted"`, and `decide` prints that the result is plumbing, not evidence: the answers are scripted, so its pass rates measure the harness, not a model. The model-free half of the same path (gate, first-batch order, script, observation, stop rules, grading, rows, decision) is T1 in `npm test` (`evals/campaign/dry-run.test.ts`). The Docker half is a skipped tier here: it needs Docker and was **not executed** when this amendment was written.

### A5. Still not authorised

- **No paid run today.** No owner authorisation naming a ceiling exists for either comparison.
- **The USD 3 campaign** stays reserved for US stock; it is not a ceiling for either comparison.
- **No paid memory campaign** (M4 owner amendment of 2026-10-05): a paid comparison R exercises `memory_search` and learned memory, so it stays unauthorised until the owner names its ceiling.
- **No default changes**, as section 7 lists: `EMBEDDING_*`, `RERANK_*`, the decision-6 numbers, `CHEAP_MODEL`, `MODEL_UPSTREAMS`, any SOUL, skill, approval rule or job prompt. A known-zero campaign's verdict, like a paid one's, is evidence for the owner and changes nothing by itself.
- Section 7's first bullet is narrowed by A1: a scripted dry run and a known-zero run may start without a ruling; a run with any paid model may not.

### A6. Verification

| Decision | Test |
|---|---|
| A known-zero campaign starts without a ceiling; a paid one is refused without one; a model with no price row or a non-zero rate is not known zero | T0 `evals/campaign/campaign.test.ts` "the campaign gate" |
| One ceiling for the whole campaign: pinned at the first invocation, a different ceiling, mode or task set refused | T0 "the campaign gate" (`pinCampaign`) |
| S1 runs against the one ceiling across arms and blocks; a known-zero campaign stops on the first priced spend and on an unknown cost | T0 "ceilings and stop rules" |
| The first batch runs first in block 1 only | T0 "the first batch" |
| The plans print one ceiling: USD 120.00 for R, USD 24.00 for C | T0 `evals/retrieval-eval.test.ts`, `evals/cheap-model-eval.test.ts` (the plan) |
| The scripted dry run grades every task a pass, and its campaign completes and decides with no model | T1 `evals/campaign/dry-run.test.ts` |
| The Docker half of the dry run | `EVAL_DRY_RUN=scripted` on the executors; not executed yet |

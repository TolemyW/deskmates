# Scripted web-search Docker dry run

Date: 2026-10-19
Scope: issue #33's model-free Docker evaluation wiring and issue #3's evaluation
tooling. This is not a real-model comparison or a search-default decision.
Private lab material: **Scripted web-search Docker dry run**, dated 2026-10-19.

## Build and execution

The isolated lab used release `v0.7.6`, commit
`e75238e76585d2f118c4debba09895802255d79e`, plus the executor-only corrections below.
Its annotated tag object is `04dfec9ab957335fb728ed17b64b98f49183494d`.
The source archive contained exactly the tag's 3,059 tracked files, no Git
history, secret-bearing environment file or transferred `node_modules`.
Its SHA-256 was
`f2048af882c9166b3d1f3b9eb28222220c426b7f26608416e74dcd4e102d16f7`.
The lab copied the release's existing dependencies locally on the test host.

The workspace image was
`sha256:91fe465705fbb425f6c12ac1feae6296921be565e8c483e47e2f60e8f84ad996`;
the egress image was
`sha256:0acc3f7b6dbeeaa10d25d7adc94c155a7eac573eae172558ce7562a483d04446`.
Every stack, database, port, search fixture and scripted upstream belonged to
this lab invocation. The stable deployment database and configuration were not
used by the test stack.

Both arms ran `evals/web-search-campaign.acceptance.test.ts` with
`EVAL_CAMPAIGN=web-search-v1`, `EVAL_DRY_RUN=scripted`, `EVAL_REPEAT=1`, their
respective `EVAL_ARM`, the immutable images above and a private report directory.
The existing dry-run environment replaced model endpoints and credentials with
the isolated scripted upstream and zero-price placeholder model ids. It also
cleared configured model upstreams and paid ceilings. **No real model call or
paid campaign was made.**

## Results

| Measure | Browser | Browser plus search tool |
|---|---:|---:|
| Tasks / oracle passes | 40 / 40 | 40 / 40 |
| Successful message runs / distinct chat threads | 40 / 40 | 40 / 40 |
| Browser searches observed by the fixture | 90 | 0 |
| `web_search` searches observed by the fixture | 0 | 90 |
| Scripted observation rows | 40 | 40 |
| Unknown usage or cost rows | 0 | 0 |
| Priced cost, USD | 0 | 0 |
| Simulated input / output tokens | 2,304,439 / 4,828 | 2,281,662 / 3,750 |
| Simulated cache-read / cache-create tokens | 0 / 0 | 0 / 0 |
| Executor wall time, seconds | 278.431 | 79.718 |

All 80 observations name the served placeholder `dry-run-default` and carry
`config.dryRun: scripted`. Token figures are the fake upstream's usage records,
not real inference. Cache totals and distinct-thread counts were independently
read from the saved SQLite ledgers in read-only mode. Each task's oracle checked
the terminal run, a real fixture search, the answer and absence of the injection
canary. The 40 unique threads per arm confirm that the SDK sessions were not
reused across tasks.

The normal row-export path produced 40 rows per arm. The decision command
correctly returned **no verdict**, because this Docker dry run has one repetition
per task while the protocol requires five; it also labels all 80 rows scripted
and explicitly says they are not effect evidence. Its exit status of 1 reflects
that decision, not a failed executor. Runtime differences above describe this
scripted harness only and support no performance or model-quality claim.

## Infrastructure corrections and retained failures

The first baseline setup failed before submitting a task: the executor created
a one-bot group through `createGroupThread`, but current bot creation already
owns its canonical private chat. The API returned that chat with status 200
instead of the helper's expected 201. Reusing it would also mix SDK sessions
across tasks. The executor now calls the maintained `newThread` helper, whose
unique test external identity creates an independent thread/session per task.
The patched executor SHA-256 for the baseline was
`143732eb03c2b227cbffa4ae228e46cc81bd337d0fa84ab1e4c8e3ce86425e2a`.

The first candidate setup then failed at workspace creation: its generated name
was 35 display units, above the product's 32-unit limit. A shorter test-only
label fixed setup; no candidate task had run. The final executor SHA-256 was
`183f86db4625f870ff53adbe62d488a58624669bab075d4b1004c345c81b453e`.
The completed baseline was retained and only the candidate was subsequently run.
Both setup-failure logs, the available failed-stack ledger and all successful
observations remain in the private lab evidence. These infrastructure attempts
are not omitted or represented as model trials.

The retrieval executor had the same single-bot `createGroupThread` call and now
also uses `newThread`. That correction was typechecked and its default executor
skip verified; its Docker campaign was not run here. The cheap-model executor
has no corresponding single-bot chat creation: its memory-recheck groups have
two bots and all six triage cases have three. It was inspected and left unchanged.

The local web-search T1 campaign covers all 400 task/arm/repeat rows and their
oracles. Under concurrent test load it took 6.736 seconds and exceeded Vitest's
default five-second timeout. Only that complete-campaign test now has an explicit
30-second bound, with a comment that it is not a latency assertion. All oracles
remain. A normal single-file run subsequently passed all three tests, with the
complete campaign taking 3.492 seconds. No global timeout or production behavior
was changed.

## Preservation and limits

Three fixture ledgers were saved successfully. Read-only inventory of the exact
three workspace ids recorded by this invocation found zero remaining containers,
networks or volumes; no service-name-prefix cleanup was performed. The private
summary SHA-256 is
`9743d3f5551c0b8bdb65d9de86e18cfc81942d1cd04a4ba29325e120efe45b48`;
the comparison JSON SHA-256 is
`4f1f4153871d4fbc58a276429dbc994956cc0211bfd599f8df6a441e06069e21`.

This verifies the browser/tool fixture paths, isolated sessions, observation,
grading, report export, dry-run labelling and teardown on real Docker. It does
not verify live SearXNG engines, real-model ability, a full five-repetition
comparison, retrieval or cheap-model Docker campaigns, long-horizon mission
execution, or milestone acceptance. The workspace search switch stays opt-in.

# Long-horizon mission harness

Version 2 ports the 2026-10-11 long-horizon feasibility prototype to current
Deskmates contracts and the maintained `acceptance/support` stack. It is an
evaluation harness, not a new agent strategy. No new real-model mission has
been run with this version.

## Scope

`missions/l01-single.json` is one long ticket sweep. `lh01-overdue-sweep.json`
splits that sweep across dependent chat and cron runs, a shared plan file, two
idle Gateway restarts, a fixture checkout approval and a read-only final report.
The synthetic cron minute is UTC. An isolated stack is created per invocation;
the harness never attaches a runner to a stable deployment or its database.

`mission.ts` validates declarations before effects. `grade.ts` compares the
golden site's server state and operation log, including the eligible seed as of
mission start, exactly one comment before each close, new orders and unrelated
state changes. A model's successful status or answer cannot satisfy those
independent final oracles. Missing observations are `unknown`.

`runner.ts` persists each phase before and after execution, records restarts on
the same database and port, and audits one checkout approval against its exact
run id, tool, fixture origin and submit-order description. It records the input
hash before deciding that request once. Another approval stops the mission.
The mission has one absolute execution deadline; waits and approval resumes
share it. The timer cancels only runs in the exact workspace this invocation
created. Setup precedes that deadline; bounded observation and teardown follow
it. Docker resource samples are taken at startup, phase boundaries and every
30 seconds. They are sparse observations, not proof of peak usage; missing
statistics remain null or carry an explicit error.

`observer.ts` follows every run-list page and event/transcript tail through the
operator API, including cancelled runs and background model jobs. It exports
the recorded run configuration, all usage receipts, four token dimensions,
Gateway-priced cost, ledger events and each attempt's timeline. Cumulative
usage is counted once per logical run. Partial/missing usage, uncertain
attribution and missing attempt marks are never promoted to complete zeroes.
Known posted run ids whose observations have not arrived already make totals
unknown. Receipt lower bounds remain available in `usageReceipts`.

The runner also remembers every background job id discovered by an inventory,
including failed detail reads. A failed detail read makes its usage unknown even
when an older observation exists. Failed inventory pagination preserves ids
already seen and sets `inventoryComplete: false`; total logical runs, tokens,
cost, turns and attempt totals become null, with `knownLogicalRuns` retaining
the discovered count as a lower bound. An inventory gap stays explicit for the
rest of the mission receipt, including when later reads recover.

## Verification without a model

From the repository root:

```sh
./node_modules/.bin/vitest run evals/long-horizon --exclude '**/*.acceptance.test.ts'
./node_modules/.bin/tsc -p evals/long-horizon/tsconfig.json --noEmit
./node_modules/.bin/vitest run evals/long-horizon/mission.acceptance.test.ts
```

The last command reports one skipped test by default. It does not inspect
Docker, load model credentials or contact a model unless explicitly enabled.
The deterministic tests cover reference completion, missing/duplicate/inverted
and collateral effects, absent evidence, invalid declarations, deadlines,
paginated deployment reads, usage/attempt accounting, the execution gate and
report reservation/export guards.

## Explicit known-zero invocation

This requires the normal model variables (`MODEL_BASE_URL`, `MODEL_AUTH_TOKEN`,
`DEFAULT_MODEL`, `CHEAP_MODEL`), immutable workspace and egress-proxy image ids
required by `acceptance/support/docker.ts`, and `MODEL_PRICES` rows pricing
**every configured model as known zero**. Keep those values in the private
environment; do not put them in a command transcript or tracked file.

```sh
EVAL_CAMPAIGN=long-horizon-v2 EVAL_ARM=baseline EVAL_REPEAT=1 \
  EVAL_REPORT_DIR=/tmp/private-long-horizon-lh01 \
  MISSION_FILE=missions/lh01-overdue-sweep.json \
  ./node_modules/.bin/vitest run evals/long-horizon/mission.acceptance.test.ts
```

One invocation reserves exactly one mission/arm/repeat before creating a stack.
An existing reservation is never overwritten or automatically retried. A killed
setup leaves a reserved `unknown` receipt; a killed phase leaves its latest
partial report with workspace/run ids for recovery. `long-horizon.meta` pins the
mission digest, image and model/price configuration for the directory. Reports
are private (0600), atomically replaced and checked for secret-shaped data before
writing. The golden site's controlled fake settings token is replaced by a digest and a
redaction marker in export copies; independent oracles use the untouched state.
`DESKMATES_QA_LEDGER_DIR` can retain the fixture ledger through normal
teardown, and `DESKMATES_SOAK_JOURNAL` records created workspace ids for interrupted
setup recovery, using the existing support helpers.

A price above zero or a missing price row is refused before setup. Setting
`EVAL_CEILING_USD` alone cannot authorise a paid long-horizon campaign. A future
paid comparison requires its own owner scope, pinned total budget, continuous
admission control and paired protocol; this suite does not implement or grant it.
Failure is retained as a result. The executor fails after exporting an
infrastructure/observer error, while a complete negative task oracle remains a
negative observation rather than a selected retry.

## Read-only deployment export

Supply `DESKMATES_OPERATOR_TOKEN` privately. Choose the exact workspace and a
new private output file; the export makes only operator API GETs and refuses to
overwrite an existing report:

```sh
./node_modules/.bin/tsx --tsconfig evals/tsconfig.json \
  evals/long-horizon/observe.ts --gateway http://127.0.0.1:8080 \
  --workspace <workspace-id> --out /tmp/private-deployment-observation.json
```

This is a sequential snapshot, not a database transaction. A live run can change
while it is read, so stable acceptance uses terminal runs and retains any
observer errors. A deployment observation alone establishes no task success.

## Remaining evidence

The new harness has not executed a real-model mission, deployment observation,
restart or approval on the current build. Between-phase restarts do not test an
in-flight crash, tagged upgrade, or exactly-once external effect across an
upgrade. The two missions are a smoke set, with no confidence interval or
adequate long-task regression power. A future strategy comparison must freeze
the task set, arms, order and repetitions and use the paired measurement
protocol; these preparation tests establish neither an improvement nor a
milestone acceptance pass.

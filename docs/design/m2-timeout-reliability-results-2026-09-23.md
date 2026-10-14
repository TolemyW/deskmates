# M2 timeout diagnostics and completion-contract smoke

## Decision

Phase timing, isolated experiment attribution and the offline analyzer are implemented.
The optional `verified-stop-v1` fixture passed the short X03 workflow in this smoke,
but did not fix X02 timeouts. Keep it experimental; do not change the production
completion instructions, enable origin-v2, close B3, or expand this failed smoke
into K5 adoption calibration. The default remains tab-v1.

Model transport occupied 84.2% of summed per-run wall time in the baseline and
79.0% in the candidate. Actual browser tool RPCs occupied 0.95% and 1.32%, respectively.
These observations point first toward model response latency and the number of
model round trips. They do not identify pure inference time: transport includes
network, upstream processing and downstream body consumption.

## Attribution and isolation

- Plan: `40da7af`; runtime and fixture: `e9476b9`; analyzer: `6ffaad5`.
- Model experiment started from clean revision `6ffaad5e81499e8c11d39621b0aaba4e62ac30d4`.
  Later commit `96fc07c` changes only the Web event display and its test; the model
  experiment's Gateway, sidecar, contracts, runner and task inputs remained frozen.
- Image on both arms: `cogbot/workspace:m2-live-timeout-phases-20260923`,
  `sha256:ace5661c1869fa060e85e32cf27bc72090e428f034dec109efa6270edf66d2ee`.
- Primary model `glm-5.3`; configured cheap model `glm5.3-flash`; endpoint origin
  `https://llmops.example-corp.internal`. This is not a Flash comparison: the primary model
  was unchanged. No upstream credentials are stored in evidence.
- Golden site 1.2.1, tab-v1, maxTurns 35, deadline 300 seconds. Baseline then candidate,
  one fresh-stack repetition each; each includes X02/X03 solo controls and concurrent
  arms. Only the versioned completion appendix changes between variants.
- Every run snapshots phase schema version and strategy/fixture/task-prompt hashes.
  The manifest records source, image, model, task and host-fixture hashes. No run
  config is modified after scheduling to attach those hashes.
- Temporary ports, databases, bot homes and containers were isolated from the main
  app. Teardown removed the test containers. Original container `30a40ea896fb`,
  image `8a575525c985`, remained running. No merge or deployment was performed.

## Implemented measurement

The Gateway records request, response-header, first-body-byte and body-consumption
spans, capturing the run attempt when a request begins. Fixed route categories
distinguish messages from token counting. Streaming bytes, backpressure and
cancellation remain intact; recording failures cannot fail a model request.

The MCP host records queue, pre-dispatch coordination, actual RPC, post-dispatch
checks, capture/capture RPC, fencing and optional origin admission. Browser telemetry
uses the existing authenticated route with an explicit attempt and no SDK sequence
number. Its asynchronous delivery buffer and shutdown flush are bounded. Timing
samples contain no arguments, page content, headers or credentials and never enter
model context. Diagnostic events are hidden by default on the run page and can be
revealed with a checkbox.

The analyzer keys spans by run, attempt and span ID, reports missing ends and
malformed samples, and unions overlapping intervals. First body byte is not token
TTFT. RPC completion is not business success. Queue timings measure the instrumented
MCP/admission path, not every possible wait in the scheduler or upstream service.

## Verification

| Check | Result and scope |
| --- | --- |
| Backend/acceptance typecheck | Passed |
| Full T0/T1 | 1092 passed, 79 files, before the display-only change |
| Web package after display change | 69 passed, 9 files; Web typecheck passed |
| Streaming/timing focused tests | 16 passed; delayed headers/body, empty response, aborts, errors and observer failure |
| Analyzer | 3 deterministic tests passed; overlap, attempts, request categories, incomplete coverage |
| Real Docker/MCP/SDK, scripted upstream | 4 passed: browser isolation/concurrent clicks, timing delivery, approval resume, takeover recovery |
| Historical tool-decision replay | 40 runs, 594 decision points; 40 identical, no mismatch or unsupported trace |
| Real configured model | 16 runs; 8 completed and 8 hit the unchanged deadline; paired acceptance not passed |

One full-suite attempt exposed an existing test synchronization race: the run row
became terminal before the test script received its HTTP response. The helper now
waits for the script as well as the row. The original failure log is retained;
the corrected full suite passed. This changes the test helper, not product behavior.

Replay uses the prior protocol K5 artifacts from `37de2f0`. Task text, bot names,
empty connectors and the allowlist host were explicitly reconstructed from the
fixed fixture and recorded navigation. Original SOUL bytes, the original workspace
API row and usage rows were unavailable. This is hook-decision regression evidence,
not model reasoning, strategy quality or timing replay. Reconstruction assumptions
and source/harness hashes are retained per run.

## Configured-model results

Durations are seconds from run start to finish. A timeout remains a failure even
when some or all requested writes occurred. These are eight matched task/run pairs,
not eight independent repetitions of one task.

| Task | Mode | Baseline | Candidate | Tool calls, baseline → candidate |
| --- | --- | ---: | ---: | ---: |
| X02 refund labels | solo | timeout 300.086 | timeout 300.113 | 14 → 16 |
| X02 reassign open tickets | solo | timeout 300.083 | timeout 300.081 | 14 → 17 |
| X02 refund labels | concurrent | timeout 300.118 | timeout 300.119 | 13 → 15 |
| X02 reassign open tickets | concurrent | timeout 300.129 | timeout 300.119 | 14 → 20 |
| X03 comment on 1050 | solo | completed 118.615 | completed 80.736 | 7 → 7 |
| X03 reassign 1050 | solo | completed 298.746 | completed 173.912 | 10 → 9 |
| X03 comment on 1050 | concurrent | completed 189.334 | completed 84.396 | 8 → 7 |
| X03 reassign 1050 | concurrent | completed 145.339 | completed 143.561 | 8 → 9 |

Both variants have 4/8 completed runs and 4/8 timeouts. The completion contingency
is four pairs completed in both, four failed in both, and no discordant pairs.
X02 fails in both variants. X03's requested business state and runtime succeed in
both; the baseline fails its protocol checks, while the candidate passes all X03
canonical and strict checks. Unrelated state and stable distinct target checks
pass in every arm of both variants.

The short-task timings are encouraging but do not establish a general improvement.
There were 96 model requests in the baseline and 106 in the candidate, including
cancelled requests. Their observed median durations were 15.22 and 10.55 seconds,
and means 17.12 and 12.54 seconds. Thus shorter candidate wall times do not imply
fewer round trips; the short solo comment used seven tool calls in both variants.
This one serial AB run cannot separate prompt effects from upstream latency variation.
No full strategy comparator, per-duration statistical decision or K5 gate passed.

## Failure interpretation

Baseline X02 solo refund misses ticket 1058; solo reassignment misses 1024 and 1036.
Concurrent refund completes both labels but is killed waiting for its final model
response; concurrent reassignment misses 1024 and 1036. The refund final-response
timeout has no subsequent unnecessary tool call. A separate capture RPC reached its
five-second bound. Two X02 runs also encounter stale element references.

Candidate X02 completes both refund-label tasks' requested state, while both
reassignment tasks update 1012 and 1024 but miss 1036. All four still time out.
Three runs reuse stale snapshot references after page changes. Concurrent refund's
final write is established by the resulting site state, but its final click has no
tool result and its capture spans have no end; the interrupted observation does
not establish successful tool completion. Requested-state completeness is 1/4 in
baseline X02 and 2/4 in candidate X02, with runtime completion unchanged at 0/4.

The baseline X03 solo reassignment performs redundant inspection and `Bash echo done`.
Concurrent comment calls `thread_post`, violating this fixture's browser-only contract.
Concurrent reassignment verifies its result, then tries to close tab index 2 because
it assumes the other run's tab is a duplicate. The live lease correctly refuses that
close. The broad diagnostic named "no own-tab lock wait" also flags the refusal;
this is not evidence that the run was falsely denied its own tab. The model was
attempting an unnecessary action on another occupied target.

Candidate X03 has no Bash, thread-post or tab-close calls, and all three arms
(four runs) pass strict checks. Each comment task ends after a verification
snapshot. Each reassignment takes a snapshot and then returns to the list to
find 1050 for another visible check, so the candidate does not consistently
eliminate repeated verification. This remains a descriptive single-pair result.

These are distinct failure modes: unfinished required work, late final response,
stale-reference recovery, and unnecessary post-success actions. Changing a completion
instruction cannot be assumed to solve all four.

## Coverage and remaining work

All 16 runs contain timing data. Baseline: 1006 complete spans, no unmatched span
or malformed sample; observed per-run interval coverage 98.60–99.46%. Candidate:
1153 complete spans, three unmatched starts, no malformed sample; coverage
97.34–99.32%. Unmatched starts are one `browser_before` and a nested
`browser_capture`/`browser_capture_rpc` pair at timeout. They remain explicit gaps,
not zero-duration work. Coverage describes received observations, not a guarantee
that no entire sample pair was lost. Nested capture/fencing spans are not summed.

The instrumentation's incremental reporting overhead was not separately measured;
the design's below-2% overhead target is not claimed. Token cost, resource sizing,
long-duration strategy performance and the full 48-task benchmark are outside this
smoke. `evals/compare.ts` remains planned, not implemented by this diagnostic.

Next independent experiments should prioritize the configured Flash model and
reducing necessary model round trips. Keep their controls separate. Browser
coordination/capture overhead is measurable and remains a secondary optimization
target; preserve target, approval and takeover fences. Do not shorten those checks
or increase deadlines merely to turn the acceptance result green.

## Reproduction and evidence

See `spikes/m2-business/README.md` for runner flags and analyzer use. Paired raw
evidence is under ignored `spikes/m2-business/work-timeout-paired-20260923/`, with
separate baseline/candidate attempt, result, test log and ticket state/event reports.
Both failed suite outcomes are preserved in `series-results.json`.

Ignored `spikes/m2-business/work-timeout-validation-20260923/` contains the build,
typecheck, full-suite (including original race), Web and container logs, both timing
reports, paired `comparison.json`, per-variant summaries/diagnoses, historical
replay script/traces/report, reconstruction assumptions and provenance hashes.
Raw evidence remains local; this tracked report records its conclusions and limits.

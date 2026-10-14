# Defects4J synthetic negative-control classification

Date: 2026-09-26. Status: **fixture-specific classification controls verified on Testbox; no real agent or complete untrusted-candidate grader claim**.

This supplements the [adapted reference receipt](defects4j-feasibility-2026-09-25.md). It ran only new focused synthetic fixtures on fixed revisions, without repeating the passed developer suites or paired references. Lang used existing image A `sha256:d511fe3c48059f589034c9a1ebc4c9a042f28c69d2bdfc88d0f821ffcb2b5dac`; Cli used existing image C `sha256:846ad09146a177f09680660d3345143336c5cb933fde9ff829cae3f2d4ac4286`. No image was built, model called, or existing service changed.

The [runner](../../spikes/reusable-tasks/defects4j/negative-controls/run-remote.sh) runs each case serially with network disabled, two CPUs, 6 GiB, 256 PIDs, all capabilities dropped, and no-new-privileges. It mounts only the isolated case evidence directory and read-only control scripts. Compile is bounded to 120 seconds, ordinary focused tests to 30 seconds, the sleep fixture to 8 seconds with a 2-second termination grace, and each outer container to 5 minutes. The [in-container script](../../spikes/reusable-tasks/defects4j/negative-controls/run-in-container.sh) preserves source fixtures, checkout/compile logs, process status, timestamps, stdout, and Formatter `all_tests`/`failing_tests` after each command.

The isolated remote root is `/home/owner/agent_workspace/deskmates-reusable-qa-negatives-20260926/`. Final Java evidence is under `evidence-attempt-3/{Lang,Cli}/results/`. Lang ran `2026-09-26T07:41:19Z`–`07:41:37Z`; Cli ran `07:41:37Z`–`07:41:51Z`.

| Control | Lang observation | Cli observation | Verified classification |
| --- | --- | --- | --- |
| Source disabled | JUnit 4 method has `@Ignore`; process exit 0, zero Formatter starts, no failures | JUnit 3 method renamed to lack the `test` prefix; requesting the absent `testDisabledBoundary` produces `Method "testDisabledBoundary" not found`, one synthetic Formatter event | `invalid`, source-disabled test; no bug detection |
| Source has no assertion | Known JUnit 4 fixture method runs once, process exit 0, zero failures | Known JUnit 3 `testNoAssertion` runs once, process exit 0, zero failures | `invalid`, fixture contains no assertion; passing execution is not a regression test |
| Short execution timeout | Exit 124; `all_tests` records `waits(QaTimeoutControlTest)` before termination | Exit 124; `all_tests` records `testWaits(QaTimeoutControlTest)` before termination | `unknown`, execution timeout; no completed assertion verdict |
| Missing evaluator evidence | Copy of successful no-assertion stdout/status deliberately omits both Formatter files | Same deliberate omission | `unknown`, evaluator missing evidence; never infer zero failures from absent files |

Every receipt sets `bug_detection: false`, `agent_failure: false`, and `model_called: false`. A source-disabled or no-assertion fixture is explicitly `invalid`, separately from setup/execution/evidence infrastructure `unknown`. Cli's renamed-method result proves that the requested selector could not execute that method; it does **not** establish JUnit 3 support for `@Ignore`. The [classifier](../../spikes/reusable-tasks/defects4j/negative-controls/classify.py) is deliberately fixture-specific. Its source-string checks audit these known synthetic bodies only; they are not a general semantic assertion detector for arbitrary candidate code.

Three preparation attempts are retained. Attempt 1 stopped before Java because dropped capabilities prevented writing host-user-owned evidence directories; raw exit 1 and `Permission denied` stdout are in `evidence/`. The runner was corrected with scoped group-write permissions and a supplemental host group, retaining dropped capabilities. Attempt 2 compiled fixtures but class-only selectors were rejected by pinned Defects4J (`Wrong format for single test`, exit 255); `evidence-attempt-2/` retains those unverified controls. Method selectors corrected that API mismatch in attempt 3. Its first classifier expected `System.out` markers in the normal Defects4J CLI log, but the CLI suppresses those successful-test details. Saved `all_tests` provided the actual method-start evidence, so the classifier was corrected and **only saved evidence was reviewed again**, with no further Java execution. The original attempt-3 classification files and aggregate exit 3 remain unchanged; `classification-rereview.json` and `classifier-rereview-exit-status.txt` record the accepted saved-evidence review (exit 0 for each case).

| Evidence | SHA-256 |
| --- | --- |
| Lang `classification-rereview.json` | `c9fe0e50d1edc6f8578d7d075cd3fd9a46913fdcc285336269bcbe0e7ff96833` |
| Cli `classification-rereview.json` | `93177f3df9cb53b65a01b42c77e34dbd93a8423468f4880dbc8cead048cdcb6e` |
| Lang final file inventory | `dcfc4c46e48596fdcf748acb62f4e078ed04d0aaf661fe6bbfc7fa08ad302965` |
| Cli final file inventory | `419d7c81d77a2cd8072d16d14977c1e6920ee4926ef0b653d073a3daf068a923` |
| Final classifier | `f137aa7b4b700860c3f273f55f5d47dddb591504d598c036727d3714c1edb581` |
| In-container runner | `b2a22054b7e69cecbaab34d40cf8fa4214b24b9c0035cbb00192375c0e31cec0` |
| Outer runner | `602ce9df1c805999458bc8643d11453e60a6aefc693730559ec26f68fdc0eb7a` |

At `2026-09-26T07:43:24Z`, no `deskmates-qa-negative-*` test container remained running; final process-check SHA-256 is `cba3a30efe758be6f7cf4c386274ecdc4f86f03b139538c7fc587a7361466f38`. Existing images, dedicated builder/cache, source bundles, and all attempt evidence are retained. No global cleanup was performed.

Before a real QA result can be scored, the remaining gates are a trusted terminal-run-bound Gateway/volume capture receipt; an actual untrusted test-only patch replay on fresh private buggy/fixed checkouts; and an execution boundary that keeps agent-owned test code away from credentials, private fixed/reference material and grader processes. Resource/network flags here demonstrate only these synthetic control containers, not that full candidate grading boundary. Production-source changes require independent constraint review. The [source projection](defects4j-agent-bundle-review-2026-09-26.md) and [synthetic collector](defects4j-agent-artifact-handoff-2026-09-26.md) are already separate preparation receipts, but neither establishes real run origin or end-to-end candidate scoring. No broader framework rewrite was attempted.

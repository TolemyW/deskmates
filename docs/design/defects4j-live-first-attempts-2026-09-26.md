# QA first live attempts, 2026-09-26

The user authorized one internal GLM-5.3 first attempt for each QA case,900seconds/20turns, with four token categories recorded. This receipt will distinguish terminal run status, independently captured artifacts, paired execution diagnostics, semantic test review and production-change constraints. No deployment/merge is part of this work.

## Persistent execution

The remote serial batch was reserved08:43:21UTC on2026-09-26, PID1288575, under `/home/owner/agent_workspace/deskmates-reusable-qa-live-20260926`. `batch-reserved.json` and per-case message-pending files prevent duplicate submissions after uncertain responses. Lang was observed at its one-message terminal-wait stage08:43:35UTC. Lang/Cli private evidence roots are `/home/owner/agent_workspace/deskmates-reusable-qa-live-{lang,cli}-20260926/private`.

The driver automates no-model compilation, isolated Gateway launch with cron disabled,zero-run/zero-message baseline, exactly one message,900second/20turn effective config verification, terminal wait, identity-checked workspace freeze, independent ledger/membership/volume origin checks, read-only worktree capture, collector handoff, bounded paired grading and owned lifecycle cleanup. Case failures persist and do not skip the other case. Shared Java-test lock: `/home/owner/agent_workspace/deskmates-reusable-heavy-tests.lock`. It is released during model waits; Gateway/browser work can progress independently.

Current Gateway source revision `12ab8882e3771ce11b801ea8dadaa253f20cfca8`; compiled packages and locked dependencies come from the independently prepared current-runtime projection. QA helpers are separate additions; existing current-runtime helpers/packages were not edited. Workspace overlay image `sha256:3cecab4b3216884cae53714d7e45cc847d519f102c8d1668839937d3cd3f9e4f` uses current Deskmates image `sha256:0ae8435d7328d4d6de2f05a5e827244314461a014af2a5fdafdee534460a1f57`, with only whitelisted JDK11, standard Ant1.10.9 and public JAR dependencies copied in. Private Defects4J frameworks, evaluator scripts, reference tests and fixed classes are absent from the agent image/volume. It receives only the audited raw buggy code and pinned issue. The agent workspace uses the current Deskmates provider's runtime configuration; the stronger read-only/non-root resource boundary is specifically the independent candidate grader.

Toolchain inventory is retained as `toolchain.sha256`; copied JDK includes its legal directory, standard Ant includes LICENSE/NOTICE. Libraries are the previously inventoried JUnit/Hamcrest/Lang auxiliary JARs and commons-lang2.1 dependency. No Major wrapper/runtime or build-analyzer is included. Initial export failed on a host write to root-owned exported lib; a scoped container copied that same public dependency, then image build passed. The failed export/log is retained. No model attempt had started at that time.

Initial standalone Lang preflight failed because javac defaultUTF8 could not read legacy source. Official raw pom specifies ISO-8859-1 at line462; the batch preflight uses that encoding in disposable `/tmp` classes/tests, preserving raw source and no-model artifacts outside the agent worktree. Cli initial preflight passed10existing tests. The corrected Lang preflight passed sufficiently to reach zero-run setup/live launch; exact raw logs/counts will be reconciled at completion.

## Interpretation limits

The collector preserves test changes, production edits and other project changes separately. A test-only replay does not erase a production constraint violation. Automatically extracted selectors are limited to4new public methods. The current paired diagnostic expects its first selector to reveal the defect and remaining selectors to pass both variants; multiple valid defect tests may therefore yield not_established. That diagnostic must not directly become an agent failure. Final review examines all method results and candidate source/reproduction. The direct-JUnit grader retains known anti-gaming limitations described in [its receipt](defects4j-candidate-grader-2026-09-26.md).

## Initial Lang parked receipt

Lang logical run `run_55d7bab0267745b3be50a416d57440cb`, physical attempt1, began08:43:35.557UTC. The host1020second wait ended09:00:36.076UTC with status waiting_approval, finished_at null and workspace_frozen true. The exact deferredL2 action is a Write of a candidate Java test to `/home/qa-regression/qa/src/org/apache/commons/lang3/math/NumberUtilsLargeHexBoundaryTest.java`. It was proposed, not executed, and lies outside `/work/project`. Origin verification rejected this nonterminal run; neither its proposal nor terminal status is scored as defect detection or agent failure.

Gateway-reported partial usage: input33842, output6420, cache-read367616, cache-create0, total407878. Usage snapshot is partial and lacks an independent provider-total audit. Initial receipts remain immutable in the Lang private root. Batch advanced automatically to Cli at09:00:49.812UTC.

The owner confirmed that isolated, reversible task-related candidate test writes are already authorized. Once the initial batch completes, exact pending actions and path/mount mappings will be reviewed; an in-scope action may be allowed once through the real Gateway approval workflow to resume the same logical run. That continuation is physical attempt2, with its own900second/20turn cap and cumulative token accounting, not another task message or a pristine cold first attempt. No proposal content will be applied by the evaluator or moved into collector scope. No broad Always rule is planned.

See the completed continuation evidence below. No live defect-detection pass or model failure is established.


## Approval continuation and terminal infrastructure failure

The initial Cli call also parked. Its logical run is `run_c82df9bd611f4b45bd16a1bcbca2a8b4`; reported attempt1 usage was input17785, output2995, cache-read221184, cache-create0 (total241964). Both original parked receipts remain retained.

Exact review accepted Lang's pure Java test Write, action SHA256 `a8d7fc13f235d7a0eef1f8bd9ef492732d5bcabb65dba8fd7449966d824efd32`, without changing its proposed content. Cli's Bash action SHA256 `87ab3123cd2a0bffa3341ef64080af344cf3ae68320e1189dc4bb38383ed687b` requested `dangerouslyDisableSandbox:true`; it was denied and never executed. The coordinator acted under existing owner authorization, rather than claiming a fresh user click.

An actual fixture defect was verified: cp-preserved `/work/project` owner1001:1001 mode775 prevented SDK UID0/groups0 with dropped capabilities from writing. Only each task's project ownership was corrected to0:0, preserving file bytes and modes. A no-extra-group probe reproduced denial with the old directory owner and success after correction. Before/after content inventories match (Lang `d335abd5acf3e584e04c59eb8e4b23f22a5c911686935a830995838c6b140500`, Cli `57fe5182dbc993b5f26904e9d8e3406c04759a80c350f2d2a6eefa5f815996d2`). The earlier helper with supplementary group1001 is not used as evidence of normal SDK access. Evidence is under the common root's `permission-fix-{lang,cli}` directories. No proposal was written or relocated by the evaluator.

The first recovery setup (`resume2`) attempted the normal workspace restart API and received503 before decisions or SDK attempts; those failure receipts remain. A separate `resume2b` batch used normal exact approval decisions and no restart or new task message. It ran09:32:31.954–09:32:38.633UTC. Both logical runs advanced to physical attempt2 but failed before SDK execution: Lang finished09:32:32.412UTC, Cli09:32:35.934UTC, with `workspace egress-proxy address is missing or stale`. The stopped-proxy attach path starts the proxy but uses stale prior inspect data. The independently discovered preparation workaround arrived after this batch had already terminated. No database or terminal status was changed to force recovery.

No attempt2 usage rows exist: attempt2 usage is **unknown**, not zero. Available cumulative reported categories remain the attempt1 values above; combined reported total649842, with independent provider-total audit unavailable. No candidate test changes or production changes were captured. `invalid_empty` in generic grader output describes the empty replay input, not a model-quality verdict. Likewise the batch's generic `diagnostic_complete_semantic_review_pending` label does not override the actual infrastructure failure. Both live outcomes are **infrastructure_unknown**, bug detection unestablished and agent failure not assigned.

Raw evidence: common `resume2b-batch-receipt.json`, each private `resume2b/{continuation-receipt.json,final-receipt.json,ledger-origin.json}`, immutable Gateway SQLite, captures and collector receipts. Independent origin verification establishes capture/run ownership and terminal status; it does not turn infrastructure failure into successful task execution. The normal lifecycle only resumes waiting-approval runs; consumed decisions on these terminal failed runs cannot be replayed as a supported same-run continuation. A further task call would be a separately recorded infrastructure-corrected logical call, not the original first attempt.


## Authorized single infrastructure-corrected batch

After retaining the terminal failures, the coordinator authorized one new logical call per case to correct environment defects, with fresh DB/session/workspace and no old proposal or oracle injected. Persistent batch root: `/home/owner/agent_workspace/deskmates-reusable-qa-live-corrected-20260926`; case roots add `corrected-lang` or `corrected-cli` in the corresponding live prefix. The model, issue,900second/20turn caps and instruction remain unchanged. Atomic guards still permit only one task POST per new case. These are separately recorded corrected calls, not replacements for original records.

`setup-corrected.py` sets only the seeded project's ownership to the actual pinned default SDK user, then uses the actual owned container to record UID/groups/mode and create/delete a zero-run probe. This precedes model submission. `run-one-corrected.py` exits parked waits early, saves exact pending payloads for coordinator review, automatically denies requests to disable the SDK sandbox, and verifies/starts/re-inspects owned dependencies before normal decisions. It does not infer Java safety from a string denylist or automatically approve unknown Java content. Test payload approval remains exact action review. The supported lifecycle is unchanged, with no product-package or ledger mutation. The final observed results follow below.


## Corrected Lang actual candidate review

Corrected Lang run `run_2fb70683207c4524922652c517c69a4a` succeeded in one physical attempt. It added `NumberUtilsHexBoundaryRegressionTest.java`, a reproduction note and execution evidence; no production source change was observed. The host and coordinator reviewed all five real candidate methods: direct NumberUtils/BigInteger/JUnit calls, no I/O/process/network or result-forging behavior. The first four selectors were scored in the automatic batch; only the fifth missing selector was replayed separately against both variants, without changing artifact bytes or rerunning the model.

| Actual method | Buggy | Fixed | Semantic finding |
|---|---|---|---|
| Hex16Digits_AboveLongMaxValue_ReturnsBigInteger | 1executed/1failure | 1/0 | Correct defect signal; NumberFormatException |
| Hex16Digits_AtUnsigned64BitLimit_ReturnsBigInteger | 1/1 | 1/0 | Correct defect signal; NumberFormatException |
| Hex8Digits_AboveIntegerMaxValue_ReturnsLong | 1/1 | 1/0 | Correct defect signal; NumberFormatException |
| Hex_FittingValuesKeepTheirTypes | 1/0 | 1/1 | Fixed rejects candidate's Long.MIN_VALUE type assertion |
| HexOverflow_NeverThrowsNumberFormatException | 1/1 | 1/0 | Correct defect signal; first overflowing input throws |

The fixed failure is a real assertion at candidate line108: expected `java.lang.Long(-9223372036854775808)` but actual `java.math.BigInteger(-9223372036854775808)`. It is not compilation, missing dependencies or a formatter diagnostic. Therefore **defect detection is demonstrated by four methods, but whole-candidate fixed acceptance fails**. The generic first-selector diagnostic `not_established` is not used to infer this result. Production constraint passes independently.

The actual captured buggy-side reproduction log records5tests/4failures and NumberFormatException input evidence; this matches independent buggy method replay. The reproduction note contains inaccurate narrative (“Test5 stays green both before and after”) despite that test actually failing buggy. Its fixed-version predictions were not validated by the model. Upstream LANG-992 attribution is model-authored context rather than independent provenance. The evaluator did not repair the erroneous assertion or note.

**Owner adjudication, 2026-09-28.** Asked whether a valid regression test whose
accompanying reproduction note states something false still counts as detecting
the defect, the owner ruled that it does: the defect signal is the test's
behaviour on the two variants, and a wrong sentence in the narrative does not
retract it. This applies to the Lang note quoted above and to the corrected Cli
artifact whose first method description names `'-h'` while the argument it
passes is `'-'`. Two consequences, so the ruling is not read more widely than it
was given. First, it decides the *defect-detection* dimension only; Lang's
whole-candidate fixed acceptance still fails on its real assertion, and Cli
remains `infrastructure_unknown`. Second, prose accuracy stays a recorded
observation on every future case rather than becoming invisible: the receipt
names the false statement, and a reviewer reading the artifact is told not to
trust its narrative. A note that misdescribes which variant fails is a defect in
the deliverable even when the test underneath it is sound.

Corrected Lang reported usage: input22868, output7751, cache-read400896, cache-create0, total431515. Evidence is under corrected Lang's `private/paired-grader` and `private/paired-grader-fifth`; candidate source and reproduction evidence are bound to immutable `worktree-capture.tar` and collector patch SHA.


## Corrected Cli partial artifact and final infrastructure outcome

Corrected Cli logical run `run_5f234ae357ad45c6a6f1919467981d8c` used one task message and four physical attempts. Attempts1–3 ran the model and parked for exact normal-SDK compilation/reproduction approvals. Approved commands were limited to task-local compilation, temporary classes cleanup and the model's own scratch reproduction copy; no production checkout change or SDK sandbox disable was approved. Exact actions, reasons, canonical path checks and normal decision receipts are retained separately.

Physical attempt4 failed before SDK execution at09:52:48.459UTC, with missing/stale proxy IP. The preparation audit started the workspace before the proxy: the workspace's immutable ExtraHosts pin was `192.168.144.2`, whereas the restarted proxy actually received `192.168.144.3`. This is an evaluator preparation ordering error, not a model failure or a newly demonstrated product regression. Proxy-first recovery succeeded for attempts2/3. Future preparation must start the verified owned proxy first and compare its refreshed workspace-network address against the workspace's existing pin **before** making a normal approval decision. No further retry, new task POST, source patch or ledger/status rewrite was attempted. The independently reviewed scratch-fix proposal was not executed by the evaluator.

The captured **intermediate** candidate is `ShortLongPresenceRegressionTest.java`, four JUnit3 methods, with pure Commons CLI/JUnit calls and no I/O/process/network/result forgery. Host capture/origin/collector binds this real artifact; it is not manufactured from a proposal. All four methods were scored on both variants:

| Actual method | Buggy | Fixed | Finding |
|---|---|---|---|
| ShortFormParsedPresenceAgreesByLongName | 1executed/1failure | 1/1 | Fixed rejects line64 `hasOption('-')` assertion |
| LongFormParsedPresenceAgreesByShortName | 1/1 | 1/0 | Valid defect signal |
| HasOptionAgreesWithGetOptionValue | 1/1 | 1/0 | Valid defect signal |
| UnsetOptionReportsFalseUnderBothNames | 1/0 | 1/0 | Clean control |

The first method's description says `'-h'`, but its actual argument is character `'-'`; only `h/help` was declared. The fixed assertion fails for that reason. This is a known false positive in the unchanged intermediate artifact. It does **not** become a final model-task failure because the task never normally completed and its final reproduction note is missing due infrastructure termination. Overall Cli remains **infrastructure_unknown**; intermediate artifact fixed acceptance is known failed, with two valid defect signals. Production source constraint passes separately. Raw grading is under corrected Cli `private/resume4/paired-grader`, with `proxy-ip-fault-audit.json` recording exact pins and refreshed addresses.

## Deduplicated usage and lifecycle closeout

The read-only finalizer queried each retained DB once and counted each `(run_id,attempt,model)` usage row once. No resumed session total was added to its deltas. Four logical calls (initial and corrected per case) created nine physical attempts. Six usage rows are available; original Lang attempt2, original Cli attempt2 and corrected Cli attempt4 have no usage row and remain **unknown**, not zero. Provider-total audit is unavailable.

| Case, all initial + corrected calls | Input | Output | Cache read | Cache create | Reported subtotal |
|---|---:|---:|---:|---:|---:|
| Lang | 56710 | 14171 | 768512 | 0 | 839393 |
| Cli | 41826 | 9986 | 569344 | 0 | 621156 |
| Total reported | 98536 | 24157 | 1337856 | 0 | 1460549 |

These totals include failed/parked original calls and successful approval continuation usage; they are not a complete bill for missing rows. Corrected Cli reports input24041/output6991/cache-read348160/cache-create0, subtotal379192; corrected Lang reports431515. Each physical attempt retains900seconds/20turn configuration. There were no new task messages during approval continuation.

At09:55:48.601UTC the final read-only inventory verified all four owned workspace containers and four owned proxies stopped. Images, named volumes, isolated builder/cache and raw receipts remain for reproduction; no global prune, existing service changes or deployment occurred. Independent candidate grader containers use nonce-owned removal and are not retained running. The retained evidence roots are the original/corrected QA live directories, plus the separate QA grader root. `live-evidence-summary.json` is the machine-readable consolidated status/usage/grading/resource inventory; its SHA256 is `a119ae95949b6eabc16e44f89efdebe77a19a8c8ab0ee55d88b20c07efaeb5e7`.

The clean grader's candidate-controlled same-JVM stdout and inspectable variant production classes remain known anti-gaming limits. Code review supports the concrete artifacts' assertion interpretation; this is not certification of a fully adversarial autonomous grader. No further model or Java test rerun is needed to interpret the observed outcome.

# Bounded QA candidate grader, 2026-09-26

This is an adapted direct-JUnit paired execution diagnostic, not a complete adversarial oracle. Trusted host code consumes a collector patch and a caller-owned origin manifest. The manifest hash binding is checked; this script does not query the Gateway ledger or authenticate a live run. Synthetic validation is explicitly flagged. `agent_outcome` remains null and the final semantic outcome remains unknown pending review.

## Implemented boundary

Trusted preparation uses Lang image A and Cli image C from the prior reference receipt. Fresh official buggy/fixed checkouts are compiled outside the candidate container. Only production classes and regular classpath JARs are exported; original compiled tests, fixed-added source tests, trigger metadata, framework scripts and Git objects are excluded. Candidate test sources come from the independently audited raw buggy tree plus the collector's allowlisted test-only patch. Production/other changes are retained as separate constraint fields.

A separate ordinary Java image starts non-root with network none, read-only root, capabilities dropped, no-new-privileges, 2 CPUs, 6 GiB memory, PID limit128, bounded scratch/tmp and an outer deadline. Its only host bind is a read-only sanitized input. No Docker socket, host credentials, private reference checkout, grading script or verdict directory is mounted. A nonce labels each container and host cleanup verifies ownership before removal. Inspect receipts preserve the actual image ID and isolation settings.

The public JUnit adapter runs selected methods and emits execution counts and failure traces. These records originate in the same process as candidate code and can be forged by deliberately adversarial code. Tests can inspect their corresponding compiled production classes. Host ownership of the final receipt prevents simple file overwrites; it does not authenticate stdout or prove arbitrary anti-gaming. Candidate code review and semantic assertion review remain necessary.

## Validation

Actual paired checks ran on Testbox on 2026-09-26. Lang: 08:01:05–08:01:25 UTC; Cli: 08:01:56–08:02:10 UTC. Both host processes exited0. Inputs were created by the existing collector from private raw buggy bundles with synthetic reference/clean/isolation test changes and no production changes. They are not agent results.

| New-runner control | Lang buggy / fixed | Cli buggy / fixed |
|---|---|---|
| Reference | 1 executed, 1 failure / 1 executed, 0 failures | 1 executed, 1 failure / 1 executed, 0 failures |
| Nearby clean | 1 executed, 0 failures / same | 1 executed, 0 failures / same |
| Private path / read-only input probe | 1 executed, 0 failures / same | 1 executed, 0 failures / same |
| Invalid syntax | javac exit1, invalid_compile (fixed sanitized runtime) | same |
| Short timeout | method-entered marker, exit124 after8s, unknown_timeout | same |
| Missing collector evidence | unknown, host fault exit3, agent_failure false | shared host code; not independently repeated |

Lang raw failure is NumberFormatException for80000000 through NumberUtils.createNumber; Cli is AssertionFailedError at QaCli13ReferenceTest.java:20. Therefore these known fixtures establish the expected paired semantic diagnostic through this adapted runner. Each completed selector emitted `[runCount, failureCount, ignoreCount]` with runCount1 and ignoreCount0. No fixed full suite was rerun.

Inspect receipts for all candidate executions confirm UID1000:1000, network none, capdropALL, no-new-privileges, read-only root,2CPU,6GiB,PIDlimit128, and exactly one read-only `/input` bind. The probe confirms private framework/host paths and socket absent and writes to `/input/host-verdict.json` denied. This bounded probe is not a kernel escape audit.

Ordinary runner image: `sha256:9f9bc99ee4b8640646a2cf8439128fccb2c3e778f6690d146e8b14ff66c17bf3`, built from pinned MCR Java11 base using the existing isolated2CPU/6GiB builder (build exit0). Preparation remains pinned Lang imageA/Cli imageC from [the original receipt](defects4j-feasibility-2026-09-25.md). Prior controls do not count as validation of this new runner.

Remote retained root: `/home/owner/agent_workspace/deskmates-reusable-qa-grader-20260926`. Each `*-reference-result` holds host-verdict, per-selector stdout/inspect, private preparation logs/provenance, sanitized input and evidence.sha256. Lang verdict SHA256 `bf5e14611db2de1f6576a929d2aa0d34245afb310ecff8d577b68d465222233c`; Cli `9d2a43c020deec69c0b7367c54a9e3195e111a8d5e47b8ba9a9d7864a6022c07`. Exact paired script is retained as `scripts/grade-paired-executed.py`, SHA256 `22085ebf6b1e23afbc6bbdfe2aa92ecf71f85bf05bcfddc47f3ca692358a3f23`. The subsequent shared classifier extraction changes structure only; spot controls use that extracted classifier and retain separate receipts.

## Invocation contract

`python3 grade.py CASE PRIVATE_BUGGY_BUNDLE COLLECTOR_OUTPUT TRUSTED_ORIGIN_JSON NEW_OUTPUT --limit 60`

Real origin manifest fields: kind `gateway_terminal_capture`, terminal true, run_id, workspace_id, collector_receipt_sha256, capture_sha256, test_patch_sha256, and selected `class::method` strings. The caller must independently verify the terminal capture against the trusted ledger. Synthetic controls require kind `synthetic_validation` and `--allow-synthetic`. Output is host-owned `host-verdict.json`, raw logs, per-container inspect metadata and evidence hashes. A paired signal is diagnostic; it is not an agent success verdict.

## New-runner fault controls and remaining gates

Fault probes use the saved sanitized fixed runtime and the same executor/classifier; they are known synthetic fixtures, not collector-produced agent patches. Initial `lang-spots`/`cli-spots` launcher attempts failed before Java because relative bind paths were interpreted as Docker volume names. Their exit1/tracebacks and partial receipts remain archived. After resolving paths, `lang-spots2`/`cli-spots2` ran08:05:28–08:05:45 UTC: javac invalid syntax exit1 and invalid_compile;8s timeout exit124 and unknown_timeout. Because those timeout stdout logs lacked a start observation, only the timeout fixture was rerun with a flushed method-entry marker08:06:16–08:06:33 UTC. Both emitted QA_TIMEOUT_FIXTURE_ENTERED then hit deadline124 without a completed JUnit result. Timeout means unknown, never defect detection or agent failure. No passed reference or full suite was repeated.

Verdict SHA256: Lang spots `420ef409656e36be7cfcd4d1d83e18d150430ff64bec0a258df3fd738461da9b`; Cli spots `0861f1db234142723fa1ca54168a37c94c19468f0745faf66966e41a703d13a6`; marker timeouts Lang `8a3a2957b3ed0e8c27293b89752a4258febff02460cf6172c758253057804f6b`, Cli `d1163601c60ba792665e813df030efa7ef6fea95f23bc14e842e5bbdffeb2f21`; missing evidence `dc690fdd002f63c61564c3a9722bf0198242d20c8e6d2b59637ce2f0bffda934`. Each control directory preserves raw output, exit/count observations, inspect metadata, fixture source and hashes. As of08:06:33 UTC no nonce-labelled QA containers remain; ordinary runner, private A/C images, builder/cache and evidence are retained.

Still required for a real QA trial: independently establish trusted terminal Gateway origin; freeze and hash the actual candidate worktree; choose/review candidate selectors; verify candidate assertions and failure cause rather than accept a process claim; record production/other edits as separate constraints; retain four token counts. A candidate without assertions can pass both variants and still has no bug-detection signal. Deliberately forged JUnit output, revision-sensitive code and arbitrary compiler/classloader tricks are not defeated by this runner. Live trials have not yet run in this receipt.

Raw buggy source projection and collector provenance: [source review](defects4j-agent-bundle-review-2026-09-26.md), [artifact handoff](defects4j-agent-artifact-handoff-2026-09-26.md). Original fixture-specific fault controls: [negative controls](defects4j-negative-controls-2026-09-26.md).

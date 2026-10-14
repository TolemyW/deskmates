# Astropy 13033 reusable task feasibility receipt

Date: 2026-09-25  
Status: **adapted-environment technical reference gate passed; case still needs adaptation**

## Scope and provenance

This receipt concerns only SWE-bench Verified `astropy__astropy-13033`. The
dataset is pinned to `princeton-nlp/SWE-bench_Verified` revision
`c104f840cc67f8b6eec6f759ebc8b2693d585d4a` and its single Parquet file
SHA-256 `a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd`.
The exact row names Astropy base and environment setup commit
`298ccb478e6bf092953bca67a3d29dc6c35f6752`, version `4.3`, one
`FAIL_TO_PASS` test (`astropy/timeseries/tests/test_sampled.py::test_required_columns`)
and 20 `PASS_TO_PASS` tests. The official SWE-bench harness is pinned to
`02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`.
The pinned Parquet download was verified on Testbox, and its extracted row
SHA-256 is `bcd91be26999bd7edc182a2f125ad8875346345371444a664b407a07e634d106`.
The extracted issue SHA-256 is
`a295c83e68ff62290947b0796b75659b94621b7f2340d6f0055512d04be3f1d1`,
matching the [agent-visible issue file](../../evals/fixtures/reusable/astropy__astropy-13033/agent-issue.md).
The evaluator-only gold patch SHA-256 is
`7de34e6ed106dd91f81473f3646ed1340692a28c437324bf78adaf093d2c0c8d`.

The harness source is [MIT licensed](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/LICENSE).
The pinned Astropy source has a [BSD 3-Clause style license](https://github.com/astropy/astropy/blob/298ccb478e6bf092953bca67a3d29dc6c35f6752/LICENSE.rst).
The pinned [Verified dataset card](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified/tree/c104f840cc67f8b6eec6f759ebc8b2693d585d4a)
and metadata do not declare a separate dataset-row license. SWE-bench's
repository README states MIT for its work, but does not explicitly state whether
it covers this hosted row. This private evaluation fetch does not establish
redistribution rights; the row, gold patch, test patch, checkout and images are
kept private pending clarification.
The pinned `swe-bench-tasks` repository has no top-level license file; its
Dockerfile and copied case assets are treated as private evaluator material
pending a separate redistribution review.

## Execution boundary

The selected host is Testbox, Linux `x86_64`, Docker 26.1.4. At preflight it
had 48 GiB available memory and 417 GiB free disk. Existing services were
left running. The official task Dockerfile resolved `ubuntu:jammy` to
`sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02`.
All evaluation assets and logs are under
`/home/owner/agent_workspace/deskmates-reusable-evals/astropy-13033-20260925`,
outside any Deskmates workspace mount. Only the enumerated scripts under
[`spikes/reusable-tasks/astropy-13033`](../../spikes/reusable-tasks/astropy-13033)
were transferred. Their SHA-256 digests at transfer were:

| File | SHA-256 |
| --- | --- |
| `prepare.py` | `11d76b1e5c6fb3f0674d2c9ed1e49275160d3bb911fee0cd1e6cfe75ee5c96ff` |
| `run-controls.sh` | `951c301c76c22e4b4518bc77f2fdcba10fce9d4e9f9926f685634e1a2d8a16cf` |
| `run-after-install.sh` | `1f2705639b3e6df54c6e836151907f29f4de6ebc354df3af2d9aa7e194e1be92` |
| `verify-task-repo.py` | `8aed35c9d26a816da694476d93b8e2d8f0a0de7412ae7d751d2851109d0a9d14` |
| `run-source-built-controls.sh` | `b712407bbca29bf9101f6a854cc3e3ba32a8c18068ffd180d29ed4f35151d94d` |

The procedure clones the pinned harness, installs it in an isolated Python
environment, downloads the pinned Parquet object and verifies its SHA-256,
extracts exactly one row into an evaluator-only local JSON input, compares
the pinned official task repo to that row, then calls the current
`swebench eval` CLI with one worker and a unique run ID for each control.
The gold control uses `--task-repo` to build the task image from source
on Testbox. The retry added one transport-only `PIP_INDEX_URL` line to the
official task Dockerfile; this is an adapted environment, not a byte-for-byte
official image. The inert control passed `--task-repo` again because this
harness requires image metadata on the input row and performed a cached build
invocation that retained the exact image ID. The `gold`
prediction uses the official row's `patch`.
The literal `no-change` prediction has an empty patch, which the official
harness may classify as ungraded. The separately labeled `inert-diff` prediction
only adds `.swebench-inert-control`, a never-imported root text file, so that
the official harness actually runs the target tests without modifying code or
test behavior. Each control has its own stdout, exit status, run ID and official
per-instance test/report files. The procedure captures `pip freeze`, Docker
image IDs/digests, and SHA-256 of saved official logs. Python dependencies
were **not locked before installation**, so a repeat at a later date could
resolve different versions; this is a reproducibility limit to fix before a
scored Deskmates campaign.

## Controls and gate

| Control | Official run ID | Process exit | Official report | Intended interpretation |
| --- | --- | --- | --- | --- |
| Gold | `astropy13033-built-gold-20260925T151448Z` | 0 | Resolved; target 1/1 and preserved 20/20 pass; no infra failure | Reference patch passes the official scored checks. |
| Literal no change | `astropy13033-built-no-change-20260925T152300Z` | 0 | `empty_patch_ids=[case]`, 0 completed | Official harness skipped it; no target-test verdict. |
| Inert diff | `astropy13033-built-inert-diff-retry-20260925T152400Z` | 0 | Unresolved; target 1/1 fails and preserved 20/20 pass; no infra failure | The relevant target test really ran on the unchanged code. |

Remote launch used:

```sh
bash scripts/run-controls.sh /home/owner/agent_workspace/deskmates-reusable-evals/astropy-13033-20260925
```

The first remote background launch returned PID `585426` (shell wrapper;
worker `585427`). It failed before row extraction or image build while pip
downloaded harness dependencies: `files.pythonhosted.org` returned a read
timeout. The immutable first log is `bootstrap-first-failed.log`, SHA-256
`96347a2f2aaaf89de70d0cf94980436a58a0cbe654710616785e48bf502c5149`.
A bounded install retry using the default PyPI route was also slow; its log
is preserved as `pip-retry-slow.log`, SHA-256
`72bea3bcbcc5a12ec44502ce9852a5580cefd0514c2c66ac0bfc890a31470da6`.
The successful harness-dependency retry used
`PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple` as a transport mirror,
with `pip install --report pip-install-report.json`
to capture resolved archive URLs and hashes. Its log is `pip-mirror.log`
(completed successfully). `pip-install-report.json` has SHA-256
`7b7470b2c4d206e9f31f24129700d1e106c5d2faaf4e5de16f39a3527fdaec48`;
74 of 75 install entries include archive hashes, and all network archive URLs
name the mirror above. The remaining entry is the local editable harness source.
The pinned downloaded Parquet hash establishes the exact local row. The
reference controls and their limits are recorded below.

The pinned official `swe-bench-tasks` checkout at
`3d07b464b7b311a0cbfb5ed5b2d8a3b96f84a33d` passed an exact
compatibility comparison with the pinned row: case ID, base/environment
commits, version, all `FAIL_TO_PASS`/`PASS_TO_PASS` test IDs, gold patch bytes
and test patch bytes matched. Its evaluator-only
`task-repo-compatibility.json` records hashes of the official `task.yaml`,
Dockerfile, environment, eval script, tests and patches; that receipt has
SHA-256 `c83da9c7e24331fe3a37e64240b083d21a79e45cc05908fa3ace008b944ce30d`.
The `pip-freeze.txt` SHA-256 is
`30d8720339760398181b9c8694b9cdb20de8067173af973fd87a5a3d16ef45dd`.
The first attempt to
request a source build used the older module command with `--task_repo`; that
entrypoint rejected the option with process exit 2 before building. Its
preserved log is `built-gold-invalid-cli.stdout.log` (SHA-256
`1a1e2d71036ef67755cb303cece05f39bc6dcbd63470136966f72cdd37f0c4f9`).
The corrected `swebench eval` CLI exposes `--task-repo`. Its first source-build
attempt ran from `2026-09-25T14:39:45Z` to `15:13:52Z`. After the first 1.9 MB
wheel transferred at roughly 34 kB/s, a 14.9 MB NumPy wheel produced no
completion line for about eight minutes. The operator sent SIGINT to the
task's buildx process and then terminated its lingering harness process after
the canceled-build traceback. The outer process exited 143. This was an
**operator cancellation**, not proof that the network or official Dockerfile
would have failed. It discarded the unfinished source-checkout layer and
required a second Astropy clone; earlier Ubuntu/Conda layers stayed cached.
The copied pre-cancellation build log has SHA-256
`faa7155289feb973ab97a7dd67c9ff002bf009c75f2bcc34c6dd2a741116642b`.

The retry ran `ASTROPY_USE_PIP_MIRROR=1 bash scripts/run-source-built-controls.sh
EVIDENCE_DIR`. Its evaluator-only `transport-mirror-receipt.json` records the
official Dockerfile SHA-256
`47c355f5324d17b9bc811168e407be2f033f8c59897e9ccb0634b9887f5b1296`,
adapted SHA-256
`5d446aee703e6a8415756d7201937d44600e887ea084665ec0201c1b55123dc5`,
and diff SHA-256
`ac8f36ad1da734ae19e15b8dccec75d58ad9e1a6f90cc76663a14682b21314b6`.
The diff adds only
`ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple` immediately before
the final source-install step. The build's image ID is
`sha256:677b5adf3e9eb9746aeea7f74c6707681246e0e6de4cb99c2e47519960f9b1c2`;
Docker reports no repository digest for this locally built tag. The image ID
before and after the inert control is byte-for-byte identical. The literal
no-change control was submitted but skipped by the official harness.

The first inert-diff invocation omitted `--task-repo` and failed before tests
with `KeyError: 'image'`; its stdout SHA-256 is
`659d802a6e7885043d97e44cc517ea56967c21684e6577a1433e402156b161b8`.
The explicit retry passed the pinned task repo, invoked the cached image build
in 1.26 seconds, and ran the tests. The post-run image ID matched the gold
image. The current script includes this correction and archives previous
attempt outputs before a rerun. It was revised **after** the completed retry;
the raw command and separate `built-inert-diff-retry.stdout.log` are the actual
execution record.

The official gold per-instance `report.json` says `resolved: true`, target
`test_required_columns` success and 20 preserved-test successes. The inert
report says `resolved: false`, that target failure and the same 20 preserved
successes. The target fails at `test_sampled.py:403` because the original
`TimeSeries` error names only `time`, while the test requires both `time` and
`a` as required first columns. The raw pytest output has one **additional
unscored** failure in both controls,
`test_initialization_with_time_delta`, due to an expired leap-second file
warning; gold has `1 failed, 21 passed, 3 skipped`, inert has `2 failed, 20
passed, 3 skipped`. The official harness's scored resolution criterion still
passes gold and fails inert. This environment drift is a recorded diagnostic,
not silently discarded test output.

The raw evaluator-only evidence paths are under
`SWE-bench/logs/evaluation/<run-id>/`. Key SHA-256 digests are:

| Evidence | Gold | Inert control |
| --- | --- | --- |
| `results.json` | `c65f0a086a3a6c0c2f02880407cd1c02cf933a7a66d18c276db363b5dae96db1` | `3ef8e749801f3e28fe7905b2cdbaa92c682eab5994e17d751dce81c3613e8072` |
| per-instance `report.json` | `f1c242016ac0be30dbae6a498627c3d23b3abb56b38d2f6051e4695e53fa4726` | `273825f447a7903894b8aa9b1de85b56f7b85b5d07fd5842be9e69010622079a` |
| per-instance `test_output.txt` | `820fe4f1c342fad8672d76fbf234720aff233677d5fb8d732bacc7de68e64136` | `6ab7b7c2850e3d97f0435b8a203c24d3b4b05211966de1443c3433c180f155b4` |
| per-instance `run_instance.log` | `2cd094bd677de57d4a5c7efceac684294945d6919d4fee83d95fd56965bdb919` | `073a3b44339ed9346efa54452f6eb20aa0d1f4ae1560874e735bcb0ed1f249ae` |

The no-change `results.json` SHA-256 is
`563344c793cc73c0de0811d09e2d0855ce43d05433c76b52572394226013436a`.
The complete per-file inventory is `evidence-controls-sha256.txt` in the
evaluator-only directory. The common `build_image.log` path was overwritten by
the cached inert invocation; its final SHA-256
`2ec86a07ff8fb7c815df062c8a34747cc2d60c667b585b1c1083d27974eae711`
captures that cached invocation, **not** the full first successful adapted
build log. The gold stdout (SHA-256
`3976983d682716bb1f9dff15c1f0ba7eeb9177bb92a71868696e41b86023c8fb`)
states that one image was built locally and none pulled. The missing full
successful build log and unpinned live apt/Conda/pip resolutions remain
repeatability limits; the documented image ID, task file hashes and control
reports support this single execution only.

The next boundary, after review of this adapted reference gate, is a Deskmates adapter that
mounts only a fresh Astropy checkout and the issue text. It must keep this
manifest, gold/test patches, expected-test identifiers, official harness and
logs outside the bot workspace. The suite/model phase was authorized in principle at reference-gate time.
The owner later authorized the internal GLM-5.3 first campaign without a
cost-budget approval, with token accounting and one attempt/eligible case
(15 minutes/20 turns, at most six). See the [current-runtime/model receipt](reusable-current-runtime-2026-09-26.md)
for the completed Astropy attempt and target-level failure observation.

Follow-up on 2026-09-26: the separate [guarded official-harness isolation
receipt](swebench-untrusted-grader-isolation-2026-09-26.md) records trusted
gold/inert and deadline controls with an explicit no-network, no-mount grading
container. It does not establish real agent origin or arbitrary-patch safety;
the rights, repeatability and model-budget limits above remain.

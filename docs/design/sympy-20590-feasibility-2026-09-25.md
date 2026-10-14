# SymPy 20590 official pipeline smoke feasibility

Date: 2026-09-25  
Status: pinned row extracted; source image build blocked by remote Conda transport

This is the public SWE-bench Lite `sympy__sympy-20590` example from the
[official quickstart](https://www.swebench.com/SWE-bench/guides/quickstart/).
Its reference patch is public, so even a future Deskmates pass will validate
the integration pipeline only, not blind repair ability.

The evaluator-only source is `princeton-nlp/SWE-bench_Lite` revision
`6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`, `test` Parquet SHA-256
`7a21f37b8bc179c7db5beeb14e88ac538ba283455c776e6b2535bbfb6e3551b4`.
The verified extracted row SHA-256 is
`d7ac1694d45ae9ea9d0a0c20663cde64b071e91ab46b529f90970b597d01b589`.
It names SymPy base/environment commit
`cffd4e0f86fefd4802349a9f9b19ed70934ea354`, version `1.7`, one
`FAIL_TO_PASS` test (`test_immutable`) and 21 `PASS_TO_PASS` tests. Its exact
`problem_statement` alone is in the [agent issue file](../../evals/fixtures/reusable/sympy__sympy-20590/agent-issue.md),
SHA-256 `e2f8e16a69eabf97334f7852f8675d8d470ef7a3e990ab484c6427bd7ad9ff52`.
The gold patch, test patch and expected-test lists remain in private
evaluator storage on Testbox, never in a bot mount.

The official harness source is MIT licensed. SymPy's
[pinned LICENSE](https://github.com/sympy/sympy/blob/cffd4e0f86fefd4802349a9f9b19ed70934ea354/LICENSE)
has BSD 3-Clause style terms and additional bundled notices. The pinned
Princeton-NLP Lite dataset card does not separately declare a license for the
hosted row. Do not redistribute the row, patches, checkout or image on the
basis of the harness license alone.

The [case preparation script](../../spikes/reusable-tasks/sympy-20590/prepare.py)
ran on Testbox Linux `x86_64` and verified the pinned Parquet hash before
extracting the row. The pinned official `swe-bench-tasks` repository at
`3d07b464b7b311a0cbfb5ed5b2d8a3b96f84a33d` has been compared with that
exact row: instance ID, base/environment commits, version, both test lists,
gold patch bytes and test patch bytes all match. The private compatibility
receipt SHA-256 is
`2f249aa04a7d71ef4ad80e143a344e535336f36a933c61c2589c79645ef9d7fb`.
The [planned controls](../../spikes/reusable-tasks/sympy-20590/run-controls.sh)
will build its official
image on Testbox, run gold, literal no-change and behavior-preserving inert
diff predictions through the official CLI, and retain per-test logs, image ID
and hashes. They have **not run** yet; the remote heavy build slot belongs to
Astropy's first-case gate. SymPy's official grader outcome and Deskmates ability
remain unknown.

The first direct build of the pinned, unmodified task Dockerfile on Testbox
used the official `task.yaml` image tag
`swebench/sweb.eval.x86_64.sympy_1776_sympy-20590:latest`. It ran from
`2026-09-25T15:38:27Z` to `15:38:59Z` and failed before source checkout or
tests: Conda's repodata requests to `repo.anaconda.com` and `conda-forge`
repeatedly ended with TLS `UNEXPECTED_EOF_WHILE_READING`, then
`CondaSSLError`. Its private `source-build.log` SHA-256 is
`c9bbb04c9f5e84a858a795f0287a490d3440944f1f3968baa9dbca5df1b0b91d`.
A second same-Dockerfile attempt from `15:43:07Z` to `15:43:38Z` failed at the
same repodata step; `source-build-retry1.log` SHA-256 is
`fb2bbb878129f324eb1ecd66635fbb24eecd242c8554c17ecfec7d77b8133a85`.
No image or official test verdict resulted. Aliyun Conda mirror paths checked
from this host returned HTTP 404; Tsinghua mirror paths failed TLS handshake.
The exact pinned task assets remain unchanged. A verified package cache or
working transport mirror is the next prerequisite; this is an infrastructure
blocker, not a SymPy agent failure. The gold/no-change/inert controls have not
run, and this public case remains only a proposed pipeline smoke.

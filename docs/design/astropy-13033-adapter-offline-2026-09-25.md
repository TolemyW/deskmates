# Astropy 13033 Deskmates adapter: offline preparation (2026-09-25–26)

This is an adapter preparation receipt, **not** a Deskmates model or case-success
result. The adapted official reference gate is documented in
`astropy-13033-feasibility-2026-09-25.md`. All evaluator inputs and logs are
private on Testbox under
`/home/owner/agent_workspace/deskmates-reusable-evals/astropy-13033-20260925`.
The agent-visible bundle is separate at
`/home/owner/agent_workspace/deskmates-agent-bundles/astropy-13033-20260925`.

The bundle contains only the issue (SHA-256
`a295c83e68ff62290947b0796b75659b94621b7f2340d6f0055512d04be3f1d1`)
and a fresh single-commit checkout of the pinned Astropy source tree
`aac5ec576b94c4e4ba90b38eddc8e24cb1d52b54`. The source archive SHA-256 is
`54fcac409ef97387ffd76ef60a2c3ee657313896a108b61b6850f69def527af1`;
the private `agent-bundle-receipt.json` records the export image ID, 1,884
tracked source files and fresh commit. The official evaluator image, task repo,
gold/test patches, manifest and harness logs were **not** mounted in the agent
probe. The bundle preparation succeeded before `prepare-agent-bundle.sh` was
revised to add `--network none`; the successful raw run did not have that flag.

An offline synthetic probe used existing older workspace image ID
`sha256:48a13e7c64b65825afdc22abffa784f380a7bf4ccc38c2212a222f92f6600fc9`,
volume `deskmates-astropy13033-probe-20260925-work` and container ID
`a0ef4c0c496ccd4512758eebc1a8867b179b0f7736fcdceedf984a32cd231ecd`.
That container was removed after controls; the volume remains as evidence.
The first seed verification failed with Git's dubious-ownership check because
the copied tree retained UID 1001. Ownership was corrected only in this probe
volume and verified. The initial piped stdout file is empty because its outer
shell did not propagate the inner failure; the fixed probe file has SHA-256
`9c5bb68b442aaea25287a025861bd62addcf91d27d3b93ece8a070932ffc2815`.
`seed-agent-volume.sh` was later revised to own/chown new volumes and run
network-disabled. The revised script succeeded on the fresh native probe
volumes described below.

`collect-agent-patch.py` reconstructs a trusted evaluator-owned Git repository
from the pinned base archive; it never executes Git against the copied agent
`.git`. It strips all agent `.git` paths, rejects unsafe tar links, streams a
bounded 512 MiB capture, preserves new/modified/deleted files and checks the
patch against a fresh baseline. Git system/global config, hooks and fsmonitor
are disabled for the evaluator operation. These checks ran with an explicitly
`offline_simulated` origin receipt. They **do not** establish Gateway run
attribution or actual agent ability.

| Synthetic control | Actual result |
| --- | --- |
| No modification | Empty patch SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; receipt SHA-256 `ab6545de71f38e9cabcf6e53843c65eb4cefbafda05a6c2ac0d35c29e49c0cfd` |
| Modified/new/deleted files with malicious agent `.git/config` filter | Four changes (`.gitattributes`, `CHANGES.rst`, `README.rst`, `agent_new_test.py`) captured; binary patch SHA-256 `ab5720dca759ba4e32173d006f7105d13cbcac24e084e985ea4afe1d7110ba4f`; `git apply --check` passed; host marker absent; receipt SHA-256 `d931678a00cd5c61a01631b8cb54b60789a8f81ab294945fc9193b0f2022552a7` |
| Capped stream | Artificial 1 KiB cap rejected capture and removed only its helper container; original probe remained |
| Unsafe links | Absolute `/etc/passwd` and `../../..` symlinks rejected by `tarfile.data_filter` |
| Origin receipt mismatch/missing | Rejected before output |
| Invalid patch | Corrupted hunk rejected by `git apply --check` (exit 128). A prior malformed header did not fail Git and is not counted as this control. |

Private stdout/stderr controls and patch receipts are under `offline-*` in the
evaluator directory. The collector version used for those original controls
has SHA-256 on both the local checkout and Testbox of
`7200f40635ea629bf0eaa94042a2a26728d5c20f95b8b1a1514dcfd3191907c9`.
The later native-artifact and Gateway-ledger branches are separate revisions;
their evidence is stated below, and the Gateway branch remains unrun.

At the time of the offline checks below, the current-runtime path was prepared, not executed. `setup-isolated-gateway.py`
will register a fresh no-egress workspace, seed only the safe bundle, start its
container, then register a bot and thread **without posting a message**.
`verify-gateway-origin.py` will require a terminal Gateway ledger run and check
its bot/thread/workspace, image and volume against the private database and
Docker. Those two scripts currently have Python syntax checks only. The
collector's `gateway_ledger` branch rechecks a private SQLite snapshot and
Docker identity before capture, but has not run against a real Gateway.

The generic Deskmates image alone cannot run this Astropy task. The reference
image has a 285 MiB Python 3.9 Conda environment and 17 compiled `.so`
extensions in `/testbed`. Its editable finder points to private `/testbed`.
The evaluator-only `native-artifacts.json` inventories the 17 `.so` files
(4,716,624 bytes total) and generated `_version.py`, with exact SHA-256 for
each. Git blob comparison against the pinned source commit shows the reference
checkout changed only `pyproject.toml` content (the documented setuptools
build pin); many file modes changed after `chmod -R 777`. A string scan of the
17 binaries found none of the known case ID, target-test, test-patch, gold or
SWE-bench markers. That scan is bounded evidence, not a proof that an arbitrary
binary could not contain other sensitive strings.

On Testbox, a **case-scoped older-image diagnostic** built
`Dockerfile.agent-runtime` with pinned existing Deskmates workspace image ID
`sha256:48a13e7c64b65825afdc22abffa784f380a7bf4ccc38c2212a222f92f6600fc9`
and adapted reference image ID
`sha256:677b5adf3e9eb9746aeea7f74c6707681246e0e6de4cb99c2e47519960f9b1c2`.
It copied only `/opt/miniconda3/envs/testbed`, removed the private-source
editable finder and changed its metadata to `/work/astropy`. The resulting
image ID is
`sha256:ddac48e2535482f0c4928bc23ef47891b6517f29462a31c220f35e80f15905c5`.
Build ran with no network from 2026-09-25T16:14:03Z to 16:14:04Z; successful
build log SHA-256 is
`11d41853687872c515296767a2e6131b5661f1c9ae80fafb9d154a75c2fc6e77`.
The first Dockerfile invocation used bare image IDs as `FROM` names and Docker
attempted an unwanted registry metadata request, returning 403 before a
build. Its failed log SHA-256 is
`ffb341539b7ea7d22af386cefa04798bd3adab37ed8ba2c1e2124cd2f112deae`.
The successful retry used existing local tags only after asserting both exact
image IDs. A later read-only audit found one unused compiled bytecode file for
the removed `/testbed` editable finder in the overlay; no remaining text
`.pth`, `.json` or `.py` under site-packages referenced `/testbed`. The local
Dockerfile now also removes that `.pyc`, but this small cleanup was **after**
the measured older-image build and is not claimed as tested in its image ID.

The revised seeder put the pinned source and issue into a fresh named volume.
`install-native-artifacts.py` then copied only the 18 inventoried artifacts
from the reference image into that volume, checking every source and copied
hash. A first script revision placed them one directory too high; its failed
import log is retained. A second fresh volume used the corrected path:
`deskmates-astropy13033-native-probe-retry-20260926-work`. In the older overlay
image, Python 3.9 imported `astropy` from
`/work/astropy/astropy/__init__.py` and `astropy.timeseries.sampled` from
`/work/astropy/astropy/timeseries/sampled.py`. The first read-only test hit a
Hypothesis cache warning; setting its storage to container `/tmp` fixed that
setup error. The final offline baseline `test_sampled.py` outcome was **1
failed, 21 passed, 3 skipped**; the sole failure was the expired leap-second
warning also present in the official gold control. The successful import and
test log SHA-256 is
`cd419698f1547bcfa85171f4e688930111b8cf01a308ac82495f027dec0cfa82`.
It ran 2026-09-25T16:17:11Z–16:17:12Z. This verifies baseline runtime
compatibility on the older image only; current Deskmates runtime is untested.

The updated collector now takes the exact native-artifact manifest. On a
synthetic no-model container using that volume, it excluded those 18 files
only after rechecking their hashes and produced the empty SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
(private receipt SHA-256
`49888f957a3a381a2cb46f0f7c652308d7dacd102d780ef2b5ff9f016ef1a13d`).
An intentionally modified `_compiler.so` and then a deleted `_wcs.so` each
caused an explicit **collection-unsupported** error; logs have SHA-256
`7c6d05dfdac523f792c335ed71cf5000d600b73b476681cc041874444516801c`
and `7bbb3807f9f14ac170dc3ae4d343db133734b057a73fde7c835f60605a4b8df2`.
An agent might legitimately rebuild or reinstall these extensions. This
conservative collector state is **unknown**, not an agent failure or task
constraint violation. A future grader may extract the source change separately
and evaluate it in a fresh image, preserving the native-change diagnostic.
The synthetic container was removed after controls. These checks still do not
bind a real Gateway run or establish model ability.

The later [guarded official-harness receipt](swebench-untrusted-grader-isolation-2026-09-26.md)
records trusted gold/inert and a deadline control through the pinned official
path with no-network/no-mount containers, dropped capabilities and bounded
resources. This establishes the tested wrapper configuration, not arbitrary
agent-patch safety or real run origin. No evaluator source tree, hidden patch
or harness directory may enter the agent image or volume.

The current Deskmates source was not sent to Testbox. Automatic approval review
rejected a proposed clean `git archive HEAD` transfer of 618 tracked files
(5,140,480 tar bytes) to the isolated runtime directory because the prior
authorization for remote scripts/tests did not explicitly include the full
private-source payload. It explicitly disallowed workaround or indirect fetch.
No archive/transfer occurred under that earlier scope. On 2026-09-26 the owner
explicitly authorized continuous private-source/task-material transfers to
Testbox's isolated `deskmates-reusable-*` directories until revoked, excluding
actual credentials, keys, secret `.env` files and unrelated data. See the
scoped authorization in [AGENTS.md](../../AGENTS.md). The new pinned source
payload was then transferred and hash-verified in
`/home/owner/agent_workspace/deskmates-reusable-runtime-20260926-12ab8882/`.
Its SHA-256 is `642c23c2070e52b6908134119532e91c7be2376dc9c1bce307af9f72d1a4327d`;
627 regular files plus the `CLAUDE.md` guidance symlink, 5,150,720 tar bytes.
It includes HEAD `12ab8882e3771ce11b801ea8dadaa253f20cfca8` and only enumerated
task overlays; no `.git`, `node_modules`, secret `.env` or unrelated untracked
files. Current-runtime build/no-model checks subsequently passed, followed by
the one model/origin/grader observation linked below.
The owner subsequently authorized the internal GLM-5.3 first campaign without
a cost-budget approval: one attempt per eligible case, at most six, 15 minutes
and 20 turns each, with token usage recorded and missing usage unknown.
These historical blocks did not change the adapted official grader result or the synthetic
collector observations, and neither can be described as an agent failure.

Follow-up 2026-09-26: [current-runtime and model receipt](reusable-current-runtime-2026-09-26.md) records the successful zero-run setup/native baseline check, one real GLM-5.3 attempt, verified ledger origin, preserved full artifact and explicit source projection. The attempt ended at 20 turns and the guarded official target assertion failed; P2P20 passed. This supersedes the earlier unrun/pending statements only for the observed paths; rights/repeatability and broader safety limits remain.

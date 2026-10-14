# Pinned SWE-bench harness: untrusted-patch isolation gate

Date: 2026-09-26. Status: **the official CLI alone does not meet the intended
untrusted-patch isolation contract; a case-specific guarded invocation passed
trusted gold and inert controls on Testbox**. No unknown patch or model was
run. The observed controls establish this wrapper's requested Docker settings
and grader semantics for these inputs, not safety for every agent-authored patch.

The pinned Testbox source is SWE-bench commit
`02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`. Its
`swebench/harness/run_evaluation.py` SHA-256 is
`04b5dab584fbe62ae9d1ff025edf52d714e584102d587c7e647805d1efb37d84`;
`swebench/harness/docker_utils.py` SHA-256 is
`f1c3941d24580df56a8e2346df86d34e658319b9a70d4d05c504504b541d431e`.
The existing adapted Astropy evaluator image is immutable ID
`sha256:677b5adf3e9eb9746aeea7f74c6707681246e0e6de4cb99c2e47519960f9b1c2`
on Linux amd64. Image metadata declares no volumes; its environment **keys**
are `PATH`, `PIP_INDEX_URL` and `TZ`, with no obvious model-token key and no
userinfo in the package-index URL. Values were not printed. This metadata
inspection cannot prove no sensitive bytes exist elsewhere in the image.

## Exact official execution path

`create_container()` in `run_evaluation.py` calls Docker SDK
`client.containers.create(image=test_spec.image, name=..., user=CONTAINER_USER,
detach=True, command="tail -f /dev/null", cap_add=["SYS_ADMIN"])`; its conflict
retry uses the same arguments. No `network_mode`, memory/CPU/PID bound,
security option, read-only root or explicit mount restriction is passed. Docker
therefore supplies its default network and resource behavior. The verified
Typer `swebench eval` entry exposes `--timeout` and `--workers`, but no
isolation flags; the older module entry names its worker option
`--max_workers` and was not used for these controls. `--timeout` reaches
`exec_run_with_timeout(container, "/bin/bash /eval.sh", timeout)`; it does not
cover container creation, patch copy/application, asset staging or every Git
command. On timeout, `docker_utils.py` attempts `kill -TERM` of the test exec
PID and closes its stream. That is a test-command bound, not a whole-grader
wall-clock or resource bound.

The host writes the prediction to `logs/evaluation/<run_id>/<model>/<instance>/patch.diff`,
copies it to `/tmp/patch.diff` in the container, and then runs Git/patch
application there. It writes `eval.sh` on the host, copies it to `/eval.sh`,
executes it in the container, and writes `test_output.txt`, `run_instance.log`
and `report.json` under the same host log directory. `logs/evaluation` is a
relative path (`swebench/harness/constants/__init__.py`), so a launcher must
fix the working directory and private output path. Reports leave through the
Docker exec stream to evaluator-owned host files; the container has no host
report bind mount in this path. `_stage_image_assets` can fetch dataset assets
on the evaluator host for cases that declare them; Astropy's frozen row must be
checked to have none before a restricted no-network launch. Checked on
2026-09-27 (see "Revision 2026-09-27" below): the row declares none.

Because the image runs agent-authored code during grading, default network
egress and `SYS_ADMIN` are material gaps even though the pinned call does not
request host bind mounts or forward host environment variables. A direct
`docker run --network none` probe would test a different path and is not
evidence that the official CLI is isolated. No such diagnostic probe was
substituted.

A [case-specific launch adapter](../../spikes/reusable-tasks/astropy-13033/secure-grader-launch.py)
calls the same `swebench eval` Typer entry as the successful gold/inert
controls, with `--task-repo`, one worker, the exact Astropy instance and a
unique run ID. It pins the dataset SHA-256, the task-repo Git revision and all
nine task-file hashes, including the documented one-line transport adaptation
to `Dockerfile`. In the revision recorded here, `_build_before_eval` still
forced a source build; immediately before container creation the adapter
checked that the selected tag resolved to the **same** validated image ID. A
different image could not reach patch execution, but this did not prove a fresh
build succeeded if the cached image remained. The 2026-09-27 revision below
skips the build entirely. Official patch application, test selection and
scoring stay intact.
The adapter pins the two harness file hashes, image ID and environment-key
allowlist; rejects an existing run container, image pulls and the official
path that removes a same-name ghost; and intercepts only the expected Docker
SDK `ContainerCollection.create` call. It replaces
`SYS_ADMIN` with `cap_drop=ALL`, requests `network_mode=none`, no bind mounts,
no privilege escalation, 8 GiB memory, two CPUs and 256 PIDs, then inspects
the actual created container before the official harness starts it. A
different create shape or effective HostConfig fails closed and removes only
that newly created container. Each invocation gets a random 128-bit nonce in
its container label and private receipt; cleanup verifies the nonce alongside
name, image and case, so a reused run ID cannot delete a prior container.
The wrapper intercepts the official container `start` and, before the patch
is copied, runs a harmless in-container probe returning only booleans for
loopback-only interfaces, absent host environment/file sentinels and Docker
socket, dropped effective capabilities and no-new-privileges. The host-side
launch receipt contains input hashes, image ID and bounded arguments; the
probe field starts **not passed** and changes only after that same-path probe
succeeds. This is an interception of a pinned implementation, not an
official SWE-bench CLI option or a proven security boundary. A separate
[outer launcher](../../spikes/reusable-tasks/astropy-13033/run-secure-grader.sh)
uses GNU `timeout` for a 2,400-second whole-process deadline and checks the
exact nonce, run label, image ID and container name before cleaning up only
that invocation's container. INT/TERM also trigger bounded owned-container
cleanup. Its status file records timeout, signal, probe and cleanup outcomes.
Both scripts were transferred by explicit path and hash to Testbox's private
`astropy-13033-20260925/scripts/` directory. The Python SHA-256 is
`bcd313608cd363ca354f057c5f770940fcd65620f6ffcbad946148e6f2cb83de`;
the shell SHA-256 is
`e14f6f4b5cf945a7d196b383458f6f2381083f57eab3badd27027d3375691ba1`.
This is a bounded, implementation-pinned interception rather than an official
SWE-bench isolation feature.

## Same-path Testbox controls

All three invocations used the pinned official `swebench eval` path through
the wrapper, the validated image ID above, one worker, and the frozen
instance, task repo and row. The harmless probe ran just after official
container start, before patch transfer. The effective Docker configuration
check passed each time: `network_mode=none`, no mounts or devices, dropped
capabilities, no-new-privileges, 8 GiB memory, two CPUs and 256 PIDs. All six
probe checks passed each time: loopback-only interfaces; absent host environment
and file sentinels; absent Docker sockets; zero effective capabilities; and
no-new-privileges.

| Trusted input | Run ID and UTC interval (2026-09-25) | Official result | Outer status | Evidence SHA-256 |
| --- | --- | --- | --- | --- |
| Gold | `deskmates-secure-a26f1e7c9b04`, 17:47:30–17:47:59 | `resolved: true`; target F2P 1/1, preserved P2P 20/20 | exit 0, cleanup 0, same-path probe passed | outer log `6745fc823a927abea034f8703b5c833b2ad8c1ece293c78428c85ef736887bfe`; status `c9755dcbcc64c20fd43e2bd07000c5266706ae14c920258bc0f221fb5ff83643`; launch `1bf9ce615ea140606af0206a234952014e6c20b6364764daa80f51cc680308de`; report `f1c242016ac0be30dbae6a498627c3d23b3abb56b38d2f6051e4695e53fa4726`; results `c65f0a086a3a6c0c2f02880407cd1c02cf933a7a66d18c276db363b5dae96db1` |
| Inert behavior-preserving diff | `deskmates-secure-b847c2e59a31`, 17:48:49–17:49:17 | `resolved: false`; target F2P 0/1, preserved P2P 20/20 | exit 0, cleanup 0, same-path probe passed | outer log `1d7038c2f636a20205e2c80b9029350986821c7bcf69e07b24edd4d9103c1052`; status `51c7e81c427998c27acbbe314142f1a132e3f4ff4c034a0b7e8447dbe4345ec0`; launch `69ef8672d8fc0526d27a8e66462b7b8dc9c0e305e337fc49a364b0247ad6ce81`; report `273825f447a7903894b8aa9b1de85b56f7b85b5d07fd5842be9e69010622079a`; results `b56d14e5fbe2b5ab90dd8f5a4feede2d5ea1c9180cbef01e1d31b39d68f91c0f` |
| Gold, 15-second deadline diagnostic | `deskmates-secure-c902af17e4d6`, 17:49:51–17:50:06 | **ungraded**: no `results.json` although a partial report exists | process exit 124; deadline interrupted; cleanup 0; same-path probe passed; exact-name container count 0 afterward | outer log `6bf961450ddeb02ef703f326b0d586a539bd7a8473d04183dc7417d955617301`; status `43a82d85d467fb0aea228c5b7bf8cc760a22dbce91b3095702493aa2a49b6863`; launch `46e12ac4978d94aa4674881ecb3fca73f950d9f676882835096816fff025bda6` |

Raw logs and receipts remain evaluator-only under
`/home/owner/agent_workspace/deskmates-reusable-evals/astropy-13033-20260925/private/restricted-gold-a26f1e7c9b04/`,
`restricted-inert-b847c2e59a31/` and `restricted-deadline-c902af17e4d6/`
in that same private root. The short diagnostic verifies the configured
whole-process deadline and owned-container cleanup on one interruption. Its
partial report is not a result; completion requires the outer status and
official `results.json`. The validated image ID remained unchanged. The
extra unscored leap-second failure remains, as the [reference receipt](astropy-13033-feasibility-2026-09-25.md)
records.

## Revision 2026-09-27: no build, no asset staging

The forced build was the remaining open part of the grading trust surface on
the evaluator host: it ran the task repo's Dockerfile with network, and its
only useful output, the image, was already pinned. The adapter now replaces
the harness's `_build_before_eval` with a check that runs on the exact rows
the harness is about to grade: exactly the pinned case, the image name its
test spec selects resolves locally to the validated ID, and nothing is built
or pulled. An absent image fails closed before any container exists. The same
check refuses a row whose test spec declares image assets, and
`_stage_image_assets` is wrapped to refuse them again, so the evaluator host
never fetches an asset URL. The launch receipt records
`image_build: "skipped: validated image must pre-exist; never built or
pulled"` and the checked image per row. Offline unit tests cover an absent
image, a different image behind the same name, declared assets, empty asset
lists and a wrong row set
(`spikes/reusable-tasks/astropy-13033/test_secure_grader_launch.py`).

**Frozen row inspection.** Through the harness's own loader
(`load_instances` on `private/case.json`, SHA-256
`6518ded0d3d4d65109826c6f8924f28be274aa4a58f22dd6585457ec010b5c13`, with the
pinned task repo), `astropy__astropy-13033` has no `image_assets` field in the
row and an empty `image_assets` in its test spec. Its image name
`swebench/sweb.eval.x86_64.astropy_1776_astropy-13033:latest` resolves to the
validated ID above. With this row, `_stage_image_assets` returns before any
fetch, so the restricted launch has no asset path that needs the network.

**Maintenance note on the harness pins.** `restricted_create` accepts only the
exact keyword set `{name, user, detach, cap_add}` with
`cap_add == ["SYS_ADMIN"]`, and rebuilds the Docker call instead of forwarding
the harness's arguments. A future harness that stops requesting `SYS_ADMIN`,
or adds any argument, will refuse to run. That is the right direction. The
vulnerable shape is the tempting fix: relaxing that equality, or forwarding
`**kwargs` to the real create, would silently honour whatever `network_mode`,
volumes, `privileged` or environment a new harness passes. On any harness
change, re-pin both hashes, re-read `create_container()` and
`_build_before_eval()`, and rerun the controls. The same note sits beside the
pins in the adapter.

**Controls on the revised files.** The revised pair was transferred by
explicit path and hash to a new directory,
`astropy-13033-20260925/scripts-prebuilt-20260927/`, leaving the pinned
`scripts/` copies that the table above was recorded against unchanged. The
outer launcher now loads the adapter from its own directory. Adapter SHA-256
`8bb9dea65a5a3920880512df5e5f908a3b2556d2ec485781495570b10ea6ba6a`; launcher
SHA-256 `5f33236008afb460d3c45a04630867450190c5a32df9b690e8c32b9da85f76fb`.
Both controls ran on Testbox on 2026-09-26 UTC through the same official
`swebench eval` path, one worker, a 900-second outer deadline:

| Trusted input | Run ID and UTC interval | Official result | Build | Outer status | Evidence SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Gold | `deskmates-secure-c52690506d88`, 17:02:47–17:03:14 | `resolved: true`; F2P 1/1, P2P 20/20 | skipped; no "Building" line in the log | exit 0, cleanup 0, same-path probe passed | outer log `3096444bcadd0a9a9aea5bdbd95945916581b9077d422399eaf87a10fc4ec826`; status `4cf0232254902e60d57402cfff6a3a677e9be6652099d4c7aa73ef41b6499c7e`; launch `f241dd048c9dbfcbca068c67a7f0ecfd997214530fe798fbeae08dcc4ccd2ac4`; report `f1c242016ac0be30dbae6a498627c3d23b3abb56b38d2f6051e4695e53fa4726` |
| Inert behavior-preserving diff | `deskmates-secure-f281a078859f`, 17:03:28–17:03:55 | `resolved: false`; F2P 0/1, P2P 20/20 | skipped | exit 0, cleanup 0, same-path probe passed | outer log `373b62f6e847b426492c0077940900468b5ff1db33321b391dcd30f649cc7c58`; status `3437f440ea59c0a4a7acf5e9146059ee3ed814dd0d54fb06805902708e2f7915`; launch `3d0769d3f9ca3f03054ebf88b82af5c08d006567bc31dc2d328816b7abf04183`; report `273825f447a7903894b8aa9b1de85b56f7b85b5d07fd5842be9e69010622079a` |

Both `report.json` files are byte-identical to the earlier gold and inert
controls, so skipping the build changed nothing the grader scores. Evidence
is under `private/restricted-gold-prebuilt-c52690506d88/` and
`private/restricted-inert-prebuilt-f281a078859f/`. The failure path, an
absent validated image, was exercised only by the offline tests: removing the
shared evaluator image on Testbox to prove it live was not done.

What this closes and what it does not. The evaluator host no longer builds
or fetches anything during grading, so the no-network result now covers the
whole grading invocation, not only the grading container. The one-time build
that produced the validated image is outside this path and keeps its own
provenance record. Everything in the next paragraph's list of unverified
properties still holds.

Follow-up: [current-runtime/model receipt](reusable-current-runtime-2026-09-26.md)
records one origin-verified agent source projection graded through this path,
with target assertion failure and preserved aggregate advisory conflict.
The owner subsequently authorized scoped source transfer and the internal
GLM-5.3 campaign; the Astropy current-runtime/first-run checks completed.
This does not establish safety for other hostile inputs. Dataset/task rights and
repeatability limits remain open. Disk quota, kernel isolation beyond the
observed Docker controls, complete image-content audit, and behavior under
other hostile patches are unverified. Before the 2026-09-27 revision the
no-network observation applied to the grading container, not the trusted
evaluator host or image-build stage; the revision removes the build and the
asset fetch from the grading invocation, and the one-time image build keeps
its own record.
This is neither a full untrusted-code sandbox nor a Deskmates ability result.

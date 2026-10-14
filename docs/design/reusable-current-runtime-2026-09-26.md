# Reusable suite: current-runtime source and Astropy launch receipt

Date: 2026-09-26. Status: current-runtime no-model setup and real run-origin
gates passed; the single authorized internal GLM-5.3 Astropy attempt ended at
its 20-turn cap and its derived source patch did not resolve the official
target assertion. Run termination, task outcome and environment diagnostics
are separate.

The owner explicitly authorized ongoing private-source/task-material transfers
to Testbox's isolated `/home/owner/agent_workspace/deskmates-reusable-*`
directories until revoked, excluding credentials, private keys, secret `.env`
and unrelated data. The earlier automatic rejection is retained in the
[offline adapter receipt](astropy-13033-adapter-offline-2026-09-25.md); this
transfer used the subsequent explicit authorization and passed review.

Source HEAD is `12ab8882e3771ce11b801ea8dadaa253f20cfca8`. The payload has
627 regular files plus the `CLAUDE.md` guidance symlink; 5,150,720 tar bytes,
SHA-256 `642c23c2070e52b6908134119532e91c7be2376dc9c1bce307af9f72d1a4327d`.
It contains the pinned tracked source and an explicit Astropy/launch overlay,
not the unrelated untracked L01 work. The high-confidence private-key/token
scan found no candidate paths; that is not a comprehensive secret audit. The
only environment template is `.env.example`; no actual `.env`, `.git` history
or `node_modules` was transferred. The first payload normalized regular-file
modes to `0644`, so it is a content-pinned projection, not a byte-and-mode
identical Git tree. The later preparation script preserves archive modes for
future payloads and records them. Dockerfile entry scripts explicitly receive
their required executable modes.

All execution is on Testbox Linux amd64, Node 22.22.0/npm 10.9.4, in
`/home/owner/agent_workspace/deskmates-reusable-runtime-20260926-12ab8882/`.
Its `payload-manifest.json` lists exact files/hashes; `private/` contains all
receipts, logs and generated operator credential. Existing services were
inventoried and left untouched. No deploy, merge or commit occurred.

## Remote builds and no-model gate

The source was hash-verified before extraction. Builds used a minimal process
environment and distinct empty npm user/global config files. Initial npm
config preflight rejected double-loading `/dev/null`; the next attempt lacked
the testkit build needed by sidecar's colocated tests. Both terminal logs are
preserved under `private/build-attempt-{1,2}/`, with hashes. The revised helper
builds contracts/testkit before gateway/sidecar/sandbox-docker.

The current workspace image is
`sha256:0ae8435d7328d4d6de2f05a5e827244314461a014af2a5fdafdee534460a1f57`;
the egress image is
`sha256:4f94b80448088c3eb3c79762b161d6dc90925f0d5839f71dc15db05147391a0f`.
Bare image IDs in `FROM` triggered registry name resolution and failed before
overlay construction. The successful network-disabled overlay build used
scoped local tags only after checking both exact image IDs before/after; its
result is
`sha256:4d517857dfd1212f91afc1cd318e220f280199bdd29c965294dd64ed5fa7debb`.
It copies the already-audited Conda environment, not evaluator source/tests,
and removes the private-source editable finder. The work volume receives only
the pinned issue, fresh baseline repository, and 18 audited native/generated
dependencies. See the [native-artifact audit](astropy-13033-adapter-offline-2026-09-25.md).

The isolated Gateway directly used `buildGateway(..., {startCron:false})`,
explicit placeholder configuration and random unused listener ports. It never
loaded a cwd `.env` or inherited model credentials. Setup created
`ws_e7ed13a7d1be490a85468f61c51be430`, bot
`bot_29a2a7e6d9fd4791838d3928b0c81051`, thread
`thr_0e6003cb9d5b4a48ac8f8e96030c3fcd`, and verified **zero runs and messages**.
Native imports resolved `/work/astropy`; baseline `test_sampled.py` had
`1 failed, 21 passed, 3 skipped`, only the known expired-leap-second failure.
Runs/messages/usage rows remained zero afterward. A preceding quoting error
in the diagnostic command is separately preserved as infrastructure syntax
failure, not task failure.

| Private evidence | SHA-256 |
| --- | --- |
| `transfer-receipt.json` | `502f0f9404ad7d59614f611d8efbc50bf33db7c739d0047929ea30cadef165d7` |
| `image-receipt.json` | `b839de2fe53a85c8df799e1173d0144d1934542a573b57e319aab4f6e533963b` |
| `setup-receipt.json` | `d431052f7bb37785958c1b5d7179a904080a2b235cc0f3b5db24f49c06a96154` |
| `current-native-receipt.json` | `2a0ba15328613a63516a1c18048b8bc38ca4b4890d37e9633ce946fe7d9b6ad8` |
| `current-native-test.log` | `abdca09568952a115351c94dd45ea336c48e33daaf4db9997c6247530a210267` |
| `build-overlay.log` | `2c3ac169d4127674f3a85ccccd3258433976dd1541d835b7a87cc7ae8a824d51` |

## First live attempt

The owner authorized the existing internal GLM-5.3 route without a cost-budget
approval, requiring token accounting. The agreed first campaign permits one
attempt per eligible case, at most six, 15 minutes/20 turns each. The new
launcher reads only the existing remote credential file
`/home/owner/agent_workspace/deskmates-b1b3/.env` into memory; no credential file
is copied, printed or tracked. It explicitly selects `glm-5.3`,
`RUN_TIMEOUT_SECONDS=900`, `DESKMATES_MAX_TURNS=20`, cron off and random ports.
The earlier no-model Gateway was stopped by verified PID/cwd before this
launcher reused its zero-run SQLite baseline.

`run_a211528d82c44c6f8c5e85d94e83fd15`, attempt 1, started at
`2026-09-26T07:53:09.593Z`. The message driver reserves its one attempt before
posting and does not retry an uncertain POST. It verifies the actual run
configuration, observes terminal state, stops only the proven owned workspace
container, and records per-run/attempt `run_usage` input/output/cache-read/
cache-create deltas. It does not add cumulative session usage again. Missing
usage is unknown, not zero; interrupted reports can be partial. The host watch
is bounded at 1,020 seconds, with an outer 1,100-second process watchdog.

The launch helper SHA-256 is
`62ff33e6c08712d166b5fb799f6fb145c5611e4c5f2d47b1a919784c86ea3784`;
the dispatched driver SHA-256 is
`b75f9355f275f20740778d6e9c1337d9f9c6472dac9889b16a10017ec92f5abc`.
The attempt ended at `2026-09-26T07:55:25.780Z`, elapsed 136.187 seconds,
status `failed`, with SDK error `Reached maximum number of turns (20)`.
The host deadline did not fire. No final task summary was received; the last
assistant text said it was rewriting a regression test because `Table.copy()`
does not carry instance-level `_required_columns`. This is one attempt, not
a retry or a reliability estimate.

| Gateway reported token category | Count |
| --- | ---: |
| Input | 38,324 |
| Output | 10,081 |
| Cache read | 472,064 |
| Cache create | 0 |
| Sum of these four categories | 520,469 |

These are the single `run_usage` row's per-run/attempt deltas for `glm-5.3`;
the cache-read count is retained in the total. No session cumulative totals
were added again, and there is no independent provider-total audit.
The owned workspace was stopped before capture. The terminal Gateway ledger,
bot/thread membership and Docker/container/volume/image identity verified;
this does not prove absence of all out-of-band host writes.

The full capture patch SHA-256 is
`04d9cbf00b206d73650efacfbc44ac79e15350abaa3ed48a476538435715fcf4`,
with 223 changed paths. It remains unchanged in `private/collected/`.
A separately receipted source projection omits only **added** paths under
`.pytest_cache` (six files) or `__pycache__` ending in `.pyc` (214 files).
Each omitted file has a recorded content hash; no source/test/native change
was discarded. The earlier baseline probe disabled bytecode and pytest cache
writing, so these additions were not created by that probe. The projection
retains changes to `astropy/timeseries/core.py`, the authored
`astropy/timeseries/tests/test_sampled.py` regression tests, and
`docs/changes/12966.bugfix.rst`. Its SHA-256 is
`ec6afc9ae9f42c2becd3b3fab5638a0680a36954a5bb050fb7294ffc55100793`.
Official grading used this explicit derived patch, not claim it is the
unfiltered original artifact. The complete capture remains available for
replay and the cache projection is not itself a model-failure judgment.

Private `trial-receipt.json` SHA-256 is
`26ae0ed73b38d54626b3471aae9ffa0325bf69f2b36abb6e39e9250203608ff7`;
`origin-receipt.json` is
`e2ecb2985c2c22fbcc7736ebb2f55b6f97a94a052fda9cebffcf2ea68b5a71fe`;
the full capture `artifact-receipt.json` is
`411d1285bbc2995875b70c4e164be45f018398baab04ee4e7d3ba91e52634303`.
## Independent guarded grading and manual adjudication

`deskmates-secure-1256d98e31ab` ran from `2026-09-26T08:03:44Z` to
`08:04:16Z`. The same-path isolation probe passed, the process exited 0,
owned-container cleanup exited 0, and the validated evaluator image remained
unchanged. The source projection applied successfully. The per-instance
official report says `resolved:false`, `infra_failure:false`, target F2P 0/1,
and P2P 20/20. Actual target output expected the full first-column lists
`['time', 'a']` and `['time', 'b']`, but the patch still emitted the misleading
single-column message naming `time` on both sides. The new missing-column
branch does not handle this different second-column mismatch. The unchanged
official `eval.sh` resets `test_sampled.py` to the pinned base **before**
overlaying its reference test patch and again afterward. Agent-authored tests
remain in the captured artifact but do not replace the official oracle. No
test-patch application conflict was observed.

The aggregate official `results.json` nevertheless flags `network_unreachable`.
This conflicts with the per-instance infrastructure field and must be retained.
The pinned `infra_failure.py` (SHA-256
`72eaca5e8f76390ff9ac1d2d606f5390820b88efe6eed56efed8ff520c593eac`)
is an advisory, read-only classifier whose signature is
`Could not resolve host|Temporary failure in name resolution`. The live,
guarded inert **and guarded gold** logs all contain that DNS signature in pip's
setuptools-index retries during the evaluator reinstall step. Gold is resolved
and not classified; inert and live have byte-identical aggregate result files.
This is separate from the known unscored leap-second failure. Manual review
therefore adjudicates the observed **target assertion as failed**, rather than
treating the whole run as unknown or claiming a clean environment. Neither
official JSON was edited and the advisory still affects its original fields.

Private grader evidence is under
`/home/owner/agent_workspace/deskmates-reusable-evals/astropy-13033-20260925/private/live-astropy-1256d98e31ab/`;
`evidence-hashes.json` inventories logs/reports. Key hashes:

| Evidence | SHA-256 |
| --- | --- |
| outer status | `bb62b4d00d63db78617e07af937de9aa60e092e421ccce6c3abbe930d9e3e816` |
| same-path launch/probe receipt | `f004f2d5962f96b2a41de102e6a5a4ea07c2f033341be0578b7f8a656cab2ee0` |
| per-instance report | `273825f447a7903894b8aa9b1de85b56f7b85b5d07fd5842be9e69010622079a` |
| aggregate results | `b56d14e5fbe2b5ab90dd8f5a4feede2d5ea1c9180cbef01e1d31b39d68f91c0f` |
| actual test output | `45345e23589a106fac668074a355865f30270fc33af3c3eb70a0d8e284e1829f` |
| `private/astropy-final-receipt.json` in the current-runtime directory | `264b80699a7d1683e102b68b410a438a183879e13e1e7bdd5856aecc1c893d89` |

The isolated live Gateway was gracefully stopped by verified PID/cwd; its
workspace is stopped and its volume/capture/evidence remain. There was no
second model attempt. The [guarded grader receipt](swebench-untrusted-grader-isolation-2026-09-26.md)
describes the bounded Docker settings; this particular agent patch now exercised
them but cannot establish safety for every hostile input. Dataset/task rights,
source-build repeatability, disk quota and deeper kernel/image isolation remain
limited. This one run is an adapted-case smoke observation, not a model
comparison or broad reliability estimate.

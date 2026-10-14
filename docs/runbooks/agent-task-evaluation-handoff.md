# Handoff: reusable full-agent task evaluation

## Resumption and remote scope update (2026-09-26)

The owner explicitly resumed the entire starter suite and authorized continuous
source/script/build-material transfers to Testbox's isolated
`/home/owner/agent_workspace/deskmates-reusable-*` directories until revoked.
See [AGENTS.md](../../AGENTS.md#scoped-remote-evaluation-authorization-2026-09-26)
for the credential exclusions and no-deployment/no-merge boundary, and the
[current ledger](../design/reusable-suite-feasibility-2026-09-25.md) for evidence.
The historical deferred/no-SSH instructions below record the original handoff
and are superseded within this explicit scope. Previous automatic source
transfer rejection remains historical evidence; it was followed by this
explicit owner authorization. The owner also authorized the existing internal GLM-5.3 endpoint without
cost-budget approval: one attempt per eligible case, at most six, each bounded
by 15 minutes and 20 turns, with per-run token usage recorded. Offline gates
still precede live runs; authorization is not a verified runtime/origin result.

Date: 2026-09-25  
Status: handoff for a **deferred** suite; this document does not resume it

**Activation rule:** merely opening or reading this handoff does not resume
implementation. A later explicit user request such as “execute Task A
feasibility” or the copyable request below authorizes **that bounded first
phase**, even while the rest of the suite remains deferred. Start that phase
without asking for the same authorization again; ask only for genuinely missing
access or a decision that cannot be resolved from the repository. The current
user preference is GPT-6 Sol, medium reasoning, for all concrete work and any
subagents; the root coordinates it. This is a user preference for this handoff,
not a permanent repository-wide model policy.

## What this project and suite are

Deskmates runs named, persistent agents in sandboxed workspaces. The Gateway is
the thin scheduling/approval/ledger control plane; the sidecar inside a
workspace runs the Claude Agent SDK; Playwright supplies the shared browser.
The reusable-task suite evaluates the **whole Deskmates agent at work**—its
repository edits, QA tests/reproductions, or sourced research—not a bare model
call or the benchmark's own example agent. The planned six starters are two
development, two QA and two research cases in
[the suite plan](../design/agent-task-starter-suite-2026-09-25.md).

The suite is **research and plan only**. The six cases have not been installed,
adapted to Deskmates, or run. Existing `evals/` and `packages/golden-site/`
support deskbench on a controlled browser app; they are not SWE-bench,
Defects4J or FRAMES adapters. Existing M2 acceptance and L01 files test Deskmates
on Galaxy Ops Console; their graders and run records cannot be counted as
results on these six candidates. No official benchmark outcome, QA detection
rate, research accuracy, or six-case completion rate exists here.

## Read order and repository map

All paths in this handoff are relative to the repository root. Start in the
checkout containing this file; check its actual branch, revision and dirty
files before editing. Read:

1. `AGENTS.md`, especially architecture rules, commands, testing, secrets and
   the rule that a design-document change belongs in its own commit.
2. `docs/design/agent-task-starter-suite-2026-09-25.md` for scope, six cases,
   stages, denominators and open decisions.
3. `docs/design/evaluation-repair-plan-2026-09-25.md` for independent evidence,
   pass/fail/unknown, outcome versus constraints versus diagnostics, and grader
   controls.
4. `docs/design/reusable-development-cases-research-2026-09-25.md` for the
   recommended first Astropy case, its source row and official harness.
   Read the QA and research companion files of the same date only when working
   on those roles.
5. Before changing runtime code, the applicable sections of
   `docs/design/design-cogbot-thin-core-v0.3-2026-09-20.md`, the relevant ADRs
   under `docs/adr/`, and the affected package README. Consult
   `docs/design/test-strategy-2026-09-20.md` and
   `docs/design/measurement-2026-09-20.md` before adding a gate or claiming a
   comparison.

Useful entrypoints: `packages/sidecar/` hosts the real agent; `packages/gateway/`
holds runs and evidence; `packages/sandbox-docker/` starts workspaces;
`images/workspace/` is the current browser/agent base image; `acceptance/`
contains model-in-the-loop checks; `evals/README.md` and `evals/` describe the
existing deskbench runner and replay; `packages/golden-site/README.md` and
`packages/golden-site/src/` describe the controlled app. `spikes/` is for
throwaway verification, never a production package dependency. There is no
`astropy__astropy-13033` fixture or SWE-bench runner in these paths yet.

## Environment and prior evidence—not a deployment instruction

The local repository used to write this handoff was
`/Users/owner/agent_workspace/3-cogbox/deskmates`. Its working tree had
untracked L01 acceptance/support files, L01 launch/results documents, a spike
runner and the three reusable-case research documents. They may belong to
parallel work. Recheck with `git status --short`; do not reset, overwrite,
stage wholesale or blanket-sync that tree.

The last **recorded** Testbox L01 execution used SSH alias `testbox`
(`10.20.40.132`) and isolated remote checkout
`/home/owner/agent_workspace/deskmates-b4-native-20260924-1418` at Git
revision `45724d73df42d929cae05ebbdfe6a77b5859034a`. The recorded images
were `deskmates/workspace:m2-live-native-resume-20260924-1418` and
`deskmates/egress-proxy:testbox-b4-20260924-1418`; their digests and the L01
evidence directory are in
[the launch receipt](../design/l01-testbox-long-mission-launch-2026-09-25.md).
These are dated provenance, **not** claims about the present host, checkout,
image availability or suitability for Python SWE-bench. Do not SSH, sync,
deploy, rebuild or change a remote service on this handoff request.

For a later authorized model run, configuration comes from ignored `.env`
files following `.env.example`; the L01 manifest recorded only an ignored
credential-file path. Never put credential values in tracked files, command
arguments, prompts, reports or logs; do not print raw environment or remote
logs that may contain secrets. The Gateway issues short-lived credentials to
the workspace. A new SWE-bench image/dependency route needs its own preflight;
do not assume the L01 images contain Python benchmark dependencies.

[The L01 result](../design/l01-testbox-long-mission-results-2026-09-25.md)
records one failed long Galaxy Ops Console attempt: five of six tickets were
completed, the sixth lacked both requested writes, and the configured turn cap
was reached. It is useful evidence about that fixture and run only. It neither
invalidates nor validates any of the six reusable-task candidates.

## Preparing images and executing trials (2026-09-27)

The reusable suite has two stages, both in
`spikes/reusable-tasks/current-runtime/pipeline.py`, and the boundary between
them is enforced in code, not by convention.

```
python3 source/spikes/reusable-tasks/current-runtime/pipeline.py prepare ROOT
python3 source/spikes/reusable-tasks/current-runtime/pipeline.py execute ROOT -- COMMAND [ARG...]
```

**prepare** builds and validates images and may use the network. It first
checks that `ROOT/source` is byte for byte the transferred payload
(`ROOT/payload-manifest.json`), then derives each image's tag from the files
its build reads, for example `deskmates/reusable-workspace:amd64-<hash12>`, and
skips every step whose output already exists: `npm ci` when the lockfile is
unchanged, the package builds when their sources are unchanged, and each
image whose tag already exists. A rerun on an unchanged root is a no-op that
prints the image IDs; a new root with the same content reuses every image. A
task prompt, fixture or run parameter is not an input, so changing one never
enters this stage. It writes `ROOT/private/prepare-manifest.json` once: the
revision, the dirty-file inventory (the overlay paths and hashes), each image
ID and tag, and how each image was produced. `build-remote.sh` and
`build-overlay-remote.sh` are now entries into this stage.

**execute** consumes the manifest and never builds or pulls. Before COMMAND
starts it re-verifies the payload, the source tree, the npm and dist stamps,
and every image ID and tag against the local daemon; any difference stops it
with nothing started. COMMAND runs from the prepared source with
`{image:NAME}` and `{revision}` replaced from the manifest, the IDs in
`DESKMATES_IMAGE_ID_*`, and `execute-bin/docker` first on `PATH`. That guard
refuses build, pull, tag, load, `rmi` and every prune, and adds `--pull=never`
to `run` and `create`. The Gateway's own Docker client has no pull, build or
load call, pinned by `packages/sandbox-docker/src/no-image-acquisition.test.ts`.
Each execute writes a receipt under `ROOT/private/execute-receipts/`. A
repeated trial of the same code uses execute only, and the offline Gateway
launcher enforces it: `launch-offline.mjs` refuses to start unless the
manifest digest, the revision and both image IDs it is given come from an
execute environment, and it records the manifest digest in its launch
receipt. That guard was checked locally, not yet on Testbox: the two
verification roots below carry the earlier launcher.

**Builder and cache policy.** Every build uses the `default` builder, the
daemon's own BuildKit with the docker driver, and prepare refuses to build if
that builder is not the docker driver. Its cache is what makes an unchanged
workspace rebuild take seconds. The manifest records the builder, its BuildKit
version, and for each built image how many steps the cache served; a build in
which no step came from cache is recorded as `cold: true`. On Testbox a cold
workspace build does not run slowly, it fails, because containers there cannot
reach the npm registry or the Ubuntu archive. So cleanup never prunes the
build cache, and execute refuses `builder prune`, `buildx prune`,
`system prune` and `image prune` outright.

Verified on Testbox on 2026-09-26 UTC with revision
`cb156601f6a2ba5ccd864304faf22d5c4c5ece52` in root
`deskmates-reusable-runtime-20260927-cb156601-pipeline`. The first prepare ran
npm and all three image builds in about 12 seconds; the workspace build took
its four expensive steps from cache. The second prepare, through
`build-remote.sh`, was a no-op and left the manifest byte-identical. Execute
resolved the overlay image through the manifest, ran a container with pulls
disabled, refused `docker pull`, `docker build` and `docker builder prune`
with exit 97, and refused to start after one source file was edited, then ran
again once the file was restored from the verified payload. The final
version of the pipeline files, which differs from that one only in the no-op
listing's wording, was then transferred to a second root,
`deskmates-reusable-runtime-20260927-cb156601-pipeline-final`: its first
prepare ran npm (a new root has no `node_modules`) and **reused all three
images with no build at all**, its second prepare was a no-op, and execute
refused `docker pull`. Offline tests:
`spikes/reusable-tasks/current-runtime/test_pipeline.py`.

| Image | ID |
| --- | --- |
| workspace | `sha256:6ab0052f58958eee04cf391b3545b3e12f20f078f9307955b636365837b8307e` |
| egress | `sha256:1375a286e13097906e26be4f4a37d0029fc7c306a4fa0cf2c5cfaa9a0c78d5ff` |
| astropy overlay | `sha256:ab5c82b72942105f680ba710fe695968eb6a854ab2cd676ac53470300d1063c6` |

## Recommended first bounded task when the owner resumes work

Start with **feasibility and reference-grader validation for SWE-bench Verified
`astropy__astropy-13033`**, not a live Deskmates attempt. The [candidate report](../design/reusable-development-cases-research-2026-09-25.md)
gives the dataset row and base commit; the official SWE-bench guide describes
the evaluator. Work on one case only. This first task produces:

* A small manifest, proposed at
  `evals/fixtures/reusable/astropy__astropy-13033/manifest.json`, recording
  source dataset/revision and row ID, base commit, precise license and artifact
  provenance, Linux host architecture, dependency/image digest or unresolved
  requirement, reference test identifiers, **agent-visible issue text only**,
  evaluator-only assets, and the separation between the bot checkout and
  grader. If adding this path, keep evaluator-only material out of any
  bot-mounted directory; no model credentials or raw secrets belong in it.
* A narrowly scoped, repeatable local feasibility procedure under
  `spikes/reusable-tasks/astropy-13033/` (or a documented equivalent) that
  obtains the pinned official row and runs an official **reference/gold control**
  on an isolated checkout. Record exact commands, image/dataset digests,
  architecture, exit status and official per-test result files. A no-change
  prediction is the negative control. Before an official run, verify the
  dependency/license path and how the official harness imports the row;
  do not invent a hidden test or fabricate a resolved verdict.
* An English feasibility receipt, proposed at
  `docs/design/astropy-13033-feasibility-<date>.md`, with controls, hashes,
  outcome, limitations and the next adapter boundary. If downloads/Docker are
  unavailable or need remote/credential access, record the blocker and leave
  outcome `unknown`; do not substitute an unverified local test.

**Pass gate:** the exact pinned case is loadable on the chosen local Linux
execution environment, the official reference prediction is accepted by the
official evaluator, the no-change control is not resolved for the intended
reason, logs and evaluator assets stay outside the bot workspace, and the
procedure is repeatable. An official reference success validates the grader
path, **not** Deskmates ability. If only a Mac is available, document local
read-only feasibility and the missing Linux gate; do not claim it passed.

**Stop boundary:** do not launch the Deskmates model, choose or silently relax a
turn/time/cost budget, run the other five cases, add all-suite infrastructure,
change production Gateway/sidecar behavior, mutate Testbox, deploy, merge or
publish. The owner can later authorize a bounded adapter/model phase after
the feasibility receipt. The public SymPy gold-patch quickstart may be used
only as an explicitly labeled harness diagnostic if the Astropy official
environment is blocked; it is not a replacement ability result.

### Phase permissions and missing decisions

| Phase | In the first task? | Boundary |
| --- | --- | --- |
| Inspect repository, source docs, case metadata and local environment | Yes | Read-only; avoid printing secrets. |
| Download pinned public assets, build an isolated local image, run official reference/no-change controls | Only if the later user explicitly invokes the copyable task below | Bound to this one case and record exact assets, commands and resource use. If platform, license, network or Docker blocks the run, document the blocker. |
| Invoke Deskmates's real model / incur model cost | No | Requires a separately frozen task-specific budget, adapter and authorization. |
| SSH, sync, build or run on Testbox; alter a deployment | No | Historical host details are provenance, not permission. |

The first task leaves the time/turn/model-cost budget, repeated-attempt count,
and full-agent instruction adapter **undecided**. Those decisions must be
recorded before a later live attempt, along with source/image/config hashes,
egress policy and the expected artifact handoff. Do not import the example
human-time difficulty label as a Deskmates budget.

## Copyable request for a later new session

> Work in this Deskmates checkout using GPT-6 Sol at medium reasoning for all
> concrete work and any subagents; coordinate the task at the root. Read
> `docs/runbooks/agent-task-evaluation-handoff.md`, `AGENTS.md`, and its listed
> design/research sources. Resume **only phase 1** for SWE-bench Verified
> `astropy__astropy-13033`: verify exact asset/license/platform feasibility,
> create a versioned case manifest and a local isolated official-harness
> reference plus no-change control if dependencies are available, then write
> an English feasibility receipt with hashes, commands, result and blockers.
> You may obtain pinned public dependencies and run the official controls for
> this one case locally. Preserve all existing dirty work. Do not launch a
> Deskmates/model trial, assume a budget, SSH or sync to Testbox, deploy, merge,
> or work on the other five cases. If a local reference run is blocked, finish
> the read-only feasibility and report the specific missing prerequisite; ask
> only if a decision or access is essential. Report which checks actually ran
> and which remain unknown.

The product owner asked earlier to record the suite plan and implement later;
the copyable request is an explicit signal to begin the one bounded phase,
with no extra reconfirmation needed for work inside that phase.

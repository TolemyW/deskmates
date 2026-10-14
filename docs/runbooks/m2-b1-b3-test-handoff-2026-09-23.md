# B1–B3 verification handoff

Date: 2026-09-23. Owner: the next testing agent.

The user stopped further testing in the development task and requested this handoff.
Do not restart a broad test campaign automatically. Development may continue in parallel;
remaining acceptance work does not block unrelated tasks. Formal B1–B3 closeout is still
pending the selected gates below. No merge, deployment or default-mode change is claimed.

## Frozen code and image

- Worktree: `/Users/owner/agent_workspace/3-cogbox/deskmates/.claude/worktrees/codex-m2-foundation-20260922`
- Branch: `codex/m2-foundation-20260922`
- Runtime revision: `c65f172f24e3ca0f88667ba4d2546108a2e50609`
- Image: `cogbot/workspace:m2-live-capture-closeout-r2-20260923`
- Image ID: `sha256:9ba49192ee2ec46a1278b14cf94510d739a74225a794793f061b9b94768f3e99`
- Selected model: `glm-5.3`; coordination: `tab-v1`; role: `v2`;
  completion: `baseline`; candidate snapshots: `inline-v2`.
- Product snapshot default remains `explicit-v1`. Candidate acceptance must be labelled
  with its actual mode; it does not prove the default configuration or general superiority.

The last two runtime commits fix background screenshot stalls by verifying and bringing
only the intended target forward before capture, then checking target, URL and control
epoch again. They do not add a global lock, extend the deadline or retry an action.
Earlier changes provide opt-in inline page snapshots, bounded status-read retries and
stronger chief/group assertions. The image above includes those changes.

For concurrent development, create a separate test worktree from this revision. Do not
modify the frozen checkout while a measurement is running. Read the repository AGENTS.md.
Do not restart the main app, modify its database, reuse its workspace, overwrite `:dev`,
or use its ports 5173/8080. Test runners create their own stack and ephemeral ports.
Coordinate only competing model/browser load, not all development work.

## Already verified — do not repeat by default

| Evidence | Result and limit |
| --- | --- |
| Full T0/T1 at `49d8044` | 1,143 tests / 82 files pass; `unit-capture.log` |
| Final fence correction at `c65f172` | All 41 coordinator tests and repository typecheck pass |
| Capture helper, coordinator and proxy before that last correction | 82 targeted tests pass; helper includes identity/race/error cases |
| Separate no-model capture experiments | Baseline background 0/8; foreground preparation 8/8; extra flags 0/8 |
| Dual-session foreground race experiments | Natural overlap and forced foreground stealing: 32/32 images correct, no timeout; includes 0/200 ms gaps |
| Previous inline r2 image `faa37310…` | Browser/approval/takeover/snapshot/cap T2 checks pass, including approval/takeover in both modes |
| Previous same-image GLM snapshot A/B | Inline 8/8 runs complete, X02/X03 canonical and strict pass; explicit 7/8, one timeout. This predates the capture fix |

The final-image T2 batch was canceled at the user's request. Its partial log contains a
successful driver result for sixteen concurrent clicks and sixteen correctly attributed
images (`clickCaptures: [8,8]`), but the batch has no complete passing suite result. Mark it
**interrupted**, not failed or fully passed. Its test container, worker and three dedicated
volumes were removed. No K5 or final-image real-model smoke was started.

Evidence roots, relative to the frozen worktree:

- `spikes/m2-business/work-closeout-validation-20260923/`: unit/build/T2 logs;
  interrupted batch: `container-capture-r2.log`.
- `spikes/m2-business/work-closeout-inline-paired-20260923/`: previous A/B raw reports.
- `spikes/m2-browser-capture/work-20260923T095928Z-72152/`: sequential reproduction.
- `spikes/m2-browser-capture/work-concurrent-20260923T101827Z-83522/`: concurrency probe.

Raw `work-*` directories are ignored by Git and remain in the original worktree. Copy
needed evidence explicitly if using another checkout. The tracked narrative is
[the closeout results](../design/m2-b1-b3-closeout-results-2026-09-23.md).

## Prioritized remaining checks

1. **Targeted final-image regression:** real browser captures, inline delivery, approval
   resume and takeover. Run the commands below once; do not repeat all historical probes.
2. **One real-model ticket smoke:** eight runs on the final image. If it fails, report the
   exact failing run and first faulty step before scheduling a longer matrix.
3. **Milestone closeout campaign, separately scheduled:** fresh ticket K5 and the named
   B1/group/chief/X01/takeover/parked-approval checks. These remain a testing backlog;
   they are not prerequisites for unrelated development.

K5 takes approximately 75–90 minutes based on the previous candidate, possibly longer.
Do not launch it merely to keep an agent busy or rerun it until green. The original
300-second task deadline and 35-turn cap stay fixed. Broader model comparisons,
performance-superiority studies, B4/B5 and resource-sizing work are outside this handoff.

## Commands

Run from the chosen test checkout. Do not print or copy credentials into tracked files.
Use a fresh output directory for every attempt; never replace previous evidence.

```sh
export WORKSPACE_IMAGE=cogbot/workspace:m2-live-capture-closeout-r2-20260923
MODEL_ENV=/Users/owner/agent_workspace/3-cogbox/deskmates/.env
EVIDENCE_ROOT="spikes/m2-business/work-handoff-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$EVIDENCE_ROOT"
docker image inspect "$WORKSPACE_IMAGE" --format '{{.Id}}'
```

Verify the image ID above before running. For targeted T2, no real model is used:

```sh
node node_modules/vitest/vitest.mjs run \
  acceptance/m2-browser.container.test.ts \
  acceptance/m2-browser-inline-snapshot.container.test.ts \
  acceptance/m2-browser-approval.container.test.ts \
  acceptance/m2-takeover.container.test.ts --maxWorkers=1 \
  > "$EVIDENCE_ROOT/t2-default.log" 2>&1

M2_BROWSER_SNAPSHOT_MODE=inline-v2 node node_modules/vitest/vitest.mjs run \
  acceptance/m2-browser-approval.container.test.ts \
  acceptance/m2-takeover.container.test.ts --maxWorkers=1 \
  > "$EVIDENCE_ROOT/t2-inline.log" 2>&1
```

Configured-model smoke:

```sh
node spikes/m2-business/run.mjs --env "$MODEL_ENV" --image "$WORKSPACE_IMAGE" \
  --model glm-5.3 --suite tickets --role-contract v2 \
  --coordination-mode tab-v1 --snapshot-mode inline-v2 \
  --completion-contract baseline --repetitions 1 --output "$EVIDENCE_ROOT/ticket-smoke"
```

Only when the closeout campaign is scheduled, use the same command with
`--repetitions 5 --output "$EVIDENCE_ROOT/ticket-k5"`. Then run the remaining named gates:

```sh
for suite in group chief billing takeover; do
  node spikes/m2-business/run.mjs --env "$MODEL_ENV" --image "$WORKSPACE_IMAGE" \
  --model glm-5.3 --suite "$suite" --role-contract v2 --snapshot-mode inline-v2 \
  --repetitions 1 --output "$EVIDENCE_ROOT/$suite"
done

DEFAULT_MODEL=glm-5.3 node spikes/m2-live/run.mjs \
  --env "$MODEL_ENV" --image "$WORKSPACE_IMAGE" --snapshot-mode inline-v2 \
  --repetitions 2 --output "$EVIDENCE_ROOT/b1"

DEFAULT_MODEL=glm-5.3 node spikes/m2-browser-approval/run-model.mjs \
  --env "$MODEL_ENV" --image "$WORKSPACE_IMAGE" --snapshot-mode inline-v2 \
  --output "$EVIDENCE_ROOT/approval" > "$EVIDENCE_ROOT/approval.log" 2>&1
```

The approval runner covers S01 and S11 parked/resume, not every historical M1 approval
scenario. The `all` business suite does not support inline mode; select named suites.

## Acceptance and reporting

- Capture regression: sixteen ordinary concurrent clicks, exact counters `[8,8]`,
  sixteen images, no skipped capture, correct target attribution. Approval and takeover
  assertions remain unchanged. Inspect capture warnings separately from business success.
- Ticket smoke: eight unique completed runs; requested state and unrelated-state checks
  pass, overlap/target/screenshot checks pass. Preserve canonical and strict outcomes.
- K5: five repetitions, X02 and X03 each present once per repetition; each scenario has
  solo A, solo B and concurrent AB; forty unique run IDs, ten classified pairs.
  Missing/failed solo controls are unclassifiable, not zero interference. Report actual
  sample size, failures, exclusions, timing gaps and uncertainty. Never replace failures.
- A clean K5 is functional evidence for this exact configuration. It is not proof of a
  population failure rate below 5%, a general strategy improvement, or deployment.
- Preserve manifests, results and raw reports even when the process exits nonzero.
  Distinguish infrastructure interruption, task failure and oracle failure.

Existing summaries:

```sh
node --import tsx spikes/m2-business/analyze.ts "$EVIDENCE_ROOT/ticket-k5" \
  "$EVIDENCE_ROOT/group" "$EVIDENCE_ROOT/billing"
node spikes/m2-business/timing-analyze.mjs "$EVIDENCE_ROOT/ticket-k5"
node spikes/m2-live/summarize.mjs "$EVIDENCE_ROOT/b1"
```

Also inspect chief/takeover/approval raw results: the business analyzer does not validate
all their assertions. Return a compact table of gate, revision/image/mode, result, evidence
path and concrete remaining defect. Do not expand the campaign without a demonstrated
failure or an explicit request. Report implementation, verification, merge and deployment
as separate states.

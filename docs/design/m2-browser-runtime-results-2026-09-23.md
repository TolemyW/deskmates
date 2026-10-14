# M2 B2 browser runtime: implementation and verification

## Status and scope

The B2 runtime implementation and focused browser/SDK/model checks are delivered.
This is not full M2 acceptance. X02/X03 K=5 interference calibration, full X04
acceptance and B3 remain open. Work stayed in `codex/m2-foundation-20260922`; the
active app on 5173/8080, its database, main checkout and shared development image
were not updated or restarted.

Implementation commit: `4938dc0927494057a24dc0068e845643cfd7efe0`.
Final image: `cogbot/workspace:m2-live-browser-final-20260923`.
Image ID: `sha256:83784feadfc2ff779fc814c63e139bfb76d9b5f3733446bb0f31b3be6f698f65`.
Pinned SDK/MCP/browser dependencies are unchanged.

## Delivered behavior

- Each run lazily opens a separate tab in the workspace's existing Chromium and
  profile. Cookies and login state remain shared. No bot access-control layer,
  origin lock, additional browser, package download or Gateway model call is added.
- MCP display indices are mapped to stable CDP target IDs. Two MCP connections
  can enumerate the same pages in different orders; URL and title are not identity.
  The initial protocol probe proved this against MCP 0.0.82.
- The existing stdio proxy serializes browser calls, leases the actual target,
  reindexes explicit selection/closure, and rejects a queued call if the selected
  context changed. Risk classification, egress and approval remain in PreToolUse.
  The hook acquires without moving the existing lease: hooks can execute ahead of
  an action already in flight. Only serialized browser dispatch changes targets.
  Delayed screenshot renewal cannot move an established lease to an old tab.
- Tab metadata under `<bot-home>/.cogbot/browser/<run-id>.json` restores the same
  target after a proxy/process restart. A closed target opens a fresh tab and
  rejects the pending action. Closing a run tab does not reveal MCP's automatically
  selected fallback page. A changed page origin refreshes approval metadata and
  rejects the current action for a fresh decision.
- Human takeover blocks dispatch and capture for every bot. Migration 0010 adds
  a persistent workspace epoch so a rapid takeover/handback still invalidates
  in-flight results and buffered screenshots. Gateway ingestion rejects those
  screenshots before ledger/SSE publication. An already dispatched action may have
  completed; the error explicitly asks the model to inspect before retrying.
- Run configuration records `browserRuntimeVersion: 1`; stable target acquisition
  is visible in ledger logs. Normal lifecycle cleanup releases the run's lease.

## Evidence

| Check | Result | What it establishes |
| --- | --- | --- |
| Root typecheck and Biome | Passed | Backend, acceptance types and repository checks |
| T0/T1 full suite | 983/983, 67 files | Existing regressions plus stable IDs, closed targets, origin changes, capture fencing, queue ordering and hook/lease behavior |
| `m2-browser.container.test.ts` | 2/2 | Real proxy/MCP/Chromium/Gateway coordination and concurrent real SDK paths using a scripted upstream |
| `m1-takeover.container.test.ts` | 5/5 | Existing takeover, wait, handback, noVNC, ledger and SSE behavior survives the runtime change |
| `m2-browser.acceptance.test.ts`, final image | 2/3 strict pairs; 6/6 runs completed | One correct numeric answer violated the required `answer: ...` reply format |
| Recorded runtime audit, final image | 3/3 pairs, 6/6 runs | Distinct targets, overlapping run intervals, no tool errors and target-matched screenshots |

The direct real-browser driver checks distinct targets, concurrent own-page
snapshots, shared cookies, same-tab contention, proxy restart, takeover blocking
both clients, skipped capture during takeover, handback, and peer usability after
one tab closes. It runs under a dedicated container with short-lived run tokens
passed through stdin; no upstream model secret is printed or committed.

The final GLM-5.3 sample took 14.2 s, 13.2 s and 10.2 s per pair. The last
revenue reader (`run_9dcf9251da36425d8405a964fa9e1bd5`) replied
`The dashboard shows "This month's revenue" as 0.00.` instead of `answer: 0.00`.
This is a strict acceptance failure, not a failed browser action. All six runs
completed with distinct per-pair targets, no tool-result errors and matching
screenshot target IDs. The offline audit records these runtime facts separately;
it does not alter the failed strict oracle or turn the T3 suite green. The shared
session-count assertion was reached in the first two pairs; in the third pair the
format assertion terminated the case first.

The model smoke seeds one operator login in the golden-site profile, then starts
two bots concurrently to read different dashboard metrics. Bots receive no login
credentials. Oracles require exact answers, separate stable targets, successful
browser results, target-attributed screenshots and exactly one authenticated
session. This verifies the focused shared-login path, not broad role following,
long-session reliability, or a performance improvement over the old runtime.

Commands (run inside the isolated worktree):

```sh
npm run typecheck
npm run lint
npm test -- --maxWorkers=1
WORKSPACE_IMAGE=cogbot/workspace:m2-live-browser-final-20260923 npx vitest run \
  acceptance/m2-browser.container.test.ts acceptance/m1-takeover.container.test.ts --maxWorkers=1
node spikes/m2-browser/run.mjs --env /path/to/main/.env \
  --image cogbot/workspace:m2-live-browser-final-20260923 --repetitions 3 \
  --output spikes/m2-browser/work-final-20260923
```

Machine-local evidence (ignored by Git):

- `spikes/m2-browser/work-final-20260923/manifest.json`: source, image, model,
  endpoint origin, test digest, start time and budgets.
- `spikes/m2-browser/work-final-20260923/browser-results.json`: full final
  case results, runs/configuration and redacted events.
- `spikes/m2-browser/work-final-20260923/runtime-audit.json`: independent runtime
  audit from `node spikes/m2-browser/audit.mjs <browser-results.json>`, including
  overlapping run intervals. The strict third-case failure remains recorded.
- `/private/tmp/cogbot-b2-container-final.log`, `cogbot-b2-live-final.log`,
  `cogbot-b2-unit-final.log`: complete final test outputs.
- `spikes/m2-browser/work-live-20260923/`: earlier candidate passed 3/3 pairs
  (6 runs), before the ahead-of-dispatch lease fix; preserved separately.

Failures found during development are not acceptance evidence: an initial test
fixture used the invalid trigger kind `thread`, and two existing assertions needed
new lock-log/configuration expectations. A renewal check initially rejected legacy
no-target leases gaining their first target; compatibility was restored while
keeping established-target moves forbidden. The final T0/T1 suite passes with these fixes. The earlier model candidate passed
its three strict pairs; the final model sample has the formatting failure above.
No retry was used to replace or conceal that failure.

## Remaining acceptance and operational limits

1. Run the measurement protocol for X02/X03 with K=5, recording overlap and
   interference against a single-bot baseline. The golden site's ticket/report
   routes are still stubs, so do not label the dashboard smoke as those scenarios.
2. Complete full X04 and a real deferred-approval resume through the new browser
   path. This batch verifies target restoration after process restart, not the
   complete parked approval scenario on the configured model.
3. B3 still needs full chief/group acceptance, adversarial relay limits and browser
   UI verification against a real stack. Existing foundation/model results remain
   valid for their narrower scope.
4. Tabs and per-run metadata remain for inspection; automatic retention/cleanup
   limits are not implemented. Measure long-lived workspace resource use before
   declaring always-on scaling complete.
5. Locks are coordination within one trust domain. Arbitrary browser code and shell
   can operate shared resources directly. In-flight actions cannot be rolled back
   by takeover. Legacy sidecars without the epoch field do not gain the new
   post-handback screenshot fence until their image is upgraded.
6. MCP result parsing is pinned to 0.0.82 and fails closed when stable target
   identity is unavailable. Browser dependency upgrades must rerun the real
   protocol and runtime checks. No strategy superiority or statistical behavioral
   equivalence is claimed from these small samples.

# M2 configured-model closeout: knowledge and ticket smoke

Date: 2026-09-24 (Asia/Taipei). These are one-pass acceptance observations, not a paired
strategy comparison or full M2 milestone acceptance. No failing sample was replaced, and no
prompt, oracle, run deadline or turn budget was changed after either run.

## Frozen inputs and evidence

Both campaigns ran from source revision `d44c796f43209c143b2ffc998fc2a12619cf77f8`
with `cogbot/workspace:m2-live-closeout-20260924-r4`
(`sha256:be3e8f675d3e876cb8d768cf63674ee18ccde54edebed833a9fc17e18cff5e21`)
and `cogbot/egress-proxy:m2-closeout-20260924-r4`
(`sha256:b23093917a36dae8faaf5a041ed691f02216b8ea0ec086bc5f3f3423c0353499`).
The golden site was version `1.2.1`. The configured model was `glm-5.3`; browser mode was
`tab-v1` with `explicit-v1` snapshots. The ticket completion contract was `baseline`.
The runner recorded source/test hashes and nonsecret configuration in each manifest.

- Knowledge: [`spikes/m2-closeout/work-knowledge-r4-20260924/`](../../spikes/m2-closeout/work-knowledge-r4-20260924/) contains `manifest.json`, `test.log`, `result.json` and `knowledge-results.json` with run events and publication facts.
- Tickets: [`spikes/m2-closeout/work-ticket-smoke-r4-20260924/`](../../spikes/m2-closeout/work-ticket-smoke-r4-20260924/) contains the corresponding manifest/log/result and `ticket-workflows-results.json` with each arm's state, run rows, checks and events.

These are ignored local evidence directories, not committed source artifacts. Both campaigns
used one repetition. The saved files were checked for the local model auth token without
printing its value; none contained it. Their disposable stacks and temporary fixture
directories were removed after the tests.

## B5 knowledge publication

`acceptance/m2-knowledge.acceptance.test.ts` passed 1/1 in 20.76 seconds. The first
configured-model run called `knowledge_propose`; the draft was absent from search and
document read before operator review. An authenticated operator approved it. A different
bot then called `knowledge_search` and `knowledge_read` for the published ID and version.
The test asserted the tool result contained that exact ID and version 1.

| Role | Run ID | Result |
| --- | --- | --- |
| Proposer | `run_6fc9d1a4540c4e2280e38f67587c8dc0` | `succeeded`; proposal `kp_6d99acf9e71f4594b5779c10598d301f` |
| Reader | `run_8f7c2a53eeec4301af011d472f05d460` | `succeeded`; read `kb_31684c76d4e6408fb0e58560f3d210bc` version 1 |

The local no-model knowledge/memory container acceptance also passed 4/4 on the earlier
r2 workspace/r1 proxy images. It covered proposal pagination beyond 25, reject/double
review, immutable versions and orphan cleanup, a fresh Gateway reopening the same store,
real-image memory edit/export/clear/version conflict, and apply-once/reject of suggestions.
The native PTY container smoke passed 1/1 on those images. Its earlier output was not
saved as raw stdout; [`spikes/m2-closeout/work-t2-20260924/results.json`](../../spikes/m2-closeout/work-t2-20260924/results.json)
is explicitly labeled transcribed verification metadata.

## Canonical ticket smoke

`acceptance/m2-ticket-workflows.acceptance.test.ts` completed both scenarios in one
campaign: **X02 failed its canonical oracle; X03 passed.** All eight run rows were retained.
Each run had the existing 300-second `RUN_TIMEOUT_SECONDS` and 35-turn limit. The first
failure was not retried, and K5 was not started.

| Scenario / arm | Run IDs and terminal status | Canonical | Strict diagnostics |
| --- | --- | --- | --- |
| X02 solo task 0 | `run_53dd2635c6d849239d86d0dd9a3530cf` `succeeded` | Pass | Two tool-result errors |
| X02 solo task 1 | `run_a060650d8c5d4039a71ec566fdfc6fea` `succeeded` | Pass | Pass |
| X02 concurrent 0+1 | `run_c723d3f23cae4324a02c135fa39ea656` `failed`; `run_2189bac61ad34bc580abe22c1f31b2ee` `succeeded` | **Fail**: runtime and requested writes | One tool-result error in run 1 |
| X03 solo task 0 | `run_7da96434396e40a3a3172219eae1b771` `succeeded` | Pass | Pass |
| X03 solo task 1 | `run_3ac752c7c66b4a02a6e722f9efbbbbc5` `succeeded` | Pass | Called `Bash`, violating the browser-only task protocol |
| X03 concurrent 0+1 | `run_323f5b0f6cb84acbb1da1c407c8ae371` and `run_2accd6c3c75547da9e3b482ce2cfc6e2`, both `succeeded` | Pass | One tool-result error in run 1 |

The X02 concurrent task-0 run ended after exactly 300 seconds with
`run exceeded RUN_TIMEOUT_SECONDS (300 s); sidecar killed`. At the paired arm's
captured state, ticket 1015 had the requested `refund` tag, ticket 1058 still had
only `support`, and all three requested reassignments had reached `li`. The canonical
requested-writes and runtime checks therefore both failed. This is the retained first
failure sample.

For that timed-out run, the ledger has 13 completed `model_request` spans and 12 browser
calls: five snapshots, three clicks, two types and two navigations. The navigations went
to `/tickets` and `/tickets/1058`; its last call was a snapshot of 1058. It made no tab
tool call or repeated login. It had no error tool results or target-lookup errors.
Summed `model_first_byte` observations were 313.7 seconds, whereas summed
`browser_rpc` observations were 2.2 seconds; these span sums are not additive wall time.
The available evidence is consistent with model execution/latency exceeding the fixed
window while a requested edit remained undone. The timed-out run had **zero** tool-result
errors; its timeout is separate from the strict errors in other runs. All four strict
tool-result errors were targeted `browser_snapshot` calls whose `target` was an
accessibility ref no longer present in the current page snapshot after a page-changing
action. Each affected run recovered and reached its reported terminal result. These are
stale target references, not authentication, approval, HTTP, schema or unknown-tool
errors; the affected runs had no approval events. They do not demonstrate a framework
lookup failure behind the timeout. The X03 `Bash` call is a model behavior deviation
from the browser-only instruction, not evidence of a framework failure.

The result is a failed canonical X02 smoke and a passing canonical X03 smoke, with strict
diagnostics failing for both. It does not justify increasing the deadline, changing the
prompt, or claiming a reliability improvement. Continue with the existing handoff and
measurement protocol before a milestone or strategy claim.

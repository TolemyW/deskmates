# M3 actual SDK streamed per-response usage observation

Date: 2026-10-03 Asia/Taipei. Diagnostic passes; production repair remains open.
No real model, production change, commit, release or deployment.

Automatic-compaction receipts revealed a coverage gap: actual SDK assistant
messages can carry provisional output usage while the proxy and final run
result contain final usage. One predeclared local SDK 0.3.278 query now tests
the public `includePartialMessages: true` path against a scripted loopback
upstream. It uses no tools, one turn and a sixty-second abort boundary with
isolated home/settings and an explicit subprocess environment.

The exact observed sequence for one response (`msg_fake_1`) is:

| Event | Synthetic input | Synthetic output |
| --- | --- | --- |
| stream message_start | 351 | 1 |
| complete assistant content-block envelope, stop_reason null | 351 | 1 |
| stream message_delta | not present | 132 |
| stream message_stop | not present | not present |
| successful SDK result | 351 | 132 |

One messages POST and one SDK HEAD probe are recorded; real model calls zero.
The assistant precedes the final delta. Its final model aggregate also reports
132 output tokens. The SDK's estimated cost is retained in raw evidence but
is not used by Deskmates pricing, nor described as real spend.

`spikes/m3-sdk-stream-usage-20261003/probe.ts` source SHA-256:
`a18c610f8ee8e1aa4db0f809e4f6c2b3dcda69fde9d29b518d2dc160d84795ce`.
Ignored `work-01/receipt.json` SHA-256:
`0d0fe415c5634b35145326c1817b138fedd9b962028c3ca0556704c335a30863`.
Six SDK/helper/lockfile inputs are hash bound unchanged; invocation exit zero,
query and upstream are closed, and standalone strict TypeScript passes.
This selected local query has no independent Docker/process termination audit.

The current production TurnUsageTracker retains the last completed assistant
block; that block need not contain final usage. This observation confirms the
SDK event path available for a separate framework repair: consume message_start
and final delta/stop by response identity without double-counting blocks or
nested streams. Preserve incomplete output as unknown when no final event
arrives, and keep compaction summarizer requests separate from main SDK turns.
Meaningful fake-SDK regressions and a real production-stack scripted check are
required before promoting that repair. No configured-model usage, window,
cache, compression quality or memory retention claim follows from this fixture.

## Subsequent repair and bounded authentication diagnostic

The earlier diagnostic above retains its original revision/outcome. Production
is subsequently repaired and checked in
`m3-sdk-final-turn-usage-results-2026-10-03.md` and the separately frozen full
`m3-stream-usage-integrated-gate-results-2026-10-03.md`.

One additional local authentication-envelope observation is reserved under
`work-auth-01`, using `auth-error-probe.ts`, the current production tracker and
a deliberately wrong synthetic token against only a scripted loopback upstream.
One logical/physical SDK query is capped at one turn and thirty seconds.
Its request recorder sees one HEAD and six messages POSTs during SDK retries.
The abort boundary is reached without any assistant, stream or final-result
envelope. The SDK reports an aborted-query exception; the fixture closes its
query and upstream and exports the partial receipt. Real model calls are zero;
token/cost measurement is unknown, not zero. No subsequent query is launched.

This observation is inconclusive about SDK authentication-error assistant shapes
and does not establish another production usage defect or a passing error-path
acceptance. No production change follows it. Tracker hash remains
`6dc0a4d4a1d36355a5e6eed38fcd64aa357a789f1e386ad829dc8dc6c7fc9c87`.
The probe has no independent owned-process audit; it is separate from the
Docker/PID audits for actual Gateway T2 invocations.
Partial receipt SHA-256:
`d5f1f96c10584960dfe166d2f5ef12f34d67ae53d3ba19fa4166ea542757e6fb`.

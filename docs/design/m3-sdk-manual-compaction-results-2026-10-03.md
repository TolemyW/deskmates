# M3 actual SDK manual compaction mechanics

Date: 2026-10-03 (Asia/Taipei). One local observation completed at
2026-10-02T16:48:31.454Z. Status: mechanical check passed; M3 remains open.
No production change, real model call, commit or deployment was made.

## Scope and binding

`spikes/m3-context-probes-20261002/compact-fake-endpoint.ts` invokes the actual
installed Claude Agent SDK 0.3.278 on macOS arm64, with the production
`createPreCompactHook`, `realFs` and `EventSink`. Its scripted Anthropic-protocol
endpoint listens only on loopback. This is not a fake-SDK test, a container
acceptance test or a configured-model measurement.

Three phases were reserved before execution: seed one synthetic session,
resume it with `/compact`, then resume after compaction. Each query permits no
tools, has one SDK turn and a sixty-second abort deadline. HOME and SDK config
are isolated in a fresh private work directory; user settings and real model
credentials are not supplied. The query handles and upstream are closed on exit.

Source SHA-256:
`7096406be3553e7b54b1f51ae6e9ff484827d06b216e09d2da1abdbae124b6ca`.
Receipt SHA-256:
`43b0c3fbbc6259210dc2ccb9bf35eec7171500d533ea2aa34312ee39ae799aa1`.
Ignored private evidence is retained under
`spikes/m3-context-probes-20261002/work-compact-01/`: reservation, receipt,
SDK transcript/archive and `verified-binding.json`. The latter binds the hook,
filesystem/sink, fake upstream, lockfile, SDK JavaScript and native executable.
An initial post-run binding command incorrectly assumed a `cli.js` package
layout; inspection identified the actual optional native package. Only that
read-only binding audit was corrected; the SDK experiment was not restarted.

## Observed results

All three phases return success in the same SDK session. Fourteen SDK messages
include exactly one manual `compact_boundary`. The actual SDK invokes
`PreCompact` before that boundary. The production hook emits one archive event
and one memory-flush event, without an archive/flush failure.

The hook's pre-compaction transcript is 16,619 characters and includes the
synthetic marker. The retained archive matches its complete bytes by SHA-256:
`4ac1c3e079e03a4b5a31c03e48d66ea180d2d0ceb3a87a8b6e5d47794a17df1e`.
This proves preservation of the original transcript supplied by this SDK's
manual compaction path, rather than merely preservation of its summary.

Boundary metadata reports `trigger: manual`, `pre_tokens: 2620`,
`post_tokens: 335`, `cumulative_dropped_tokens: 2285` and `duration_ms: 24`.
These are fixture-derived observations: the upstream supplies estimated usage.
They must not establish a real endpoint's token counts, cost, context window or
compression quality. The receipt records three messages POSTs and three SDK
HEAD probes, all to the local fake upstream; real model calls are zero.

Standalone strict TypeScript checking passed before execution. A separate
receipt audit verifies three successful results in one session and the archive
hash. No full project suite was repeated for this spike-only addition.

## Limits and remaining gates

The memory-flush callback deliberately returns a synthetic untrusted-page
snapshot. This verifies callback/event wiring, not actual sidecar taint tracking,
learned-item extraction or Gateway ledger persistence. The probe calls the hook
directly through SDK options; it does not run `runOnce` or the Gateway/container
stack. Its canned summary already contains the marker, so subsequent marker
presence is not evidence of model recall or poison resistance.

Automatic compaction under a real context limit, configured-model prompt/cache
behavior, real usage coverage, post-compaction task quality, container runtime
behavior and ordered paired memory experiments remain separate requirements.
The proposed larger real-model campaign has not been launched.

# Fresh-thread memory context control

Date: 2026-10-03 (Asia/Taipei). Status: selected no-model component control
verified; combined actual runtime and full M3 remain incomplete. No SDK query,
model configuration read, model call, Docker invocation, remote dispatch,
production edit, deployment, commit or release occurred.

The existing database retention-off preflight checks forgetting through search,
index and canonical exports. It does not test whether old thread messages or
SDK sessions would reintroduce previously revealed answers. The new
`spikes/m3-memory-campaign-20261002/context-control-preflight.ts` covers that
selected prerequisite using production run-payload/context code and routes.
It uses an in-memory Gateway fixture with the scheduler stopped, not the SDK.

Each synthetic arm creates an answer-bearing old thread, a synthetic prior SDK
session ID, one trusted workspace note, one pending imperative confirmation and
one unpublished knowledge proposal. Manual SOUL/MEMORY rules are preserved.
The retention-off arm forgets its note through the operator route; the on arm
keeps it. A reused old thread still passes its canary to the constructed prompt
after forgetting and still receives the synthetic session ID. This positive
control proves that forgetting alone cannot neutralize earlier thread context.

A fresh thread's prepared request has no SDK session ID and no answer-bearing
old message in its trigger. Independent snapshots show:

| Selected surface | Retention on | Retention off |
| --- | --- | --- |
| Rendered fresh context | Canary present | Canary absent |
| Pinned memory index | Canary present | Canary absent |
| Run-token memory search | Canary present | Canary absent |
| Canonical export | Canary absent (fixture seeds no bot-scoped experience) | Canary absent |
| Run-token access to old thread transcript/operator proposal/confirmation APIs | 401 for all three | 401 for all three |
| Internal read of unpublished knowledge proposal | 404 | 404 |
| Internal knowledge search | Empty | Empty |

The pending confirmation and proposal remain host-visible and unchanged;
the old transcript prefix and manual rule bodies are preserved. No ledger is
erased to obtain a clean result. These are selected delivery/API observations,
not an access-control boundary between bots or a guarantee about every channel.
The clean filesystem is explicitly synthetic. Actual shared-profile, diary,
scratch/transcript reset and canonical export regeneration must still be
combined with a real fresh SDK query in the campaign controller.

Both arms pass. Standalone strict ES2022/NodeNext checks pass with
noUncheckedIndexedAccess and exactOptionalPropertyTypes; Biome's stdin
fix/check is byte-identical. API method/route names were corrected before the
runtime invocation. The source was copied before the one passing invocation,
and its receipt/current bytes match that copy. All **707** inventoried local
package/image/acceptance inputs still match frozen candidate 42bab952. The
offline comparison-tool repair is separate and does not alter those inputs.
No full T2 or real model suite was rerun for this new spike-only prerequisite.

| Material | SHA256 |
| --- | --- |
| Script | 4a08c8e6e8c12347056c43aa7faebd4477b811a3fd48c94f2a9e8689b17b912a |
| Retention-on report | 635cc32fda4767e39a166c1a7d785ae0f0ee1b8caaf75274b25444dc62c6e934 |
| Retention-off report | 402a2c92ee4de6b4d7f27092f8a8b864298885bd7327c584484647a000b01dfc |
| Runtime receipt | 7b7a55b187c539a0d72a05e685d649405daa8d1c8580c802e0e4a1e857ef72b1 |
| Source/report verification | 9f3236c8442a7201a2fb8791e89553c5af630181ae8c91b11ceee794fc7e3a00 |
| Frozen-input comparison | 47497640a5c43b54b7917a354d4c8ea1a8f0ded801f451ccee1908ecfe626396 |

Private source copies and reports remain under
`spikes/m3-memory-campaign-20261002/work-context-control-01`.
A throwing global fetch guard records zero unexpected fetches; the fixture's
proxy-request ledgers are empty. All session IDs/status transitions here are
synthetic; the query count is **0 SDK / 0 real models**. This is not a strategy
result. The legal ordered driver, combined runtime control, adequate per-bucket
sampling, poison modalities and scoped real-model results remain required.

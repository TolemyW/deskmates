# M3 frozen integrated gate including actual SDK memory lifecycle

Date: 2026-10-03 Asia/Taipei. Full deterministic gate passes; full M3 remains
open. One new frozen candidate and one full Testbox T2 invocation. No real
model, strategy adoption, commit, release, image build or stable deployment.
This does not relabel the preceding 3530ec94 90-pass gate or the separate local
SDK lifecycle/restart observations.

## Candidate and dispatch

- HEAD: `1109ec784d6493b39ccfbde605484f4feef6bc98`, dirty working tree.
- Source inventory: 967 files, manifest
  `42bab952f411f34f993ee9d18ba2d74be6db482df2e13e1b2806d3c8fe4b748a`.
- Source archive:
  `e0a9ab986c78a40eba3db12ff5f2240b06dca8277a4272168a7c671fb5b778c6`.
- Hash-bound source/helper transfer:
  `395ee2174e3526aff68f9bfae3d577f5e50257abc021abaf22140640afae42c9`.
- Remote root:
  `/home/owner/agent_workspace/deskmates-reusable-memory-integrated-gate-20261003-42bab952`.
- Unit: `deskmates-memory-integrated-gate-20261003-42bab952.service`.
- Invocation: `c720671ad30c4dd7b19c62ef1cb52e4b`.

Explicit inventory excludes actual credentials, secret-bearing .env, keys,
.git history, node_modules, compiled output and unrelated spike receipts. Only
the nine explicitly required existing T2/preflight spike files enter source.
Dependencies are copied only on the host. The shared heavy-test mutex serializes
this invocation. Test environment is a whitelist; no workstation or inherited
model credentials are used. Helpers are separately hashed.

Compared with the previous frozen gate, code changes are exactly
`acceptance/m3-memory-lifecycle.container.test.ts` and `acceptance/t2-smoke.list`;
other changes are documentation. No production input changed. The existing
amd64 workspace image is reused only after 216 relevant image source files and
freshly rebuilt contracts/sidecar/connector/golden compiled bytes match the
parent. Binding receipt:
`ea681d2f6cf373bdd07da290c823dc696fda560cf384d670df575c2fe9c9fcc8`.

| Image | Exact ID |
| --- | --- |
| Workspace | `sha256:81490be0a44d7a56f136f2572310d88621181d32bbf14cb6e0bd20453721181a` |
| Egress | `sha256:d279fa358ec208ccd6f117538cc4b307288a53b4e0448a76d701e7c88c1d565d` |
| Golden site | `sha256:c19acaf63d39570fba4bd850e75a9bbea05554ffc731417aea8dd749c63ddb69` |
| Connector | `sha256:c64e59e4041375dc80b8e9504aaebe935d789165e4a742fbb41e98f0f6f0a1b3` |
| PostgreSQL | `sha256:1b3c642526f8d274b12bdcd93b90aeb7e68a1f59eb20613adb96ed561c01d98c` |

No aliases, caches, production database or stable containers are changed.

## Gates and independent evidence

| Gate | Result |
| --- | --- |
| Backend/acceptance typecheck | Pass |
| Web typecheck | Pass |
| Lint | Pass |
| Complete T0/T1 | 2475 pass, zero fail/skip, 241 files |
| Workspace builds | Pass |
| Complete T2 | 91 pass, zero fail, one opt-in real-model SDK-shape skip, 29 files |
| Selected offline decision replay | One decision, identical, no error/unsupported |
| Ledger coverage | All 21 stack snapshots saved; integrity/FK-valid, 64 run rows and 52 synthetic usage rows |
| Exact resource audit | All 190 owned Docker identities independently absent |
| Frozen source audit | All 967 remote source hashes unchanged after build/tests and independent collection |

Full T2: one invocation, two workers, 368.65 seconds, original five-second
capture bound and eight two-client click rounds. All sixteen captures pass.
No diagnostic browser overlay, experimental flag or timeout widening. This
does not prove a cause/fix for the retained earlier 6.658-second screenshot
failure; historical failures and nondiscriminatory ABBA observations remain.

The new lifecycle assertion passes inside this full invocation. Five successful
actual SDK attempt-1 runs use four sessions: trusted candidate, untrusted memory
search, same-session tainted resume, background genuinely mixed-trust
consolidation, then clean fresh-session search. The on-host closed-ledger audit
checks both trust levels in the saved consolidation source set, retained episode
and task provenance, human-applied trusted bot note, rejected imperative, two
tombstones with all earlier bodies redacted, original session tainted and fresh
session clean. All five SDK usage rows match seven independent proxy responses
in input/output/cache fields: synthetic input 119501, output 471, cache 0/0,
cost unknown/null. These are the new amd64 invocation's counts, not pooled with
the earlier local observations. No real recall/poison quality is inferred.

Ordinary product prompt hash stays identical within this invocation:
`a7a8edaff9ab74005b9aef579ba3129bcfd9402679b1a1b0533df2afbec892d9`.
Same resumed-session wire system is identical; the new ordinary session differs
only in SDK billing-header block 0. Environment-dependent prompt hashes are not
claimed identical across separate local/remote observations. Cache benefit is
unmeasured.

Automatic compaction also passes on this image: actual SDK run
`run_3da2e8f344524fa0bc611672515c8bab`, session
`ef4f9d16-e70b-42bc-99a5-c4528cbbe981`, twenty-record raw archive exactly matches
the transcript prefix and retains the original successful Bash/tool-result
pair. Archive length 110923 UTF-16 code units. Main turn output 26/59 matches
proxy records in all fields; separate summarizer output 41 gives final
synthetic input 228716/output 126/cache 0/0/cost unknown. The directly launched
.mts replay passes; this invocation has no replay recovery or SDK/T2 retry.

## Transient unit observation limit and retained polling errors

Live snapshots confirm MainPID 4002213 with the exact InvocationID throughout
the test. After all commands finish, systemd garbage-collects the transient
unit: LoadState not-found, MainPID 0, inactive/dead, InvocationID empty. A strict
poll fails because it expects the InvocationID to remain; its receipt is
retained. A subsequent read-only template correction first fails before
execution because generic replacement modifies USER_UNIT/USER_INVOCATION_ID
field names. Exact delimited substitutions correct that polling helper.
Neither error starts another SDK query, task, build or T2 invocation.

Independent follow-up confirms the exact previous PID and process group absent
and retains user-journal start/resource-completion records bound to the original
InvocationID. The unit's native exit status is **unknown after collection**;
ExecMainStatus 0 on a missing unit is a default and is not asserted as the
original process exit. Every actual gate command's saved exit status is 0 and
the independent suite/receipt oracles pass. Unit disappearance plus exact
PID/group absence establishes termination; the status file alone does not.

## Bindings and remaining scope

Thirty-eight selected files are safely downloaded and hash-verified; no raw
database transfer. Retained on-host ledgers have independently checked hashes.

- Selected receipt archive:
  `d9b97f61c7a19d8edf544037586ff06ce588d2cf78fa5d13b0201350b3678e35`.
- Independent on-host audit:
  `05c6169e10a2c48aea33bb635b3f7413886ad33829b6de0709780cbc59c0be96`.
- Independent downloaded-proof audit:
  `65d40f98e0380b45655101d5b2c8cf55341d52f7bb205029343406033f0bb2df`.
- T2 JSON: `5279c601cac9747649dda88a71964f3052d1da12d7359a9e47212c5868bae037`.
- Memory proof: `b10a2ff97bd47b42fe5cd078db5919a52947cc7fd2f150eddad35d0cce3b53f1`.
- Decision replay:
  `512d23764ea356198bfd4fa2c6d1b5f7989a2bddd1468e2d37726b044ec27806`.

The post-dispatch test-strategy documentation update removes the obsolete
Desktop VM gate per C41 and maps WhatsApp/cost/context/memory acceptance. It and
later results/matrix/progress prose are separately attributable documentation
changes; all local production/test inputs still match this frozen candidate.
No code gate is promoted across an untested code change.

Full configured-model domain/context/memory and powered paired retention/poison
gates remain open. Live WhatsApp requires the owner's not-yet-prepared account
configuration. Native browser download landing remains unverified. Expanded
model campaign scope confirmation is pending after the prior automatic approval
rejection; no real-model campaign starts here. M3 remains incomplete.

# M3 frozen candidate remote receipt — 2026-10-02 fcbd9e69

Campaign: `/home/owner/agent_workspace/deskmates-reusable-m3-candidate-20261002-fcbd9e69`. Source HEAD `1109ec784d6493b39ccfbde605484f4feef6bc98` plus explicit dirty inventory. No commit/tag/merge/deployment; stable resources untouched.
Files: 931; manifest SHA256 `fcbd9e6993ce8f4136ace2606f666f2cb113c9b3b37acba46c003a025b67642f`; archive SHA256 `3d29ab69fa90b99f04e0cba15c241e6b376edd78480f72c0d2c9f61786f20228`.

| Gate | Status | Exit / reason |
| --- | --- | --- |
| copy-linux-dependencies | passed | 0 |
| offline-dependencies | passed | 0 |
| backend-typecheck | passed | 0 |
| lint | passed | 0 |
| t01 | passed | 0 |
| web-typecheck | passed | 0 |
| web-build | passed | 0 |
| backend-build | passed | 0 |
| channels-bin-link | passed | 0 |
| supplemental | passed | 0 |
| populated-migration-and-cli | passed | 0 |
| workspace-image | passed | 0 |
| egress-image | passed | 0 |
| golden-image | passed | 0 |
| connector-image | passed | 0 |
| public-egress-preflight | passed | 0 |
| connector-default-user-import | passed | 0 |
| domain-no-model-preflight | passed | 0 |
| t2-full | passed | 0 |
| t3-matrix | blocked | Automatic approval rejected broad real-model campaign scope; deterministic-only runner never reads model config or invokes models |
| context-measurements | blocked | Automatic approval rejected combined real-model scope; both measurement modes uninvoked |
| whatsapp-live-provider | blocked | owner has WABA account; scoped account/test-number configuration not ready; fake Graph is not live acceptance |

`evidence/supplemental.json`: 8 passed / 0 failed / 0 pending; failed suite count 0.

`evidence/t01.json`: 2438 passed / 0 failed / 0 pending; failed suite count 0.

`evidence/t2.json`: 86 passed / 0 failed / 1 pending; failed suite count 0.

Image IDs in images.json; test-support ledger preservation overlay original saved and used for source verification. All raw failures/partial attempts remain. Real/fake usage is separated in evidence/usage-real-model.json and usage-fake-model.json; attempts also in evidence/model-usage.json and SQLite ledgers; missing usage remains unknown. Each selected T3 suite executes once; no automatic repost/retry. Model keys parsed only in same-user child memory; no copied secret file or secret argv.
Cleanup: 181 exact created resources recorded, 0 still present. Domain reserved names checked by exact identity and fixture label. No prefix sweep/prune.
Fatal type if present: none. This receipt alone does not establish full M3 acceptance; live WhatsApp and separate memory/context strategy campaigns remain separate.
# Actual completion clarification

The deterministic-only unit finished at 11:32:20 UTC (started 11:25:40).
All 931 original source hashes were reverified after build and after T2.
T0/T1: 2438 passed; supplemental: eight passed; T2: 86 passed, zero failed,
one skipped real SDK-shape model-call assertion. The first concurrent browser
capture case, new real client disconnect/child-reaping case, SDK stable-ID
case and canonical restoration assertion all passed. This is one necessary
regression of changed code, not evidence of a quantified capture-reliability
improvement; the earlier 38bc failure remains retained.

The four final images were used directly in the single fresh domain
preflight. Product count changed from 23 to 22 by an owned host control,
while the mutant retained 9999; data receipt rows were A/2/150 and B/2/275.
Default non-root connector import and strict public egress preflight passed.

All 181 exact created resource identities were absent on final inspection.
This does not mean all removal commands succeeded: 110 reported exit 1,
primarily because tests had already torn down those resources. Final residue
was zero. Stable deployment resources were untouched.

The real-model branch was removed before the permitted launch because
automatic approval rejected the combined eighteen-suite/two-probe scope.
It was not restarted or bypassed. No model configuration was read, no T3 file
or context mode ran, and actual real-model calls are zero. The automated
receipt's generic model-bootstrap/one-suite-policy paragraph describes the
unexecuted plan. See the separate approval-scope table for exact assertion,
attempt, deadline and request boundaries; eighteen suites are not eighteen
model calls. Live WhatsApp remains a missing configuration prerequisite.

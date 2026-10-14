# M3 learned-memory prerequisite results — 2026-10-02

These are no-model prerequisites for the full campaign in
`m3-context-and-memory-plan-2026-09-29.md`, not Phase 4 acceptance or a measured
strategy improvement. None of these scripts changes production code, historical
ledgers, human rules, SOUL, or an existing deployment. The scripts and generated
receipts are outside the frozen `fcbd9e69` business candidate.

## Retention-off database control

`spikes/m3-memory-campaign-20261002/control-preflight.ts` uses the production
Gateway stores and routes through a no-model fixture with its scheduler stopped.
The common production learned-write path creates trusted/untrusted workspace
notes, task state and a pending imperative. A host fixture seeds one trusted bot
note representing an already consolidated result; no consolidation model runs.

Before forgetting, four applied notes are searchable, three appear in the pinned
version set, and the bot note appears in the canonical learned-experience export.
The untrusted page note is absent from the pinned index. The pending imperative
is also absent and remains a separate confirmation record.

Forgetting all four notes through the authenticated operator API leaves no
learned notes in the index, run-token search or canonical learned-experience
export. All four rows remain tombstoned and their version bodies redacted.
Manual SOUL, legacy human notes, the pending confirmation and another workspace's
canary remain unchanged. There are zero model requests.

The retained passing receipt is
`spikes/m3-closeout-20261002/work-local/memory-retention-control-preflight-02/receipt.json`.
Script SHA256:
`a1b965b77a63d9067c9100ccdf315a2223c45876cd830c9a596c5dde792a10ab`.
Standalone TypeScript checking passes with ES2022/NodeNext. The earlier `-01`
receipt retains a script assertion error: confirmation listing returns a page
object, and the script originally counted the object instead of its suggestions.
The corrected script was run in a fresh fixture/report directory. This was a
harness correction, not a production-memory failure or a selected model retry.

This proves only the database component. A full memory-off arm still needs fresh
SDK sessions and a common, audited procedure removing the campaign's own diary,
transcripts, scratch artifacts and browser pages between sessions in both arms.
Pending approvals/confirmations and accessible old transcripts also require
explicit treatment so they cannot leak a previously revealed answer. Human rules
must survive. This receipt neither proves an OS-process restart nor the absence
of every alternate memory channel.

## Historical suggestion classification

`spikes/m3-memory-campaign-20261002/classify-history.mjs` reads all 71 legacy
`memorySuggestions` from the two retained VendorDB long-run archives. Whole-file
hashes and expected run/suggestion counts guard the annotations against applying
to a changed archive. Raw bodies remain in ignored generated reports; this
document records aggregates only.

| Archive | Suggestions | Primary task scope | Workspace fact candidates | Bot method candidates | Human-rule eligible | Trust unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original, 68 runs | 54 | 19 | 20 | 15 | 0 | 54 |
| Revised, 39 runs | 17 | 8 | 7 | 2 | 0 | 17 |

Primary scopes are interpretive annotations, not a classifier gold set. Some
bodies mix facts and procedures and need splitting before any later migration.
Task-only allocations, deadlines, role instructions and artifact paths must not
become permanent experience. Workspace engine/adapter observations require
version-specific evidence and validity intervals. Twenty claims were marked
for independent validation, including conflicting approximate fixture limits
and blanket capability statements. This audit does not revalidate those claims.
Bot-authored useful content still cannot create a human-owned standing rule.

All historical trust values are unknown: these archives predate item-level
turn/source-taint receipts. Successful run status, absence of browser tools and
local shared-file reads do not establish trusted provenance. There is no
automatic promotion of old suggestions to trusted memory.

As a diagnostic only, the current deterministic classifier was applied with
empty rules/trusted-entry context. It gated 9/54 original and 2/17 revised
suggestions. Of the manually marked instruction-like bodies, 38 original and
14 revised bodies were classified `apply`; examples include local sequencing
and Chinese obligation phrasing. This is not a measured false-negative rate:
the annotations include benign procedures, context is incomplete, and `apply`
does not mean trusted or permanently consolidated. The current text-only
do-not-learn preview excluded none of these old bodies; historical transient
failure provenance is unavailable. Do not tune a new classifier against this
result and declare the poisoning gate passed.

Retained reports:
`spikes/m3-closeout-20261002/work-local/memory-history-classification-01/summary.json`
and `classified-suggestions.json`. Script SHA256:
`9ceea5c4470f01853241e5da04e5dcbf0c02573302c8afefa8de6653796a1a4d`.
Classifier source SHA256:
`5d7b0363e20bc9222c06185f6af96657c31ee9ca72b1bb1910b176b8c359c4bd`.

| Input | SHA256 |
| --- | --- |
| Original runs | `4ba02b0f1b11fb86ef3a164faef7f9fa2f4458b7a45c306806b26dac3aca8ebd` |
| Original events | `3dbedc4af6d13cc651a4f609c8e7eef7a25ba19eaf698035a3b5be14e9700c83` |
| Revised runs | `4a42b607c0dd0fad983d54f56bae15bb4f907d9685986a10d969028cdd4b88ab` |
| Revised events | `7302eeb238333a7b4b8e9143157f356c6a8f2fa022caea9625867cec4d18c307` |

The ordered G-RECALL/G-SCOPE/G-STALE/G-RULE/G-POISON/G-LONG campaigns, a full
retention-off paired arm and statistical safety evidence remain required.
G-XWS remains an exact structural T1/T2 gate. No model call, strategy knob,
migration, release or deployment was made by this prerequisite work.

## Ordered campaign oracle and HTTP/container fixtures

The new host-only `campaign-oracle.ts` specifies 54 prerequisite cases with five
ordered sessions each. The corpus covers all six statistical families; G-XWS
remains a separate exact structural oracle. Thirty distinct page-poison cases
are fixture definitions, not thirty completed model trials. PDF/image payloads
and powered sampling remain unverified. The ordinary golden-site package/task
version has not changed; this separate facade is not a promoted task-set release.

The evaluator checks a separately reserved case/arm/repeat/source/knob binding,
fresh task/thread/SDK attribution, both arms' file/profile/transcript controls,
off-arm absence from search/index/canonical export, human rule hashes, exact
responses, current eligible workspace facts and actual pinned task-scope data.
Historical episodes are not automatically classed as pinned scope leakage.
Missing store/action coverage stays unknown; a correct answer cannot make an
unverified control pass. Unknown cache fields/cost remain null. Duplicate
attempt/model usage rows are rejected rather than double counted.

Each result row represents a whole campaign. Incomplete campaigns and failures
remain present; no session is promoted to an independent comparison unit.
An invalid fixture/control prevents a strategy verdict, not exclusion of an
unfavourable row. Randomized arm order is reproducible from a predeclared seed;
the actual driver's legal session-order randomization, K/power and acceptance
matrix still need freezing before calls.

An initial long oracle counted boundaries without their position. It was
strengthened before model calls: complete event coverage must show one to three
boundaries, with a real event after the early constraint and before the answer.
The early constraint is now freshly visible in both arms in long sessions 1/3/5,
so an off-arm failure from unavailable cross-session memory cannot be mistaken
for compaction loss. This is a fixture/oracle correction, not adoption of a
production rotation or context knob.

The latest evaluator self-check passes **36 checks using 108 fabricated campaign
inputs**, zero models. Earlier 31/33-check receipts remain. Latest report:
`spikes/m3-closeout-20261002/work-local/memory-oracle-selfcheck-03/receipt.json`.
The latest real loopback HTTP check passes **540 public phase reads over 54
cases**. It verifies hidden/never-revealed facts, mutation/deletion visibility,
private transition authentication, out-of-sequence/idempotent transitions,
readonly routes, inaccessible answer/state APIs, bounded distractors and a
fixed-origin console proxy with bounded replies. Report:
`spikes/m3-closeout-20261002/work-local/memory-http-fixture-preflight-02/receipt.json`.
Strict standalone TypeScript compilation and JavaScript syntax checks pass.

### Testbox packaging receipts

| Invocation | Binding / result | Runtime cleanup |
| --- | --- | --- |
| `deskmates-m3-memory-fixture-20261002-1ad79f0d-01.service` | Five representative containers/HTTP phase checks passed, but wrapper flock coverage was not verified: Python's default close-on-exec descriptor released the lock at Node exec. Raw receipt retained; separate wrapper audit marks full protocol unaccepted. | Seven exact runtime IDs absent; build images retained |
| `deskmates-m3-memory-fixture-20261002-d13bf7c0-02.service` | Inheritable-descriptor correction and Node kernel-flock precondition pass; five representative cases pass. | Seven exact runtime IDs absent; build images retained |
| `deskmates-m3-memory-fixture-20261002-2f84c6ef-03.service` | One focused G-LONG packaging check after the early-constraint phase correction; kernel-flock precondition passes. | Three exact runtime IDs absent; build images retained |

The lock correction was also checked locally with a real Node child: a competing
nonblocking flock was refused while it lived and succeeded after its exit.
The corrected Node harness checks its open descriptor, inode and its own kernel
FLOCK record before creating resources and before every case. No model retry or
result selection occurred; these are separately retained no-model infrastructure
checks. Independent SSH confirms all three units ended successfully. The first
unit's wrapper defect still prevents pooling it as verified lock coverage.

Remote prefixes are the corresponding isolated
`/home/owner/agent_workspace/deskmates-reusable-m3-memory-fixture-20261002-*`
directories. Source transfer has an explicit five-file inventory plus its JSON
manifest; no .git, node_modules, credential file or unrelated data. Private
synthetic cases/control tokens are generated on the evaluator host; tokens
are never argv/logged or copied into a bot workspace. No bot workspace or real
model exists in this preflight. All model-config reads/calls remain zero.
Only exact journaled runtime identities are removed; no image/cache prune or
stable deployment changes occur.

| Binding | SHA256 |
| --- | --- |
| First manifest | `1ad79f0d27e3f09f0e8672b07ec8e98bb7e030b6109fc79774b527057b89aca5` |
| First archive | `7b284587be35947374c852eb17916a701520e4b477ee64731b386c3fb34918ba` |
| Kernel-lock correction manifest | `d13bf7c0d863c4313654e3b2b642649ea5cfb7e2f0224e754a36bcd8b6c2e6ca` |
| Kernel-lock correction archive | `5d3f29e2eb70b12b691a68ff2b32c3df9ebca2b365068f9c8ae5a6c867e3c6ed` |
| Long-phase correction manifest | `2f84c6ef6f05b834e53a52454d981155edf53587ff2b1925c94b1c8db741f402` |
| Long-phase correction archive | `9a167578d2ef27dcb36238e12a11fbea87e2185d6b364e62c031c6ea8be2ab59` |

The base Golden ID is
`sha256:c19acaf63d39570fba4bd850e75a9bbea05554ffc731417aea8dd749c63ddb69`.
The corrected five-case fixture image is
`sha256:7295753c65872905a9776cf8d716f28d3a1ea8c7f7b68dbdd21963e5a5029ba4`.
Full image/source/cleanup/kernel-lock receipts are preserved locally under
`spikes/m3-closeout-20261002/work-local/memory-fixture-container-01`, `-02`
and `-03` and in each remote directory. The later oracle-only source additions
are independently tested; packaging receipts cover their declared emitted
inventories, not every later evaluator edit or actual SDK compaction.

The real multi-session SDK/controller, common file/profile reset, actual Gateway
learning/forgetting, long-task sizing from observed window limits, source-taint
and complete model ledgers still need integration. No statistics or milestone
claim is made from fabricated evaluator inputs or no-model fixture checks.
The prepared eighteen-suite/two-probe request does not include a real memory
campaign; that separate campaign needs its own concrete authorized scope.

## Actual Chromium and common filesystem reset

`runtime-reset-preflight.mjs`, `runtime-files.mjs` and `runtime-browser.mjs`
now implement and check a proposed common between-session baseline procedure,
outside the frozen business candidate. This is an actual headed Chromium check
using the previously tested workspace image
`sha256:02a7beac87366654ab0c24324b0865da2eac9aaaf6cd81ad36fd51104cfd284e`,
not fabricated browser observations. All containers and three volumes are fresh
and campaign-owned. Network mode is `none`; only the synthetic localhost fixture
inside the selected container is reachable. No ports, SDK, model credentials,
task POST, stable service or existing workspace is involved.

Four no-model invocations are retained separately:

| Unit suffix | Outcome | Retained invocation |
| --- | --- | --- |
| `e4254fc7-01` | Failed before seeding: the deny-all Chromium resolver rejected the fixture's `127.0.0.1` page origin. The fixture now uses the already exempt `localhost`; no egress policy was relaxed. | `1d973a9f310a4655846ac0f44102bd21` |
| `9a2d0308-02` | Seed passed, but recently acknowledged cookie/localStorage writes were absent after immediate SIGTERM stop/recreation. No reset verdict. | `5164ded0b2c347389447f1e02c022bfc` |
| `18baa7ec-03` | Added state diagnostics reproduce the same persistence failure: IndexedDB, cache and service worker survived; the baseline cookie/localStorage did not. No reset verdict. | `98fa4566cd5b4eaaa719f54488be85ab` |
| `009d9305-04` | Acknowledged CDP `Browser.close`, observed termination, full snapshot/restore and final browser checks pass. | `607f490cb68440e38c01b6740a2032e0` |

Each full unit name is
`deskmates-m3-memory-reset-20261002-<suffix>.service`; directories are
`/home/owner/agent_workspace/deskmates-reusable-m3-memory-reset-20261002-<suffix>`.
Each launcher retains the inherited/kernel-verified heavy-test flock, uses a
900-second execution limit plus 120-second stop allowance, and strips inherited
model credential variables. The first three failures are not pooled into the
passing run. They are infrastructure/control findings, not learning trials.

The final procedure seeds a synthetic baseline login cookie, localStorage,
IndexedDB, cache and service worker. Manual SOUL/MEMORY for both synthetic bots
and the shared baseline file also survive. A second stage writes a prior-session
canary into these browser stores, both bots' synthetic SDK transcripts, diaries,
learned exports, a hidden shared file and `/tmp`. An ordinary restart of that
owned container still exposes the canary: this is the positive control showing
that restart alone is insufficient. The controller then gracefully closes
Chromium, restores **all** of `/home`, `/work` and `/profile` while the workspace
is stopped, removes the old container, and recreates its writable layer from
the same pinned image. The host baseline archive is available only to the
stopped-volume helper, never the live workspace.

The baseline and immediately restored inventories match exactly, including
directories, permissions, file sizes/hashes and symlinks. Their tree SHA256s are:

| Tree | Baseline = restored |
| --- | --- |
| `/home` | `34861177ff3b6a212dcb34360e7e921b2a5cc9a49d7c87c627f3dcd79fc6a993` |
| `/work` | `b98a87b86d7f961ea03c03b73786c5641c6fe42554b4292f5e172934247d1782` |
| `/profile` | `98c844dd3aaa4acf5b565b35d2d6528ee55221840b364e33b2be8f26ca66538e` |

These hashes are taken before Chromium restarts; the browser legitimately writes
profile metadata after startup. The final live probe independently finds only
the baseline cookie/localStorage/IndexedDB/cache/service worker; old transcripts,
diaries, learned exports, shared canary and writable-layer `/tmp` canary are
absent. Fresh-page sessionStorage is empty. Closing all pages alone is not used
as a substitute for profile restoration.

The passing unit is terminal (`inactive/dead`, `MainPID=0`, `Result=success`).
Independent SSH reinspects all **25 exact runtime identities** from the four
runs: zero remain, and the heavy-test lock is available. Docker lookup failures
count as absence only on a specific no-such-resource result, never a timeout,
permission or daemon error. Receipts are retained under
`spikes/m3-closeout-20261002/work-local/memory-reset-container-01` through `-04`;
the last directory includes `independent-audit.json`.

| Passing source/transfer binding | SHA256 |
| --- | --- |
| Runtime manifest | `009d9305800ea01d11b80ebd338c2c7ae4057ee83d741cab5ce977129b8e9038` |
| Runtime archive | `467932db33ba3f7fd89139c7db71e57d09e53f1a487d0a19f3912419fd58f0cd` |
| Launcher | `c34af721dc66006d10dbf8650cd5bca28bc8087901eeb05c80d13dd236ca1f05` |
| `runtime-reset-preflight.mjs` | `a91a3e4ef83285ed682f8e44d4e80fed9d4bdd6ccffb5d031b63922d3c5e334f` |
| `runtime-files.mjs` | `b2fb506acede310d750d7c8cd5aca99fa5b95ee679409faac6b7d4d848b122a0` |
| `runtime-browser.mjs` | `d5178e8a18e983d89cabb37a2e544ba5ca8b05815800959b7665d321ae544b28` |

This corrects the prerequisite shutdown procedure, **not production `entry.sh`**.
The observed immediate SIGTERM durability gap remains an explicit production
follow-up; the passing CDP control must not be cited as its repair or a default
shutdown regression pass. In this isolated image, `entry.sh` intentionally exits
1 when Chromium is closed outside its TERM trap. The harness accepts that only
after the CDP close acknowledgement and observed non-OOM termination, and does
not enable an automatic restart policy on these test containers.

Full retention-on/off integration is still pending: freeze the baseline before
real queries, keep the Gateway database outside the restored tree, regenerate
canonical learned exports from each arm's database state, create actual fresh
threads/queries without `resume`, and exclude alternate answers in old Gateway
transcripts or confirmations. This check does not prove actual consolidation,
source-taint completeness, SDK compaction or a powered model improvement.

Production follow-up update: the immediate-stop durability issue is now repaired
on a separate 934-file candidate. Ordinary DockerProvider stop/recreation
preserves immediately written cookie/localStorage values, and the unresponsive
browser fallback fits its stop budget. The focused workspace-image T2 suite
passes 15 cases. See `m3-workspace-shutdown-results-2026-10-02.md` for the distinct
source/image binding, retained old-image control failures and remaining broader
gates. This does not retroactively change the old memory-control receipts.

# M3 canonical management and populated upgrade results

Date: 2026-10-03 (Asia/Taipei). Selected UX-01 management and migration checks
pass. Full M3 remains incomplete. No commit, deployment or real-model call was
made; production services were not involved.

## Problem and repair

An actual built-browser save during a synthetic parked continuation received
the correct production Gateway 409 refusal. The UI replaced that reason with
“SOUL.md changed since it was loaded” and offered version reconciliation, even
though the saved version was unchanged. This was a display defect; the server
never saved the blocked draft.

`SoulEditor` now compares the refreshed saved version with the loaded version.
When they differ it preserves the existing conflict/reconciliation flow. When
they match it displays the actual server refusal and removes reconciliation
controls, retaining the local draft. No protection or session rule changes.

Two new parked/current-run regressions fail before the repair (8 pass / 2 fail)
and pass after it (10 pass). Existing real-version conflict and retained-draft
tests remain passing. Whole-project T0/T1 passes **2462/2462**, zero fail/skip.
Web and backend typecheck, lint and Web build pass. The first lint invocation
reported only new-test formatting; targeted formatting and the final lint pass
are retained. No backend/container production input changed, so the prior
frozen full T2 remains a separate receipt rather than a new full T2 claim.

## Actual observations

The fixture uses real file-backed SQLite, production migration code, production
authenticated Gateway HTTP and the built React UI. Its file-reader results and
run states are explicitly scripted. It does not use Docker or the Agent SDK.

| Check | Result and boundary |
| --- | --- |
| Populated pre-0019 upgrade | Original columns and rows in 13 tables remain exact across 0019–0024: workspaces/bots, transcripts/membership, sessions, run and both attempt usages/events, decided approval, browser waiter and immutable memory versions |
| Canonical migration | Existing bots receive null canonical fields, not empty replacements; FK check empty, enforcement on, reapplication no-op |
| Failed 0020 rebuild | Injected invalid reference causes an exception; old waiter retained, runs_new absent, 0020 marker absent, FK enforcement restored. This is the rebuild's atomic rollback, not rollback of the whole migration batch |
| Stopped unimported bot | Actual SOUL GET refuses without a provider create or file read |
| Concurrent SOUL/MEMORY import | Two held scripted reads of each file surround a real operator PATCH; the late import returns the operator version and never overwrites it |
| SOUL draft navigation | Dirty local instructions survive Knowledge → Manage navigation in the same authenticated client |
| SOUL version conflict | Concurrent authenticated edit is shown separately; local draft remains; explicit latest-base selection then save succeeds |
| Parked SOUL guard | Before repair, actual UI falsely reports version change. After rebuild, it shows the actual parked-run refusal, preserves the draft and offers zero reconciliation buttons; SQLite body/session remain unchanged |
| Offline scoped edit | Cancel owned parked state; saving succeeds while the other bot has a synthetic running row. Only the edited bot's session disappears, peer session remains |
| Manual MEMORY conflict | Dirty-bot switching guard and Keep editing work; remote text is separate, local draft remains, explicit latest-base then save succeeds offline |
| Roster and new bot | Role search filters peer; new bot created while stopped shows Needs instructions, then offline SOUL save shows Instructions saved |
| Test-conversation entry | Creates exactly one single-member empty thread; zero messages/runs for it, no provider create or SDK execution |

Historical rows were synthesized in a pre-change database, not copied from a
production database. The invalid-reference rollback fixture is intentionally
invalid and is retained separately. Direct synthetic parked/running rows test
guards and browser feedback; they do not prove actual SDK parking/resumption.
The two delayed imports are HTTP races with a scripted reader, not simultaneous
real-container bot startup. Earlier actual SDK own/peer canonical restoration
remains separately bound in `m3-canonical-peer-restoration-results-2026-10-03.md`.
Concurrent real bot startup/import-before-execution is still required.

## Source, bundle and receipt bindings

Retained raw receipts, AX snapshots, SQLite files and logs are under the ignored
`spikes/m3-management-browser-20261003/work-01/`; source and protocol are retained
in its parent. This was one Gateway fixture: old and rebuilt UI used the same
owned database and synthetic parked row, without repeating a model task.

| Binding | SHA-256 |
| --- | --- |
| Fixture source | `1724aef88de42a0555dac4aa5f71e94421fcc219430909bdff85e7c4fd6d7335` |
| Original row projection | `3a1a0e42e9ac9c6996713e36fe43f1ae079176707c99198980502a28205d9050` |
| Before management source | `8bc43356630f6ae25a3114c31cd31b29fcb54c9dc5764a3430425d438f4e0fb6` |
| After management source | `3e1ee8104b491cea9faa632715515ef62decfa61e37b2d1465dcaa6291a1bde0` |
| Final management tests | `42bffdab83dd2953d072f8f00c846b484d07d4a3589e122f6707eb50622c4dfa` |
| Before Web main index-dKYe5fwL.js | `015f6dfc42cd8fc59ea690b388d60c2030d1ce880858303ee80d450ae224b5bb` |
| After Web main index-BIEF849U.js | `8609bf0a65aa1d187725c278fcab704a3c2c176d3165bfa25a0a26ce60b5771b` |
| After Web index | `d36717a39a74a5540db30a1aa122293b332ea837853f1f8ecd43da6839fdc25c` |
| Terminal receipt | `0031ce3a961946d03fea17ecc03989e63fbcca7eaf3dd161506409f9ca7e2763` |

The original 920-input inventory covers backend/sidecar/compiled/migration files,
the fixture and original Web build; all non-Web-build inputs remain unchanged.
The separately saved management source and new bundle hashes bind the repair.
The observed page script src is `/assets/index-BIEF849U.js`. Before/after AX and
screenshots retain the refusal; conflict and offline-save AX, memory proof and
final API responses retain the other checks. Exact-label locators for wrapped
select/textarea labels did not match; inspection identified their accessible
roles and corrected the controls. These observation failures did not restart
the fixture or alter the product.

Both temporary tabs close. The fixture exits zero, zero provider creates,
zero SDK execs and zero real-model calls; only six scripted physical reads occur
before offline browser editing. Final SQLite integrity is `ok`, foreign keys
have no violations, and the known operator port 61488 independently refuses
connections. Only the fixture's synthetic run rows are cancelled at shutdown.
Standalone strict fixture typechecking passes. Browser file disk landing,
configured-model/provider and paired-strategy acceptance remain separate gates.

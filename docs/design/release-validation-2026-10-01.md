# v0.2.18 deployment and scenario validation

Date: 2026-10-01. Status: deployment and campaign complete, with retained failures. The four-role
stock task failed; successful infrastructure checks do not erase that result.

## Release

The owner requested a new Testbox release and validation of portable scenarios,
VendorDB SQL/procedural compatibility, and multi-bot US stock research/strategy.

- Release: `v0.2.18`, source `543f69342ce1a7c2908b6bd5f89d89c8b25c5fce`.
- GitHub release workflow: `36826662702`, passed; includes clean-checkout
  typecheck, lint, unit/integration tests, web checks and image build.
- Local checks: typecheck and lint passed; 222 T0/T1 files / 2334 tests passed;
  web production build passed. An initial sandbox-limited invocation could not
  listen on loopback ports; the authorized rerun with local networking passed.
- Testbox full T2: 25 files passed, 84 tests passed, one skipped, 145.68 s.
  The skipped SDK shape real-model call requires credentials that T2 deliberately
  does not receive. The later T3 campaign exercises the real SDK/model path.
- Workspace image: `sha256:270a722a76b93f7ed4d4a6e465079dc411ca94c4a1c85023fec2a602f7592fe8`.
- Egress image: `sha256:37d262a80778dcdb693179d20da247b09c97ad1ca48a504d74096de865e2f9b6`.
- Base was built using the established `LOCAL_BASE=1` path on Testbox from
  cached inputs; its local image ID is recorded in the release receipt and is
  distinct from the CI registry build ID.
- Activated at 2026-10-01 14:59:25 Asia/Taipei, from v0.2.17, after draining
  zero active runs. Backup:
  `/home/owner/Data/deskmates-stable/backups/20261001T065925Z-v0.2.17-to-v0.2.18`.
- Read-only post-activation checks: UI `/` 200 with root and asset links;
  anonymous `/api/config` 401; authenticated config 200 reporting v0.2.18;
  authenticated runtime 200.

Stable retains its existing `glm-5.3` / `glm5.3-flash` settings and secrets key.
No workstation `.env` was transferred. A proposed copy of an existing model
credential file was rejected by automatic approval review before execution;
the revised launcher injects only existing host test-model variables into child
process memory without copying or persisting a new model credential file.

## Isolation and reproducibility

Campaign root:
`/home/owner/agent_workspace/deskmates-reusable-release-20261001`.
The v0.2.18 source transfer has an explicit inventory; 1131 regular source files
match their SHA256 digests. Separate manifests identify the test harness added
outside the release. Model work uses fresh Gateway SQLite databases, workspaces,
fixed release image IDs, cron disabled, 300-second/18-turn physical limits and
at most 900 seconds observation per scenario. The original team smoke retains
its 120/180-second observation deadlines. Model tests take the host heavy-test
lock. No model task is automatically resubmitted, and no external-action approval
is automatically granted. Reports preserve per-run configuration, events and
usage. Missing usage is unknown.

## VendorDB engine probes

Fresh VendorDB and PostgreSQL data and loopback ports 26432/26433 were provisioned;
no previous smoke/soak or stable data was used. The pinned VendorDB image is the
existing 2026-09-17 build, not a new database revision. PG16 is a supplemental
live oracle; this is not the full PostgreSQL regression suite and does not test
Oracle PL/SQL.

All 13 frozen groups completed, 28 statement positions on each engine (56
executions), with no timeout. Seventeen positions differ in status, row values
or SQLSTATE; this includes consequences of preceding failures and must not be
presented as seventeen independent database defects.

| Area | Observed result |
| --- | --- |
| Grouping, window, CTE, UPDATE/DELETE | Paired row values matched for supplied inputs |
| Integer division and zero divisor | VendorDB differs from PostgreSQL integer semantics |
| PRIMARY KEY | VendorDB accepted a duplicate that PostgreSQL rejected with 23505 |
| varchar length | VendorDB accepted an overlong value PostgreSQL rejected with 22001 |
| CHECK | VendorDB rejected CREATE; later missing-table error is cascading |
| ADD COLUMN | VendorDB rejected ALTER; subsequent shape differs |
| PL/pgSQL DO, function, exception function, procedure | PostgreSQL accepted all creations; VendorDB rejected each with 42601 |

The last row is direct engine evidence. Separately, the product connector's
validator rejects procedural syntax; that is an adapter support limitation,
not evidence that the database executed a procedure.

## Model scenarios

### Portable configuration and direct/group chat: passed

Import and export preserved Bot configuration, canonical SOUL/manual memory and
ordered thread membership on a real Gateway. A direct one-bot chat returned
`SINGLE_OK`; a delegated two-bot chat returned `TEAM_TOTAL=42`. Four logical
runs total (one direct, three delegated). No schedule or old transcript was
imported, and no task POST was retried.

### Shared browser and workspace brief: passed

`acceptance/m3-group-workspace.acceptance.test.ts` passed on the exact release
image in 133.16 s overall (120.35 s observed task). Five runs, zero failed or
parked. `w_tickets` delegated to `w_kpis`, received the KPI findings, and wrote
`/work/ops-brief.md` with the expected ticket IDs, count and revenue. The test
reported three directed handoffs, with no browser lock refusal. This is one
functional observation, not a reliability estimate or a paired improvement.

### US equities: failed to produce the final deliverables

All four roles contributed on AAPL/MSFT/NVDA. The researcher visited all three
official earnings sources and wrote `fundamentals.md`. The strategist wrote and
revised `strategy-draft.json`; the risk reviewer wrote `risk-review.md`. The
review identified a concrete contradiction: rebalancing back to the original
target can undo the drawdown de-risking rule. It also distinguished absent price
series/backtests from verified company data.

Nine logical runs were recorded. When the eighth bot-authored message was the
risk report addressed to the lead, the Gateway paused the thread and suppressed
the mention wake. It also cancelled a queued run. The ledger's system message
is explicit: `turn budget reached: risk's mention of investment_lead was not delivered`.
Neither `/work/investment-report.md` nor `/work/strategy.json` exists.

The cause is the existing bounded-routing rule in
`packages/gateway/src/threads/router.ts`: it appends the bot message, tests
`botCountSinceLastHuman >= turnBudget`, and pauses/cancels queued routing before
waking the recipient. The default of eight is consumed by ordinary assignments,
clarifications and specialist reports. This is a **P1 product completion gap**
for a normal four-role workflow; the run-level success/silence statuses do not
imply task completion. The strategy draft must not be treated as an approved or
backtested recommendation.

No cap was silently raised and no successful rerun was substituted for this
failure. A follow-up design should preserve loop bounds while providing an
explicit blocked-task state and a bounded final handoff/summary or operator
continuation. Changing the cap alone would be a strategy knob change requiring
its own declared experiment, not evidence that the design is fixed.

### VendorDB bot workflow: completed; report quality has retained issues

The initial import failed during fixture preparation because the harness
requested `vendordb-probes.json` instead of `probes.json`. No task or model call
occurred for that import. Its error/import is retained. The corrected VendorDB-only
Gateway completed in five logical runs, with all three roles contributing and
all three required files present. The live connector analyst executed read-only
batches on both PostgreSQL and VendorDB, reproducing `5/2` as 2 vs 2.5 and the CTE sum
as 5 on both. The independent reviewer dry-validated a DO block; it was rejected
before database contact. The final report distinguishes direct engine results
from the adapter's `DO`/`CALL`/`CREATE PROCEDURE` restriction.

Manual review found **P2 output-quality issues** that the marker/file oracle does
not catch. Preserve the generated reports unchanged and read them with these
corrections:

1. The chief says "5 cascaded steps"; the listed receipts contain **four**:
   CHECK's failed-table INSERT, two SELECTs after failed function creation, and
   CALL after failed procedure creation. The numbered cases/step counts in the
   host receipts are authoritative.
2. The procedural reviewer and chief describe different parser error positions
   as proven distinct implementation root causes. The probes establish rejection
   of the tested forms; error locations alone do not prove internal grammar or
   implementation causes.
3. The reports say metadata comparison is false/uninformative when both sides
   error. In the CHECK negative step, both engines error and `sameMetadata` is
   **true**, because both omit metadata. Equal absence proves no wire-format
   compatibility, but the stored comparison flag must not be misstated.
4. The analyst's table correctly notes that a tested `CREATE FUNCTION` parsed as
   external DDL, but later wording generalizes that all procedural forms are
   blocked by the connector. The explicit deny rule is DO/CALL/CREATE PROCEDURE;
   do not generalize it to every function form. No function creation was
   submitted through the connector in this scenario.

Thus the end-to-end **workflow** passed, while the generated report is not a
fully verified technical diagnosis. A future report-quality oracle should bind
counts and factual statements directly to receipt IDs and steps.

## Usage, cleanup and retained evidence

There are 23 logical run rows across the four functional scenarios. Recorded
usage covers 22; one risk run was cancelled while queued (`startedAt: null`) and
has no usage row. Do not substitute a made-up token count for that absent row.
Observed totals: **522,930 input**, **95,237 output**, **3,385,344 cache-read**,
**0 cache-create** tokens. These are the recorded categories, not a cost quote or
a count of independent model API requests.

All five owned Deskmates workspaces have no remaining containers. The three exact
SQL test containers and their empty Compose network were removed after the
model campaign ended. VendorDB bind-mounted data, the PostgreSQL data volume,
Gateway/connector ledgers and evidence remain on Testbox. No global prune or
stable workspace cleanup occurred. A final check reports stable v0.2.18 active,
with zero active stable runs.

Host evidence includes `scenario-results`, `scenario-results-vendordb-correction`,
`group-workspace-results`, `vendordb/probes.json`, `cleanup-verification.json` and the
release's `.release/t2.json`. Local evidence copies are under the ignored
`spikes/release-validation-20261001/work-results/` directory. The checked-in
[`results-summary.json`](../../spikes/release-validation-20261001/results-summary.json)
keeps the compact audit. Scripts and frozen scenarios are described in
[`README.md`](../../spikes/release-validation-20261001/README.md).

This round ran all T0/T1, all T2 and the requested bounded model scenarios plus
the shared-workspace T3. It did not rerun every historical milestone T3 case,
the long soak, paired A/B efficacy evaluation, a stock-price backtest or live
trading. It is not a claim of complete milestone acceptance.

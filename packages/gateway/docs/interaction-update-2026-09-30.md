# Interaction development update (2026-09-30)

Canonical configuration and continuation add migrations 0019 and 0020. Existing
bot files are imported without replacing their contents with empty defaults;
new/imported bots use Gateway-owned SOUL and manual notes. Generated MEMORY
exports preserve those notes alongside trusted experience. Run requests carry
canonical file snapshots; no long-lived model credential is added to this store.

Turn exhaustion uses the existing approval mechanism for Continue/Stop, with a
saved SDK session, attempt accounting, a two-continuation limit and expiry.
Automatic memory consolidation is selected by durable counters: three closed
episodes or ten candidates, ten quiet workspace minutes and a 24-hour cooldown.
A consolidation run is created with `model` set to the bot's cheap model
(ADR-0023 decision 2); `src/scheduler/job-models.ts` is the one list of job
kinds that run on the cheap model, and the job kind is its only input.
Learning exclusions and pinned-index omissions produce ledger receipts.

Strategy effectiveness is **UNVALIDATED** until paired evaluation. This development
pass does not establish integration or deployment acceptance; the follow-up scope
is in `docs/runbooks/interaction-optimization-test-handoff-2026-09-30.md`.

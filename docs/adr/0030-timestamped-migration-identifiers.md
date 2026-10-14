# ADR-0030: Timestamped migration identifiers

Date: 2026-10-13
Status: Accepted (at the owner's request, 2026-10-13)
Source: issue #53 ("Decompose shared hotspots for conflict-safe parallel development"), the owner's request of 2026-10-13, and the reserved-number bookkeeping of the M4 batches (2026-10-09 and 2026-10-10).

## Context

Gateway schema changes are forward-only SQL files `packages/gateway/migrations/NNNN-name.sql`, applied once each, in filename order, at startup (`packages/gateway/src/db/migrate.ts`), and recorded by name in `schema_migrations`. A database that holds a name this binary does not know is refused as migrated by a newer Gateway (ADR-0022 MIG-05). Backup manifests record the applied names (`packages/gateway/src/db/backup.ts`); nothing else parses them.

The next number is the one shared counter every schema change takes from. Two branches developed in parallel both pick the next free number, and the second to merge collides. To avoid that, a coordinator has reserved numbers before every parallel batch. That is a central step that every feature waits on, and it fails when a branch is started outside a batch or a batch's plan changes.

The loader also has a silent hazard. When branch A merges `0057` and branch B, started earlier, later merges `0056`, a database that already ran `0057` applies `0056` afterwards. Filename order, the documented apply order, is then no longer the order the database saw. Nothing reports it.

## Decisions

1. **New migrations are named `YYYYMMDDHHmm-<kebab-slug>.sql`.** The prefix is the UTC authoring time to the minute (for example `202610131420-task-labels.sql`); the slug is lowercase letters, digits and hyphens. Existing `NNNN-name.sql` files keep their names forever. The loader accepts both forms and nothing else. Every legacy name starts with `0` and every timestamp with `2`, so lexical order puts every legacy file before every timestamped one and filename order stays the apply order.
2. **A migration that may have shipped is never renamed.** Its name is its identity in every database's `schema_migrations` and in every backup manifest; a rename makes an existing database look as if a newer Gateway migrated it. The only allowed rename is of a migration that has not merged to `main`.
3. **A branch's new migrations sort after every migration already on its target branch.** `scripts/check-migration-order.mjs` (dependency-free) lists the migration files a branch added since its merge base with the target (default `origin/main`, overridable with `--base`) and fails when one sorts at or before the newest migration on the target, when one does not use the timestamped form, or when the branch deletes or renames a migration that is on the target. Its message tells the author to re-timestamp the file. CI runs it in the `static` job: against the base branch for a pull request, and against the previous commit for a push to `main`.
4. **The Gateway refuses to apply a migration out of order.** `applyMigrations` refuses, before applying anything, a pending migration that sorts before the newest already-applied one, and names both in the error. A database applied in filename order is unaffected. The refusal of a database migrated by a newer Gateway and the list of migrations that run with foreign keys off are unchanged.
5. **Migration numbers are no longer reserved.** New work takes a timestamp when it writes the file; a parallel batch plan does not allocate migration identifiers.

## Alternatives considered

- **Keep sequential numbers with a coordinator.** The status quo: central, and it still lets an early-started branch merge a lower number after a higher one.
- **Rename all existing migrations to timestamps.** Every deployed database and backup manifest holds the old names; a rename map in the loader is permanent complexity for no gain. Rejected by decision 2.
- **Apply out-of-order migrations anyway** (as some tools do with an "out of order" flag). Two migrations written without knowledge of each other may touch the same table; applying them in an order no developer tested is the failure this ADR exists to stop. The branch re-timestamps instead.
- **Hash or UUID identifiers.** No natural order; the apply order would need a separate manifest that every branch edits, which is the shared hotspot again.

## Verification

| Decision | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | `listMigrationFiles` returns legacy and timestamped files, legacy first, and ignores names in neither form; all current migrations still apply from empty | T0 `packages/gateway/src/db/migrate.test.ts` ("accepts legacy and timestamped names", "applies from an empty database") | new migrations merged with a legacy number after 2026-10-13 (target 0) |
| 2 | A branch that deletes or renames a migration present on the target fails the check | T0 `scripts/check-migration-order.test.mjs` (rename and delete cases, temporary git repository) | shipped migrations renamed (target 0) |
| 3 | An added migration that sorts at or before the target's newest, or uses the legacy form, fails the check with a re-timestamp message; one that sorts after passes; CI runs the check in `static` | T0 `scripts/check-migration-order.test.mjs`; `.github/workflows/ci.yml` step "New migrations sort after the target branch" | CI failures of the check per month |
| 4 | A pending migration sorting before the newest applied one throws an error naming both and applies nothing; applying the current migrations in two in-order steps succeeds; the newer-database refusal still throws | T0 `packages/gateway/src/db/migrate.test.ts` ("refuses an out-of-order pending migration", "applies in-order in two steps", "still refuses a database migrated by a newer Gateway") | Gateway starts refused for out-of-order migrations (target 0) |
| 5 | No batch plan reserves migration identifiers; the loader and the check need no reservation input | T0 `scripts/check-migration-order.test.mjs` runs with no reservation list; review of the next parallel batch plan | batches that reserve migration identifiers (target 0) |

## Consequences

- `AGENTS.md` and `packages/gateway/README.md` describe the new form when this ADR's implementation merges; existing docs that cite a migration by number stay correct.
- Tests that copy "every migration before 0027" by comparing names keep working: every timestamped name sorts after every legacy one.
- A branch that sits open while `main` gains a migration must re-timestamp its own before it merges, as the check reports. This is the cost of decision 4's guarantee.
- `packages/connector-postgres/migrations` has its own loader and one migration; it is not covered by this ADR.

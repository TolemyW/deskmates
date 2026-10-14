# ADR-0001: Record architecture decisions

Date: 2026-09-20 (verification rule added 2026-09-20, same day)
Status: Accepted

## Context

The current design document under `docs/design/` (v0.3 at the time of writing) is the long-form description of the system. Decisions that change it, or that are made while implementing it, need a place that is smaller than a design revision and more durable than a chat log.

A review of ADR-0002 to ADR-0005 on 2026-09-20 found decisions whose words had no fixed meaning ("human online", "short-lived token", "stateful page") and decisions with no test or metric that would fail if the code drifted. A decision nobody can check is a preference, not a decision.

## Decision

1. Use Architecture Decision Records in `docs/adr/`, one file per decision, numbered. Required sections: Context, Decision, Verification, Consequences. Optional sections are allowed (Precedent, Data model, Open items, Definitions).

2. **Every numbered item under Decision has a row in Verification** with three columns: what the item means concretely (a value, a rule, an invariant), which test proves it (tier and name from `docs/design/test-strategy-2026-09-20.md`), and which metric tracks it if it is a matter of degree (name from `docs/design/measurement-2026-09-20.md`). A default value that is a guess is marked as a guess and the row says how it will be calibrated. An item that cannot be verified says so in the row and why.

3. Status vocabulary: `Proposed`, `Accepted`, `Superseded by ADR-nnnn`. Superseding an ADR means writing a new one that names the old one; the old one keeps its text and gets a banner. A superseded ADR needs no Verification section.

4. A decision that changes the design document also gets a one-line note in that document's change table.

## Verification

| Item | Means | Test | Metric |
|---|---|---|---|
| 1, 2 | every file in `docs/adr/` with status Accepted has a `## Verification` table whose row count is at least the number of numbered decisions | T0 static: `docs.test.ts` parses the ADRs and asserts it | none |
| 3 | status line matches the vocabulary | same static test | none |
| 4 | not machine-checked; reviewer reads the change table | none | none |

## Consequences

Agents and humans working in this repo read `docs/adr/` before proposing a change to something an ADR already covers. When an ADR row names a test that does not exist yet, the test is part of the milestone that implements the decision, and the test strategy §11 table lists it.

## Verification amendment (2026-10-04)

The original `docs.test.ts` row above described a planned check, not an executed
receipt. It is implemented by `scripts/docs-consistency.mjs` and
`scripts/docs-consistency.test.mjs`. Run `node scripts/docs-consistency.mjs`;
the test file also runs in the root T0/T1 suite.

The check validates the top-level Status vocabulary separately from
implementation and acceptance notes, allowing existing case and prose qualifiers.
ADR-0006 retains its historical `Implementation in progress` label as an explicit
legacy exception; it is not promoted to Accepted by this documentation change.
`Accepted` means the architecture decision was accepted, not that every runtime/model/milestone gate passed. Existing status
qualifiers are preserved; Proposed decisions are not promoted
merely because some implementation exists.

For each non-superseded ADR, every explicit decision ID in Decision/Decisions
sections and amendments must occur in a nonempty Verification row with meaning,
test/evidence and metric cells. Grouped IDs and ranges count by identity: extra
rows, repeated IDs, or an unrelated metric cannot cover a missing decision.
Amendment IDs such as `A1` and `4a` are distinct. Superseded ADRs are exempt from
coverage, but their successor must exist and name the old ADR. Section-heading
aliases already in use (`Decision`/`Decisions`, `Means`/`Concrete meaning`,
`Test`/`Executable proof`) are supported. This checks traceability structure;
it does not execute the named proof or certify its quality.

The same script checks only explicitly marked current-status summaries in the
README, AGENTS, architecture blueprint, M3 scope closeout and M4 status ledger,
plus the ledger's pending-gate table. Historical receipts and frozen translations
are not searched for modern status claims. Changing the current scope requires
updating the bounded contract and its tests alongside the documentation.

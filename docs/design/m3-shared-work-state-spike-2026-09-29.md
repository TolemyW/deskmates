# Spike: shared work state for multi-bot context

Date: 2026-09-29. Status: design; code under `spikes/shared-work-state/`; no
model run yet. No production package changes.

## Question

Multi-bot failures in the vendordb campaigns were not failures to remember. They
came from bots holding different, private versions of the same shared work:

- ops kept repeating a d03 flag that chief had already ruled on in its own
  journal (`m3-vendordb-workflow-v2-2026-09-29.md`);
- chief counted rejected submissions as coverage, and a q01 request collision
  in the shared directory could not be attributed from files afterwards
  (`m3-vendordb-longrun-2026-09-28.md`);
- 25 of 68 runs ended silent in the first campaign;
- the v2 campaign's host controller (frozen first submissions, hash-addressed
  receipts, exclusive create) coincided with 0 instead of 6 pre-SQL rejections
  and 3 instead of 32 thread-message runs, but also saw a same-byte overwrite
  and preflight-mirror misuse of the file convention. It was not a paired
  experiment and changed more than one thing.

Hypothesis H1: a host-held, versioned, attributed work state, which each bot
reads as a projection of what changed for it, reduces duplicate work, repeated
settled disputes and no-progress runs, compared with a shared mutable notes
directory, at no loss of correctness.

Risk H2, tested first: an authoritative-looking shared state spreads a wrong
claim further than the same claim in a notes file. If H2 holds, the direction
fails regardless of H1.

The spike decides whether to write an ADR for Gateway-held work state. It is a
pilot with a small K and makes no paired improvement claim.

## The primitive under test

A host-side daemon, `boardd`, holds one board per workspace outside the
container. It does three things and interprets nothing:

1. **Store.** Items `{id, kind, title, body, state, owner, refs, version,
   history}`. `kind` and `state` are free labels. Every accepted operation is
   appended to a host-side log with the writing bot and a sequence number.
   Writes to an existing item carry `expect_version`; a mismatch is rejected
   as a conflict. `claim` succeeds only on an unowned item. `dispute` and
   `resolve` are first-class operations, so a settled dispute is visible as
   settled. A `ref` to a workspace file is accepted only with the file's
   current SHA-256; the daemon snapshots that content into host storage, so
   the evidence cannot be changed afterwards.
2. **Project.** It publishes `board/state.json` and, per bot,
   `board/views/<bot>.json`: items the bot owns, items changed since the bot's
   last `ack`, and open disputes, capped in size.
3. **Receipt.** Each operation gets a receipt (`accepted`, `conflict`,
   `rejected` with reason) the bot can read.

Transport is the one v2 used: bots write operation files into
`/work/<exp>/board/outbox/`; the daemon reads them with `docker exec`, and
publishes views and receipts with `docker cp`. Bots use a small `board` CLI.
Attribution is by `--as <bot>` (defaulting to `$HOME`'s basename): soft, as
every bot boundary is in this design. There is no access control between
bots; any bot may update any item if it holds the current version.

Not tested here: wake-on-change (ADR-0005 stays as is; all runs are cron
ticks) and Gateway-side injection into the wake payload (bots pull their view
with `board view` as the first step of each tick).

## Scenario: ticket triage on the golden site

Different from vendordb on purpose: web UI work, no SQL, no host executor.

Three bots in one workspace, the golden site as the only allowlisted origin:

| Bot | Role |
|---|---|
| `lead` | Plans, assigns tickets, reviews triage, resolves disputes, writes the final report |
| `triage-a`, `triage-b` | Triage assigned tickets on the site |

Every bot runs on native cron, one bounded tick every 6 minutes, for 42
minutes (7 ticks each). Cron runs start a fresh SDK session, so the shared
channel is the only thing that carries work across ticks.

Rulebook (identical in both arms, in `GUIDE.md`): each of the 23 open tickets
is triaged exactly once:

| Rule | Action | Derived from |
|---|---|---|
| R1 | One comment beginning `TRIAGE bug` or `TRIAGE support` | ticket tag |
| R2 | Open bug older than 30 days: add tag `stale` | ticket age |
| R3 | A comment mentions a refund: add tag `refund` | ticket comments |
| R4 | Assigned to zhang: reassign to whichever of li or wang had fewer open tickets at campaign start | ticket list, a shared derived fact |
| R5 | Ticket 1077: the triage comment states the 2026-08 difference between the monthly report and the sum of August orders | reports and orders, a shared derived fact |

The oracle is computed by `analyze.py` from `/api/state` and `/api/state/log`
after reset, not hand-written, so it cannot drift from the seed.

### Planted wrong claims (H2 probe)

At campaign start, before any tick, the harness adds three false claims
attributed to `lead` as "handover notes from the previous shift". Each is
cheap to check on the site:

| Claim | Truth | Wrong outcome if adopted |
|---|---|---|
| "1011 was mislabeled; treat it as support" | tagged bug, 45 days old | `TRIAGE support`, no `stale` |
| "The August report matches the orders; difference 0.00" | 120.00 | 1077 comment without 120.00 |
| "li is the less-loaded assignee" | the true answer, computed at campaign start | zhang tickets go to the wrong person, if li is not the true answer. If li is the true answer, this claim is replaced by the mirrored one about wang, so the claim is always false |

Arm A gets them as a section of `notes/handover.md`; arm B as three board
items of kind `fact` owned by `lead`. Same text, same attribution, same time.

## Arms

| Arm | Shared channel | Everything else |
|---|---|---|
| A (baseline) | A shared `notes/` directory with a suggested `progress.md`, free-form, as bots coordinate today | Same bots, SOUL, GUIDE rulebook, model, cron, maxTurns, golden-site seed |
| B (board) | The `board` CLI and published views; `notes/` exists but GUIDE says progress, claims and disputes live on the board | Same |

Each replicate runs A and B concurrently in two workspaces, each with its own
golden-site instance reset before start, so host and model load hit both arms
alike. K = 3 replicates. Each replicate is 21 runs per arm, 126 runs in total.

## Measurements

All from golden-site state and log, the Gateway run records and the board log.
Load-invariant ones are primary, per the quiet-host lesson.

| Metric | Definition | Hypothesis |
|---|---|---|
| Planted-claim adoption | Tickets showing a wrong outcome from §planted claims (0–3 per replicate) | H2: B not higher than A |
| Planted-claim correction | A claim explicitly disputed or corrected in the shared channel before campaign end | H2 context |
| Duplicate triage | Tickets with more than one `TRIAGE` comment, or a tag added by two bots | H1 |
| Rework | Tags or assignee set and later changed | H1 |
| Correct triage | Tickets meeting R1–R5 at the end | Non-inferior |
| Coverage | Tickets triaged at all | Non-inferior |
| No-progress ticks | Runs with no site write and no shared-channel write | H1 |
| Tokens per correctly triaged ticket | Gateway usage / correct tickets | Reported |
| Settled-dispute repetition | A bot re-raising a point after it was resolved (board log in B; `notes/` diff review in A) | H1, descriptive |
| Board discipline (B only) | Conflicts, rejected ops, items without refs | Feasibility |

## Decision rule (declared before the run)

- **Stop (H2):** B adopts more planted claims than A in 2 or more of 3
  replicates, or in total. Record it; no ADR.
- **Go to ADR:** H2 does not hold, and B has fewer duplicates plus rework than
  A in at least 2 of 3 replicates, with correct triage in B not lower than A
  by more than 2 tickets in any replicate.
- **Otherwise:** inconclusive; record it; no ADR from this spike.

K = 3 cannot show small effects. This rule is a go/no-go for writing an ADR
and running a proper paired evaluation, not evidence of a strategy improvement.

## Budget and authorization

The existing Testbox evaluation authorization is scoped to its first campaign
and excludes others, so this run needs its own owner authorization before any
model call: a dedicated Gateway instance (never the stable deployment), two
workspaces, 126 runs of about 10 minutes and 50 turns at most, all tokens
recorded, and an estimated cost of USD 15–25 at the vendordb per-run rate.
Offline work (daemon, CLI, tests, analysis against a locally reset golden site)
needs no model and proceeds first.

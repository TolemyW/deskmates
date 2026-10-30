# ADR-0042: Run audit: failure classes, a runs index, "mark as wrong" and ledger retention

Date: 2026-10-16
Status: Accepted (under owner delegation, 2026-10-17; issue #11), with amendment 2 adding two failure classes. Shipped since v0.7.0. Still pending and not accepted by this: classification of the stable host's exported `runs.error` corpus against the target of zero `other` for the known classes, the manual browser pass of the drawer's changes section and mark, and whether the stable host sets `RUN_EVENTS_RETENTION_DAYS` and to how many days (the owner's call; the default stays off). The classification corpus is shaped from a test deployment's ten-day triage and the v0.7.3 acceptance, not exported from either.

## Context

After a run ends an operator could open one drawer per run and nothing else. `GET /api/runs` filtered by thread, bot, workspace and phase only. A ten-day triage of a test deployment had to export the SQLite ledger and classify `runs.error` by regular expression outside the product: 88 of 106 failures were one dead cheap model and 14 an allowlist bug already fixed, which nobody could have seen from the UI. The drawer omitted most of what the ledger knows about a run (its learned items, files changed, sites visited, approvals, task checkpoints and artifacts, and most of `config_json`). An operator had no way to say "this run was wrong" other than curating memory entries afterwards. `npm run evals` pointed at a missing file. `run_events` had no retention.

The learning loop already has a do-not-learn notion per learned item (ADR-0011 amendment A2: transient observations and failed runs are skipped), but nothing an operator can set on a run.

## Decision

1. **Failure class is derived, not stored.** `ledger/failure-class.ts` classifies `runs.error` into `model_unavailable`, `model_deadline`, `tool_allowlist`, `egress_blocked`, `approval_denied`, `wall_clock`, `sdk_abort`, `no_reply`, `budget_limit`, `platform_interruption` (ADR-0029 decision 7), `sandbox_unavailable` or `sidecar_exit` (amendment 2), or `other` (`RunFailureClass` in contracts). One ordered table of lower-case ASCII substrings is the only source: the code applies it to a run view and the same table is rendered as one SQL `CASE` for filtering, so the two cannot disagree. The class names the root cause: "model not found", "no worker available" or a 5xx the SDK retried is `model_unavailable` even when the job's deadline is what ended it. The Gateway's own reason codes (`no_reply`, `deadline`, `turn_budget`, `budget_exhausted`) are exact matches. The model job that failed does not change the class; current job names and the ones they replaced classify alike. A run without an error has no class. Nothing is backfilled or migrated: a new rule reclassifies history on the next read.

2. **The run list filters for audit.** `GET /api/runs` adds `status` (one or a comma-separated list), `lane`, `since` and `until` (on `created_at`, `until` exclusive), `failureClass` and `q` (case-insensitive substring of `error`). They compose with the existing filters in SQL, so a keyset page is never short, and are part of the cursor's scope. Every run view carries `failureClass` and `mark`. The web UI adds a runs index screen with these filters; a row's text is the run's Activity summary (ADR-0033) when it has one, else its error or reply's first line.

3. **Mark as wrong.** An Owner or Admin of the run's workspace may mark one run wrong with an optional note (`PUT /api/runs/:id/mark`, at most 2,000 characters) and remove the mark (`DELETE`). The mark is one row in `run_marks` (verdict `wrong`, note, who, when) and that row is the run's do-not-learn flag: while it stands, consolidation neither counts nor takes the run's experience candidates, and a run marked before it ends records each learned item as skipped with reason `marked_wrong` and writes none. Removing the mark restores the candidates as consolidation input. Entries the run already applied are not touched; curating them stays a human edit. The mark is shown on the index, the run drawer and the Activity card, and the drawer and the card offer the action. No thumbs-up, tags or issue links.

4. **What this run changed.** The run drawer gains a section built from the run row (`summary.learned` with each item's trust, `filesChanged`, `sitesVisited`; the frozen model, skill set, SOUL version and system prompt hash from `config_json`), the existing `GET /api/runs/:id/memory-versions` (the memory the run was given), and one new route, `GET /api/runs/:id/changes`: the run's approvals with their decisions, its task checkpoints and artifacts, the learned-memory entries whose source it is, its mark and whether retention pruned it. Each list is capped at 200 rows.

5. **Replay from the drawer.** A terminal run's drawer offers "Save as replay fixture": the exact `npm run replay -- export --gateway <origin> --run <id>` command, which writes `evals/traces/<id>.json` with the existing exporter. The browser cannot write to the repository and the Gateway does not import `evals/`, so the export stays a developer-side command; the exporter now sends `DESKMATES_OPERATOR_TOKEN` as a bearer so it works against an authenticated Gateway. `npm run evals` replays every trace under `evals/traces/` and, on an empty set, says so and exits 0.

6. **Retention is off unless set, and the operator exports first.** With `RUN_EVENTS_RETENTION_DAYS` set to a positive number of days, an hourly pass removes the `run_events`, `run_usage` and `model_requests` rows of terminal runs that finished longer ago, at most 200 runs per pass, oldest first. It keeps the run row and its summary, its Activity summary, approvals and mark, and its stored Costs summary: the usage summary is computed before the usage rows go and written back after the deletion triggers drop it, so Costs does not lose the run. A run with an approval nobody has decided is never pruned, whatever its status. Each pruned run keeps one `run_retention_prunes` row (when, the limit, how many rows of each kind), which the drawer shows and which makes a second pass a no-op. Exporting traces or backing up the database before enabling it is the operator's job; `packages/gateway/docs/run-audit.md` says how.

## Alternatives considered

- **Store the failure class on the row.** Faster to filter, but a classification that improves would need a backfill and old rows would disagree with new ones. A derived class is recomputed on every read; the run list is bounded by its page.
- **Mark by editing `config_json`.** The configuration records the knobs a run ran with; an operator's verdict after the fact is not one of them.
- **Delete applied memory on mark.** Destroys a human-visible history for a one-bit signal; the confirmation and forget flows already cover curation.
- **A Gateway route that writes the replay fixture.** The Gateway would import `evals/` and write into a source tree it does not own; a deployed Gateway has no such tree.
- **Prune whole runs.** Loses the index, Costs and the audit trail the marks hang on; the bulk of the ledger is events.

## Consequences

- Classification quality depends on the substring table; a new error shape lands in `other` until a rule is added with a corpus string.
- Retention trades replayability for space: a pruned run cannot be exported as a trace any more.
- A marked run's candidates stay in the database and in the confirmation queue; only consolidation ignores them.

## Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1 | every corpus string of each known class classifies there, none `other`; SQL agrees with code on every string; job names old and new do not change the class | `gateway/src/ledger/failure-class.test.ts` | share of failed runs classified `other` |
| 2 | status, lane, time range, class and text compose and page; unknown values are 400; views carry `failureClass` and `mark`; the index screen sends the composed filter | `gateway/src/api/run-audit-routes.test.ts`; web `features/run-index` tests | runs-index queries per triage session (not measured) |
| 3 | a mark removes the run's candidates from consolidation input and eligibility; a run marked before it ends writes nothing and logs `marked_wrong`; unmarking restores | `gateway/src/api/run-audit-routes.test.ts`; web `features/runs` mark tests | marked runs per week |
| 4 | the changes route answers one run's approvals with decisions, checkpoints, artifacts and memory writes; the drawer section renders them with two requests | `gateway/src/api/run-audit-routes.test.ts`; web `features/runs/run-changes.test.tsx` | none |
| 5 | the exporter sends the bearer on every request; `npm run evals` on an empty set exits 0 with a message | `evals/replay.test.ts`; `evals/run.test.ts` | committed traces |
| 6 | old terminal runs lose events, usage and requests and keep row, Activity and Costs summaries; a run with an undecided approval, a live run and a recent run keep all; a second pass is a no-op; unset does nothing | `gateway/src/ledger/run-retention.test.ts` | rows pruned per pass |

## Amendment 1 (2026-10-16, owner-decided): the runs index screen is withdrawn

Decision 2's runs index screen (`#/run-index`, a **Runs** link in the Operate group) is removed from the web UI. In use it listed raw error text next to successful runs and gave an operator nothing to act on; runs are reached from where they happened (the Activity cards of a chat, approval and task cards, `#/runs/<id>`), and the run drawer now leads with the story of what the bot did (`packages/web/docs/run-index.md`). The Gateway side of decision 2 is unchanged: `GET /api/runs` keeps the status, lane, time, failure-class and text filters for scripts and the compare tooling, and every run view still carries `failureClass` and `mark`. The web half of decision 2's verification row (`features/run-index` tests) no longer applies; `gateway/src/api/run-audit-routes.test.ts` remains the proof.

## Amendment 2 (2026-10-17, under owner delegation): infrastructure and sidecar-exit failures have classes

Status: Accepted under owner delegation (2026-10-17). The v0.7.3 acceptance on issue #11 (2026-10-17, read-only SQL over 576 runs) grouped 311 failures by hand and found 24 that the product's classifier files as `other`: 10 where the workspace's computer could not be prepared (Docker address pools exhausted, a legacy network, a missing egress proxy, unverified volume ownership) and 14 sidecar exits without a `run_ended` from one bug. Decision 1's purpose is that an operator sees the root cause without exporting the ledger; a class an operator acts on differently (repair the host, or fix the sidecar) is worth naming. A user abort is not one of them: the SDK's "process aborted by user" is a deadline or abort the sidecar caused (issue #11, methodology note), and stays `sdk_abort`.

7. **Two more classes, in the same rule table.** `sandbox_unavailable`: the attempt failed before or around the sidecar's exec, which the Gateway writes as `sandbox error: …`, or the error carries one of the provider's own messages for a legacy or mismatched network, an exhausted address pool, a missing managed egress proxy, an unavailable egress proxy image or unverified volume ownership. It is ordered before the model rules, so a provider message is never read as a model's. `sidecar_exit`: the sidecar process ended without its `run_ended` (`sidecar exited without run_ended (exit N)`); it is ordered last, so a cause the Gateway's stderr tail names (a model error, an abort, a rejected start request) keeps its own class. Both are derived like every class, so history is reclassified on the next read and nothing is migrated.

### Verification (amendment 2)

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 7 | each sandbox and sidecar-exit corpus string classifies there, in code and SQL; a sidecar exit whose tail names a model error, an abort or a rejected start request gets that class; the web labels both in every locale | `gateway/src/ledger/failure-class.test.ts`; web `i18n/catalogs.test.ts` | share of failed runs classified `other` (target 0 for the v0.7.3 groups) |

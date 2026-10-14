# ADR-0033: Activity shows one card per run, grouped by round, with a bounded AI summary

Date: 2026-10-13
Status: Accepted by the product owner on 2026-10-13 (issue #109: automatic AI summaries, Chinese at most 50 characters, at most five lines; wireframe choice: one card per run grouped under the round's triggering message). Real-model summary quality is not measured.

## Context

The operator's 2026-10-13 review found Activity hard to read: it did not say which input started which run and produced which output; old failures from other conversations and background jobs looked like current work; retries showed raw JSON; and completed runs showed a whole paragraph. ADR-0005 amendment 4 gives every request a durable round with explicit run relations, so Activity can group by request instead of by time. ADR-0028 established a recorded, tool-free sidecar job for approval summaries; it covers approvals only and is not extended here.

## Decision

1. **One card per run, grouped under its round.** Activity lists runs, not rounds. A run related to a round (ADR-0005 decision 31) is grouped under that round's triggering message; any other run (cron, webhook, bus) is grouped under its own trigger. Filters: current round or all, and foreground (interactive lane) or background. Earlier rounds are collapsed. Summary jobs themselves never appear as activity. Queries stay workspace-scoped like the run list.

2. **A card is at most five lines.** Line 1: bot, lane, status and time. Lines 2 to 4: the summary, at most three lines, clamped in CSS as a safety net. Line 5: actions — 原文 (Original), 去审批 (Go to approval) for a run waiting on one, 重试 (Retry) for a failed round member. The original reply, error, tool calls and audit references (run id, message ids) open below the card on demand and are never clipped. Unbreakable text wraps anywhere.

3. **The summary bound is counted, not guessed.** Text that contains any CJK ideograph, kana or hangul is bounded to 50 grapheme clusters, whitespace excluded, an emoji counting as one. Other text is bounded to 30 whitespace-separated words. Both are also limited to three lines. `boundActivitySummary` in `contracts` applies the bound and marks a cut with "…"; the sidecar applies it to model output and the Gateway applies it again before storing.

4. **Eligibility.** A summary job is queued only when an ordinary agent run (no `runType`) reaches `succeeded`, `failed` or `stopped`, and its source does not already fit the bound. Its source is the triggering message, the run's `done` and final reply, and its error. A source that fits is shown verbatim with no job. `silent`, `cancelled` and non-terminal runs get a deterministic status line and no job. There is no backfill of runs that ended before this ADR.

5. **Cached by source version, generated once.** The source version is the run's attempt and terminal status. `run_activity_summaries` holds one row per `(run, source version)`; the row is inserted with the job in one transaction, so a second terminal event, a reload or a navigation finds the row and queues nothing. A resumed run that ends again in a new attempt has a new version and may get one new job; at most three versions are generated per run. A card whose stored version is not the run's current one shows the fallback, not the stale text. Viewing never generates.

6. **The job is the ADR-0028 job shape with a different instruction.** One background run of the source run's bot, `runType: activity_summary`, CHEAP_MODEL frozen in its configuration, one turn, no tools, plugins, skills, session or workspace instructions, a 45-second deadline and at most 4,000 source characters wrapped as untrusted data. It asks for the outcome or blocker in the source's language, with no claim of success the run status does not support. Usage, model requests and price are recorded like any run, so the job counts toward the workspace's spend (#61). A failed job is not retried.

7. **Honest fallback; summaries change nothing.** When there is no summary (pending, failed, not eligible, stale), the card says so in words and shows the deterministic status line. A summary never changes a run's status, routing, transcript, approvals or ledger; the card's status comes from the run row, and the AI label stays visible.

8. **Retries are readable.** A `model_retry` event renders as "retry n of m", the reason (HTTP status or error type) and the announced wait. Its raw JSON is behind a disclosure. The ledger keeps every event.

## Alternatives considered

- **One card per round.** Rejected by the owner's wireframe choice: a round with one failed and three good members needs four separate outcomes.
- **Regenerate on view, or refresh live runs on a timer.** Costs a model call per glance, and an ongoing summary can contradict the status line a second later. Live runs show their status; a periodic refresh can be its own decision with a measured budget.
- **Summarize every terminal run.** Short replies already fit; a model call would only paraphrase them.

## Consequences

- One extra background run per long terminal run, on the same bot's background lane, which can delay that bot's next background run by up to the job's deadline.
- Activity reads rounds; it shares their identity with the chat's current-round strip (ADR-0005 decision 36).

## Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1 | runs group under their round's message, other runs under their own trigger; current-round and lane filters; summary jobs are not listed; older rounds collapsed | web `runs/activity.test.tsx` | none |
| 2 | a card has header, summary (three-line clamp) and actions; original text, error, tool calls and run id open on demand | web `runs/activity.test.tsx` | card height on desktop and 390 px (visual check, not run) |
| 3 | 50 graphemes for CJK including emoji and mixed text, 30 words otherwise, three lines, "…" on a cut; long unbreakable text | `contracts/src/activity-summary.test.ts` | share of summaries cut by the bound |
| 4 | a long succeeded or failed run queues one job; a short one, a silent, cancelled or live run, and a summary job itself queue none | `gateway/src/ledger/activity-summaries.test.ts` | summary jobs per terminal run |
| 5 | a second terminal event or a repeated read queues nothing; a new attempt queues one more; a fourth version queues none; a stale row is not shown as current | `gateway/src/ledger/activity-summaries.test.ts` | duplicate summary jobs (0) |
| 6 | the fake SDK sees no tools or session, bounded wrapped source and the activity instruction; output is bounded; usage is recorded | `sidecar/src/presentation-summary.test.ts`; `gateway/src/ledger/activity-summaries.test.ts` | summary input, output and cache tokens |
| 7 | absent, failed and stale summaries render the fallback with the run's status; completion of a job changes only the summary row | `gateway/src/ledger/activity-summaries.test.ts`; web `runs/activity.test.tsx` | failed summary jobs |
| 8 | `model_retry` shows attempt, count, reason and wait; raw JSON behind a closed disclosure | web `runs/model-retry.test.tsx` | none |

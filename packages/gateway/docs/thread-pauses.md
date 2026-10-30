# Thread pauses

ADR-0005 amendment 3: decisions 20, 23, 24, 25 and 27 accepted by the owner on 2026-10-17;
decisions 21, 22 and 26 rewritten that day per the owner's ruling and resubmitted for sign-off.
A paused thread stores bot messages and wakes nobody; the scheduler starts no queued run of it.

## What a pause records

`threads.pause_reason` is `turn_budget` (a turn-budget breach, or a loop-breaker volume or
repetition trip of amendment 5 decision 40) or `operator` (an Owner or Admin paused it). The
status, the reason, the causing seq (`paused_seq`), the pause time (`paused_at`) and, for a
turn-budget pause only, `resume_at` are written by one update (`ThreadStore.pause`); the schema
refuses a paused row without a reason and an operator pause with a resume time. The thread API
returns them as `pauseReason`, `pausedSeq`, `pausedAt` and `resumeAt` while the thread is paused.

## How a pause ends

| Pause | Human message | Resume (`PATCH status: "active"`) | Reset window |
|---|---|---|---|
| `turn_budget` | ends it, wakes as usual | ends it, one notice | ends it, one notice |
| `operator` | stored, wakes nobody | ends it, one notice | never |

- **Reset window.** `resume_at` is the pause time plus the workspace limit
  `turnBudgetResetMinutes` in effect at the pause (5 to 1440, default 60, never `off`; set on
  `PUT /api/workspaces/:id/limits` by an Owner or Admin, see [workspace limits](workspace-limits.md)).
  `ThreadRouter.resumeDuePauses`, called from `continueWalks` on every scheduler pass (at least
  once a minute), resumes each due pause with one `system` notice whose seq becomes
  `budget_reset_seq`.
- **Budget origin.** The turn budget, `round-v1`'s per-round count and the loop breaker's volume
  and repetition rules count bot messages after both the latest human message and
  `budget_reset_seq` (`BUDGET_ORIGIN_SQL` in `threads/messages.ts`). Resume and the window move
  the origin to their notice; a human message is itself a new origin.
- **Nothing else unpauses.** Approval decisions, expiries, reminders and bot messages leave a
  thread paused; `threads/thread-unpause-callers.test.ts` pins the three callers of
  `ThreadStore.resume`.
- **Cancelled work stays cancelled.** A pause cancels the thread's queued runs (`turn_budget` or
  `operator_pause`) and completes its pending walks; a live run finishes and a parked run stays
  parked. No resume revives them.

## Who is told

- A breach posts one `system` notice (decision 6's wording, the dropped mention, the cancelled
  runs, the resume time); a further breach while paused posts none but records `cap_breached`.
  A channel bound to the thread relays it like any `system` line.
- The web rail row says "paused until <time>"; the conversation shows the reason and the time to
  resume, with Resume for an Owner or Admin, and the chat info offers Pause and Resume.
- A run that posts into a paused thread gets `routing.paused` (`reason`, `resumeAt`) in its
  `thread_post` answer, and a run delivered messages of a paused thread gets the same facts in
  its routing context; the sidecar words both.
- Operator pause and resume are `thread.pause` and `thread.resume` audit rows with the actor;
  asking for the state a thread is already in writes nothing.

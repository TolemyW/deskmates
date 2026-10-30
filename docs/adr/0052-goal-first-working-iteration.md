# ADR-0052: Goal-first working iteration

Date: 2026-10-20
Status: Proposed (working branch requested by the owner after issue #69); release/deployment acceptance
and paired model-strategy evaluation are pending. This record specifies the bounded iteration,
not the recurring-plan or automatic memory-promotion redesign proposed in that issue.

## Context

The default assistant can create a teammate but cannot necessarily mention it from its private
chat. Group creation alone also starts no work: `thread_post` posts only in the current run's
thread. Request changes only reopens a task. Memory recheck failures can resubmit the same
entry/version despite ADR-0011 A28's no-retry requirement. Maintenance runs obscure user work.

## Decision

1. **Start collaboration explicitly with group creation.** Extend ADR-0051's `group_create`
   with an optional nonempty `message` (at most 16,000 characters) and optional `startWith`
   names. The sidecar tool requires that list: one first worker for dependent work, an empty
   list for all teammates. Explicit starters override incidental mentions in assignment text;
   every starter must be a teammate in the group, other than the assistant. Older callers
   omitting the list retain explicit-mention routing, or address all teammates if none is named.
   Only the same default-bot
   run may call it, under the existing frozen/current checks. It creates a group containing
   that assistant and the requested same-workspace bots and posts one bot-authored message
   addressed to the selected starters. The existing router enforces relay, pause, budget and loop
   rules; no allowlist, human membership or access setting changes. The source gets an inert
   link to the group. The reply reports a posted message, never claims human acceptance.
   Preserve the source chat's private audience on the group; workspace-shared sources stay
   shared. Do not copy the source transcript. Use a workspace-scoped web-thread external key
   derived from run id and canonical request content; repeating the identical call in the
   same run returns the original group without a second message/run/notice. A changed request
   or new run is a new act. A group without `message` still starts no work. Every created group
   writes `thread.create` with actor, members, source run and requester, without message text.
   After this run actually starts a group, its creation report in its one-member source chat
   renders otherwise undeliverable references to those teammates as plain names. Deliverable
   allowlisted mentions, ordinary messages and group routing remain unchanged. This avoids an
   introduction producing a second, refused handoff after work already started successfully.

2. **Revision is an explicit Run action.** Extend the existing task Run request with optional
   nonempty `feedback` (at most 4,000 characters). It is valid only for a delivered task.
   With the existing task version and idempotency key, one transaction reopens the task,
   submits the revision through the existing dispatcher and stores feedback in its human
   execution message. Feedback advances the scope version, so an old run's frozen delivery
   scope cannot overwrite the requested revision. Prior delivery history remains. No ordinary PATCH dispatches. The UI
   collects feedback before this action, preserves it on failure and has an explicit cancel.
   The same key returns the original submission even with the old version. Existing role,
   queue, budget and scheduler checks apply; a failed dispatch rolls back reopening.

3. **Enforce no retry within the daily recheck window.** An entry/version already submitted
   in the last 24 hours is ineligible, regardless of job result. Read the persisted input
   triples from the job's run, so restart cannot reset the exclusion. A new note/version
   remains eligible and every attempt still counts against the workspace's limit. This
   implements ADR-0011 A28's no-retry limit without changing verdict/trust/freshness rules.
   The UI calls the daily count submitted checks, including failures, rather than completed
   rechecks. The next day's pass may reconsider the entry under the existing daily policy.

4. **Separate user work from internal jobs.** Latest-per-bot presentation excludes runs with
   `runType` and `model_job` triggers, including historical maintenance using cron triggers.
   Full history retains and explicitly names background processing; it is not a completed
   user task. Privacy filters apply before choosing the latest visible user run.

5. **Make the everyday review usable.** Show full latest delivery summary/outstanding items
   and structured output outside system diagnostics, clearly attributed to the bot. File
   identity checks are not semantic acceptance. SOUL editing is reachable in everyday bot
   settings. Advanced model/approval/network controls keep their existing roles and places.
   No automatic task acceptance, recurring-state redesign or memory-to-rule promotion.
   The chat shows one inert store-outcome notice when learned items are gated, excluded from
   current memory or saved as untrusted outside task scope. A model's "remembered" is not a
   receipt. Trusted applied writes stay quiet; the notice changes no trust or rule and wakes
   nobody. Shared project facts use workspace scope; current-value wording keeps correction
   history out of the fact statement. This is guidance, not a semantic identity guarantee.

The assistant template and tool guidance use the actual group-start contract and avoid
unconditional setup questions. These are strategy changes for new/default template users;
existing saved SOULs are not overwritten. Their behavioral improvement is unmeasured until
paired evaluation; offline routing tests only establish the mechanism.

## Verification

| Decision | Means | Test | Metric |
| --- | --- | --- | --- |
| 1 | Default creation launches only selected starters, deduplicated and audited, with source privacy retained; creation reports preserve allowed routing | `default-bot.test.ts`; sidecar `default-bot-tools.test.ts`; real-model lifecycle record of 2026-10-21 | duplicate starts; premature reviewer wakes; refused introductions |
| 2 | One feedback action reopens and dispatches once; failures roll back; other edits do not dispatch | `task-triggers.test.ts`; web `tasks.test.tsx` | user actions per revision; duplicate submissions |
| 3 | A failed version is excluded for 24h, including after store recreation; different versions/notes remain eligible | `memory/recheck.test.ts` | successful verdicts; attempts per entry/version |
| 4 | Internal failures do not replace latest visible work and remain identifiable in history | `run-pagination.test.ts`; web `contacts.test.tsx` | misleading latest-state reports |
| 5 | Complete result/qualifications precede review; instructions reachable in Use; failed/untrusted memory writes have truthful inert feedback | web task/contacts tests; `memory/learning-notice.test.ts`; real-model lifecycle record of 2026-10-21 | time to understand result; setup questions; false save claims |

No paid evaluation or deployment is authorised by this record. Local UI evidence is prototype
layout evidence; new model-strategy effectiveness and live integration remain separate gates.

The owner separately requested bounded real-model lifecycle validation on 2026-10-21. That
functional check and its fixes are recorded in `docs/design/goal-first-real-model-results-2026-10-21.md`.
It authorises neither a broad statistical campaign nor a release. The evidence policy of
automatic renewal remains ADR-0011's; changing it awaits the proposed ADR-0053 decision.

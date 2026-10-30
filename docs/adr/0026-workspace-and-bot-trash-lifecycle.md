# ADR-0026: Workspaces and bots use reversible Trash before permanent deletion

Date: 2026-10-11
Status: Accepted for implementation by the product owner on 2026-10-11; implementation and T2 evidence pending
Source: GitHub issue #50 and the owner's interactive decisions on 2026-10-11
Builds on: ADR-0004 (workspace is the environment boundary), ADR-0006 (per-workspace Docker resources), ADR-0022 (Owner/Admin/Member roles)

## Context

Deskmates can create and restart workspaces but cannot retire them. A workspace container, its
egress proxy and network can be recreated, while its named browser, work and home volumes are
deliberately retained. Gateway rows, secrets, channel bindings and integration connections also
remain indefinitely. Bots have the same lifecycle gap.

The product needs a visible team-level Trash, a reversible stop, and an explicit permanent delete.
The first version should keep the operation simple: archive is one hard-stop action, not a staged
retention workflow. Automated retention, exports and backup rewriting have no user yet and are not
part of this decision.

## Decisions

1. **Trash is team-level and uses the existing tenant roles.** An active workspace or bot may be
   moved to Trash by an Owner or Admin. Owners and Admins can list Trash, restore an item, and
   permanently delete it. Members cannot see or act on Trash. A trashed item is read-only and is
   excluded from ordinary active lists, routing and scheduling.

2. **Archiving a workspace is one hard-stop action.** The Gateway first makes the workspace
   ineligible for every new trigger, then in the same requested operation:
   - ends any human takeover and invalidates screen tickets;
   - cancels active and queued runs and denies pending approvals;
   - stops cron, webhook, channel, bus and chat wake delivery;
   - stops the channel runtime for that workspace;
   - stops the workspace container and egress proxy.

   The database content and the named browser, work and home volumes stay. The operation is
   idempotent. A process interruption may leave cleanup work to retry, but never re-enables a
   trigger; there is no user-facing wait-for-runs or wait-for-takeover mode.

3. **Restore reverses archive, not history.** Restore makes the existing rows and volumes active
   again. The sandbox is started on demand through the normal provider path. Cancelled runs and
   denied approvals do not resume, and missed external messages or scheduled occurrences are not
   replayed merely because the workspace was restored. Channel connection state may be reused when
   its plugin retained valid state, but the runtime starts through its normal connection lifecycle.

4. **Bots use the same Trash model.** Archiving a bot immediately stops its schedules and new wakes,
   cancels its queued/running work and denies its pending approvals. Its definition, canonical
   private chat, messages and run history remain readable to Owners/Admins in Trash and return on
   restore. Other bots remain active. Permanent deletion removes the bot and its related content.

5. **Permanent deletion is explicit and live-data complete.** It is available only for an item
   already in Trash and requires typing its current name. Deleting a workspace removes, by exact
   workspace id and managed labels, its container, egress proxy, network and named volumes. It
   revokes and deletes secrets, connections and channel state, then deletes all workspace content,
   including bots, threads, messages, files and file metadata, tasks, memory, skills, runs, events,
   approvals, usage and cost rows. Deleting one bot applies the equivalent bot-scoped deletion and
   does not touch its peers.

   The only survivor is a team-level, non-content tombstone containing the opaque deleted object id
   and kind, the actor id and the deletion timestamp. It contains no transcript, file path, secret,
   run payload, usage/cost value or human-authored name.

   This is the sole exception to ADR-0012 receipt immutability, ADR-0011 memory-version
   immutability and ADR-0018 fixed live usage/cost history. Each exception is enforced by a
   transaction-scoped guard for the exact workspace or bot id; ordinary deletion remains refused,
   a peer cannot match the guard, and commit or rollback removes the guard.

6. **There is no automatic purge in the first version.** Trash has no retention countdown. Nothing
   is deleted until an Owner or Admin chooses Delete permanently. The first version also has no
   pre-delete export, backup rewriting or restore filtering, and no idle-container stop. Permanent
   deletion guarantees removal from the live Deskmates database and managed Docker resources only;
   backup policy is a separate future decision.

7. **Cleanup is exact and inspectable.** Runtime removal selects resources by the recorded
   workspace id and Deskmates ownership labels, never a name prefix. Operator tooling lists database
   workspaces and their exact containers, proxies, networks and volumes, reports labeled orphans,
   and removes an orphan only after explicit confirmation. The stable runbook uses that tool and
   never prunes the shared daemon.

## Consequences

- Workspace and bot rows need an archived timestamp and actor. Ordinary queries exclude archived
  rows unless the Trash API explicitly requests them.
- Trigger admission, scheduling and channel dispatch must share one archived-state check. UI-only
  hiding is insufficient.
- SandboxProvider needs a stop operation that preserves volumes and a permanent-delete operation
  that removes them. Existing `destroy()` continues to mean recreate-safe removal and therefore
  must not silently change to delete volumes.
- Cost history for a permanently deleted item disappears. This supersedes the earlier issue comment
  that proposed retaining tombstoned cost rows.
- A future backup or export design must amend this ADR; it is not implied by the live-data delete.

## Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | Owner/Admin can list, archive, restore and permanently delete; Member receives no Trash data and cannot act | T1 route-policy and lifecycle API tests for all three roles | archived workspaces/bots |
| 2 | One archive request revokes takeover, rejects new triggers, cancels active/queued runs, denies pending approvals, stops channel delivery and leaves the container stopped | T1 lifecycle test with fake provider/channel runtime and seeded runs, approvals and lock; no intermediate wait state is offered | archive failures by step |
| 3 | Restore retains rows and volumes, creates no replacement history, resumes no cancelled run/denied approval and re-enters the normal on-demand sandbox/channel path | T1 restore test; T2 volume sentinel survives archive/restore | restore failures |
| 4 | Archiving one bot stops only that bot and preserves its private chat/history for restore; permanent delete removes that content while a peer bot remains intact | T1 bot lifecycle and isolation test | trashed bots |
| 5 | Permanent workspace delete removes every scoped database row and exact managed Docker resource, including volumes, while a second workspace remains byte-for-byte present; only the bounded tombstone remains | T1 database cascade/secret revocation test; T2 two-workspace Docker deletion test | permanent deletes and failures |
| 6 | No timer or scheduler purges Trash, no export/backup/idle-stop endpoint or setting is introduced, and usage/cost rows disappear on permanent delete | T0 route/config/schema assertions plus T1 fake-clock test | none |
| 7 | The operator command lists exact resources/orphans and requires confirmation before deletion; prefix-similar resources and another Deskmates deployment are untouched | T0 command planning test; T2 labeled-resource cleanup test; stable runbook rehearsal | orphan count |


## Amendment 1 (2026-10-16): pause is not Trash

Source: GitHub issue #10 (owner scope: a `paused` flag on the bot; cron, webhook and chat wakes
skipped with a visible reason; running runs untouched; parked approvals stay parked; distinct from
Trash). The scheduler's hold of queued work and the webhook's 409 were engineering choices awaiting
owner review and are Accepted under owner delegation (2026-10-17): holding queued work loses
nothing and starts it on resume, and a 409 lets a webhook sender retry instead of queueing work
behind a pause nobody may lift.

### Context

Trash (decision 4) was the only way to stop an always-on bot, and it is a hard stop: it cancels
the bot's runs and denies its approvals. An operator who only wants a bot to stop taking new work
for a while, and to pick up again where it was, had nothing.

### Decision

8. **A bot can be paused, which stops new work and ends nothing.** `PATCH /api/bots/:id` with
   `{paused: true | false}` sets or clears `bots.paused_at` and `paused_by` (an actor label), audited
   as `bot.update`; `BotDefinition` carries `pausedAt` and `pausedBy` while paused. While paused:
   - a matching cron round creates no run; the Gateway log names each skipped round and the bot's
     private chat says so once per entry and pause;
   - a webhook delivery is refused with 409 `invalid_transition`, `details.reason: "bot_paused"`,
     so the sender can retry later; nothing is queued behind the pause;
   - no thread wake is created for the bot, whether by a mention, `@everyone`, an unaddressed
     request offered to members, a system notice or `message_bot`; the thread gets a system
     message naming the paused bot and the message it was not woken by, and an unaddressed request
     goes to the next awake member. The message stays unseen by the bot, so the first wake after
     it is resumed delivers it; missed wakes are not replayed by themselves;
   - the bot's own queued runs, and a parked run whose approval a person answers meanwhile, wait in
     the scheduler (a `log` event `{source: "scheduler", waitReason: "bot_paused"}`) and start when
     the bot is resumed. Gateway jobs hosted on the bot (a presentation summary, a probe, a SOUL
     draft; they carry a `runType`) are not its own work and still run;
   - a live run finishes; a parked run stays parked; no run is cancelled and no approval denied;
   - "Run now" (ADR-0043 decision 5) and a round member retry are refused.

   Unlike Trash, a paused bot stays in every list, thread and routing table, its configuration
   stays editable, and resuming needs no restore. Resuming starts the queued work at once.

### Verification (amendment 1)

| Decision | Concrete meaning | Test | Metric |
|---|---|---|---|
| 8 | a paused bot gets no run from two cron ticks and a mention, its chat shows one schedule notice and one wake notice, a webhook is 409 `bot_paused`, "Run now" is 409; in a group an unaddressed request and `@everyone` wake only the awake member; a queued run waits with `waitReason: bot_paused` while a parked run stays parked, and resuming starts the queued run; the audit records `paused` before and after | T1 `packages/gateway/src/bots/bot-pause.test.ts` | paused bots; skipped wakes in the Gateway log |

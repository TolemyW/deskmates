# Private-chat handoff verification — 2026-10-09

Scope: [ADR-0024](../adr/0024-private-chat-nonmember-mentions.md),
[issue #11](https://github.com/TolemyW/deskmates/issues/11).

## Implemented behavior

A bot's private-chat final reply or `thread_post` can mention a same-workspace
non-member in its message allowlist. The Gateway routes the request through
the existing pairwise bus and records source attribution. Invalid or suppressed
addresses receive a visible diagnostic. Ordinary group, bus and external-channel
routing stays under ADR-0005; private-chat membership does not expand.

Each recipient has a persistent canonical private-chat binding. Incoming
handoffs appear there as operator activity, with request preview, source-message
link, collaboration link and live run state. Read watermarks belong to the
authenticated operator. A reminder does not create a model message or run.
Contacts resolves the same binding. The list uses request previews and unread
badges. Reconnect reconstructs activity from persisted rows.

Source/recipient deduplication, HTTP request receipts, transaction rollback,
relay/turn caps and coalesced runs have deterministic coverage. The routing
change is recorded as `privateHandoffVersion: 1` in run configuration. There is
no historical replay and no model-quality improvement claim.

## Automated verification

- `npm test` after rebasing onto main `2dcf6a6`: 297 files, 3,169 tests passed. Local HTTP listeners were enabled;
  no Docker or external model was used.
- After the final cross-tenant test, reconnect assertion and activity-list
  adjustment, the focused `private-handoffs`, `direct-message-routes` and
  `incoming-handoffs` suites passed: 3 files, 19 tests.
- `npm run typecheck` and the web TypeScript check passed.
- `npm run lint` and `npm run docs:check` passed.
- `npm run build -w packages/web` passed with a large-chunk advisory.

The focused tests cover mention and explicit tool requests, coalescing, exact
source links, live status, per-operator reads, tenant guards, canonical binding
adoption/group promotion, paused/source/bus limits, unknown and unconfigured
names, atomic fault rollback and request replay after rebuilding the context.
Existing delegation-outcome tests cover duplicate terminal event handling.

## Browser verification

The checked-in [fixture](../../spikes/private-chat-handoffs/README.md) ran a real
Gateway and Vite UI locally with an in-memory database and fake lifecycle events.
The following were observed in the in-app browser:

1. `databricks_fan`'s final reply mentioning `@team_chief` creates an unread
   collaboration request in the chief's private-chat list entry.
2. Opening that chat shows one queued activity card and clears the unread badge.
3. Completing the recipient fixture changes the same card to Completed over SSE
   without reloading the page.
4. View original message navigates to the source thread with the exact message
   ID in the URL; the source includes the linked handoff and terminal outcome.
5. The fixture returns `reminders: 1`, `inboxMessages: 0`, `inboxRuns: 0`,
   `recipientRuns: 1`. The reminder does not execute the request twice.

![Completed recipient reminder](../../spikes/private-chat-handoffs/completed.jpg)

The screenshot predates the final chat-list preview wording change; that change
is separate from the observed card, navigation and status behavior.

## Limits

No T2 Docker suite, T3 real-model run, paid evaluation, release or deployment was
performed. The reported historical production conversation was not inspected
or replayed. These results establish deterministic routing/UI behavior with
fake execution, not a claim that a real model will complete the delegated work.

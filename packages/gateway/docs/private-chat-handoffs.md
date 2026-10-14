# Private-chat handoffs (ADR-0024)

Non-member mentions in bot-authored one-member web chats reuse `message_bot`
routing, with allowlist checks, cap diagnostics, transaction rollback and
source-message deduplication. `privateHandoffVersion: 1` identifies this behavior
in run configuration. Migration 0036 persists canonical inbox bindings, incoming
activity, per-operator read watermarks and run-scoped message request receipts.

`POST /api/bots/:id/private-chat` resolves the stable inbox.
`GET /api/threads/:id/activity?cursor=&limit=` reads incoming handoffs, newest
first, 20 per page (at most 100) with `nextCursor` for older ones (#113 slice CH);
`POST /api/threads/:id/activity/read` advances the authenticated operator's
watermark through a fetched sequence. These member routes enforce tenant
ownership. `thread_activity` SSE invalidates inbox/list data. Activity is never
appended to the recipient's model transcript and never schedules a run.

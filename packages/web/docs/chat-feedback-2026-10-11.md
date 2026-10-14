# Chat feedback update (2026-10-11)

The rail interleaves canonical private chats and groups by latest activity; shared pins keep
one combined pin order, and earlier private histories and the folded bus list stay reachable.
Approval decision notes wrap across the chat and resolve known bot IDs to names.

Run links open a right-side dialog while the originating screen stays mounted. The router
captures each route and hash together so live renders cannot overwrite the return address.
Events default to newest first with an explicit order toggle; metadata and usage are folded,
and continuation controls expand when waiting for a continuation decision. A direct run link
still works over the Chats screen.

One-member chats show a read-only projection of the bot's runs in other conversations and
background work. Active work and the latest three finished runs are visible; older results
fold away. This uses the existing bot-run API and shared SSE connection, recovers on reconnect,
and does not write messages or wake a bot. Incoming handoff cards retain their own durable
identity/read state and are excluded from the additional feed. The header reflects active work
elsewhere too. This activity projection is not an additional unread-notification system.

File references use compact filename/path cards and open the existing bounded rich renderer in
a focus-managed drawer. Markdown headings, lists, tables and code render there; the existing
untrusted-content, remote-image opt-in, range-budget and download policies still apply.

Local verification and synthetic browser evidence:
[`ui-chat-feedback-results-2026-10-11.md`](../../../docs/design/ui-chat-feedback-results-2026-10-11.md).

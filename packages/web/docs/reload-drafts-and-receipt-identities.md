# Reload drafts and authorized receipt identities (#73/#75)

`draft-storage.ts` provides a bounded `sessionStorage` reload aid. It stores only unsent text,
scoped to authenticated user/tenant/authentication time and the Gateway-authorized workspace/chat.
No credentials, pending submissions or failed-send queues are stored. Account/tenant changes and
logout invalidate it; unavailable storage keeps the existing memory path. A session rotation for
the same person on the same client (password change) keeps the in-memory composer state, chat
authorizations and reload copy, re-scoped to the new authentication time. Keystrokes are written
after a short debounce and flushed on `pagehide`/`beforeunload`; send transitions write at once.
Text typed before a chat is authorized replaces (or, if empty, removes) its stored copy. Unsupported
unscoped formats are discarded, not migrated by guessing an owner. See the
[verification and retention boundaries](../../../docs/design/chat-drafts-identities-results-2026-10-12.md).

`ActorDirectoryProvider` uses the existing tenant-members read only for Admins/Owners. Active
human names are presentation metadata; raw actor IDs/types remain in audit details. Members do
not make directory requests. Snapshots are memory-only, scoped to the tenant's members client (not
the open workspace) and refreshed on focus/online or after one minute, one request at a time; the
previous names stay visible during a refresh, and failures invalidate names.

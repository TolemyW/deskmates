# Chat reload drafts and authorized receipt identities

Date: 2026-10-12. Issues #73/#75. Base main `59ca426403fa2b776b0f928392d3da3d29138b6d`.
Issue bodies and owner comments were read before implementation. PR #80 already fixed false-empty
offline handling and current-session names; PR #86 supplies the preserved layout and controls.

## Retention decision

Use `sessionStorage`, not a new server store or durable `localStorage` cache. This is a tab-local
refresh aid, not a cross-browser-restart feature. Browsers may restore a tab's storage after a
restart or copy it into a duplicated tab; the same scope and two-hour expiry still apply.
The stored scope is authenticated user ID, selected tenant and authentication timestamp. Each
entry additionally uses workspace and thread IDs. A thread is restored only after its successful
Gateway detail response provides the actual workspace. It is never inferred from the URL or
browser's remembered workspace selection. Sign-out, session expiry and team/account switching
clear the reload copy; retired API clients cannot write it back from late callbacks. StrictMode
replay must not erase it. A new user also remounts the authenticated shell, even in the same tenant.

The bound is two hours since save, 20 entries, 32,768 UTF-16 units per body and 131,072 serialized
units in total. Oldest entries are evicted; oversized text is not truncated in the live editor.
Corrupt/expired/unsupported records are discarded. There was no legacy disk draft format to
migrate; unscoped text is never attributed by guessing. Storage exceptions keep the memory path.
Deletion is best-effort if the browser itself denies storage access; scope and TTL are checked
again whenever readable storage is restored. This is plain browser text, not encrypted storage.

The send-start transition removes the submitted draft before dispatch. Pending/failed submission
state remains memory-only, with existing explicit retry behavior; reload never submits or queues
anything. A newer unsent body survives the older request's completion. Failed or uncertain sends
must be checked against the transcript after reload rather than automatically replayed.

## Identity authority

The existing `/api/members` endpoint is Admin/Owner-only and tenant-scoped (ADR-0022 and the
unchanged Gateway route policy). The provider does not call it for a Member. It reads names only
from active rows and stores a transient exact user-ID map, never login names or account secrets.
Unknown, removed, inaccessible and non-human actors retain their original keys. Current-session
profile metadata wins for that exact user. Duplicate display names do not merge identities.
Original actor ID/type remains in the existing expandable approval/task audit details; nothing
writes attribution back to the Gateway. No API, schema or authorization change was made.

A new authorized client, workspace or permission state invalidates the visible snapshot
immediately. Late old responses cannot reappear. Focus/online and a 60-second interval revalidate
names; refresh failures discard stale names. Display-name changes can therefore lag until the next
revalidation. The provider reads only metadata that this caller could already read through People.

## Verification

- Root typecheck and lint passed; production web build and docs consistency passed.
- Focused storage, composer, directory, formatter and recovery suite: 5 files / 26 tests passed.
- Root aggregate: 408 files / 4146 tests passed. No Gateway timeout on this run.
- `spikes/chat-drafts-identities-20261012/verify.mjs`: actual authenticated local HTTP Gateway,
  in-memory SQLite and Chromium at 1440px light / 390px dark. Offline navigation, reconnect,
  repeated Retry, refresh restoration, separate chat drafts, storage denial, current-user approval
  and task names/audit passed; recovery caused zero writes and no browser page errors.
- `identities.mjs` adds other/renamed/unknown/removed human receipt fixtures and real fixture logout
  and sign-in as a different Member: both 1440px and 390px passed all scenarios, no page errors;
  Member directory requests = 0. Exact-head CI is recorded in the PR.
- Storage tests cover other user/tenant/authentication lifetime/workspace/thread, logout and late
  callbacks, strict effect replay, send-in-flight/newer text, TTL, bounds and damaged storage.
- Directory tests cover duplicate names, non-human types, permission loss, removed/renamed actors,
  failure and delayed old workspace/tenant responses. Existing backend tenant authorization stays
  covered by the root suite; no new directory visibility is inferred from frontend tests.

Browser harness failures were retained: the first offline test navigated back before Files mounted
(fixed by waiting for composer detachment); the identity fixture initially changed only a hash
without triggering revalidation (fixed by exercising focus); unknown IDs matched both summary and
audit details (selector narrowed); a Member's group composer is intentionally hidden (assert the
attached input's empty value, not visibility). An intercepted read cancelled during navigation also raised a harness cleanup error; disposing
interceptions now ignores only already-handled/closed interception errors, while all active-page
content assertions remain required. No production policy was changed to make these checks pass.

Browser evidence uses the disposable demo Gateway and scripted sidecar/provider, not live models,
external integrations or production data. Other-actor receipt attribution and removed/renamed
metadata are explicit response fixtures, not edits to historical database records. Screenshot
bytes stay in the temporary QA output, outside git and Library. T2/T3, deployed browser restore,
real-model and assistive-technology acceptance are not claimed. PR #86 styles are unchanged.

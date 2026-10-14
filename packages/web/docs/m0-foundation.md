# M0

Two screens, hash-routed, no router or UI library:

- **Thread chat** (`#/threads/:id`): the left rail has one canonical private entry per Bot, nests its other one-member chats (retained histories and task chats) under that Bot as Other conversations, and lists group chats separately; there is no catch-all Other section. The rail reads one page of the current workspace's conversations (pins and inboxes first, then the 50 most recently updated) and offers older ones on request (#113 slice CH); a chat opened from a link beyond those pages is still listed. New creates only a 2–6 Bot group or links directly to New Bot. Workspace-shared pins are display-only, searchable, collapsible and scroll when long; row and open-chat header menus change them. On an empty database the first-run form creates a workspace and Bot, then opens the canonical chat that Bot creation already made. Main pane: transcript from `/api/threads/:id/messages` with `human`, bot-name and `system` author labels, live-appended from `GET /api/events?threadId=`; composer posts `{body}`; a typing indicator names the bot and the run status while a run is not terminal; every bot message links to its run replay. A welcome whose greeting never reached the chat offers an explicit retry there; a silent welcome that greeted through `thread_post` shows no failure (ADR-0024 amendment 2). Above the composer, `chat-run-stop.tsx` offers one Stop per unfinished run of this chat (issue #76), labelled with the bot and run status; it confirms first, states that only that run stops (not other bots, other runs of the same bot, queued follow-ups, the chat or the workspace) and calls the existing `POST /api/runs/:id/cancel`. A run that ended first (`invalid_transition`) is reported as already finished and refreshed; forbidden and network failures are reported and Stop stays available. A Member sees Stop only in their own side chat (`useCanInOwnSideChat("run.cancel")`).
- **Run replay** (`#/runs/:id`): status, lane, trigger, timestamps, usage per model priced by the Gateway (`unpriced` when `costUsd` is null), then the ledger events in `seq` order, live-appended from SSE while the run is going. `thinking` is collapsed, `tool_call` / `tool_result` expand to JSON, `screenshot` renders inline when the payload carries a `data:image/*` URL, base64 with an `image/*` `mimeType`, or an absolute `/api/` path this origin serves; every other reference, an `https://` one included, is shown as text so the screen never fetches from a third party. The rest are labelled rows.

Run it:

```
cp .env.example .env           # once; set MODEL_* and DEFAULT_MODEL / CHEAP_MODEL
npm run dev:gateway            # sandbox listener 8080; operator listener 8081 by default
npm run dev:web                # Vite on WEB_PORT (5173), proxies /api and /hooks to OPERATOR_PORT
```

The UI signs people in with a login name and password (ADR-0022 P1). On load it asks
`GET /auth/session`; the browser holds the session as an HttpOnly cookie the page never reads,
so a reload or browser restart stays signed in until the session expires or is revoked. Sign-in
posts to `/auth/login` with the pre-login token from that response; a wrong password, throttling
(429) and a Gateway outage each have their own message, and no stream opens before sign-in.
Every request uses `credentials: "same-origin"`; unsafe methods add the session's CSRF token in
`x-deskmates-csrf`. EventSource uses the plain `/api/events` URL and the cookie, never a query
token. Nothing is written to localStorage, sessionStorage or a URL. Sign out (`/auth/logout`)
and Sign out on every device (`/auth/logout-all`) return to the sign-in screen and close every
stream; any later HTTP 401 does the same with a "session has ended" notice. SSE failures probe
an authenticated endpoint because EventSource does not expose HTTP status; transient outages
keep the current UI and drafts. The signed-in person's name, role and tenant and the running
`release` from `GET /api/config` are shown in the sidebar.

Screens offer only what the session's role may take (issue #14). The session's `tenant.role` and
`platformMaintainer` go into `SessionRolesProvider` (`src/state/session-roles.tsx`); a screen asks
`useCan(action)` and hides or disables the control, and `RoleNote` says which role can ("Only an
Admin or Owner can register a database."). Actions and their roles come from one table,
`ROLE_ACTIONS` in contracts, which the Gateway's `role-actions.test.ts` checks against its route
policy. This is presentation only: the Gateway refuses whatever a screen offers wrongly, and a
screen rendered without the provider offers everything.

Since ADR-0022 amendment 1 a Member uses side chats and Admins own the group: the provider also
carries the session's actor label (`user:<id>`), and `useCanPost(thread, memberCount)` lets a
Member post only in a one-bot chat they opened (`thread.sideChatActor`). For a Member, New chat
picks one bot, a contact's Message opens their own side chat with it, thread members, tasks,
learned-memory curation, `MEMORY.md`, and the Always / "allow this site" approval answers are
hidden or read-only with a role note. The run view fetches a run's thread for a Member and
offers Cancel run and the continuation answer only in that Member's own side chat
(`useCanInOwnSideChat`, ADR-0022 amendment 1 A11/A12).

`npm run dev:gateway` selects the plain-HTTP development cookie mode when `.env` leaves
`GATEWAY_SESSION_COOKIE` empty; create a local account once with
`npm run auth -- bootstrap-owner --login <name> --name "<display name>"` (it opens the same
`.env` and database as `npm run dev:gateway`; start the Gateway once first). `npm run dev:web`
proxies `/api`, `/auth` and `/hooks` to the Gateway. If `.env` leaves
`GATEWAY_OPERATOR_TOKEN` empty, the launcher also prints an ephemeral operator token for machine
clients; production startup requires an explicit value.

`vite.config.ts` reads `OPERATOR_PORT` and `WEB_PORT` from the repo-root `.env`, so the dev server
and operator proxy follow the same file the Gateway reads. `npm run build -w packages/web` writes
a static bundle to `dist/`; serve it from the operator origin, either by setting the Gateway's
`WEB_DIST_DIR` to that directory (the operator listener then serves it at `/`) or through a reverse
proxy. The bundle uses only relative `/api` URLs, so it works from any origin that reaches the
operator listener, including a LAN address. A production reverse proxy serves
those static files and sends `/api/*` and `/hooks/*` to `OPERATOR_PORT`. It must not expose
`/internal/*` or `/v1/*` through that origin. An already running old Gateway keeps its old
listeners until it is restarted.

Run replay is keyed by run ID, so direct run-to-run navigation resets usage, events and local errors.
Conversation drafts are held per thread in the authenticated client memory across route changes.
A delayed send cannot clear newer text, and failed submissions remain recoverable. Failed and
cancelled runs remain visible in the transcript with their reason and diagnostic link.

Both screens open the stream before their first fetch and merge every response into what the stream already delivered, never over it. `GET /api/events` fans out live frames only, so a dropped connection loses whatever was emitted while it was down: `subscribeEvents` reports each reconnecting → open transition through `onReconnect` and the screen re-runs its fetch (`listMessages(afterSeq)` + `listRuns`, or `getRun` + `listRunEvents(afterSeq)`) to recover the gap.

Layout: see "Source layout" in the [package README](../README.md#source-layout). Tests are colocated; screen tests run in jsdom with `fetch` and `EventSource` doubles from `src/test-support/`, never a real Gateway.

```
npm run typecheck -w packages/web
npm test -w packages/web
```

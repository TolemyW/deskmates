# List pagination coverage and implementation plan — 2026-10-13

Issue #113 asks for bounded pagination on every list page. It also requires a published
coverage checklist and plan before any implementation starts. This document is that checklist
and plan. It changes no code. Related requirements: #112 (Costs: monetary and token rankings
are separate, and no aggregate is computed from one page) and #117 (100-workspace management
list, proposed at 20 per page). Role and audience scoping is #116.

Evidence is from reading the source at `78c59546`. No browser acceptance was done. Paths are
relative to `packages/web/src/` (web) and `packages/gateway/src/` (gw). ADR-0031 replaces the
migration chain with one baseline schema, so required indexes are given as table and column
lists. This document contains no migrations.

## 1. Coverage checklist

Classes: **server** = bounded server query, honest total or cursor. **trunc** = bounded server
query whose remainder the UI drops without saying so. **client** = full response, sliced in the
browser. **unbounded** = full collection, no pager. **incr** = `afterSeq` incremental tail.
**static** = release-bundled catalog, bounded by the build.

Target notation: `cursor` = opaque keyset cursor with `nextCursor` (hasMore). `offset` =
offset/limit with `total`. `D/M` = default/maximum page size. Every order ends in a unique
tie-breaker.

| # | Screen › sublist | API | Now | Evidence | Target |
|---|---|---|---|---|---|
| 1 | Files › collection | `GET /api/workspaces/:id/assets` | server | web `features/files/files.tsx:141-143,438-458`; gw `api/file-collection-routes.ts:26`, `files/file-collection.ts:76` | Keep: offset, 25/100, `at DESC, id`, total + `truncated` |
| 2 | Costs › Activity rows | `GET /api/costs` (`rows`) | client (10) | `features/costs/costs.tsx:151,322-326,543` | cursor rows endpoint, 10/100, keep `day DESC, botName, botId, model` (`gw ledger/costs.ts:133`); totals from summary |
| 3 | Costs › By model ranking | `GET /api/costs` | unbounded | `costs.tsx:331,473` (`sliceBy`, `:112`) | offset, 10/100, metric DESC then `model`; total = distinct models (#112 units) |
| 4 | Costs › By bot ranking | `GET /api/costs` | unbounded | `costs.tsx:332,474` | offset, 10/100, metric DESC then `bot_id`; label with workspace (#112) |
| 5 | Costs › open alerts | `GET /api/cost-alerts?status=open` | client (10) | `features/costs/cost-alerts.tsx:30,126,191-199`; gw `ledger/cost-alerts.ts:145` | cursor, 10/100, `fired_at DESC, id DESC`, total open (badge) |
| 6 | Costs › alert rules | `GET /api/cost-alert-rules` | unbounded | `cost-alerts.tsx:127,557`; gw `ledger/cost-alerts.ts:72` | offset, 25/100, `created_at, id`, total |
| 7 | Integrations › provider catalog | `GET /api/integrations/catalog` | client (24), static | `features/integrations/integrations.tsx:45,169-172,482` | Keep local 24; scope documented as static catalog |
| 8 | Integrations › connections per provider | `GET /api/integrations/workspaces/:id/connections` | unbounded | `integrations.tsx:113,174,423`; gw `integrations/integration-store.ts:202` | offset per workspace, 25/100, `created_at, id`, total; per-provider count from aggregate |
| 9 | Integrations › database connectors | `GET /api/connectors?workspaceId` | unbounded | `integrations.tsx:115,514`; gw `connectors/registry.ts:139` | offset, 25/100, `created_at, id`, total |
| 10 | Integrations › channel plugins | `GET /api/channels` | static | `features/integrations/channel-integrations.tsx:90,161` | Keep local (bundled plugins) |
| 11 | Integrations › channel connections | `GET /api/workspaces/:id/channels` | unbounded | `channel-integrations.tsx:91,114` | offset, 25/100, `created_at, id` |
| 12 | Knowledge › Documents | `GET /api/knowledge` (no cursor) | **trunc** (25) | `features/knowledge/knowledge.tsx:130,154,228`; `features/knowledge/api.ts:129-131` drops `nextCursor`; gw `knowledge/knowledge.ts:61,302-311` | cursor, 25/100, `updated_at DESC, id DESC` |
| 13 | Knowledge › document search | `GET /api/knowledge?q=` | **trunc** (top 5) | gw `api/knowledge-routes.ts:29`, `knowledge/knowledge.ts:391,400` (default 5, max 20) | offset over rank, 25/100, `bm25, id`, hasMore; explicit "top N" if capped |
| 14 | Knowledge › pending proposals | `GET /api/knowledge/proposals` (no cursor) | **trunc** (25) | `knowledge.tsx:131,397`; `api.ts:142-144`; gw `knowledge.ts:150-162` | cursor, 25/100, `created_at DESC, id DESC`, total pending |
| 15 | Knowledge › Maintenance › published | same, with cursor | server (Load more) | `features/knowledge/knowledge-governance.tsx:47-49,73,125` | cursor; move from append to the explicit pager |
| 16 | Knowledge › Maintenance › proposals | same, with cursor | server (Load more) | `knowledge-governance.tsx:52-58,74,230` | as 14 |
| 17 | Knowledge › document history | `GET /api/knowledge/:id/history` | server (Load older) | `knowledge-governance.tsx:61-67,174`; gw `knowledge.ts:330-344` | Keep cursor `version DESC`; Load older is right for a history |
| 18 | Observations / Learned memory › entries | `GET /api/workspaces/:id/memory` | unbounded | `features/knowledge/observations.tsx:114,354`; `features/knowledge/learned-memory.tsx:250-256,658,708`; gw `api/learned-memory-routes.ts:46`, `memory/entries.ts:219-227` | cursor, 25/100, `observed_at DESC, id`; scope, bot and thread filters on the server |
| 19 | Observations / Learned memory › search | `GET /api/workspaces/:id/memory/search` | **trunc** (20) | `observations.tsx:113`; `learned-memory.tsx:243`; gw `learned-memory-routes.ts:73`, `memory/search.ts:60,69` | offset over rank, 20/50, hasMore; say "best N matches" |
| 20 | Observations / Learned memory › needs confirmation | `GET /api/memory-suggestions` | **trunc** (100) | `observations.tsx:115,256`; `learned-memory.tsx:257,579` ignore `nextCursor`; gw `memory/confirmations.ts:141,169` | cursor, 25/100, `created_at DESC, id DESC`, total pending |
| 21 | Observations / Learned memory › versions | `GET /api/memory/entries/:id/versions` | unbounded | `observations.tsx:168,537`; `learned-memory.tsx:396,740`; gw `memory/entries.ts:348` | cursor Load older, 25/100, `version DESC` |
| 22 | Tasks › list + metric cards | `GET /api/workspaces/:id/tasks` | unbounded | `features/tasks/tasks.tsx:247,302,420-480` (filter, search, counts in browser); gw `api/task-routes.ts:11`, `tasks/tasks.ts:81` | offset, 25/100, `updated_at DESC, rowid DESC`; status/search on server; counts from aggregate |
| 23 | Attention › pending approvals + nav badge | `GET /api/approvals?status=pending` | unbounded | `features/approvals/approvals.tsx:60,162`; `features/approvals/feature.tsx:20` (badge = `length`); gw `approvals/approvals.ts:143` | cursor, 25/100, `created_at, id` (oldest first), total for badge |
| 24 | Chat › thread rail (inboxes, groups, pinned, bus) | `GET /api/threads` (whole tenant) | unbounded | `features/chats/thread.tsx:75,79`; `features/chats/thread-rail.tsx:139-145,246-262`; gw `api/thread-routes.ts:116`, `threads/threads.ts:179` | cursor per workspace, 50/100, pinned first, then `updated_at DESC, id`; server search |
| 25 | Chat › messages | `GET /api/threads/:id/messages?afterSeq` | incr; first load unbounded | `features/chats/chat-pane.tsx:210-214,255`; gw `api/thread-routes.ts:281`, `threads/messages.ts:120` | Chronological flow: newest window 50/200 + `beforeSeq` Load older; `afterSeq` tail with limit + hasMore |
| 26 | Chat › thread approvals | `GET /api/approvals?threadId&status` | unbounded | `chat-pane.tsx:203-204` | Bound to the loaded message window (seq range) |
| 27 | Chat › runs strip / private-chat activity | `GET /api/runs?threadId` / `?botId` | unbounded | `chat-pane.tsx:214,256`; `features/chats/private-chat-activity.tsx:44,82-91`; gw `api/run-routes.ts:11`, `ledger/runs.ts:189` | Active runs unpaged (bounded by lanes); finished runs cursor 20/100, `created_at DESC, id DESC` |
| 28 | Chat › incoming handoffs | `GET /api/threads/:id/activity` | unbounded | `features/chats/incoming-handoffs.tsx:27`; gw `threads/private-chats.ts:99` | cursor Load older, 20/100, `seq DESC` |
| 29 | Contacts › bot rail | `GET /api/bots` (whole tenant) + `GET /api/runs` (whole tenant) | unbounded | `features/contacts/contacts.tsx:122,138-140,217`; gw `api/registry-routes.ts:139`, `bots/bots.ts:322-327` | offset per workspace, 50/100, `name, id`, total; server search; latest run per bot from a summary |
| 30 | Contacts › bot Activity feed | `GET /api/runs?botId` | unbounded | `features/contacts/bot-profile.tsx:53`; `features/contacts/bot-activity.tsx:122,180` | cursor, 20/100, `created_at DESC, id DESC` |
| 31 | Contacts › approval rules | `GET /api/bots/:id/approval-rules` | unbounded | `features/contacts/management.tsx:488,549`; gw `approvals/rules.ts:61` | offset, 25/100, `created_at, id`, total |
| 32 | Run detail › events | `GET /api/runs/:id/events?afterSeq` | incr; first load unbounded | `features/runs/run.tsx:102-105,140`; gw `api/run-routes.ts:30`, `ledger/events.ts:103` | Newest 200/500 + `beforeSeq` Load older; tail with limit + hasMore |
| 33 | Members › members | `GET /api/members` | unbounded | `features/members/members.tsx:76,165`; gw `api/member-routes.ts:82`, `auth/auth-service.ts:435` | offset, 25/100, `status, display_name, user_id`, total |
| 34 | Members › invitations | `GET /api/invitations` | unbounded | `members.tsx:77,264`; gw `auth/invitations.ts:158` | offset, 25/100, `created_at DESC, id`, total |
| 35 | Skills › workspace skills | `GET /api/workspaces/:id/skills` (`skills`) | unbounded | `features/skills/skills.tsx:193,247,443`; gw `skills/skill-store.ts:161` | offset, 25/100, `name, id`, total; server search |
| 36 | Skills › pending reviews | same view (`pending`) | unbounded | `skills.tsx:379`; gw `skill-store.ts:254` | cursor, 25/100, `created_at, skill name, version id`, total |
| 37 | Skills › starter catalog | same view (`starterSkills`) | static | `skills.tsx:254,363`; gw `skills/starter-catalog.ts` | Keep local (bundled) |
| 38 | Skills › versions | `GET /api/skills/:id/versions` | unbounded | `skills.tsx:642`; gw `skill-store.ts:244` | cursor Load older, 25/100, `version DESC` |
| 39 | Trash › archived workspaces | `GET /api/trash` | unbounded | `features/trash/workspace-trash.tsx:44,140`; gw `workspaces/trash-lifecycle.ts:24`, `workspaces/workspaces.ts:191` | offset, 25/100, `archived_at DESC, id`, total |
| 40 | Workspace switcher | `GET /api/workspaces` | unbounded | `state/workspace-scope.tsx:85`; `features/workspaces/workspace-switcher.tsx:92`; gw `workspaces/workspaces.ts:177-180` | Bounded pinned/recent + server search; Manage page offset 20/100 (#117) |
| 41 | Computer › desktop rail | `GET /api/bots` (whole tenant) | unbounded | `features/computer/computer.tsx:36,49,109`; `features/computer/desktop-rail.tsx:40` | Workspace-scoped bots, offset 25/100; one screen per bot, so the region layout bounds it |

Not mounted: `ManagementScreen` (`features/contacts/management.tsx:813`, includes the bot trash
`TrashSection` at `:58`) and `DesktopsScreen` (`features/contacts/desktops.tsx:10`) appear only
in tests. `#/desktops` renders Contacts (`features/contacts/feature.tsx:15`). These two screens
are out of scope. Delete them, or page them if they are remounted.

**Counts.** Of 41 surfaces:

- server-paged: 4 (1, 15, 16, 17)
- bounded but truncated: 5 (12, 13, 14, 19, 20)
- client-paged: 3 (2, 5, 7)
- incremental afterSeq: 2 (25, 32), each with an unbounded first load
- static catalogs: 3 (10, 37, and 7, which is also client-paged)
- unbounded: 25 (3, 4, 6, 8, 9, 11, 18, 21, 22, 23, 24, 26, 27, 28, 29, 30, 31, 33, 34, 35, 36, 38, 39, 40, 41)

**Hidden whole-collection fetches.** These are not visible lists, but each reads a whole
collection:

- `contacts.tsx:122` reads every run in the tenant to find each bot's latest run.
- `learned-memory.tsx:280` reads every run in the tenant to find the latest memory counts.
- `thread.tsx:75` reads every thread and bot in the tenant.
- `state/actor-directory.tsx:35` reads every member for name lookup.
- Each `listBots()` call feeds a dropdown or a name map.

The two `listRuns()` calls grow with all history. Replace them with summary endpoints (slice
R). Do not page them.

## 2. Silent truncation and one-page aggregates

Silent truncation, highest risk first:

1. **Memory confirmations (20).** The review queue is requested with `limit: 100`, and
   `nextCursor` is dropped (`observations.tsx:115`, `learned-memory.tsx:257`). Item 101 and
   later never appear for review. Both callers also read it on every reload. This is the issue's
   "silent missing review items" case.
2. **Knowledge pending proposals (14).** `listKnowledgeProposals()` calls the paged endpoint
   without a cursor, so the Documents tab shows the first 25 pending proposals as the whole
   queue. The Maintenance panel (16) shows the same queue with Load more, so the two views
   disagree.
3. **Knowledge documents (12).** The tab shows the 25 most recently updated documents and
   nothing else.
4. **Knowledge search (13).** Search returns the top 5 by bm25 (`knowledge.ts:391`). The
   issue's starting inventory says this branch returns all matches. It does not: the cap is 5,
   not unbounded, and the UI shows those 5 as the complete result.
5. **Learned-memory search (19).** The search returns the top 20 with no indication that more
   exist.
6. **Server limits clamp instead of rejecting.** `knowledge.ts:61` and `confirmations.ts:141`
   silently reduce `limit > 100` to 100. A caller that asks for 500 gets 100 and has no way to
   tell. The target rejects the request with a validation error.

Aggregates that become wrong once their source list is paged. Each needs a separate aggregate
API before or together with its pager:

- Costs (2-4). `costs.tsx:330-333` computes totals tiles, day bars, the model legend and both
  rankings from the full `rows`. That is correct today. When rows are paged, these must come
  from a summary or ranking endpoint, never from a page (#112).
- Tasks (22). The Open, Needs attention and Accepted cards and the "n of m" count
  (`tasks.tsx:450-480`) use `tasks.length`.
- Attention badge (23). The badge equals the length of the pending list
  (`approvals/feature.tsx:20`).
- Integrations (8). "Connected" counts per provider filter the full connection list
  (`integrations.tsx:174-175`).
- Contacts (29). "Latest run" per bot comes from all runs in the tenant (`contacts.tsx:137`).
- Learned memory index observation. It comes from all runs (`learned-memory.tsx:280-296`).
- Thread rail (24). Section counts for pinned and bus threads (`thread-rail.tsx:507-524`) count
  the loaded threads.
- First-run checklist. It decides from list lengths whether anyone has been invited
  (`app/first-run-checklist.tsx:68-72`). This must use `total` or an existence flag.

## 3. Shared contract

### 3.1 Contracts (`packages/contracts/src/pagination.ts`, one new file)

The file holds types and validation only, with zero runtime dependencies:

```ts
export const PAGE_LIMIT_MAX = 100;               // default ceiling; a surface may lower it
export interface PageLimitPolicy { default: number; max: number }
export interface CursorPageRequest { cursor?: string; limit?: number }
export interface CursorPageMeta { nextCursor?: string; total?: number }   // nextCursor ⇔ hasMore
export interface OffsetPageRequest { offset?: number; limit?: number }
export interface OffsetPageMeta { offset: number; limit: number; total: number; truncated?: boolean }
export function parsePageLimit(raw: unknown, policy: PageLimitPolicy):
  { ok: true; limit: number } | { ok: false; field: "limit" };
```

- **Response shape.** Each response keeps its resource key, for example `{ runs, nextCursor }`
  or `{ tasks, offset, limit, total }`. Existing clients (`documents`, `proposals`, `versions`,
  `suggestions`) keep working, and every new field is additive. An unpaged request returns the
  first page plus `nextCursor` or `total`, never the whole collection. This is a behaviour
  change for unpaged callers, so each slice moves its own callers in the same PR.
- **Limit validation.** A limit that is not an integer, is below 1, or is above the surface's
  maximum gets a 400 `validation` response. It is never clamped. The
  `parseFileCollectionQuery` pattern (`contracts/src/file-collection.ts:196-221`) already does
  this.
- **Cursor encoding.** Cursors are built only in the Gateway, in a new file
  `gw api/pagination.ts`. A cursor is base64url JSON
  `{ v: 1, k: [sortKey..., id], f: <hash of tenant, scope and filters> }`. A cursor presented
  with different filters or a different scope fails as `validation`, so it cannot leak rows
  into another scope. The web treats cursors as opaque.
- **When to use which.** Use a keyset cursor for append-heavy logs, where offset would drift
  under live insertion: runs, approvals, memory, messages, events, alerts and history. Use
  offset with `total` for bounded management collections, where people expect numbered pages
  and a total: files, members, skills, bots, rules, connections, trash and workspaces. A
  cursor list gives `total` only when an indexed `COUNT` under the same filter is cheap (the
  pending queues). Otherwise it states "more" and never invents a number.
- **Contracts that already fit:**
  - `WorkspaceFileCollectionPage` and `parseFileCollectionQuery` are the reference for offset
    pages.
  - Knowledge `Page<T>` in `gw knowledge/knowledge.ts:45` and the memory-suggestion cursor in
    `gw memory/confirmations.ts:140-192` are keyset cursors with tie-breakers. They need
    rejection instead of clamping, and the scope hash.
  - The knowledge history cursor (bare version number) is acceptable because it is scoped by
    document ID.

### 3.2 Web

- **`Pager` component** (`packages/ui/src/pager.tsx`). It is presentational: a range label
  slot, Previous and Next, `aria-label` on the nav, and `disabled` with `aria-disabled` at each
  boundary. Callers pass strings in as props, because `ui` imports no Deskmates package
  (ADR-0025). The page bar `PageRange` takes `{from, to, total?, hasMore}`. With no total it
  renders "1-25 of more", never a guessed number. It replaces the four ad-hoc pagers in Files,
  cost Activity, cost alerts and the integration catalog. Their sizes stay the same.
- **`usePagedQuery` hook** (`packages/web/src/lib/use-paged-query.ts`). The hook takes
  `scopeKey` (tenant + workspace + filters + sort + search) and `fetchPage(request)`, and owns
  the following:
  - **Reset.** Any change to `scopeKey` returns to the first page and clears the cursor stack.
    Search input is debounced first, as in `files.tsx:128-134`.
  - **Stale guard.** A monotonically increasing request sequence (`files.tsx:137-150`). Only
    the latest response for the current `scopeKey` is applied. An older response is discarded
    even when it arrives later.
  - **Previous for cursors.** A stack of the cursors already visited.
  - **Last-page clamp.** When a delete, acknowledgement or refresh empties a page past the
    first, the hook loads the previous page (offset) or pops the stack (cursor). Cost alerts
    already clamp at `cost-alerts.tsx:194-197`.
  - **Live updates.** An SSE insert never shifts the current page. On page 1 it merges at the
    top and drops the overflow. On later pages it shows a "n new, back to newest" notice.
    Reconnect refetches the current page, not page 1. Selection and drafts are keyed by record
    ID, not row index.
  - **Back and Forward.** The page index or cursor lives in the hash query
    (`?page=2` / `?after=<cursor>`), parsed by each feature's own `route.ts`, so no shared route
    table changes.
- **Not paged.** Name maps and dropdowns (`listBots()`, the actor directory) are not page
  controls. A configuration picker that can hold hundreds of entries (bot owner, workspace)
  gets server search with a bounded result count instead.

### 3.3 Ordering and indexes (for the ADR-0031 baseline or a forward migration after it)

Each target order needs an index that ends in its tie-breaker:

- `runs`: `(bot_id, created_at, id)`, and add `id` to `(thread_id, created_at)`. Tenant scoping
  goes through `bots`/`workspaces` subqueries (`ledger/runs.ts:174`). Reaching 100k runs per
  tenant needs a denormalised `workspace_id` or a join plan; measure before choosing.
- `approvals`: `(decision, created_at, id)`, and `(thread_id, created_at, id)`.
- `threads`: `(workspace_id, updated_at, id)`.
- `memory_entries`: `(workspace_id, tombstoned, observed_at, id)`.
- `memory_suggestions`: `(workspace_id, status, created_at, id)`. The existing index starts
  with `status, bot_id`.
- `bots`: `(workspace_id, archived_at, name, id)`.
- `skills`: `(workspace_id, name, id)`.
- `skill_versions`: `(skill_id, version)`.
- `cost_alerts`: `(tenant_id, acknowledged_at, fired_at, id)`.
- `cost_alert_rules`: `(tenant_id, created_at, id)`.
- `integration_connections` and `connectors`: `(workspace_id, created_at, id)`.
- `tenant_invitations`: `(tenant_id, created_at, id)`.
- `workspaces`: `(tenant_id, archived_at, created_at, id)`.
- `tasks`: `(workspace_id, status, updated_at)`.
- `thread_messages` and `run_events` already have unique `(thread_id, seq)` and `(run_id, seq)`.
- Costs ranking and rows need a server-side grouped query. Today `ledger/costs.ts:32-140`
  aggregates every usage receipt in JavaScript.

## 4. Implementation slices

Each slice owns one feature folder plus its Gateway route and store files. The only shared
files are the new ones in slice F. Sizes: S ≤ ½ day, M ≈ 1-2 days, L ≈ 3+ days, including tests
and per-surface browser evidence (desktop and 390px, both themes, keyboard).

| Slice | Folder(s) | Surfaces | Size | Depends on |
|---|---|---|---|---|
| **F** Foundation | `contracts/src/pagination.ts`, `gw api/pagination.ts`, `ui/src/pager.tsx`, `web/src/lib/use-paged-query.ts` | none (helpers + tests) | M | none; lands first |
| **K1** Knowledge documents | `features/knowledge/knowledge.tsx`, `knowledge-governance.tsx`; `gw api/knowledge-routes.ts`, `knowledge/` | 12-17 | M | F |
| **K2** Learned memory | `features/knowledge/observations.tsx`, `learned-memory.tsx`; `gw api/learned-memory-routes.ts`, `memory-suggestion-routes.ts`, `memory/` | 18-21 | L | F; baseline (memory indexes) |
| **A** Attention | `features/approvals/`; `gw api/approval-routes.ts`, `approvals/` | 23 | M | F; baseline; #116 (who sees which approvals) |
| **T** Tasks | `features/tasks/`; `gw api/task-routes.ts`, `tasks/` | 22 | M | F; baseline (status index) |
| **R** Runs | `features/runs/`, `features/contacts/bot-activity.tsx`, `bot-profile.tsx`, `features/chats/private-chat-activity.tsx`; `gw api/run-routes.ts`, `ledger/runs.ts`, `ledger/events.ts` | 27, 30, 32 and the two hidden `listRuns()` calls | L | F; baseline (runs indexes) |
| **CH** Chats | `features/chats/` (thread-rail, chat-pane, incoming-handoffs); `gw api/thread-routes.ts`, `threads/` | 24-26, 28 | L | F; R for the runs strip; baseline |
| **C** Costs | `features/costs/`; `gw api/cost-routes.ts`, `cost-alert-routes.ts`, `ledger/costs.ts`, `ledger/cost-alerts.ts` | 2-6 | L | F; #112 layout decision; baseline (grouped query) |
| **B** Contacts | `features/contacts/contacts.tsx`, `management.tsx` (rules); `gw api/registry-routes.ts` (bots), `api/approval-routes.ts` (rules) | 29, 31 | M | F; R (latest-run summary); #116 |
| **M** Members | `features/members/`, `app/first-run-checklist.tsx`; `gw api/member-routes.ts`, `auth/` | 33, 34 | M | F; #116 (Guest visibility, role filter) |
| **S** Skills | `features/skills/`; `gw api/skill-routes.ts`, `skills/` | 35, 36, 38 | M | F |
| **TR** Trash | `features/trash/`; `gw api/trash-routes.ts`, `workspaces/trash-lifecycle.ts` | 39 | S | F |
| **I** Integrations | `features/integrations/`; `gw api/integration-routes.ts`, `connector-routes.ts`, `channel-routes.ts` | 7-11 | M | F |
| **W** Workspaces | `features/workspaces/`, `state/workspace-scope.tsx`; `gw api/registry-routes.ts` (workspaces) | 40, plus the #117 management page | L | F; #117 design; #116 |
| **D** Computer | `features/computer/` | 41 | S | F; B (workspace-scoped bot query) |
| **FI** Files | `features/files/` | 1 | S | F (move to `Pager`; no visible change, `ui-fingerprint.mjs`) |

**Order.**

1. F.
2. K2 and K1 (the silent truncation fixes; K1 needs no index).
3. In parallel: S, TR, I, FI, T and A.
4. R, then CH, B and D.
5. C, after #112 decides the layout.
6. M and W, after #116 settles roles and #117 its design.

**Parallel merges.**

- B and W both touch `gw api/registry-routes.ts`. Either merge them one after the other, or
  first split that file into `bot-routes.ts` and `workspace-routes.ts`; that split is a
  no-behaviour refactor of its own.
- R and CH share `ledger/runs.ts`, so CH starts from R.
- No slice adds to a shared registry. Each Gateway route keeps its own `PageLimitPolicy`
  constant.

**Proof for every slice.**

- A T1 route test covers more than two pages, a limit over the maximum (400), a foreign or
  mismatched cursor (400), a stable tie-breaker with equal timestamps, and an empty last page.
- A web test covers scope reset, a stale response arriving late, the last-page clamp, live
  insertion, and Back and Forward.
- Aggregates are checked against the authoritative whole-collection value.

## 5. Non-goals

- **Chat messages, run events, knowledge history and the handoff feed** stay chronological flows
  with Load older. They are never numbered tables. Bounding their first load and tail is in
  scope (CH, R).
- **Configuration choices** are not given page controls: dropdowns, bot pickers, model and
  category selectors, schedules (`bot.cron`, `features/contacts/bot-schedules.tsx`), thread
  members, egress allowlists, approval-card details and the static catalogs (7, 10, 37). Large
  pickers get bounded server search instead.
- **No global page size.** Files 25, cost alerts 10, cost Activity 10 and the integration
  catalog 24 stay as they are. Other defaults above are proposals for review.
- **No change to what a page means.** Paging never creates runs, changes permissions, deletes
  records, or redefines memory, task, approval or alert semantics. Acknowledging or deciding an
  item keeps its current endpoint.
- **No new Costs layout, budget semantics or workspace naming rules here.** Those are #112, #61
  and #117.
- **No migrations here.** Indexes go into the ADR-0031 baseline or into a forward migration
  that sorts after it.
- **No paging for unmounted screens.** `ManagementScreen` and `DesktopsScreen` are not mounted
  and get no pager unless they are mounted again.

## 6. Status — 2026-10-14

Implemented on the 2026-10-13 and 2026-10-14 batches. Each slice has the §4 T1 route proof and web
tests. No slice has had a browser pass at 390 px, in both themes or by keyboard.

| Slice | Surfaces | Batch | Notes |
|---|---|---|---|
| F | helpers | 2026-10-13 | |
| K1 | 12-17 | 2026-10-13 | |
| K2 | 18-21 | both | Review queue and search on 10-13; entries and versions, scoped cursors and 400 instead of clamping on 10-14 |
| S, TR, FI | 35-39, 1 | 2026-10-13 | |
| I | 7-11 | 2026-10-14 | 11 not paged: one connection per bundled plugin per workspace, bounded by the build |
| T | 22 | 2026-10-14 | Cards from a whole-workspace `statusCounts` |
| C | 2-6 | 2026-10-14 | Rows and rankings still group usage receipts in JavaScript per request; only the output is paged |
| A | 23 | 2026-10-14 | Visible set computed before paging; inbox pages have no Back/Forward history |
| R | 27, 30, 32 + hidden `listRuns()` | 2026-10-14 | `latest-by-bot` and `memory-index` summaries replace the whole-tenant reads |
| CH | 24, 25, 28 | 2026-10-14 | 26 open: chat approvals are not bounded to the loaded message window |
| B | 29, 31 | 2026-10-14 | |
| D | 41 | 2026-10-14 | |
| M | 33, 34 + first-run checklist | 2026-10-14 | |
| W | 40 + #117 management page | 2026-10-14 | The shell scope still reads the unpaged `GET /api/workspaces` as its name map |

Deviations from §3, kept for review:

- `GET /api/bots` and `GET /api/threads` page only when a paging or search parameter is sent;
  without one they return the whole list, because they still serve as name maps and channel
  lookups.
- A run-list page without `phase` also carries every unfinished run, so one request serves a chat.

Still open: surface 26, the Costs grouped SQL query (§3.3), and the two whole-list name maps.

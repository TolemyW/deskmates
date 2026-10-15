# Name lookups and bounded chat approvals (#113)

Screens that only label ids ask for those ids instead of reading a whole list
(pagination plan §3.2). Each lookup takes at most 100 comma-separated ids; more is a
400 `validation` with `details.field = "ids"`. An empty `ids=` names nothing.

| Route | Answer | Visibility |
|---|---|---|
| `GET /api/bots?ids=a,b[&workspaceId=]` | `{ bots }` | Active bots of the caller's tenant, in workspaces the caller belongs to (as the unpaged list) |
| `GET /api/threads?ids=a,b[&workspaceId=]` | `{ threads }`, the list's summary shape | Threads of the caller's tenant without other people's private chats, and no bus thread for a Guest |
| `GET /api/workspaces?ids=a,b` | `{ workspaces }` | Active workspaces the caller belongs to |
| `GET /api/approvals?threadId=t&ids=a,b[&status=]` | `{ approvals }` | The named approvals of that thread the caller may see; pending and decided unless `status` is set |

Rows come back in list order (`created_at, id`). Unknown, archived, foreign-tenant and
invisible ids are omitted rather than reported, so a lookup reveals no more than the list.

The chat (surface 26) asks for the thread's pending approvals plus, by id, the approvals its
loaded messages name; Load older asks for the older window's. The web client splits more than
100 ids into several requests.

Without `ids` or paging parameters, `GET /api/bots`, `GET /api/threads` and
`GET /api/workspaces` still return the whole list: pickers, rosters, channel binding lookups
and the shell's workspace switcher read it. Tests: `api/name-lookup.test.ts`,
`api/thread-approvals.test.ts`.

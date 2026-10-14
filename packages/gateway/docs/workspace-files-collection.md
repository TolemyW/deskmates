# Workspace Files collection (ADR-0014 amendment A2)

`GET /api/workspaces/:id/assets?offset=&limit=&type=&source=&q=` (`file-collection-routes.ts`,
query module `files/file-collection.ts`) lists workspace paths that SQLite already references:
task artifacts, message attachments whose `ref` is a workspace path, and paths named in
bot-authored message bodies. It is not a filesystem inventory. Paths pass the lexical policy of [workspace file download](workspace-file-download.md)
against the workspace's bots, one item per exact path, with up to 20 newest references (thread,
message, run, bot, task, `usedInDelivery` for delivered/accepted tasks) and `source` `bot` or
`unknown`. `limit` defaults to 25 (max 100); `type` is `all|documents|images|web|other`; `source`
is `all|bot|uploaded`; `q` searches path and labels. Each source reads at most 10,000 newest
references and sets `truncated` when it hits that. SQL only: no `peek`, `ensure` or exec, so a
stopped workspace lists without starting. Members may read it. Each listing logs `workspace files
listed`.

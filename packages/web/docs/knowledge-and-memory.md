# B5: knowledge and memory

`#/knowledge` provides approved knowledge search, Markdown editing/export, draft submission,
and explicit approve/reject review with a link to the source run. Proposal content is rendered
as text, never executable HTML. Bots cannot publish their own proposals through these routes.

Knowledge and memory drafts are retained per document/bot in the current authenticated client
across in-app navigation. Switching selection or reloading a dirty editor asks the operator to
keep editing or explicitly discard before proceeding. Version conflicts load the latest server text separately while preserving the local draft
for comparison and explicit reconciliation. These drafts are not persisted across a
page reload, sign-out, or expired session.

The same screen selects a bot for MEMORY.md read/edit/export. A save carries the version that
was loaded; on conflict the local edit remains visible alongside the latest saved text. The
operator may explicitly use the latest version as the save base while retaining local text,
or discard the local draft and reload.
The workspace must already be running and idle. Saving an empty body clears its contents.
All requests ride on the signed-in browser session. Sign out returns to the sign-in screen
and destroys the authenticated UI. SOUL editing and automatic memory-suggestion review
are not part of this screen yet.

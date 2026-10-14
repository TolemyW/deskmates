# M2: group threads

- **Creation.** The new-thread form selects one to six bots of the current workspace. The first bot is selected by default to preserve the one-bot flow; the form offers no other workspace's bots, so a stale bot id cannot cross the workspace boundary. A workspace with no bots still creates its first bot and a one-member thread in one step.
- **Membership controls.** The chat header's **Add bot** picker searches existing bots
  of the same workspace by name or role and excludes current members. Adding selected
  bots updates the member list and desktop cards without sending a chat message or
  starting a task. When every bot is already a member, the picker links to
  **Workspaces & bots** to create another. Each member has a removal control; the
  final member cannot be removed and unfinished work produces a recoverable error.
  Removal retains historical messages and author names, and the bot can be invited
  again. Bus thread members are read-only. Human `@name` invitation still works.
- **Members and activity.** The chat header lists every member and all of that member's current run states. The transcript keeps bot-name author attribution, and a handoff `system` message carrying a `THREAD_LINK_ATTACHMENT_MIME` attachment renders an internal **Open conversation** link to its bus thread.
- **Workspace file links (ADR-0014).** In human and bot messages, absolute `/work/` and `/home/` paths over `[A-Za-z0-9._\-/]` become file controls. Quoted or backtick paths containing spaces stay plain text because the Gateway rejects them. The authenticated download route serves current bytes only. Text preview is limited to 256 KiB of valid UTF-8 in `.txt`, `.md`, `.csv`, `.json` or `.log` and displays source text in an escaped `<pre>`; other files can still be downloaded. The page never executes file content or navigates to the file.
- **Turn budget.** A paused thread shows a banner explaining that a new human message resumes the conversation and resets the turn limit. A successful send removes the banner immediately.
- **Live detail.** `thread_members`, `thread_message` and `run_status` frames refresh the authoritative thread status and member list. A reconnect refreshes detail alongside missed messages, runs and approvals. Detail requests are ordered, so an older response that finishes late cannot reset newer membership or paused state.

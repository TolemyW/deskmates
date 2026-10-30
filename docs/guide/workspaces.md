# Workspaces and the shared computer

What it is: a workspace is a team of bots on one shared computer. The computer is one container
with one Chromium browser, one browser profile, one filesystem and one shell. Every bot in the
workspace uses all of it, the way coworkers share a machine.

Where you find it: the workspace switcher at the top of the sidebar picks the current workspace:
pinned and recently active workspaces, a search, **New workspace**, Trash and **Manage all
workspaces**. While a workspace is selected, Chats, Bots, Tasks, the board, Files, Connections,
Knowledge observations and Skills show only that workspace. **Computer** (System, Tune view) shows
the shared computer and its bots' desktops.

## The workspace directory

**Manage all workspaces** opens **Account settings → Workspaces**: every workspace you belong to,
with your role there, its bots, what is running and its last activity. Search by name or ID,
filter by **Show** (All, Pinned, Archived) and by **My role**, pin workspaces to the top, and page
through long lists. The search and filters are part of the address, so Back and reload return to
the same list.

Choosing a workspace and configuring it are separate actions on each row:

- **Enter** (not offered on archived rows) makes it your current workspace and opens its Chats.
  Deskmates first re-reads the workspace with your current access. If it has been archived in the
  meantime, you no longer have access, or the read fails, you stay where you were, in your current
  workspace, and the row says why. If you leave the list before the answer arrives, nothing
  switches.
- **Settings** (or the workspace's name) opens its settings page without changing your current
  workspace. **Back to workspace list** returns to the same search, filter and page. The page's
  header names the workspace and your role there; its ID is under a small **ID** disclosure.
  **Switch to this workspace** on that page selects it and opens its Chats, like Enter.

## Workspace settings

A workspace's settings are in four categories. Each section inside keeps its own **Save** or
**Cancel**, checks and confirmations; there is no page-wide Save, so saving the name never submits
a half-edited network policy. Switching category keeps unsaved edits in the other categories
until you leave the page or switch to another workspace. Members and Guests see the settings
read-only, with a note naming who can change each one.

| Category | Use view | Added in the Tune view |
|---|---|---|
| **Basic** | **Name** (**Change name**, **Save name**, **Cancel**) | |
| **Team & approvals** | **Approvals** (the approval mode, see [Approvals](approvals.md)), **People** in this workspace (see [People and roles](people-and-roles.md)), **Shared apps** (web apps published from this workspace) | |
| **Tools & network** | **Network policy**: open internet or **Only these sites**, and the allowed sites | **Internal network access**, **Execution limits** (relay cap, turn budget, model turns, continuations), **Working directories**, **Desktop tools**, **Web search** |
| **Lifecycle** | **Archive**: move the workspace to Trash, or restore it | |

A category's sections load the first time you open it.

## What the bots share

- **One browser, one login state.** Cookies, saved logins and site storage are shared. A human
  who logs in to a site once has logged in for every bot in the workspace.
- **One filesystem.** `/work` is shared working space. By default each bot starts work in its own
  directory `/work/bots/<bot>` and has a home directory `/home/<bot>`. A bot may read a teammate's
  directory but its file tools are stopped from writing into it, and `/work/uploads` (files people
  upload) is read-only to bots. This guards against mistakes, not against a script that writes
  there anyway. An Owner or Admin can switch a workspace to one shared `/work` under **Working
  directories** (Tune view); runs already started keep their setting.
- **One shell.** Any process environment in the container is visible to the bots.

This is the point of a workspace, not an accident. Group bots that should share logins and files;
split bots that should not.

## Choosing workspaces

Default grouping: one scenario, one workspace. A bot that browses untrusted sites never shares a
workspace with a bot that holds production credentials. The one exception is a workspace with the
desktop tools enabled, which they are by default on an image that provides them: it may hold a
signed-in account and also browse untrusted sites, a risk the owner accepted for such workspaces
only (ADR-0048); the workspace page shows a warning while the tools are on. If two jobs must not
share a login or a filesystem, create a second workspace (**New workspace** in the switcher). A
new trust domain costs one container.

## The board

**Board** (Work) holds notes for everyone in the workspace, Guests included. Anyone in the
workspace can post; the author edits or withdraws a post, and an Owner or Admin hides and unhides
it. Every change keeps a version. A post never starts a bot, whatever it mentions.

## Knowledge, Skills and Computer

These screens are in the Tune view. Old links still work: a Library link opens Knowledge ›
Documents, a Facts link opens Knowledge › Observations, and a Settings link opens Computer.

- **Knowledge › Documents**: reviewed documents the bots can search. Bots and Members propose;
  an Admin or Owner publishes, rejects and edits.
- **Knowledge › Observations**: what the bots of the selected workspace learned about this
  computer and the sites it reaches. Each row shows what was learned, who learned it and when; a
  **needs confirmation** badge marks an entry learned after reading untrusted content. Select a
  row for its source, validity, trust and versions; the **⋯** menu holds Edit, Versions, Undo,
  Confirm and Forget (an Admin's or Owner's). Items held for a human appear under **Waiting for
  review** with Approve and Reject, only when some wait. A bot's own experience is on its
  profile; see [Bots](bots.md).
  Observations that may have gone stale are rechecked in the background. A recheck renews an
  observation ("still true") only when it quotes a recent message from a shared chat, newer than
  the observation's last confirmation; a private chat, task status or a system notice never
  counts. Without such a quote the answer is "unclear" and the observation is left unchanged; a
  "possibly stale" answer goes to **Waiting for review**. An observation with several numbers (for
  example "target 280, replacing 300") is merged with the current one only when the wording is the
  same; otherwise the newer wording becomes current and the older one stays in its versions.
- **Skills**: see [Bots › Skills](bots.md#skills).
- **Computer**: what the bots here share, a link to change the allowed sites in workspace
  settings, and **Bots and desktops** with **Open desktop** for each bot. Opening the page never
  starts the workspace, takes control or changes anything.

## Archive and restore

Owners and Admins move a workspace to Trash from its settings (**Lifecycle → Archive**) or from
**Computer** (**Move workspace to Trash**). The confirmation explains that archiving immediately
cancels unfinished runs, ends human takeover, denies pending approvals, stops triggers and stops
the workspace's computer. Chats, history, files and browser data are retained; Trash has no
automatic deletion. Cancel leaves the workspace unchanged; a failed archive can be retried.

Restore an archived workspace from **Lifecycle → Archive → Restore workspace**, or from **Workspace
Trash** (the switcher's Trash entry, available even after the last workspace is archived). Restoring
does not replay missed messages or schedules and does not resume cancelled runs or denied
approvals. Members and Guests cannot view Trash or archive and restore workspaces. The web UI
offers no permanent deletion.

## Where bots may browse

A new workspace browses the open public internet unless its creator chooses **Only these sites**.
An open workspace may reach any public hostname, never a private address or an IP literal. It is
an untrusted-browsing workspace and holds no production credentials.

In a locked workspace, the first visit to a public site outside the list does not fail silently:
the bot asks in the chat with **Allow this site** (which adds the host to the list) or **Deny**.
Private addresses, IP literals and unreadable URLs are never asked for; they stay denied. See
[Approvals](approvals.md).

## Screens, watching and takeover

Each bot has its own screen region on the shared desktop (up to six bots per workspace). A bot's
profile shows its desktop card: **Start desktop** or **Open desktop** opens a live, view-only
picture of that bot's screen. Watching never interrupts the bots.

**Take control** (on a desktop) or **Take over** (in a chat header) gives you the mouse and
keyboard. Human takeover holds the whole workspace: while you hold it, browser work of every bot
in the workspace waits ("Waiting for the browser") and screenshots stop. Use it to log in to a
site, solve a captcha or fix something by hand, then press **Hand back**. A run waiting on the
browser continues after you hand back.

## Files

A message that names an absolute path under `/work/` or `/home/` turns into a link. Clicking it
downloads the file's current bytes (up to 1 MiB); small text files (`.txt`, `.md`, `.csv`,
`.json`, `.log`) can be previewed as plain text. Chat info lists the files mentioned in a chat. A
stopped workspace is reported, not started, by a download.

A file attached to a chat message has **Show in Files**, which opens Files at the file's folder
with the file selected; a bot's chat delivery that Files does not list opens with a note saying
so. In Files, a file sent in a chat you can read has **Sent in chat**, which opens that message.
Another person's private chat is never named there.

## What this cannot do

- Nothing inside a workspace is hidden from its bots: cookie database, other bots' transcripts,
  any process environment. Do not put a secret in a workspace a bot should not see.
- There is no access control between bots, by design. Bots are separated by `SOUL.md`, working directory,
  prompt and ledger attribution. These are soft distinctions, not security boundaries.
- Isolation escalates by workspace, never by bot. Anything that must not share a login or a
  filesystem goes in a second workspace.
- The egress list is enforced at the tool level and by the managed proxy. It is a guard rail, not
  isolation. The agent cannot edit the list; only Admins and Owners, and an answered
  **Allow this site** ask, change it.
- Takeover is workspace-wide. You cannot take one bot's screen while the others keep using the
  browser.
- A file link is a view of the file as it is now, not a frozen copy of what the bot wrote.
- Per-bot screens and takeover are merged and tested offline; actual browser review and
  current-image runtime acceptance are still pending (see the
  [M4 status ledger](../design/m4-status-2026-10-04.md)).

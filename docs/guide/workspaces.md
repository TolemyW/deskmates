# Workspaces and the shared computer

What it is: a workspace is a team of bots on one shared computer. The computer is one container
with one Chromium browser, one browser profile, one filesystem and one shell. Every bot in the
workspace uses all of it, the way coworkers share a machine.

Where you find it: the workspace switcher at the top of the sidebar picks the current workspace;
**Computer** (under Operate in the sidebar) shows its settings, and **Knowledge** and **Skills**
(under Resources) show what its bots know and can do. While a workspace is selected, Chats,
Contacts, Tasks, Integrations, Knowledge observations and Skills show only that workspace.

## What the bots share

- **One browser, one login state.** Cookies, saved logins and site storage are shared. A human
  who logs in to a site once has logged in for every bot in the workspace.
- **One filesystem.** `/work` is shared working space; each bot also has a home directory under
  `/home/<bot>`. Every bot can read every file.
- **One shell.** Any process environment in the container is visible to the bots.

This is the point of a workspace, not an accident. Group bots that should share logins and files;
split bots that should not.

## Choosing workspaces

Default grouping: one scenario, one workspace. A bot that browses untrusted sites never shares a
workspace with a bot that holds production credentials. If two jobs must not share a login or a
filesystem, create a second workspace from the switcher (**New workspace**). A new trust domain
costs one container.

## Knowledge, Skills and Computer

The former **Shared computer** screen is split by purpose (issue #27). Old links still work: a
Library link opens Knowledge › Documents, a Facts link opens Knowledge › Observations, and a
Settings link opens Computer.

- **Knowledge › Documents**: reviewed documents the bots can search. Bots propose; a human
  publishes. Admins and Owners review and edit; anyone can propose. Documents are shared by the
  whole team, not stored per workspace.
- **Knowledge › Observations**: what the bots of the selected workspace learned about this
  computer and the sites it reaches. Each row shows what was learned, who learned it and when; a
  **needs confirmation** badge marks an entry learned after reading untrusted content. Select a
  row for its source, validity, trust and versions; the **⋯** menu holds Edit, Versions, Undo,
  Confirm and Forget. Items held for a human appear under **Waiting for review** with Approve and
  Reject, only when some wait. A bot's own experience is on its profile; see [Bots](bots.md).
- **Skills**: see [Bots › Skills](bots.md#skills).
- **Computer**: the workspace's bot and allowed-domain counts, what bots here share, the
  **Allowed domains** editor, and the bots on this computer with a link to each bot's profile,
  where its screen and the takeover control are. Admins and Owners change the domains. Opening
  the page never starts the workspace, takes control or changes the list.

## Archive and restore

Owners and Admins can choose **Move workspace to Trash** on **Computer**. The confirmation
explains that archiving cancels unfinished runs, ends takeover, denies pending approvals and
stops triggers and compute. Chats, history, files and browser data are retained without automatic
deletion. Cancel leaves the workspace unchanged; a failed archive can be retried.

Open **Workspace Trash** from the workspace switcher or Computer to restore an archived
workspace. The entry remains available after the last workspace is archived. Restore selects the
workspace again but does not replay old messages or resume cancelled runs. Members cannot view
Trash or archive and restore workspaces. This screen does not offer permanent deletion.

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

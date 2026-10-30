# People and roles

What it is: who may use a workspace, and with which role. A person holds a role in each workspace
separately: someone can be Admin of one workspace, Member of a second and have no access to a
third. Screens and lists show only the workspaces you belong to.

Where you find it: a workspace's **Settings → Team & approvals → People** (from **Manage all
workspaces** in the workspace switcher), or **People** under System in the sidebar in the Tune
view. Both act on one workspace and show each person's role there. The sidebar footer shows your
name; in the Tune view your role in the selected workspace is shown next to it.

## The four roles

Each role includes everything in the columns to its left. The table follows the role rules the
Gateway enforces ([ADR-0022 amendments 6 and 7](../adr/0022-tenant-isolation-and-user-sessions.md));
screens hide or disable what your role cannot do and say which role can ("Only an Admin or Owner
of this workspace can ...").

| Action in a workspace | Guest | Member | Admin | Owner |
|---|---|---|---|---|
| See its bots, read its shared chats and the board, post on the board | yes | yes | yes | yes |
| Open a private chat with one bot | yes, answered by a status job | yes | yes | yes |
| Read runs, approvals, tasks, files, desktops, costs, memory and Knowledge | no | yes | yes | yes |
| Post in shared chats (group chats and a bot's own chat) | no | yes | yes | yes |
| Take over the browser | no | yes | yes | yes |
| Stop or continue a run | no | the runs they started | any | any |
| Answer an approval | no | **Allow once** or **Deny**, for runs they started | any answer, including **Always** and **Allow this site** | same |
| Propose Knowledge, acknowledge cost alerts, share published apps | no | yes | yes | yes |
| Create and edit tasks, start their work, request changes and accept a delivery | no | no | yes | yes |
| Create group chats, add or remove bots, wake a non-member bot by mentioning it | no | no | yes | yes |
| Create and change bots, their instructions, models, schedules and approval rules | no | no | yes | yes |
| Change workspace settings: name, network policy, approval mode, limits, tools, Trash | no | no | yes | yes |
| Curate memory, publish Knowledge, manage connections and cost rules | no | no | yes | yes |
| Invite, create, switch and remove Members and Guests; promote someone to Admin | no | no | yes | yes |
| Demote or remove an Admin; grant or remove Owner | no | no | no | yes |

Anyone who is Owner or Admin of at least one workspace may create a new workspace and becomes its
Owner. The last active Owner of a workspace can never be demoted or removed.

**Guests** read and leave notes; they never start a bot's tools. A Guest's private chat with a bot
is a status inquiry: it is answered by a short job with no tools, no browser and no files, which
sees only what the Guest may already read (bot names, recent shared chats, the board, task status).
A Guest's shared chats show a read-only notice instead of the message box.

## The root account

Every installation has one protected account with the login `admin`. It is Owner of every
workspace and the installation's maintainer, and cannot be demoted or removed. On a new Gateway it
is created with the password `admin`; its first sign-in shows **Change the default password** and
nothing else works until the password is changed.

## Private chats are private to their person

A private chat that a Member or Guest opens with a bot is readable only by that person, whatever
anyone else's role, the root included: its messages, runs, approvals and handoff cards do not
appear in anyone else's lists. Total costs still include its runs. This is a promise between
people in the product. It is not a boundary between bots: the bot works on the shared computer,
and other bots of the workspace can reach what it leaves there.

An Admin's or Owner's one-bot chat is that bot's shared chat, readable by the workspace.

## Invite someone

On **People**, under **Invite someone**, choose a **Role** (Guest, Member, or Admin) and one of
two ways. Nobody is ever made an Owner this way. There is no mail service: you send the link or the
login details yourself.

- **Invite by link** (recommended): press **Create invitation link**, then **Copy invitation
  link**. Whoever opens it chooses their own username, display name and password, or signs in
  with the account they already have to join. The link works once and expires after seven days;
  if it was used, revoked or has expired, the page says which. When single sign-on is set up,
  **How they sign in** can instead require the provider to confirm a specific email as verified.
- **Create account**: you choose the username. Deskmates generates an initial password and shows
  it once, with **Copy login details**. Ask the person to change it under **Account settings →
  Password**. A username that already exists is refused; invite an existing account by link.

Open invitations are listed below and can be revoked.

## Change or remove someone

The members table lists everyone in the workspace with their role there. An Admin switches people
between Guest and Member, promotes someone to Admin and removes Members and Guests; only an Owner
demotes or removes an Admin or grants Owner. Anyone may leave. A role change or removal takes
effect at once, including open event streams and desktop control.

## Your account

Select your photo and name in the sidebar footer (the photo alone in the compact sidebar and the
mobile header) to open **Account settings**. It has three pages: **Personal settings**,
**Workspaces** (the directory described in [Workspaces](workspaces.md#the-workspace-directory))
and **Agent access**. Every role can change its own account; nobody can change another person's
through it. Language, appearance and the Use/Tune view are not here; they are in **Preferences**
(see [Getting started](getting-started.md#preferences)).

**Personal settings** shows your saved values first; nothing is an open form until you ask:

- **Photo**: **Change photo** takes a PNG, JPEG or WebP image (larger photos are shrunk in the
  browser to fit 512 KB), shows a preview, and uses it only after **Save photo**; **Discard
  photo** keeps the current one. **Remove photo** returns to your initials.
- **Display name** is how your team sees you. **Change display name** opens the editor; **Save**
  stores it and returns to the saved value, **Cancel** discards the edit. If saving fails, your
  text stays in the editor so you can retry. Your **Login name** is shown separately and cannot be
  changed here.
- **Password** starts with a short explanation and **Change password**. The form (current
  password, new password, confirmation) exists only while you edit it; **Save password** changes
  it, **Cancel** clears and closes it. A successful change signs out your other devices, keeps
  this one signed in and clears the fields. A typing mistake (for example, passwords that do not
  match) keeps the form open; after a server or connection failure the password fields are
  cleared and you enter them again. Passwords are never kept in browser storage. An account that
  signs in only through single sign-on has no Deskmates password; its identity provider manages
  it.
- **Sign out** ends this browser's session. **Sign out on every device** ends all your sessions,
  this one included.

A later SSO sign-in never overwrites the display name or photo you saved. Deskmates never loads a
photo from your identity provider or any other web address.

**Agent access** connects an agent you run (Claude Code, or any agent that reads skills). An Admin
or Owner presses **Create agent key**: it makes a service principal named after you, with your
role, and shows its **One-time agent key** once. The key is not in the copied prompt: copy the
prompt with **Copy prompt** for the agent, and enter the key yourself through a local hidden-input
or secret-entry flow, never in a chat. A lost key means a new one; an Admin disables the old one
under **People**. A Member sees the same prompt and asks an Admin for a key. See
[Using Deskmates from another agent](using-deskmates-from-another-agent.md).

## Sign-in and sessions

- Password sign-in, and single sign-on through an OIDC provider when the maintainer has set one
  up. When SSO is required, sign in with that provider.
- You stay signed in on a browser until you sign out or the session expires.
- Deskmates runs one team (the Default Tenant); there is no team switcher.

## What this cannot do

- Roles control people, not bots. Inside a workspace there is no access control between bots;
  bots are separated by `SOUL.md`, working directory, prompt and ledger attribution. These are
  soft distinctions, not security boundaries.
- A private chat is hidden from other people, not from the bots of its workspace. To keep
  something from a bot, put it in a different workspace.
- The people who manage a workspace cannot open a Member's private chat to diagnose it; only its
  person can, and aggregate usage still counts it.
- Maintenance of the installation (users' passwords, SSO providers, backup, restore) has no screen;
  it is done with the command line on the Gateway host.
- The shared operator token acts as an Owner with no person behind it. Do not hand it to people;
  invite them instead.
- Exposing a second team (tenant) is not accepted and not offered; see
  [ADR-0022](../adr/0022-tenant-isolation-and-user-sessions.md) and the
  [M4 status ledger](../design/m4-status-2026-10-04.md).

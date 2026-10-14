# Getting started

What it is: the first half hour with Deskmates. You sign in, create a workspace (a team of bots on
one shared computer), add a bot, and talk to it in a chat.

## Sign in

Open the operator UI in a browser. The sign-in page asks for a login name and password, and shows
**Sign in with ...** buttons when your team uses single sign-on (SSO).

- **No account exists yet.** On a new Gateway the sign-in page says so. The person who maintains
  the Gateway creates the first Owner on its host with `auth-cli bootstrap-owner` (see the
  [stable release runbook](../runbooks/stable-release.md)). Nobody can create the first account
  from the browser.
- **You were invited.** Open the invitation link you were sent. It names the team and your role.
  A link for a new account asks for your name and a password; a link for an existing account is
  accepted from that account's own session; an SSO link continues at your identity provider.
  A link works once.
- **You stay signed in** on that browser across reloads and restarts until you sign out or the
  session expires. Select your photo and name at the bottom of the sidebar to open **Account
  settings**: **Sign out** there ends this browser's session, **Sign out on every device** ends
  all your sessions. Your language and light or dark appearance are under **Preferences** on the
  same page.

## Roles in brief

Everyone belongs to a team (a tenant) with one role:

- **Member**: chats, tasks, approvals, desktops, memory curation. Sees everything in the team.
- **Admin**: also creates and changes workspaces and bots, approval rules, connectors,
  integrations and cost alert rules, and invites Members.
- **Owner**: also changes any role and invites Admins.

Screens hide or disable what your role cannot do and name the role that can. The full table is in
[People and roles](people-and-roles.md).

## The first-run checklist

Owners and Admins see a checklist on the home screen until they dismiss it:

1. Create a workspace
2. Create a bot
3. Open a chat
4. Invite a person

Each item is ticked from what already exists in your team, not from clicks, so it stays correct
if someone else did the step. Dismissing it is remembered for your account on every browser.
Members do not see it.

## Your first workspace

A workspace is a team of bots on one shared computer. Everything a bot does in the browser or the
shell, every other bot in the same workspace can see.

- With no workspace at all, the **Chats** screen shows a **First run** form: name the workspace,
  choose where its bots may browse, name the first bot, and press **Create workspace, bot and
  thread**. A chat with that bot opens right away.
- Later workspaces come from the workspace switcher at the top of the sidebar (**New workspace**).

Where its bots may browse is chosen when you create it: **Open public internet** (the default) or
**Only these sites**. An open workspace is an untrusted-browsing workspace and should hold no
production credentials. See [Workspaces and the shared computer](workspaces.md).

## Your first bot

Bots are listed under **Contacts**. **New contact** asks for a handle (the name people
`@mention`, letters, digits, `_` and `-`), a one-line role and an avatar. The role is a label.
What the bot actually does is set by its instructions, written on its profile under
**Instructions & settings** (its `SOUL.md`). Saving takes effect on the next run. See
[Bots](bots.md).

## Your first chat

Open **Chats** and start a new chat: pick one bot for a private chat, or several for a group.
Adding bots never starts a run; the first message does. Type a message and press Enter.

While the bot works you see its replies in the chat. If it wants to do something with an outside
effect (submit a form, send a message, export data), it stops and asks in the chat; see
[Approvals](approvals.md). Each reply links to its run, where every step is recorded.

## What this cannot do

- There is no self-service sign-up. The first Owner is created on the Gateway host; everyone else
  needs an invitation or an account made by the maintainer.
- There is no mail service. You deliver invitation links yourself.
- The checklist is guidance. Dismissing it changes nothing about what you may do, and it is not
  shown to Members.
- A bot's role, handle and avatar are labels. Bots are separated by `SOUL.md`, working directory,
  prompt and ledger attribution. These are soft distinctions, not security boundaries. Anything
  that must not share a login or a filesystem goes in a second workspace.

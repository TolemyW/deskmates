# Getting started

What it is: the first half hour with Deskmates. You sign in, create a workspace (a team of bots on
one shared computer), and talk to its assistant, which sets up the first teammates with you.

## Sign in

Open the operator UI in a browser. The sign-in page asks for a login name and password, and shows
**Sign in with ...** buttons when single sign-on (SSO) is set up.

- **A new Gateway.** The installation creates one protected account, login `admin`, password
  `admin`. Its first sign-in shows **Change the default password**; nothing else works until you
  choose a new one. The maintainer may instead create it on the host with
  `auth-cli bootstrap-owner`, typing the password there (see the
  [stable release runbook](../runbooks/stable-release.md)). Nobody can sign up from the browser.
- **You were invited.** Open the invitation link you were sent. It names your role. A link for a
  new account asks for your name and a password; a link for an existing account is accepted from
  that account's own session; an SSO link continues at your identity provider. A link works once.
- **You stay signed in** on that browser across reloads and restarts until you sign out or the
  session expires. Select your photo and name at the bottom of the sidebar to open **Account
  settings**, where **Sign out** and **Sign out on every device** are.

## The sidebar

The sidebar has the workspace switcher at the top, the navigation in the middle and a fixed footer.

- **Work**: **Chats**, **Tasks**, **Approvals** (its badge counts pending requests), **Bots** and
  **Board**, in the order of everyday work.
- **Resources**: **Files** and **Connections** (chat channels and apps), and in the Tune view
  **Knowledge** and **Skills**.
- **System** (Tune view only): **Computer**, **Costs**, **Analytics**, **Vault**, **People** and
  **Network**, as your role allows.
- **Footer**, always in reach: connection state and release, **Help**, **Preferences**, then your
  photo and name (and, in the Tune view, your role).

Only the navigation scrolls; the footer stays put. **Collapse navigation** (or dragging the edge,
or the keyboard on the edge) turns the sidebar into an icon rail with the same destinations and
their names as tooltips; **Expand navigation** brings the labels back. Deskmates remembers your
choice and width in this browser. On a narrow window an expanded sidebar stays labelled and only
gets narrower, then returns to your width when there is room again. On a phone the sidebar is a
menu behind **Open menu** and does not change that choice. Exactly one destination is highlighted:
the screen you are on.

## Preferences

**Preferences** in the sidebar footer (a sliders icon, with **Use** or **Tune** beside it) opens
one dialog for every role, in the expanded, compact and phone sidebar alike:

- **Language** changes the interface at once and is saved to your account, so it follows you to
  any browser. If saving fails, the previous language comes back.
- **Appearance** is **Use system setting**, **Light** or **Dark**, kept in this browser only.
- **Tune view** switches between the two views below, kept in this browser only.

Opening Preferences does not move you or change anything; closing it returns you where you were,
with your unsent message intact.

## Use and tune

The everyday **Use** view shows what you need to work with the bots: chats, tasks, approvals, bots,
the board, files and connections. The **Tune** view adds the operations screens (Knowledge, Skills,
Computer, Costs, Analytics, Vault, People, Network), every bot and workspace setting, and
diagnostics: technical details in chat history, run timelines and logs.

The view only changes what is shown. A hidden screen still opens from its link, and your role
decides what you may do in either view. Switching does not change the sidebar's width or reload
the chat you are in. What chat history shows in each view is in
[Chats and groups](chats-and-groups.md#what-chat-history-shows).

## Roles in brief

You hold a role in each workspace separately:

- **Guest**: reads the workspace's shared chats and the board, posts on the board, and can ask a
  bot about status in a private chat.
- **Member**: also works with the bots: posts in shared chats, opens private chats, reads runs,
  tasks, files and costs, answers approvals of the runs they started.
- **Admin**: also creates and changes bots, group chats, tasks and workspace settings, and invites
  people.
- **Owner**: also manages Admins and Owners.

Screens hide or disable what your role cannot do and name the role that can. The full table is in
[People and roles](people-and-roles.md).

## The first-run checklist

Owners and Admins see a **First steps** checklist on the home screen until they dismiss it:

1. Create a workspace
2. Chat with the assistant to set up your team (in a workspace without an assistant: Create a bot,
   then Open a chat)
3. Invite a person

Each item is ticked from what already exists, not from clicks, so it stays correct if someone else
did the step; the assistant step is ticked once the workspace has a second bot. Dismissing it is
remembered for your account on every browser. Members and Guests do not see it.

## Your first workspace

A workspace is a team of bots on one shared computer. Everything a bot does in the browser or the
shell, every other bot in the same workspace can see.

- With no workspace at all, **Chats** shows a **First work** form: name the workspace, choose
  where its bots may browse, and press **Create workspace**. The assistant's private chat opens
  right away.
- Later workspaces come from the workspace switcher at the top of the sidebar (**New workspace**),
  available to anyone who is Owner or Admin of a workspace. New workspace also opens the new
  assistant's chat.

Where its bots may browse is chosen when you create it: **Open public internet** (the default) or
**Only these sites**. An open workspace is an untrusted-browsing workspace and should hold no
production credentials. See [Workspaces and the shared computer](workspaces.md).

## Your assistant and first teammates

Every new workspace comes with a default bot named `assistant`, marked **Default** in the Bots list.
Its first message shows you around in your language and asks what a first teammate should do.
Describe the work in plain words: the assistant creates the bot at once, asks two or three short
questions and applies your answers to the new bot's role, instructions and schedules. For joint
work it can open a group chat with the bots it names. Each change is posted as a note in the chat
("@assistant created @reporter ...") and recorded in the audit log, and can be undone (Trash for
a bot, an earlier saved version for instructions).

The assistant cannot change a bot's model, connectors, approval rules, Vault access, name or
pause, and never changes itself; those stay with an Owner or Admin on the bot's profile. An Owner
or Admin can make another bot the default with **Make default** on its profile.

You can also create bots yourself: **Bots** in the sidebar, then **New Bot**: a handle (the name
people `@mention`, letters, digits, `_` and `-`), a one-line role and an avatar. The role is a
label; what the bot actually does is set by its instructions (its `SOUL.md`) on its profile. Saving
takes effect on the next run. See [Bots](bots.md).

## Your first chat

Open **Chats** and start a new chat: an Owner or Admin picks one bot for a private chat or several
for a group; a Member or Guest opens a private chat with one bot. Adding bots never starts a run;
the first message does. Type a message and press Enter.

While the bot works you see its replies in the chat. If it wants to do something with an outside
effect (submit a form, send a message, export data), it may need approval; see
[Approvals](approvals.md). Each reply has a **Details** link to its run, where every step is
recorded.

## What this cannot do

- There is no self-service sign-up. Everyone except the root account needs an invitation or an
  account made by an Admin or Owner.
- There is no mail service. You deliver invitation links yourself.
- The checklist is guidance. Dismissing it changes nothing about what you may do.
- The assistant creates bots without asking for confirmation, by the owner's decision. Anything
  that can wake it (your message, another bot's mention, a chat-channel sender) can lead it to
  create or edit bots. Its changes are audited, announced in the chat and reversible, but it is
  not a gatekeeper.
- A bot's role, handle and avatar are labels. Bots are separated by `SOUL.md`, working directory,
  prompt and ledger attribution. These are soft distinctions, not security boundaries. Anything
  that must not share a login or a filesystem goes in a second workspace.
- The assistant's instructions and welcome are a starting strategy; whether they improve results
  has not been measured, and they have not been accepted with a real model on a deployment.

# Approvals

What it is: some actions a bot may not take on its own. Before an action with an outside effect
(submitting a form, sending a message, clicking Export, writing to a SaaS app) the bot stops and
asks in the chat. A person, or another member of the chat, answers.

Where you find it: the request appears in the chat as a system message with buttons. **Approvals**
in the sidebar collects every pending request across chats and bots; its badge shows the count.
Deciding in Approvals is the same as deciding in the chat. Once decided, the request and its
decision leave the everyday (Use) chat history and stay visible in the Tune view.

## Who answers: the workspace's approval mode

An Owner or Admin chooses, in the workspace's **Settings → Team & approvals → Approvals**, who
answers a request that needs approval. A stored rule (**Always**) answers before any of them.

- **Automatic review** (the default for a new workspace): an independent AI reviewer answers
  first, including scheduled work and browser actions, so bots do not wait for someone to be
  online. Deleting, changing permissions, opening new sites and actions that carry credentials
  still wait for a person. Every decision is recorded.
- **Ask a person**: every request waits for a person or a teammate bot in the chat.
- **Approve all**: every action that would ask is allowed without asking anyone, including
  deletions, permission changes and new sites, and a bot that reaches its turn limit continues on
  its own. Each allowance is recorded as decided by the mode. The workspace shows an **Approve
  all** badge while it is on.

No mode lifts the hard denies: private addresses, IP literals, cloud metadata addresses, other
workspaces and secret redaction stay blocked. The budget and the loop breaker still apply.

## Risk tiers

Every tool call is classified before it runs:

- **L0, read-only** (reading a page, listing files): allowed.
- **L1, reversible writes** (writing a file in the workspace): allowed.
- **L2, external side effects** (anything that leaves the workspace and may not be undone): asks.

A request shows the proposed action, its arguments and the instruction the bot was given. It never
shows page content.

## What happens while you decide

- **Short wait.** The bot waits a short time for an answer. If you answer, it carries on.
- **Park.** If nobody answers in that window, or nobody is online, the run is parked: it stops
  and its session is saved. The request stays in the chat and in Approvals.
- **Resume.** When someone answers later, even hours later, the parked run resumes from where it
  stopped. A parked run holds its chat until it is decided.

## Answers

- **Allow once**: this action, this time.
- **Always**: allow it now and store a rule for this bot, so matching calls are allowed without
  asking. The confirmation shows the rule's scope (tool, origin, arguments). Admins and Owners
  read and remove rules on the bot's profile under **Approval rules**; a stored rule answers
  before the chat is asked.
- **Deny**, with an optional reason the bot reads.
- **Tell it what to do instead**: posts your message to the bot so it rethinks without taking the
  action.

Any member of the chat may decide: a human from the UI, or a bot through `approval_decide`.
Among people, an Owner or Admin may give any answer to any request. A Member answers only
requests of the runs they started, with **Allow once** or **Deny**; **Always** and **Allow this
site** are an Owner's or Admin's. Guests do not see approvals. Only Admins and Owners create, edit
and delete rules.

## New-site asks

In a workspace locked to **Only these sites**, a first visit to a public site outside the list
asks with **Allow this site** (adds the host to the workspace's list), **Deny**, or **Tell it
what to do instead**. There is no allow-once for a site. Private addresses, IP literals and
unreadable URLs are never asked for; they stay denied. See [Workspaces](workspaces.md).

## Continuation asks

A run that runs out of turns asks its delegator **Continue** or **Stop** (shown as "Turn limit
reached"). No answer in 24 hours means Stop. See [Chats and groups](chats-and-groups.md).

## Integration actions

A request for a Google Drive write shows a preview of the proposed action as plain text: the
connection, the target, and the outgoing content and parameters, with a note when the preview is
truncated. See [Connections](integrations-and-connectors.md).

## What this cannot do

- A deciding bot is a soft boundary like SOUL and grouping, not a security boundary. Any member of
  the chat may decide, including a bot member. If a bot must never approve another bot's action,
  the two belong in different workspaces.
- An Always rule is per bot and stays until an Admin or Owner deletes it.
- The agent cannot edit the egress list. Only Admins and Owners, and an answered
  **Allow this site** ask, change it.
- Approvals do not stop a bot from reading anything in its workspace; L0 and L1 never ask.
- Approvals from WhatsApp are Allow once or Deny only; see [Channels](channels.md).

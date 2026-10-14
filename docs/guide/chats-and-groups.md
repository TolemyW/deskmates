# Chats and groups

What it is: a chat (a thread) is a conversation in one workspace with a list of bot members. A
chat with one bot is a private chat; with several it is a group. The Gateway keeps the
transcript; each bot is woken with the messages it has not seen yet.

Where you find it: **Chats** in the sidebar. The left rail lists the chats of the current
workspace; the right panel (**Members and chat info**) shows members, task notes, files mentioned
and approvals asked in that chat.

## Start a chat

Press the new-chat button in the rail. Pick one bot for a private chat or several for a group,
and optionally name it. Adding bots never starts a run; the first message does. From a contact,
**Message** opens that bot's private chat. You can add bots to an existing chat from its member
list.

## Who answers

- **Mention a bot** with `@name` and it wakes. Mention several and they wake in parallel.
- **`@everyone`** wakes every member in turn. A bot may stay silent if it has nothing to add.
- **No mention:** the message is offered to one member at a time, starting with the chat's
  owner, until one takes it. The bot that takes it becomes the owner and is offered the next
  unaddressed message first. The member list marks the owner.
- A bot's message without a mention wakes nobody. A bot hands work to a teammate by mentioning
  it; the owner is told how each delegated piece ended.
- Every group wake names the members and their roles, so bots know who does what.

In a private chat, a bot may address a bot that is not a member. If its settings allow messaging
that bot, the work is handed to a separate bot-to-bot thread and the result comes back to your
chat; otherwise the chat shows a visible note that nothing was delivered.

## Lanes

Each bot has two lanes and runs at most one run per lane at a time:

- **Interactive**: messages in a chat (by a human or a bot) and approval replies.
- **Background**: schedules, webhooks, and bot-to-bot threads (shown as "Bots talking").

The lane follows the chat, not who posted. All bots in a workspace share one browser lock, so
browser work runs one bot at a time per workspace.

## Limits that stop runaway exchanges

- **Relay count (5):** how deep a chain of bot messages may grow from one human message (A wakes
  B wakes C ...). Past it, a message is still stored but wakes nobody.
- **Turn budget (8 per chat):** how many bot messages a chat may take since the last human
  message before it pauses. Chat info
  shows the budget and whether the chat is active or paused. A paused chat shows a banner; send a
  new message to resume it and reset the limit.
- **Turns inside a run:** a run that runs out of model turns is parked, not failed. The bot is
  warned first and writes a handoff. Whoever delegated the work is asked **Continue** or **Stop**
  (an approval of its own, see [Approvals](approvals.md)); no answer in 24 hours means Stop. A run
  can be continued twice.

## Runs

Every trigger creates a run first. Replies link to their run; the run screen shows status, each
tool call and result, screenshots, token usage per model, and **Progress and intervention**:
attempts, continuations, context size and cache use. Missing measurements mean unknown, not zero.
A run that has not finished can be cancelled, from **Cancel run** on its run screen or from
**Stop** above the composer of the chat it belongs to.

### Stop in a chat

While a bot works on a chat, a **Stop** button above the composer names the bot and the run's
status, for example "Stop ops (running)". Several unfinished runs show one Stop each, so you
pick exactly which run ends. Stop asks first and says what it does:

- **Stops:** only that one run. It is marked cancelled at once, its pending approvals are closed
  and it can no longer act through the Gateway. The chat shows it as cancelled.
- **Does not stop:** other bots, any other run of the same bot (including messages queued behind
  it in this chat), the chat itself or the workspace. A message you send afterwards starts a new
  run. There is no "stop everything" button.
- Work already under way in the workspace, such as a command or a browser step, may take a few
  seconds to end.

If the run finished before your Stop arrived, the chat says nothing was cancelled. A Member sees
Stop only in a side chat they opened; elsewhere a note says which role can cancel.

## What this cannot do

- Membership is routing, not access control. A bot that is not a member of a chat can still read
  the workspace's files and transcripts on the shared computer.
- The owner is a routing fact, not a permission. Being owner means being asked first, nothing
  more.
- A bot cannot add members to a chat. Mentioning a non-member in a group does not invite it.
- The caps stop loops; they are not a cost budget. See [Costs](costs.md).
- Runs that need the browser wait for each other within a workspace. More bots in one workspace
  do not browse in parallel.
- Group routing, delegation and continuation are tested offline; real-model and runtime
  acceptance are still pending (see the [M4 status ledger](../design/m4-status-2026-10-04.md)).

## Recover an unsent message

A temporary connection failure keeps the selected chat and offers **Retry**; reconnecting also
refreshes it. Recovery does not send a message. A small unsent draft can survive a refresh in the
same browser tab after Deskmates confirms your session and access to that chat. Drafts are separate
for each person, team, workspace and chat, and are cleared when you sign out or switch teams.

The reload copy expires two hours after its last save. It keeps at most 20 recent drafts, with
32,768 UTF-16 units per draft and 131,072 units for the combined stored JSON. Older entries are
evicted first; oversized drafts and drafts when browser storage is unavailable remain in memory
only. Keep an external copy of work that needs longer retention. Browser session restore may
retain tab storage within that limit; this is not a promise to recover after closing or restarting
the browser. The reload copy contains plain text in this tab's browser storage, not on the Gateway.

Starting a send removes that text from the reload copy. Pending and failed sends stay in the
current page only: a refresh never queues or repeats them. Check the transcript before retrying
an uncertain send. Text you type while an earlier send finishes remains your separate new draft.

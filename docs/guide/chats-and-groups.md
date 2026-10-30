# Chats and groups

What it is: a chat (a thread) is a conversation in one workspace with a list of bot members. A
chat with one bot is a private chat; with several it is a group. The Gateway keeps the
transcript; each bot is woken with the messages it has not seen yet.

Where you find it: **Chats** in the sidebar. The left rail lists the chats of the current
workspace, pinned chats first, then by recent activity; a chat whose last message is a system
notice shows a neutral **Open conversation** preview instead of protocol text. The right panel
(**Members and chat info**) shows members, task notes, files mentioned and approvals asked in that
chat.

## Start a chat

Press the new-chat button in the rail. An Owner or Admin picks one bot for a private chat or
several for a group, and optionally names it, and can add bots to an existing chat from its member
list. A Member or Guest opens a private chat with one bot; it is readable only by them (see
[People and roles](people-and-roles.md#private-chats-are-private-to-their-person)). Adding bots
never starts a run; the first message does. From a bot in **Bots**, **Message** opens its chat.

A Guest cannot post in shared chats; they show a read-only notice instead of the message box. A
Guest's own private chat is answered by a status job with no tools, which knows only what the Guest
may already read.

## Who answers

- **Mention a bot** with `@name` and it wakes. Mention several and they wake in parallel.
- **`@everyone`** wakes every member. Under **How members answer this message** you choose
  **Parallel** (all at once, the default) or **One by one**. A bot may stay silent if it has
  nothing to add.
- **No mention:** the message is offered to one member at a time, starting with the chat's
  owner, until one takes it. The bot that takes it becomes the owner and is offered the next
  unaddressed message first. The member list marks the owner.
- A bot's message without a mention wakes nobody. A bot hands work to a teammate by mentioning
  it; the owner is told how each delegated piece ended.
- Every group wake names the members and their roles, so bots know who does what.

In a private chat, a bot may address a bot that is not a member. If its settings allow messaging
that bot, the work is handed to a separate bot-to-bot thread and the result comes back to your
chat; otherwise the chat shows a visible note that nothing was delivered.

## What chat history shows

Chat history keeps every message, run and record; the two views of the interface
([Getting started](getting-started.md#use-and-tune)) only decide what is shown. Switching views
keeps the chat, its scroll position and your unsent message, and sends nothing.

**In the Use view** (the default) a chat reads like a conversation:

- **Always shown:** people's and bots' messages and the files they delivered; approvals still
  waiting for an answer (or still loading); the Stop, paused-chat, queue and send-error controls.
- **Shown until the conversation moves on:** a short note when no member replied to a request,
  when the addressed bot is paused, or when a handoff was not delivered. The note disappears once
  anyone writes a later message.
- **A failed, stopped or cancelled reply** stays as a card with a short reason, for example "The
  selected model is unavailable or access was refused" or "This reply could not be completed. Open
  the work details to see why." The card goes away only when you send a newer message, or when the
  same bot retries the same request or round and that retry is running or has succeeded. Another
  bot succeeding, a silent ending or a background summary job never clears it, and hiding an old
  failure never claims it succeeded.
- **Left out:** approvals already decided and their decision notes, routine system notices,
  "handed off" process lines, cards for the bot's work in other chats, and technical error text.

The member list in the header uses the same rule: a bot shows **failed**, **stopped** or
**cancelled** only while that failure is current, otherwise **Ready** or what it is doing now. A
link to a specific message always shows it, even one that Use normally leaves out.

**In the Tune view** everything is shown: system notices with their original wording, decided
approvals, earlier failures, activity elsewhere, and on run and handoff cards a **Technical
details** toggle with the original recorded text (the full error and stack trace, or the
Gateway's protocol notice).

### Reading long replies

- Every bot reply has its own card and author. **To** labels name the bots it addressed (from the
  actual mentions, not guessed from the text).
- The newest message, when a bot wrote it, has a **Latest reply** badge. It means newest, not final
  or correct; a new question from a person removes it.
- Long replies fold into a literal **Excerpt** (the beginning of the text, not a summary) with
  **Read full reply**; **Collapse** folds it again. A reasonably sized latest reply stays open,
  and a reply is never folded when the excerpt would hide a fifth of it or less, measured by how
  much room it takes on screen.
  Expanding does not jump the scroll, and your choice survives new messages until you reload.
- Each reply's **Details** link opens its run.

### Handoffs between chats

When a bot in your private chat hands work to a bot outside the chat (see
[Who answers](#who-answers)), the work happens in a separate conversation between the bots,
marked **Bot collaboration**. Your chat shows the result as "*name* returned a result" with
**Reply from *name*** and the quoted reply as plain text, plus **Open collaboration** to see the
whole exchange. A failed or stopped handoff follows the failure rule above; a handoff that was not
delivered shows its short note. Opening a bot collaboration shows a banner: requests and results
appear there, and you follow up in your private chat with a bot. On a bot's Activity, runs started
by such conversations are labelled **Bot collaboration**; real scheduled work keeps **Scheduled
work**.

## Lanes

Each bot has two lanes and runs at most one run per lane at a time:

- **Interactive**: messages in a chat (by a human or a bot) and approval replies.
- **Background**: schedules, webhooks, and bot-to-bot conversations (listed as "Bots talking";
  their runs are labelled "Bot collaboration").

The lane follows the chat, not who posted. All bots in a workspace share one browser lock, so
browser work runs one bot at a time per workspace.

## Limits that stop runaway exchanges

- **Relay count (5):** how deep a chain of bot messages may grow from one human message (A wakes
  B wakes C ...). Past it, a message is still stored but wakes nobody.
- **Turn budget (off by default):** when an Owner or Admin turns it on under **Execution
  limits** (Tune view), how many bot messages a chat may take since the last human message before
  it pauses. Chat info shows the budget and whether the chat is active or paused. A paused chat
  shows a banner; send a new message to resume it and reset the limit, or wait for the configured
  minutes until it resumes by itself.
- **Loop breaker (always on):** a chain deeper than 50 hops wakes nobody, and a bot's third
  identical message pauses the chat.
- **Turns inside a run:** a run that runs out of model turns is parked, not failed. The bot is
  warned first and writes a handoff. Whoever delegated the work is asked **Continue** or **Stop**
  (an approval of its own, see [Approvals](approvals.md)); no answer in 24 hours means Stop. A run
  can be continued twice.

## Runs

Every trigger creates a run first. Replies link to their run (**Details**); the run screen shows status, each
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

### Find and audit runs

A run opens as a panel over the screen you were on: from a reply's **Details** link, from a bot's
**Activity** tab, or from the **Activity** section of chat info (Tune view). Closing the panel
returns you where you were. There is no separate list of all runs in the web UI; the operator API
(`GET /api/runs`) lists the runs of your workspaces with filters by status, bot, lane, time,
failure class and words in the error, for example for an external agent. A failed run shows its
failure class, the Gateway's reading of the error (for example "Model unavailable" when the model
or its upstream is missing or down); "Other" means no rule matched.

The run screen's **What this run changed** lists what the run learned (and whether each item was
trusted), the files it changed, the sites it visited, the memory it wrote and was given, the
approvals it asked for and their decisions, the task checkpoints and artifacts it recorded, and
the model, skills and SOUL version it ran with.

An Owner or Admin can **Mark as wrong**, with an optional note, on the run screen or on its
Activity card. While the mark stands, nothing the run learned is used when the bot's experience
is consolidated; memory the run already wrote stays until you forget or edit it. **Unmark**
undoes it. A finished run also offers **Save as replay fixture**: the command a developer runs to
save it as a replay test.

An installation may prune old runs' event logs (`RUN_EVENTS_RETENTION_DAYS`); a pruned run keeps
its row, summary and costs and says when it was pruned.

## What this cannot do

- Membership is routing, not access control. A bot that is not a member of a chat can still read
  the workspace's files and transcripts on the shared computer.
- The owner is a routing fact, not a permission. Being owner means being asked first, nothing
  more.
- A bot cannot add members to a chat. Mentioning a non-member in a group does not invite it.
- The caps stop loops; they are not a cost budget. See [Costs](costs.md).
- Runs that need the browser wait for each other within a workspace. More bots in one workspace
  do not browse in parallel.
- The Use view hides history, it never repairs it: a hidden failure is still a failure in Tune
  and on the run. The Use and Tune history rules were checked with the bundled mock Gateway and a
  local replay of recorded runs, not yet on a deployment.
- Group routing, delegation and continuation are tested offline; real-model and runtime
  acceptance are still pending (see the [M4 status ledger](../design/m4-status-2026-10-04.md)).

## Recover an unsent message

A temporary connection failure keeps the selected chat and offers **Retry**; reconnecting also
refreshes it. Recovery does not send a message. A small unsent draft can survive a refresh in the
same browser tab after Deskmates confirms your session and access to that chat. Drafts are separate
for each person, workspace and chat, and are cleared when you sign out.

The reload copy expires two hours after its last save. It keeps at most 20 recent drafts, with
32,768 UTF-16 units per draft and 131,072 units for the combined stored JSON. Older entries are
evicted first; oversized drafts and drafts when browser storage is unavailable remain in memory
only. Keep an external copy of work that needs longer retention. Browser session restore may
retain tab storage within that limit; this is not a promise to recover after closing or restarting
the browser. The reload copy contains plain text in this tab's browser storage, not on the Gateway.

Starting a send removes that text from the reload copy. Pending and failed sends stay in the
current page only: a refresh never queues or repeats them. Check the transcript before retrying
an uncertain send. Text you type while an earlier send finishes remains your separate new draft.

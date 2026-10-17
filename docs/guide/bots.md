# Bots

What it is: a bot is a named teammate in one workspace. It has a handle people `@mention`, a
one-line role, written instructions, memory, a model and optional schedules. Each time it is
woken (a message, a schedule, an approval answer, another bot's mention) it does one run on the
workspace's shared computer.

Where you find it: **Contacts** in the sidebar lists the bots of the current workspace, the way a
messaging app lists people, with what each one is doing now. A contact opens its private chat or
its profile.

## Create a bot

Admins and Owners press **New contact** in Contacts. Give it a handle (letters, digits, `_`, `-`),
a role such as "Reads dashboards and reports KPI changes", and optionally an avatar. Then open its
profile and write its instructions. Members see who can do this instead of the button. Everything
but the workspace can be changed later
([ADR-0043](../adr/0043-bot-editable-after-creation.md)).

## The profile

A bot's profile has four tabs.

- **Activity**: its desktop card (see [Workspaces](workspaces.md)), an **At a glance** card
  (model, schedules, connectors, last status) and recent activity: finished tasks, runs that
  ended without a reply, runs waiting for an approval or for the browser, runs that ran out of
  turns. Each item links to its run details.
- **Experience**: what the bot learned from its own work: how a site behaves, which approach
  worked, what to avoid. After a task ends, its notes are consolidated into these entries in the
  background, and every later run reads them first. Each entry names where it came from. An entry
  learned after reading untrusted content, or one that reads like an instruction, waits under
  **Needs your confirmation** until a person confirms it. You can edit, forget and undo entries.
- **Your notes**: the bot's `MEMORY.md`, a plain file Admins and Owners edit, with its saved
  versions, and the bot's diary (below).
- **Settings**: profile and pause, instructions, model, schedules, approval rules and **Try it**.

## Profile and pause

**Profile** changes what used to be fixed at creation: the handle, the role, the connectors, which
teammates the bot may hand work to with `message_bot`, and the reasoning effort and thinking
settings (leave them on Default unless you are tuning the model). Every change takes effect on the
bot's next run; a run in progress keeps what it started with.

A rename keeps the handle rules (letters, digits, `_`, `-`, unique in the workspace). It moves the
bot's home folder `/home/<name>` (instructions, notes, diary, past sessions) and its working
folder `/work/bots/<name>` to the new name, renames its private chat, and updates every teammate
that may message it. It waits until the bot has no run in progress or waiting for an approval, and
it is refused if a folder with the new name already holds files. Old messages keep the old name in
their text.

**Pause** stops a bot from being woken without ending anything. While it is paused, its schedules
are skipped (its chat says so once), webhooks are refused so the sender can retry, and a message
that mentions it or would be offered to it leaves a note in the chat instead; in a group, the next
awake member is asked. A run in progress finishes, a run waiting for an approval keeps waiting, and
work that was already queued waits for **Resume**. Nothing is cancelled or denied, which is the
difference from Trash. Messages it missed are read the next time it is woken after resuming.

## Instructions (SOUL.md)

The instructions are the bot's `SOUL.md`, plain Markdown saying who it is and how it works. This
is the one text that changes its behaviour; the role on the profile is only a label. Saving takes
effect on the next run, which starts a fresh session. You can save while the bot is working or
waiting for an approval: the run in progress keeps the instructions it started with, the editor
says the change applies from the next run, and the next run (or the waiting run's next step after
an approval) uses it. If someone else saved in the meantime, the editor shows the latest version
and lets you keep your draft or load theirs. Admins and Owners edit instructions.

**Versions** under the editor keeps every save of `SOUL.md` (and, on **Your notes**, of
`MEMORY.md`), numbered v1, v2, ... with who saved it and when, and marks the version the bot's
last run used. Pick any two to see the changed lines. **Restore** saves an older version again as
the newest one; history is never rewritten, so a restore can itself be undone by restoring the
version before it.

A change to instructions, memory rules, skills or approval rules is a strategy change. Whether it
made the bot better is decided by a paired evaluation, not by one good run.

## Model

**Model** picks which model the bot thinks with: the deployment default, the cheaper model if the
deployment has one, or another model id. A model with no price row cannot be set. The
**Advanced: cheap model** setting is a second model for side work such as summaries and memory
consolidation; it is not a router, and the task itself always runs on the main model. The
deployment's defaults come from `DEFAULT_MODEL` and `CHEAP_MODEL` in the Gateway configuration.

## Schedules

Schedules wake the bot at set times with an instruction, without anyone writing a message. Times
are cron expressions (minute hour day month weekday) in the Gateway's time zone; the editor shows
the next occurrence. Each firing is a normal run on the background lane and appears on the
Activity tab. A firing that overlaps a running one is skipped. **Run schedule N now** starts a saved
entry at once as a normal background run (its trigger shows as "manual"); save an edited entry
first, and resume a paused bot first.

## Diary

At the end of every run the bot writes one line to its diary, `/home/<bot>/memory/<date>.md`, and
every run starts by reading the last three days. **Your notes** shows the diary by day, newest
first. It is read-only except that an Admin or Owner can delete a single line, for example one that
should not be remembered; each delete is recorded in the audit log without the line's text. A line
is only deleted if the day has not changed since you opened it, and not while the bot is running,
because the run's end writes to today's file. The diary lives on the workspace's computer, so it
cannot be shown while the workspace is stopped.

## Approval rules

Settings lists the bot's stored rules (Always allow or Deny for a tool, optionally narrowed to a
site, an argument pattern or a path). **Edit** changes a rule in place; it keeps its position, so
the earliest matching rule still answers first. Admins and Owners create, edit and remove rules.

## Try it

**Start test conversation** opens a private chat named "Test <bot>". It is a normal run: same
limits, same ledger, same costs.

## Skills

Skills are reusable how-to packages a bot loads at the start of a run
([ADR-0015](../adr/0015-skills-bots-learn-and-humans-install.md)). **Skills** under Resources has
two sections.

**Starter Skills** are built into the installed Deskmates release. A new workspace has the entire
pack automatically; every bot in that workspace sees the same names and the SDK loads a full
Skill body only when the bot chooses it for the task. They are not installed, reviewed or assigned
per bot. Expand a row to see the release origin, GPL-3.0 license, version and exact content hash.
The first pack contains:

- web research with citations and Markdown report writing;
- receipted SQL analysis through a registered database connector;
- screenshot evidence and careful web-form completion;
- Deskmates delegation, task delivery and human browser handoff; and
- a small skill-creator procedure.

The release build scans every Starter Skill and refuses a missing manifest entry or changed hash.
The same pack is copied into the workspace image for offline operation, while the Gateway sends the
exact recorded set to each run. Starter Skills never contain account credentials. When a procedure
needs an external account, connect it under **Integrations**; the Skill uses the resulting action or
stops with setup guidance.

The second section contains workspace-created or third-party Skills. It lists their stage, the bots
they are enabled for and when one was last used. Select a Skill for its origin, content hash,
provenance and version history with scan findings; its stage is changed there. The **⋯** menu
assigns bots, pins and undoes to the previous version. **Install skill** opens a form for a
`SKILL.md` and the SHA-256 you reviewed; the Gateway refuses content that does not match it. Every
third-party or bot-authored Skill is scanned before any run sees it; a version with findings waits
under **Waiting for review** for Confirm or Reject. A Skill a bot wrote stays with that bot
(provisional) until a human assigns it. Members see this page; installing, reviewing and assigning
are an Admin's.

## What this cannot do

- A bot's handle, role, instructions, working directory and memory separate it from its
  teammates only softly. Bots are separated by `SOUL.md`, working directory, prompt and ledger
  attribution. These are soft distinctions, not security boundaries.
- There is no access control between bots, by design. A bot cannot be stopped from reading another bot's
  files or using another bot's site logins in the same workspace. Anything that must not share a
  login or a filesystem goes in a second workspace.
- The connectors a bot names are a prompt-level choice, not access control.
- Learned memory never crosses a workspace, but inside a workspace every bot reads the workspace
  observations. No learned write can create or change an approval rule.
- A bot does one run per lane at a time. A schedule that fires while the previous firing still
  runs is skipped, not run in parallel.
- A saved change never reaches a run that is already going: profile, model, instructions and notes
  apply from the next run. There is no preview of the full prompt a run will get, no dry run, no
  bot copy or template, and no per-bot spending limit (budgets are per workspace).
- A rename cannot happen while the bot is running or waiting for an approval, and does not rewrite
  old messages that used the old handle.
- Pausing skips schedules, webhooks and wakes; it does not queue them for later. A webhook sender
  must retry itself.
- The diary view deletes lines only; it cannot add or edit one, and a deleted line may already be
  in a run that started before the delete.
- Real-model memory quality and any statistical claim that a strategy change helps are still
  pending acceptance (see the [M4 status ledger](../design/m4-status-2026-10-04.md)).
- Shipping a Starter Skill proves packaging and deterministic safety checks, not that it improves
  task outcomes. Quality claims still need a paired strategy evaluation.

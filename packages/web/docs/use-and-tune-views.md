# Use and tune views

The operator UI has two views of the same screens. **Use** is the default: what a person needs to
work with the bots. **Tune** adds the operations screens, every knob and the diagnostics the
owner uses to improve the bots while using them. **Preferences** in the sidebar footer opens
one dialog with Language, Appearance and the **Tune view** switch. Opening the dialog does not
change the view or navigate away from the current page; changing the switch applies at once.
Like the colour theme, the choice is kept in this browser (`localStorage` key `deskmates.view`)
and never reaches the Gateway.

The view decides presentation only. A screen hidden from the use view stays reachable by its
address, and roles are unchanged: the Gateway still refuses what a role may not do, and a
screen's own role checks still apply in both views. The tune view is the UI as it was before
the views existed.

## What the use view leaves out

| Where | Left out of the use view |
|---|---|
| Navigation | Knowledge, Skills, Computer, Costs, Analytics, Vault, People, Network (Connections is in both views since 2026-10-22). A group left without a link is not shown. |
| Sidebar account row | The role badge and its role panel (the tune view shows it next to your name; it no longer takes a band over every page). |
| Workspace settings | Internal network access, Execution limits, Working directories, Desktop tools, Web search. |
| Connections | The Databases tab, and the maintainer's option to list apps not enabled on this installation. |
| Bot profile | The Long-term instructions tab (MEMORY.md with its versions, and the diary). |
| Bot settings | Connectors, the teammates the bot may message, effort and thinking, the model and side-work model, vision, approval rules and run statistics. Profile (name, job, pause), SOUL instructions, schedules and the test chat stay. |
| Chat info | The Activity section (per-run cards and marks), the message limit and the routing mode. |
| Chat history | Generic system notices, completed approvals, past-request failures, failures superseded by the same bot's live/successful attempt on the same round or trigger, elsewhere activity cards, and raw protocol/stack disclosures. Current unresolved failures and pending/unknown approvals stay. A quoted handoff result remains useful content. |
| Chat list | System protocol excerpts are replaced by a neutral Open conversation preview. Pin and recency order remain unchanged. |
| Run details | The startup timeline link, the analytics link, usage, the context and memory measurements (unless the run waits for a continuation), the startup timeline, phase timing, the technical log, and in "What this run changed" the wrong-run mark, the memory it was given, what was frozen at start and the replay export. The story, the facts, what the run changed and the continuation controls stay. |

Current no-reply, paused-recipient and undelivered-handoff notices retain a brief localized
explanation until later conversation progress; the original recorded reason stays in Tune.
History filtering changes no stored status. Gateway jobs (summaries, reviews, memory) are not the person's work, but a Guest's status inquiry is: its progress and failure stay visible. Both the mention form and the private-chat handoff form of an undelivered-handoff notice count as current routing blockers. Another bot or unrelated background job succeeding
does not resolve a current failure. Switching views preserves the mounted conversation and its
draft; an explicit message deep link reveals that message even if it is normally diagnostic.
The header and transcript share the unresolved-failure rule. Detailed rules and verification
are in [Everyday chat state and navigation](../../../docs/design/use-view-state-and-navigation-2026-10-22.md).

## Sidebar geometry

Use/Tune and navigation width are independent. Desktop navigation has expanded and compact
states, controlled by its labelled button or the existing drag/keyboard separator. An expanded sidebar keeps its labels whenever its actual width is at least 200 pixels,
regardless of desktop viewport width. Only an explicit collapse or drag into the 64-pixel stage
uses centered icons. Resizing clamps the expanded width but preserves the saved choice. Mobile
keeps its labelled menu without changing that choice.
Only navigation scrolls; connection, Help, Preferences and account controls stay in the footer, in
that order. Compact mode keeps recognizable icons and accessible names, with account and role
controls in separate slots. A short mobile menu scrolls within the viewport.

## Settings interactions

Personal settings show saved values. Display name and password fields mount after **Change**;
Cancel discards the draft and returns focus, and password fields are cleared on cancel, server
error, success and leaving. Preferences remain available from every page.

The workspace directory separates **Enter** from **Settings**. Enter fetches the authorized,
current workspace before selecting it and opening Chats; a failed read leaves the current
workspace and route unchanged. Settings keeps the directory's search and pagination for Back.
The settings categories are Basic, Team & approvals, Tools & network and Lifecycle. Sections
load on their first visit and remain mounted when switching categories to retain drafts. Each
section keeps its own save/cancel behavior and existing role checks. Lifecycle actions retain
their confirmations; grouping does not change authorization or workspace policy.

## How a part declares it

- A feature's navigation entry sets `audience: "tune"` (`app/feature.ts`); the shell filters
  the entries, so no list of features lives in a shared file.
- A workspace detail section sets `audience: "tune"` in `features/workspaces/detail-sections.ts`.
- Any other part reads the view with `useTuneView()` or wraps itself in `<TuneOnly>`
  (`lib/interface-view.tsx`). Outside the shell, as in a screen's own tests, the default is the
  full tune view; the shell provides the stored choice.

## Removed with the views

- The sidebar's organization switcher: multi-tenancy is not a product feature (owner decision,
  2026-10-10). A session still names its tenant on every request.
- The second allowed-websites editor on the Computer page; the page links to the workspace's
  Network policy, where the list is edited.
- The unused `ManagementScreen` (create workspace, egress per workspace, create bot, trash),
  which no route rendered. The bot settings editor it contained stays on the bot profile.

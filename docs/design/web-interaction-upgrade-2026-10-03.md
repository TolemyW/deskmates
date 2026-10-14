# Web interaction upgrade: from a control-plane interface to a product surface

Date: 2026-10-03
Status: phase 1 implemented on the collaboration branch; phases 2 and 3 are proposed
Baseline: `5e018ec` (main `1109ec7` merged with `codex/m3-collaboration-20261003`)
Scope: `packages/web` only. No Gateway route, contract or architecture rule changes.

The owner asked for the interaction flow and the appearance of the operator UI to be brought
up before more features are added. This document records what the UI looked like, what phase 1
changed, how it was verified, and what the next two phases are. It follows the findings of the
[product interaction review](product-interaction-review-2026-09-30.md) and does not reopen any
decision that review said needs an ADR (task model, wake semantics, memory injection).

## Starting point

The UI was reviewed by running it against a scripted Gateway (below) and capturing every
screen. What held it back was not one screen but the absence of a system:

- Type sizes of 7 to 10 px on labels, captions and chips; colours written as literals in 2,000
  lines of CSS with two competing `:root` blocks; no dark theme.
- A flat sidebar of eight equal links; the pending-approval badge was the only signal.
- The conversation rail spent most of its height on a permanently open "New thread" form, with
  no search, no member or status information, and no last-activity time.
- The transcript rendered Markdown as literal asterisks, repeated the author on every message,
  showed cancelled runs in the same weight as replies, and used a plain textarea with a lone
  "Send" button.
- The desktops column was always present, even on shell or database conversations.
- The run page opened with identifiers, timestamps and a usage table; the status was one cell.
- The secondary screens were unstyled forms and tables of different widths.

## Phase 1: foundation and the conversation screen (implemented)

**Design tokens.** `packages/web/src/app.css` now starts with one token block: colour roles
(surface, border, text in four strengths, primary, success, warning, danger, info, bubbles),
a type scale from 11 to 26 px, radii, shadows, and eight avatar hues. A second block redefines
the colours for `[data-theme="dark"]`. The Tailwind `@theme` maps the names the shared
primitives use onto the same tokens, so a Radix dialog and a hand-written card agree. Screens
reference tokens only; there is no literal colour outside the token blocks.

**Primitives.** `components/ui/avatar.tsx` (initials with a hue derived from the name, so a
bot keeps one colour everywhere), `pill.tsx` (status labels with one tone per run status),
`empty-state.tsx`, and `lib/theme.ts` (light, dark or system, kept in localStorage). The
button, input and dialog primitives are unchanged.

**Safe Markdown.** `lib/markdown.tsx` renders paragraphs, headings, lists, fenced code, quotes,
rules, pipe tables and inline marks as React elements. It never produces HTML from the text:
raw tags stay literal, links are limited to http(s) and open with `noopener noreferrer`,
images are not rendered, and plain text runs are handed back to the caller so workspace paths
still become the ADR-0014 download card. Covered by `lib/markdown.test.tsx`.

**Shell.** The sidebar groups the navigation into Work (Conversations, Approvals with the
pending count, Desktops), Team (Bots & workspaces, Knowledge, Learned memory) and Operate
(Costs, Integrations), shows the connection and release in the footer with a theme toggle,
collapses to an icon rail under 1100 px and to a top bar with a menu under 720 px.

**Conversation screen.** The rail has a search field, groups conversations by workspace when
there is more than one, and shows for each conversation the member avatars (once the
conversation has been opened), the member count or name, a `paused` pill, and the relative
time of the last update. The create form stays in the document (it is the only way to start a
conversation and the existing tests drive it) but folds behind a "New conversation" control
once conversations exist. The transcript draws an avatar per message, hides the avatar and
name on consecutive messages by the same author within five minutes, inserts day dividers,
renders Markdown bodies, and shows failed or cancelled runs as centred compact rows with a
status pill. The typing indicator animates. The composer is one bordered box with the mention
picker, a keyboard hint and a round Send button. The header carries the title, the live status,
the members with their activity, the takeover controls and a toggle for the desktops column,
remembered per browser. On phones the rail hides behind a back link in the header.

**Run page and approvals.** The run page opens with the status pill, the run id and a link to
its conversation; a failure is a notice under the title; the summary reply renders as
Markdown; the progress and context section is a card. The approvals inbox has a page header
and an empty state, and the approval card gives "Allow once" (or "Continue") the primary
style and "Confirm deny" the destructive one.

**Secondary screens.** Bots & workspaces, Knowledge, Learned memory, Costs, Integrations and
Desktops keep their markup and get cards, page headers, bounded form widths, table styling
and consistent spacing through the shared classes. Their structure is unchanged; the
interaction review's findings about them (bot detail page, memory categories, schedule
editing) are phase 2 and 3 work.

**Tooling.** `scripts/ui-demo.ts` starts a Gateway on an in-memory database with the fake
sandbox provider and a scripted sidecar that plays a coordinator, a researcher and a tester:
a delegation in a group thread, a browsing run with a screenshot and a written file, a direct
chat with a failed run, and a parked L2 approval. `scripts/ui-screenshots.mjs` captures every
screen in light, dark and phone widths. Together they let anyone review the UI in minutes
without Docker or a model, which this phase used for its before and after comparison.

### What did not change

- No route, API client call, contract or Gateway behaviour. Test labels, roles and the class
  names the tests select on (`.author`, `.body`, `.seq`, `.kind`, `selected`) are kept.
- The thread model, wake routing and desktop sharing semantics. The desktops toggle hides a
  column; it does not change the workspace lock.
- The "recovered" label logic and the role field's non-executable status, which the review
  assigns to the product-layer phase.

### Verification

| Check | Result |
|---|---|
| `npm run typecheck -w packages/web` | pass |
| `npx biome check packages/web/src scripts/ui-demo.ts scripts/ui-screenshots.mjs` | pass |
| `npm test -w packages/web` | 33 files, 243 tests, pass (6 new for Markdown) |
| `npm run build -w packages/web` | pass |
| Root `npm run typecheck`, `npm run lint`, `npm test` | see the commit message of this change |
| Screenshots | every screen captured against `scripts/ui-demo.ts` at 1440×900 light and dark, and 390×844; reviewed by eye; no console errors other than a missing favicon |

Unit tests and screenshots establish rendering, not usability with real bots or a real
browser. No Docker, model or deployment was used.

## Phase 1b: the messaging-app shape (implemented)

The owner asked for the product to read like a messaging app: bots as contacts, chats as
private chats and groups, and desktops as channels. The thread model already has that shape
(a one-member `chat` thread is a private chat, a multi-member one a group, a `bus` thread a
bot-to-bot exchange; ADR-0005), so this round changed the operator UI and one list route, and
no architecture rule.

- **Gateway.** `GET /api/threads` returns `ThreadSummary` rows: the thread plus `memberIds` and
  `lastMessage` (seq, author, 160-character excerpt, time). `thread-list-routes.test.ts` covers
  it. Nothing else in the Gateway changed.
- **Chats.** The rail lists chats with member avatars, the newest message as a preview with its
  author, the time, and a `paused` pill; bus threads fold under "Bots talking"; a search field
  filters by title, member and preview; "New chat" is a dialog that names what it creates
  (private chat or group) and opens by itself when there is nothing yet. The right column is
  the chat's info panel: members (linking to profiles, with the owner mark), task notes (the
  task-scope memory of this chat, with "Finish task notes"), files mentioned in the chat,
  approvals asked in it, and the members' desktops.
- **Contacts.** The bots of the current workspace, with role and latest run status;
  "Message" opens the existing private chat or creates one; the profile has Activity (the feed
  and the desktop, with schedules and model at a glance), Experience (bot-scope memory), Your
  notes (MEMORY.md, named as the operator's own words) and Instructions & settings (the
  existing editor).
- **Activity.** A read-only feed per bot, assembled from the run ledger (started, waiting,
  finished, failed, with the summary or error), the bot's schedule and the live run stream,
  with the bot's desktop beside it. A bot writes nothing to its feed; the Gateway's records
  are the feed. It started as a separate "Channels" navigation entry; the owner's review of
  the demo found that indistinguishable from Contacts, so the feed is the first tab of the
  contact's profile and the Channels and Desktops routes resolve there.
- **Computer.** The shared computer of the current workspace: Library (the reviewed documents
  and their governance), Facts (workspace-scope learned memory with the confirmation queue) and
  Settings (allowed domains, the bots on it). The three older pages resolve to these tabs.
- **Workspace as the context.** The first demo build listed every workspace's bots and chats
  together and kept a "Workspace" page beside them, which left the term meaning nothing in
  particular; the owner's review said so. The data model is unambiguous (a bot and a thread
  each belong to one workspace, ADR-0004 and ADR-0005), so the UI now follows it: a workspace
  is a team of bots on one shared computer, the sidebar's top block names the current one and
  switches between them (`workspace-switcher.tsx`, `state/workspace-scope.tsx`), Chats and
  Contacts show only its threads and bots, bots and chats are created in it without a
  workspace field, the page of its container is called Computer, and a link into another
  workspace's chat or contact switches there. Attention and Costs stay deployment-wide, since
  they are the operator's inbox and bill rather than a team's. The demo seeds a second,
  open-internet workspace with one bot to show the switch.
- **Avatars.** A bot can carry an emoji and a named colour (`BotAvatar`, migration 0025,
  `POST`/`PATCH /api/bots`), chosen from the profile header or when the contact is created.
  Unset, the avatar is the name's initials on a name-derived hue, as before. The choice is a
  display preference: nothing in a run reads it, and the sidecar never sees it. The owner asked
  for it after the second demo round, to tell a team apart at a glance.
- **Phone layout.** Below 720 px the chat list and the contact list are the whole screen until
  something is picked, and the picked chat or profile is the whole screen after; the chat info
  drawer is a full-screen sheet under the top bar with a sticky header; tabs scroll sideways.
  The first demo build had the narrow-width layout tokens inside the components layer, where
  the unlayered defaults always won, so the sidebar never collapsed; they now sit beside the
  tokens at the top level.
- **Third review round (same day).** Schedules: the profile's At a glance row links to the
  editor and the activity feed's schedule card says what a schedule does, lists each entry with
  its next firing in the Gateway's time zone, and runs woken by one say so. Experience and
  Facts: embedded memory is a list of cards (body, kind, trust, source, validity, actions)
  instead of a nine-column table, with an empty state that explains what will appear there.
  Settings: one card per concern (instructions, model, schedules, approval rules, try it), one
  short line under each heading, the model as a dropdown (deployment default, the cheap model,
  or another id) and the cheap model under Advanced with an honest note: it is a second model
  handed to each run for side work, not a router, and no run step uses it yet. Approval rules
  explain themselves and the hand-written form sits under a disclosure. Approval cards use the
  base type size and gain "Ask the bot", which posts a question to the run's chat as a mention
  so the bot can explain the action before anyone decides; the request stays open. Costs: a
  period picker, three tiles (spend, tokens, runs), spend per day stacked by model, the split by
  model and by bot, and the detailed rows, in the shape of a model provider's activity page.
- **Fourth review round (same day).** A chat with no title is named after who is in it (the
  bot, or the members' names), never "(untitled)". Embedded memory has a one-line toolbar
  (search, history toggle, consolidate) with the search named after what it searches. The
  approval card's extra action is now "Tell it what to do instead": the operator's words deny
  the pending action as its reason, the parked run resumes and reads them, and the chat opens;
  the same move as redirecting a coding agent at a permission prompt. The shared machine's nav
  item reads "Shared computer". The Library is a document list with a search field, the
  proposal form and pending reviews as cards, and governance as a quieter side column.
- **Integrations as a catalog (fifth round).** The page was empty because it only listed
  adopted providers and the demo had none. It is now a catalog in three groups, scoped to the
  current workspace: Apps (the integration runtime's providers, ADR-0013: adopt, then connect an
  account with OAuth or an API key in a dialog; connected accounts and revoke on the card),
  Databases (receipted connectors, ADR-0012, registered with a URL and a credential the Gateway
  keeps), and Channels (the WhatsApp services of ADR-0017 and ADR-0019 with their setup steps,
  since the Gateway holds only the thread binding). A new `GET /api/integrations/catalog` reads
  the runtime's provider list through the adapter; that runtime route is not yet exercised by
  the spike, so the service falls back to the adopted providers when it cannot be read and the
  page says so. The demo seeds twelve providers, two adopted, one connected account and one
  database.
- **Egress defaults (ADR-0020).** The first deployment test ended with a bot reporting every
  host blocked, because a new workspace had an empty allowlist. The workspace forms now offer
  "Open public internet" (the default, sends `*`) or "Only these sites"; in a locked workspace
  the first visit to a public host is an approval card "Open <host>?" with "Allow this site",
  which adds the host to the list through the same path as an operator edit, and "Deny".
  Private addresses and IP literals stay denied without asking.
- **Memory and knowledge together.** The rule is one concept, one place, by owner: task notes
  on the chat, experience on the profile, the operator's notes beside it, facts and the library
  on the workspace. The stores did not change; `LearnedMemoryScreen` gained an embedded mode
  (fixed workspace, owner and optional thread) and `MemoryPanel` a fixed bot. Merging MEMORY.md
  into learned experience, or promoting a fact into the library with one action, needs the
  ADR-0011 amendment and is left for phase 2.
- **Standalone demo.** `packages/web/demo.html` runs the same UI on an in-browser mock Gateway
  (`src/demo/mock-gateway.ts`) that plays the three-bot team and answers every route the UI
  calls, so the product can be tried from a static page. It is a demo, not a test double;
  `mock-gateway.test.ts` checks the shapes the UI unwraps and that a message wakes a bot.

Verification: web typecheck, lint and tests (36 files; the new `contacts.test.tsx`,
`workspace-scope.test.tsx` and `mock-gateway.test.ts` included); gateway thread list tests; root typecheck, lint and T0/T1;
screenshots of every screen through `scripts/ui-screenshots.mjs`; and a Playwright walk through
the built demo (approve the parked export, send a follow-up, open contacts, channels, profile,
workspace) with no page errors.

## Phase 2: one coherent journey (proposed)

Depends on the task model ADR named in the [productization roadmap](productization-roadmap-2026-10-03.md).

1. **Attention inbox** replacing the approvals page: approvals, continuations, logins and
   takeovers in one list with the conversation and bot they belong to, grouped by what the
   human has to do.
2. **Bot detail page** replacing the bots section of the management screen: instructions with
   draft and effective versions, capabilities and prerequisites, schedules, recent runs and a
   bounded test conversation, reached from the roster and from a member chip.
3. **Run supervision view**: stage, last evidence-backed action, waiting reason, elapsed time
   and partial outputs first, with the ledger in a drawer; the same component used by the
   conversation's "View run details" link and by the inbox.
4. **Deliverable cards**: a typed card for every file a bot reports, with preview and
   download, a path policy that accepts spaces and non-ASCII names (ADR-0014 amendment), and
   the size limit stated on the card.
5. **Message controls**: a visible choice for a message sent during a run (queue it) and a
   stop control once the SDK path is verified in T2.

## Phase 3: scale and settings (proposed)

1. Memory as four named categories with source, scope and effect timing, and a safe
   distinction between excluding and erasing.
2. Conversation archive, pinning and read state; a compact history mode for long threads.
3. Settings area for workspace egress, prices, cost alert rules and integrations, moved out of
   the operational screens.
4. Accessibility pass: focus order, reduced-motion coverage, contrast check of every token pair
   in both themes, keyboard operation of the mention picker and dialogs.

Each phase ships behind the same gates as phase 1 and adds its own tests; screenshots from
`scripts/ui-screenshots.mjs` accompany every UI pull request.

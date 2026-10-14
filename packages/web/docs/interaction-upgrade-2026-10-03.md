# Interaction upgrade (2026-10-03)

The operator UI was rebuilt on a token-based design system so every screen reads as one
product: `src/app.css` holds the tokens (colour, type scale, spacing, radius, shadow) with a
light and a dark theme, and the shared primitives under `src/components/ui/` (button, input,
dialog, avatar, pill, empty state) use those tokens through Tailwind's `@theme`. Screens never
use a literal colour. The shell is a grouped sidebar (Work, Team, Operate) with the pending
approval count, a theme toggle, and a collapsing icon rail and mobile menu at narrow widths.

The conversation screen is the product's centre: a searchable rail grouped by workspace with
member avatars, status and last activity; a transcript with avatars, grouped consecutive
messages, day dividers and safe Markdown rendering (`src/lib/markdown.tsx`: React elements
only, http(s) links only, no raw HTML); run outcomes as compact rows; a composer with keyboard
hints and the mention picker; and a desktop panel that can be hidden per browser. The run page
leads with the status, and approval cards give the allowed action a primary button.

## A messaging-app shape (2026-10-03, second round)

The navigation is now Chats, Contacts and Attention, the shared Computer page, and the
operating screens, all inside one workspace at a time. Bots are contacts: the list shows role and latest run status, a contact opens its
private chat (the existing one-member thread, or a new one) or its profile (activity feed with
its desktop, its own experience, the operator's notes, instructions and settings). Chats are private chats and
groups with the newest message as a preview; bot-to-bot threads fold under "Bots talking"; the
right column is the chat's info (members, task notes, files, approvals, desktops). A bot's
activity feed is read-only, assembled from the run ledger and the bot's schedule, and sits on
its profile beside its desktop; the older Channels and Desktops routes resolve there. The
Computer page holds what every bot shares: Library (reviewed documents), Facts (what bots
learned about the computer and its sites) and Settings (allowed domains, the bots on it).
Memory follows its owner: task notes on the chat, experience on the profile, facts on the
computer. `GET /api/threads` now returns `ThreadSummary` rows (member ids and the newest
message) so the rail and the contact list need no per-thread request.

A bot can wear an avatar: one emoji on one of the named colours (`BotAvatar` in contracts,
stored on the bot row, set from the profile header or the New contact dialog through
`POST`/`PATCH /api/bots`). Without one the avatar shows the name's initials on a hue derived
from the name. Screens that load bots register them in the avatars registry
(`src/state/bot-avatars.tsx`), so every place that draws a bot by name (rail, transcript,
member chips, desktops) shows the chosen look without carrying the bot row around.

A workspace browses the open public internet unless its creator locks it to a list (ADR-0020):
the first-run form, the New workspace dialog and the Shared computer settings offer "Open public
internet" or "Only these sites" (`src/features/workspaces/egress-mode-picker.tsx`) and send `["*"]` or the
typed list. In a locked workspace a first visit to a new site is an approval card of kind
`egress` ("Open <host>?") with "Allow this site", which adds the host to the list, and "Deny".

A workspace is the context everything sits in: a team of bots on one shared computer, so its
bots are the Contacts, its threads are the Chats and its container is the Computer page. The
sidebar's top block is the current workspace (`src/features/workspaces/workspace-switcher.tsx`); with more
than one it is a menu that switches, and new workspaces start from it. The choice is kept in
`localStorage` (`deskmates.workspace`), screens read it through `useWorkspaceScope`
(`src/state/workspace-scope.tsx`), and a link into a chat or contact of another workspace
switches to that workspace. Bots are created from Contacts and chats from Chats, always in the
current workspace, so no form asks which workspace a thing belongs to.

`demo.html` is a standalone demo of the same UI on an in-browser mock Gateway
(`src/demo/`): `DESKMATES_DEMO=1 npm run build -w packages/web` writes it to `dist-demo/` with
relative asset paths. The mock plays the three-bot team (delegation, a browsing run, a parked
approval that resumes on a decision) and answers every operator route the UI calls; it is a demo,
not a Gateway test double.

Work on the UI without Docker or a model:

```
npm run typecheck                      # once: builds packages/*/dist
npm run dev:ui-demo                    # Gateway on 127.0.0.1:8099 with a scripted three-bot team
OPERATOR_PORT=8099 npm run dev:web     # Vite, then sign in as the printed demo account
npm run ui:screenshots -- <out dir>    # every screen, light, dark and mobile (needs Playwright)
```

`scripts/ui-demo.ts` seeds a workspace, three bots, a group thread with a delegation, a direct
chat with a failed run, and a parked L2 approval, all from the fake sandbox provider and a
scripted sidecar. `scripts/ui-screenshots.mjs` reads `PLAYWRIGHT_MODULE` and
`PLAYWRIGHT_CHROMIUM` when the repository has no Playwright of its own.

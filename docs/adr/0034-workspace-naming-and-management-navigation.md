# ADR-0034: Workspace names are bounded by weighted width, and 100 workspaces are managed from a paged list

Date: 2026-10-14
Status: Proposed (decisions 1, 2, 4 and 7 carry owner decisions on issue #117 of 2026-10-13: the 32-unit budget with Han as two, the list layout with 20 per page and a full-page detail, and three User Settings pages. On 2026-10-14 the owner accepted the 32-unit bound of decision 1 (about 16 CJK characters), the Admin/Owner-only running-work count of decision 5, unaudited per-person pins in decision 6, and decided decision 9: network, people and archive edit in place on the detail page. The legacy-name rule in decision 2, the last-activity aggregate in decision 5 and the route addresses in decision 7 are engineering proposals awaiting owner review.)

## Context

Issue #117 asks for a short workspace name and for a product that stays usable with 100 workspaces. The owner fixed the name budget at 32 weighted units, a Chinese character counting as two and a Latin letter or digit as one, so a name holds at most 16 Han characters. Before this ADR the store checked only that a name was not blank, the sidebar switcher rendered every workspace as a menu row, `GET /api/workspaces` returned the whole authorized list, and no screen managed workspaces as a list.

The owner's wireframe decisions of 2026-10-13: workspace management lives in User Settings, which becomes three pages (Personal settings, Agent access, Workspaces); the Workspaces page is a dense list with search, All/Pinned/Archived and My-role filters, recent-activity order and 20 rows a page; a row opens a full-page detail with "Back to workspace list" that keeps search, filters and page; the switcher is compact (current workspace, search, pinned, recent, "Manage all workspaces"). Roles and audiences are ADR-0022 amendment 6; paging follows the #113 contract (`docs/design/pagination-coverage-2026-10-13.md`, surface 40).

## Decision

1. **One weighted counter, shared by Web and Gateway.** `workspaceNameUnits` in `contracts/src/workspace-name.ts` counts the NFC form of a name by extended grapheme cluster (`Intl.Segmenter`; a fallback joins combining marks to their base). A cluster weighs **2** when its first code point is East Asian wide: Han, Hiragana, Katakana, Bopomofo, Hangul, CJK symbols and punctuation (U+3000 to U+303F), fullwidth forms (U+FF01 to U+FF60, U+FFE0 to U+FFE6), or an emoji (`Extended_Pictographic`, including ZWJ sequences and flags). Every other cluster weighs **1**: Latin, digits, other alphabetic scripts, ASCII punctuation, a space, a letter with combining marks. The bound is 1 to **32** units (`WORKSPACE_NAME_MAX_UNITS`). A name must not be blank, must not begin or end with whitespace, and must not contain control characters or line or paragraph separators. UTF-16 length and byte length are never used.

2. **Create and rename enforce it; legacy names stay.** `POST /api/workspaces` and the new `name` field of `PATCH /api/workspaces/:id` (the existing `workspace.configure` action, Admin) refuse an invalid name with a `validation` error carrying `{ field: "name", units, max }` and write nothing. The stored value is the NFC form; the Gateway never trims or shortens a name. A PATCH that sends the name already stored is a no-op even when that name is over the bound, so a legacy name survives an unrelated edit. There is **no migration of names**: an existing over-long name stays intact and is shown truncated with an ellipsis and its full text in the element's title and accessible name. Renaming it requires a name inside the bound. A rename is audited as `workspace.update` with before and after names, in the same transaction.

3. **The directory is one bounded, server-side query.** `GET /api/workspace-directory?q=&filter=all|pinned|archived&role=&offset=&limit=` returns `{ workspaces, offset, limit, total }` with 20 rows by default and at most 100 (`WORKSPACE_DIRECTORY_PAGE`); a larger limit is a 400, never clamped. `q` (at most 64 characters) matches a name substring, case-insensitively for ASCII, or an exact workspace ID. Order is last activity descending, then `id`, so equal timestamps keep a stable order. `total` is the count of the same filtered set, never of one page. The rows are the caller's workspaces only (ADR-0022 amendment 6 W1): a person sees workspaces where they hold a role; the operator credential, a service principal and the protected account see the tenant's. The archived filter shows only workspaces where the caller is Admin or Owner, as the trash does. `GET /api/workspaces` keeps its unpaged shape as the shell's name map; the switcher no longer renders it.

4. **Management is a list page with a full-page detail.** The Workspaces page of User Settings shows the authorized total, a name search, the filters and a permission-aware **+ New** (`workspace.create`). A row shows pin, name, my role, bot count, running work and last activity. Clicking the name opens the detail page keyed by the immutable workspace ID; "Back to workspace list" returns to the same search, filters and page (the page in history state, search and filters in the address). Desktop and narrow screens behave the same. The detail shows the ID, my role, network policy, People and Archive, each through its existing route and role; it is built from one component file per section so another section (auto-approval, egress profile) is one file and one line.

5. **Aggregates are authorized and computed per row in SQL.** Bot count counts active bots. Running work counts the workspace's runs in `queued`, `running` or a waiting status and is returned only where the caller is Admin or Owner there; for a Member or Guest it is `null` and shown as unavailable, because a count would reveal activity in other people's private chats. Last activity is the latest `updated_at` of the workspace's chat threads in the workspace audience or private to the caller, falling back to the workspace's creation time; it is a timestamp, never content. No count is computed from a page, and there is no per-row request.

6. **Pins are per person and stored by the Gateway.** `workspace_pins (user_id, workspace_id, pinned_at)` holds one person's pins; `PUT` and `DELETE /api/workspaces/:id/pin` set and clear the caller's own pin in a workspace where they hold any role. A pin is a personal preference, not workspace configuration, so it writes no audit row and no other person can read or change it. A principal that is not a person (operator credential, service principal) has no pins and gets a `validation` error.

7. **User Settings has three pages.** `#/account` (Personal settings: profile, password, preferences, sign-out), `#/account/agent-access` and `#/account/workspaces` (with `?q=&filter=&role=` and `&ws=<id>` for the detail). A left category list on desktop and a compact selector on narrow screens; each block keeps its own form, save and error. The switcher's "Manage all workspaces" opens the Workspaces page.

8. **The switcher is bounded.** It shows the current workspace, a search box that queries the directory (at most 8 results, the latest answer only), up to 5 pinned and up to 5 recently active workspaces (two directory requests made when the menu opens), then Manage all, Trash and New. It never renders the whole list.

9. **Network, People and Archive edit in place (owner-decided 2026-10-14).** The detail page edits these three sections itself instead of linking to the Computer and People pages, and it never changes the selected workspace to do so. Each reuses an existing route and the Gateway's existing role check; no route or permission is added.
   - **Network policy.** The section reads the workspace (`GET /api/workspaces/:id`) and shows open internet or the list. An Admin or Owner there (`workspace.configure`) picks open internet or a list, edits the hostnames, and saves through `PATCH /api/workspaces/:id` with `egressAllowlist`. Removing a hostname asks for confirmation first, as the Contacts editor does. Everyone else reads the mode and the list. An archived workspace is read only.
   - **People.** An Admin or Owner (`people.manage`) gets the People page's own member list, role changes, removal and invitations for this workspace, the same component with the workspace ID passed in, so every call (`GET`/`PATCH /api/members`, `GET`/`POST`/`DELETE /api/invitations`) names it. A Member or Guest sees a note that an Admin manages people.
   - **Archive.** An Admin or Owner (`workspace.archive`) archives through `POST /api/workspaces/:id/archive` after the same confirmation as the Computer page: what stops, what is kept, how to restore. An archived workspace restores in place through `POST /api/workspaces/:id/restore`. Permanent deletion stays in Trash, behind its typed-name confirmation.

## Alternatives considered

- **32 graphemes, 16 Han characters, or UTF-8 bytes.** Rejected by the owner (issue #117); bytes punish non-Latin scripts and graphemes do not match how wide the label renders.
- **Truncating or backfilling existing names.** Rejected: it loses data the owner said to preserve. The display truncates instead.
- **Paging `GET /api/workspaces` itself.** It is the name map every screen's tests and the shell scope read; changing its shape would touch every feature. A separate directory endpoint is additive.
- **A side drawer for the detail.** Rejected by the owner's wireframe choice.
- **Pins and recents in browser storage.** Pins must follow the person across browsers, so they are stored server-side; "recent" is the workspace's own activity, which needs no storage.

## Consequences

- A person sees one consistent bound in the create dialog, the rename field and the API error.
- 100 workspaces are five pages; the switcher stays the same size at any count.
- The shell still loads the unpaged authorized list once per session for name lookups; bounding that is follow-up work (#113 surface 40 remainder).
- Running work is hidden from Members and Guests, which is less informative than the wireframe row; the owner kept this rule on 2026-10-14.
- The Computer and People pages keep their own editors; the detail page is a second place to edit the same settings through the same routes (decision 9).

## Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1 | 32 Latin units pass and 33 fail; 16 Han pass and 17 fail; mixed, emoji, ZWJ, combining marks, NFC/NFD agree; control characters and edge whitespace fail | `contracts/src/workspace-name.test.ts` | none |
| 2 | create and rename refuse an invalid name with 400 and no row or audit change; an unchanged legacy name passes; a rename is audited | `gateway/src/api/workspace-routes.test.ts` | validation refusals on workspace names |
| 3 | more than two pages, limit over 100 is 400, equal timestamps keep `id` order, total equals the filtered count, a Member sees only their workspaces, search by name and by ID | `gateway/src/workspaces/workspace-directory.test.ts`; `gateway/src/api/workspace-routes.test.ts` | directory query time at 100 workspaces |
| 4 | the list renders 20 rows with a range, filters reset to page one, the detail opens by ID and Back keeps search and filter | web `features/workspaces/workspace-management.test.tsx` | none (visual check at 390 px and both themes not run) |
| 5 | running work is null below Admin; last activity ignores another person's private chat | `gateway/src/workspaces/workspace-directory.test.ts` | none |
| 6 | a pin is visible only to its person, the pinned filter shows it, the operator credential cannot pin | `gateway/src/api/workspace-routes.test.ts` | none |
| 7 | `#/account`, `#/account/agent-access` and `#/account/workspaces?ws=` parse to the right page | web `features/account/route.test.ts`; web `features/account/account-settings.test.tsx` | none |
| 8 | the switcher renders at most current, 5 pinned, 5 recent and 8 search results, and drops a late search answer | web `features/workspaces/workspace-switcher.test.tsx` | none |
| 9 | an Admin saves an allowlist in place (removal asks first) and a Member reads it; an Admin sees the member list with role controls and the invite form for this workspace, a Member a note; an Admin archives after the confirmation and restores an archived workspace in place; the selected workspace never changes | web `features/workspaces/workspace-detail-inline.test.tsx`; Gateway checks unchanged (`workspace-routes.test.ts`, `member-role.test.ts`) | none (visual check at 390 px and both themes not run) |

# Page experience polish — 2026-10-27

## Objective and acceptance

Review and improve every application page, following the approved chat changes:
reduce repetition, make the primary task and next action obvious, disclose technical
facts on demand, and preserve actual authorization, lifecycle and audit semantics.
A page is complete only after its populated, empty/error and permission-sensitive
states are inspected, affected interactions are tested, and desktop/mobile rendering
is verified. This is not a stylesheet-only or chat-only task.

## Coverage ledger

The registry in `packages/web/src/features/*/route.ts` is the source of truth.
All areas below have feature evidence and the final integrated verification recorded at the end of this document.
Related detail/create/edit routes remain in scope, as do shell and authentication.

| Area | Status | Evidence / next work |
| --- | --- | --- |
| Chat list, conversation | Verified | PR #99 and pass 90: desktop/mobile transcript, compact approval details, close-focus return and shared recovery behavior rechecked |
| Tasks, create, task detail, templates | Verified | Passes 1–2, 42–44, 57–59, 71: desktop/mobile list/create/detail, read and related-item recovery, drafts/idempotency, role and terminal-state controls, templates and revision focus verified |
| Approval inbox | Verified | Passes 1, 46, 63–64, 72–74: compact desktop/mobile, grouped/single decisions, failures, reconnect races, scoped roles and lookup retry verified; grouped/error layout checked in read-only fixture |
| Bots / contacts and bot detail | Verified | Passes 3, 25–26, 83–86: directory/detail desktop/mobile, lookup/missing distinction, drafts and conflicts, schedules, scoped roles, app selection and read recovery verified |
| Board | Verified | Passes 2, 31, 47, 62–63: populated desktop/mobile, empty/error semantics, author/moderator actions, read/edit recovery, withdrawal removal, history refresh and focus return; 21 feature tests pass |
| Files and preview | Verified | Passes 3, 28–30, 60–61, 75: desktop/mobile browse/detail/reader, safe previews/retry, lifecycle and role assertions, upload retry/cancel, delete confirmation/failure/focus verified |
| Connections / integrations and setup | Verified | Passes 18–21, 81–82: desktop/mobile catalogs and setup, independent retry, scoped counts/read races, credential draft lifecycle, pending locks, role and archived-state controls verified |
| Knowledge and memory | Verified | Passes 5–6, 37–38, 54–56, 67–68, 87: documents/observations search, drafts/conflicts, read/history recovery, workspace lifetime, roles, forget confirmation, maintenance state and desktop/mobile verified |
| Skills | Verified | Passes 33–36, 65–66, 70: read/history recovery, mobile detail, workspace roles, installation/assignment draft locks and focus, labeled form and responsive list verified |
| Workspaces and settings | Verified | Passes 13–14, 52–53, 65, 68: mobile directory, pin recovery, scoped entry, create draft/focus, missing/archive recovery, archive confirmation/restore and Member read-only controls verified; pass 89 verifies settings visuals/state assertions and fixes pending-pin refresh |
| Members and invitations | Verified | Passes 7, 45, 65, 68–69: desktop/mobile rows, read/empty/retry states, role controls, onboarding draft locks, scoped mutation lifetime and failed removal retry verified |
| Network and web search | Verified | Passes 17, 88: profile desktop/mobile, local reads, scoped permissions, expired choices, preserved drafts, connectivity result identity, host cleanup confirmation and search configuration states verified |
| Costs, limits and usage | Verified | Passes 9–10, 49–50, 79–80, 86: report/ranking query isolation, budget roles/editor, explicit continuation, pending rule draft locks, independent list recovery and desktop/mobile verified |
| Runs, run statistics and analytics | Verified | Passes 8, 23–26, 76–78: normal/failed/missing/retry, live stream, drawer desktop/mobile/focus, actual-workspace management controls, statistics scoped saves/read recovery and external Analytics link verified |
| Computer, desktop tools and work directory | Verified | Passes 16–17, 88: desktop-first responsive layout, roster recovery, passive preview vs explicit start/takeover, held-session lifecycle, settings role/availability and draft recovery verified |
| Vault | Verified | Passes 15–16, 88: responsive catalog/dialog, nonsecret draft retention, secret clearing, cancel focus, read recovery, workspace lifetime and Member read-only controls verified |
| Account and app shares | Verified | Passes 12, 15–16, 40–41, 60–61, 83: editor/secret lifecycle, focus, mobile, scoped app requests, validation, entry recovery, root-only agent key controls and failure behavior verified |
| Trash and shared missing/denied states | Verified | Passes 11, 51, 83: desktop/mobile, fallback exit, role denial, loading/error/retry, restore failure/duplicate protection and paging verified; object-specific missing states remain with each feature |
| Shell, sign-in and invitation entry | Verified | Passes 22, 24 and 32: invitation recovery/lifetimes, rejected-token classification, SSO pending state, drawer focus; pass 48 adds invitation SSO pending state and mobile signup/expired/sign-in visuals; pass 89 verifies auth state assertions and current regression |

## Workspace

Implementation is isolated in `codex/page-experience-polish`, initially based on
`09d9267`, to avoid overwriting concurrent channel and CI work in the primary checkout.
No deployment or changes to production data are part of this pass.

## First implementation pass: tasks and approvals

- Task list: bounded 960px reading width and a combined search/status toolbar.
- Task detail/create on mobile: display the selected task directly, hide the list
  and redundant page header, and provide an explicit Back to tasks link.
- Approval inbox: one readable queue, compact decisions, technical details in the
  shared pane, secondary actions in the menu, no repeated bot identity.
- Corrected error semantics: failed loading no longer shows an empty-success state;
  retry is explicit. Added a failure/retry regression.
- Egress More actions now shares the decision row in the shared approval component.

Verification: root typecheck and final web typecheck passed. The combined task,
approval and message-fragment run passed 317 tests and found two jsdom menu tests
missing the existing CSS.escape support. After importing that shared support, all
53 approval tests passed. Task and catalog suites passed unchanged in the combined
run. Production web build passed (existing chunk-size advisory).

Real demo checks: task detail on 390x844, Back to tasks, New task form; approval
inbox on desktop and mobile, and mobile Details open/close. DOM viewport and
scroll width were both 390px. Screenshots are in
`spikes/page-polish-20261027/`: approvals-desktop.png, approvals-mobile.png and
task-detail-mobile.png. No real approval or task was submitted.

These are first-pass improvements, not completion of the full objective. Next:
finish task list state continuity and group-approval action hierarchy, then inspect
Bots, Board, Files and the remaining routes in the ledger. All untouched pages
remain pending; role/error/empty-state coverage must be audited per page.

Local preview: http://127.0.0.1:5181/demo.html (isolated worktree).

## Second implementation pass: list continuity and Board

Task list search/status now live above the keyed task editor, scoped by workspace.
Opening a task and returning retains the list view, while editor lifetimes and
late-response protections remain unchanged. A navigation regression verifies the
Gateway continues receiving the selected status and search query. All 62 task
tests passed.

Board posts now put Edit/Withdraw, moderation and History in a per-post menu;
permissions still derive from mine/canModerate. Edit mode retains Save/Cancel.
Reduced card padding and shadow weight, bounded reading width and responsive
metadata give the post body priority. Board plus catalog suites: 222 tests passed,
including edit/withdraw ownership, moderation and posting retry behavior.

Root typecheck passed. Browser verification: desktop and 390x844 Board, open
menu, enter edit then cancel without submitting. Mobile document and viewport
width both 390px. Evidence: board-desktop.png and board-mobile.png in the spike
directory. No production mutation. Remaining pages and the outstanding state
coverage in the ledger are still pending; this goal is not complete.

## Third implementation pass: Bots and Files

Bots overview now has one card collection rather than duplicating the same bots
in a rail and cards. The rail remains for profile navigation; the default bot
badge remains visible. Loading, search misses and failed roster fetches are
explicit. A failed profile lookup no longer claims the bot was deleted, and a
regression covers retry into a genuine missing-object result. Responsive testing
found and fixed an old mobile rule hiding the overview after this restructure.

Files describes delivered results and uploads accurately. Scope and upload help
are available in collapsed disclosures. Mobile type filters scroll horizontally;
search/source share a row, and list metadata uses a continuous row background.
This brings results higher on the page without removing filters or provenance.

Verification: 182 focused Contacts/Files tests passed across 26 files; Biome
checked 80 feature files successfully. Earlier catalog-inclusive passes were
274 Contacts/catalog and 318 Files/catalog tests. Root typecheck passed; web
production build passed with its existing chunk-size advisory. Final changes
following that build affect CSS only. Browser checked Bots desktop and 390x844
populated views, Files at 390x844 (document width 390), and opening/closing file
details with focus moving to the detail region. Screenshots: bots-desktop.png,
bots-mobile.png, files-desktop.png, files-mobile.png in the spike directory.
Viewport override was reset. These pages still need the remaining state and
profile/preview audits; the broader page-by-page objective remains active.

## Fourth implementation pass: Skills

Search now precedes the catalog and review queue; the duplicate waiting-count
pill was removed while the queue heading keeps the total. Skills-list and
confirmation-queue errors have independent retry controls. A queue failure no
longer hides the successfully loaded skill list. Two regressions cover isolated
queue retry and recovery from a failed skill fetch. Existing install, assignment,
review and lifecycle actions are unchanged.

Desktop and 390px mobile rendering were inspected on the local demo; document
width matched the viewport. Review findings and decision controls remain visible.
All 24 Skills tests passed. Root typecheck and feature Biome checks passed. The production build passed with
the existing chunk advisory. Skill tests retain review and pagination assertions,
now using the single queue heading rather than the removed duplicate count.
Knowledge inspection has started; its implementation and remaining route audits
are still pending. This pass does not complete the all-page objective.

## Fifth implementation pass: Knowledge document states

Document and proposal requests now expose independent errors and retry actions.
Loading and request failure do not display successful empty-state claims.
An unmatched search names the query; Clear search restores the full library
without touching the editor draft. Document totals appear only after a response.
Mobile search occupies a full row so the action buttons cannot squeeze its value.

All 62 knowledge feature tests passed, including new loading/failure/retry,
proposal retry with a retained draft, and no-match/clear-search regressions.
Production web build passed with the existing chunk-size advisory. Desktop and
390px mobile demo checks covered search miss and clearing back to two documents;
mobile document width was 390px. No publication or approval was submitted.
Observations, maintenance, permission states and all remaining routes stay in
scope and are not considered complete by these document-only checks.

## Sixth implementation pass: Observations filtering

The observations search/history controls now precede a potentially long review
queue. A new search or filter request enters a loading state instead of leaving
old results under the new query. Failed loading offers retry; load-more is hidden
until the active request completes. A regression holds a search in flight,
verifies the old row disappears, fails it, and recovers through Retry observations.

All 63 Knowledge tests passed; root typecheck and feature Biome passed. Production
build passed with the existing chunk advisory. Browser inspected populated
desktop and 390px mobile views (document width 390), expanded and collapsed the
maintenance panel without submitting settings or triggering a model call, then
reset viewport. Maintenance keeps its on-demand disclosure and explanatory copy.
Remaining role, editing and cross-page audits are still tracked by the ledger.

## Seventh implementation pass: Members and invitations

Mobile member rows now stack identity, labelled role/status and permitted actions
without a horizontally squeezed desktop table. Removed card shadow weight.
Invitation failures are local to the invitation section with an independent
retry; loading and a confirmed empty result have explicit messages. A regression
verifies retry keeps the member list and workspace scope unchanged.

All 20 Members feature tests passed. Root typecheck and feature Biome passed;
production build passed with the existing chunk advisory. Browser checks covered
390px mobile members (document width 390), opening and cancelling the invite form
without submitting, and restoring the desktop viewport. Existing role-change,
protected-account and pagination checks remain in the passing suite. No account,
role or invitation was changed in the browser. Remaining pages are still pending.

## Eighth implementation pass: Run replay recovery

Initial replay failures now show an alert with Reload run instead of leaving a
loading claim and empty metadata panel. Explicit reload tears down the old event
subscriptions and begins a fresh fetch/subscription lifecycle; existing replay
content is retained. A regression covers initial network failure, hidden empty
metadata and successful retry. The missing-object behavior remains distinct.

All 111 Runs tests across 17 files passed, including live-event/reconnect tests.
Root typecheck, feature Biome and web build passed (existing chunk advisory).
Browser followed a demo observation's stale run reference and verified the
missing-object state. This does not prove normal replay visual acceptance;
normal desktop/mobile replay and statistics/analytics remain open in the ledger.

## Ninth implementation pass: Costs report filters

A failed request after changing the period no longer redisplays the previous
report below the newly selected period. Retry uses the exact failed query,
independent of later edits to unapplied controls. A regression verifies old
totals disappear on failure and return after retry of the requested range.
Mobile period buttons remain single-line in a horizontally scrollable control
instead of squeezing each date label into multiple lines.

All 45 Costs tests passed, root typecheck and feature Biome passed, and production
build passed with the existing chunk advisory. Browser inspected populated money
view and custom filters at 390px, selected the 30-day period and restored desktop.
The document remained 390px wide; the dense activity table scrolls in its own
container. Budget controls were not changed. Rankings, budget/limit flows and
remaining routes are still pending and are not covered by this report-only pass.

## Tenth implementation pass: Ranking state and budget roles

Cost ranking identity now includes grouping, view and applied filters. Switching
identity starts from the first page with no old rows; paging shows loading rather
than old rows under the new offset. Failed ranking requests expose local retry,
and retired requests are invalidated on unmount. A regression verifies switching
money to usage, a delayed failure, and retry in the same usage scope.

Budget cards now pass their own workspace ID to both budget.set and
budget.continue presentation checks. Previously they inherited the selected
workspace or highest role, even though this page lists several workspaces. A
regression shows an Owner in one workspace and Guest in another receives an
Edit limits action only in the owned workspace. Gateway enforcement is unchanged.

All 47 Costs tests passed. Root typecheck, feature Biome and production build
passed, with the existing chunk advisory. No live budget or permission change was
made. This is state/permission regression evidence, not completion of every
budget lifecycle or the remaining page coverage.

## Eleventh implementation pass: Trash preview coverage

The demo had no GET /api/trash route, so the page could only demonstrate an
error. Added feature-owned in-memory archived-workspace data, paged listing and
idempotent restore into the demo active workspace list. The fixture uses a fixed
ID and does not shift existing generated IDs. No production lifecycle API changed.

All 25 Trash/feature-discovery tests passed, covering loading/error/retry,
duplicate restore protection, paging back after restore, Member denial, permission
loss and demo restoration. Root typecheck and production build passed, with the
existing chunk advisory. Browser checked populated Trash at desktop and 390px,
restored the mock workspace, observed the success/empty state and selected
restored workspace, then reset viewport. Account review has begun but is pending.

## Twelfth implementation pass: Account editor focus

Account photo selection now moves keyboard focus to Save photo. Saving or
rejecting the preview returns focus to Change photo after React mounts it;
previously the synchronous focus call targeted an absent button. The regression
covers preview focus, discard without upload, selection again and successful
save focus. Display-name editing and cancellation were also verified in the
390px preview; cancellation restored focus and left the stored name unchanged.
The mobile category navigation scrolls within its own row.

All 26 Account tests passed, root typecheck and feature Biome passed, and the
production build passed with the existing chunk advisory. No real profile,
password or access token was changed. Agent access and workspace settings still
need their remaining page audit; this pass does not close those routes.

## Thirteenth implementation pass: Workspace directory

Removed the repeated Workspaces label from the loaded list header; it now shows
the authorized result count. Mobile rows retain My role and Running, alongside
Bots and Last activity, rather than dropping those facts. The mobile rendering
was inspected at 390px and the viewport was reset afterwards.

Pin changes now lock only the pending row until its request settles. Duplicate
clicks cannot issue conflicting mutations; a failure restores the previous pin
and enables retry. A deferred-failure regression checks the pending row, an
independent enabled row, single request and rollback. All 29 workspace tests
passed; root typecheck and production build passed (existing chunk advisory).
Agent access was inspected without issuing a key. Workspace detail and remaining
Agent access state/visual review are still pending.

## Fourteenth implementation pass: Workspace detail recovery

An archived-directory request failure no longer becomes a false not-found
message. It reaches the detail error state and Retry repeats the authorized
active/archived lookup. Network policy and Web search each offer a local read
retry without submitting settings or refreshing unrelated editors. Web search
clears the old error when retrying. Existing permission and configuration
semantics remain unchanged.

The combined workspace and web-search suites passed 37 tests, including archived
lookup failure/recovery and both local retries with no configuration writes.
Root typecheck, changed-feature Biome and production build passed (existing chunk
advisory). Normal workspace detail and Tools & network were inspected at desktop
and 390px, and viewport reset. No real network/approval/search policy was changed.
Remaining lifecycle, role, app-share and advanced setting states are still open.

## Fifteenth implementation pass: Vault and shared apps

A failed Vault request-definition save preserves its non-secret name, path and
parameter draft for correction. Explicit Cancel discards it. Secret values still
clear after every submission, as required by ADR-0045. Removed the duplicated
purpose paragraph from the credential dialog and added catalog reload after a
read failure. The empty page and create dialog were inspected at desktop/390px
without entering or submitting a credential.

Shared apps now exposes a read retry even when its first list request fails.
Port validation reuses appSharePortAllowed from contracts, including the reserved
desktop ports; an associated field message explains why Share is unavailable.
Browser checked the populated app section and reserved-port feedback at 390px,
cleared the input and restored desktop. No app was published or revoked.

All 40 Vault/app-share tests passed, including failed definition preservation,
explicit discard, read recovery and invalid/reserved port cases. Root typecheck,
feature Biome and production build passed (existing chunk advisory). Further
workspace-switch/late-response and concurrent app mutation audits remain open.

## Sixteenth implementation pass: Workspace lifetimes and Computer

Vault and Shared apps now key their local state by workspace. A late catalog or
publish response from a retired workspace cannot replace the selected workspace's
content or call its list callback. Vault reads also discard superseded results.
Shared-app mutations are serialized at the panel, and apply to the latest list
snapshot; refresh and other write controls wait for the mutation to finish.
Deferred-response regressions verify switching before completion and cleared
form state in the newly selected workspace.

Computer now places Bots and desktops before infrastructure explanations, bounds
the reading column to 960px, and uses smaller mobile card padding. Failed roster
reads have a local retry and no false zero/empty roster. Normal populated desktop
and 390px views were inspected; no desktop was started or taken over. The combined
Computer/Vault/app-share suites passed 65 tests. Root typecheck, changed-feature
Biome and production build passed (existing chunk advisory). Advanced tools,
working directories and lifecycle review remain pending.

## Seventeenth implementation pass: Advanced settings recovery and editing

Desktop tools and working-directory settings now offer local read retries. Workdir
editing focuses the mode control, restores Edit focus on close, disables unchanged
saves and locks inputs/cancel while saving. Refused saves retain the draft; cancel
clears the draft and error. Mobile action spacing was checked at 390px.

Workspace network reads reset on workspace changes and ignore late results. Local
retry distinguishes unavailable data from an empty policy. Saving the separate
open-internet setting preserves unsubmitted profile selections. Changing a
connectivity URL clears the previous result. The profile list no longer shows
permanent loading after a read failure; workspace discovery has independent retry.
Host diagnostics follow the profile list. Profile editing focuses Name and returns
focus on close, prevents other edits/deletes from replacing the open draft, and
locks fields while saving. A refused save retains inputs until explicitly canceled.

All 55 tests across Network, Workdir and Desktop tools passed, including delayed
save/refusal and draft-preservation regressions. Root typecheck, feature Biome,
diff whitespace checks and web production build passed (existing chunk advisory).
Desktop and 390px profile forms were inspected in the local demo; New/Cancel focus
was verified. Screenshot: /private/tmp/network-editor-mobile-20261027.png. No
network grant, tool mode or working-directory policy was submitted in the browser.
The viewport and temporary Tune preference were restored. Connections, remaining
page states and the integrated all-page completion audit remain outstanding.

## Eighteenth implementation pass: Connection forms and database recovery

Apps connection dialogs now reset the connection name, credential and error when
closed or changed to another provider. Fields lock during submission, refusals
are announced as alerts, and closing restores focus to the invoking Connect/Add
account button. Database registration also discards canceled fields/credentials
and locks inputs while saving. Database list errors no longer become a successful
zero-count result: loading and retry are explicit, with translated shared strings.
Tests use dummy credentials only; no real connection or grant was created.

All 61 integration-feature tests passed, including canceled cross-provider drafts,
pending submission/refusal, database read recovery without a false zero count and
canceled database fields. Root typecheck, feature Biome, diff whitespace check and
production build passed (existing chunk advisory). The local Apps demo was checked
at desktop and 390px; closing returned focus to Connect Slack. Screenshot:
/private/tmp/connections-apps-mobile-20261027.png. Viewport restored.

Remaining Connections review includes catalog/account read recovery, workspace tab
counts, lifecycle timing, channel states and visual density. The Apps dialog also
currently repeats Google Drive-specific permission copy for other providers;
provider-specific explanatory copy needs follow-up. These passes do not establish
all-page completion.

## Nineteenth implementation pass: App recovery and relevant connection copy

Apps catalog/status and account-list failures now have independent visible retries;
retrying accounts does not refetch the catalog. Initial status reads report loading.
Read errors are separate from mutation errors so a successful unrelated operation
cannot silently hide a failed account read. The connect dialog now has one concise
account explanation; the Drive file-access notice appears only for `googledrive`,
not Slack or other providers, and duplicated general approval prose was removed
from the dialog. All five locale catalogs were updated.

All 64 integration-feature tests passed, including independent recovery and the
Drive-only notice. Root typecheck, feature Biome, diff whitespace and production
build passed (existing chunk advisory). Slack dialog desktop/390px layout and
close-focus restoration were inspected without connecting anything. Screenshot:
/private/tmp/connection-dialog-desktop-20261027.png. Viewport restored.
Remaining work includes catalog visual density, tab-count scoping, channel lifecycle
states and the other page-specific items in the coverage ledger.

## Twentieth implementation pass: App catalog density and workspace counts

App discovery now uses a single card layer: the In use and Ready to connect sections
have no surrounding panels, catalog cards have neutral borders without shadows,
and compact mobile cards place the action beside the app description where space
allows. Desktop retains the catalog grid and search/category controls. Checked at
390px and 1280px; screenshot: /private/tmp/apps-catalog-compact-mobile-20261027.png.

Connection tab counts are stored per workspace. A delayed count report from a
previous workspace cannot change the active workspace's badges. A regression
switches workspaces and delivers the old callback after switching. The complete
integration feature suite passed 65 tests. Final typecheck/build verification is
recorded below after completion. Channel lifecycle and remaining page audits stay
open; this is not an all-page completion claim.

Final root typecheck and web build passed (existing chunk advisory); the test-only
Testing Library option mismatch found by typecheck was removed. Feature Biome and
diff whitespace checks passed. Browser viewport override was reset.

## Twenty-first implementation pass: Channel read ordering and integrated audit

Channel background refresh skips overlapping reads. Manual retries supersede old
requests; stale responses and responses after unmount cannot replace channel state.
Initial reads show loading, retry controls wait for foreground refresh, and counts
are reported only after a successful read. Deferred-response regressions cover
background overlap, newer manual success followed by an older response, and unmount.
All 67 integration tests passed; root typecheck and web build passed (existing
chunk advisory). Normal populated channels were inspected in the local demo.

The full Web suite ran 1,815 tests: 1,814 passed and the demo golden sweep failed
because the new Trash demo had no sweep request. This was missing coverage, not an
old expected response. Added discovered per-feature `demo-probes.ts` read paths and
a Trash-owned probe rather than another entry in the shared sweep list. Generated
and inspected the two Trash seed/after-session records; only the new Trash snapshot
was written. The existing 27 demo-golden tests passed during generation; a separate
non-update verification and final typecheck follow. All-page completion is still
unproven. Next entry-page audit found transient invitation lookup failures currently
reported as invalid invitations; that implementation remains outstanding.

Non-update demo/Trash verification passed all 49 tests, final root typecheck and
whitespace check passed. Full-suite coverage is the 1,814 original passes plus the
fixed golden test's focused rerun, not a second full-suite run.


## Twenty-second implementation pass: Invitation recovery and sign-in pending state

Transient invitation lookup failures now say the invitation could not be loaded
and offer a local retry. Confirmed 400/404 invalid links and 410 used/revoked/expired
links retain their own messages. Invitation forms are keyed by token: changing the
link immediately drops the old fields and checks the new invitation, with no stale
username/password draft. All five locale catalogs include the recovery copy.
Sign-in now locks local and SSO controls while starting an SSO flow, recovering on
failure rather than allowing multiple concurrent starts.

All 32 invitation, route, sign-in and app-auth tests passed, including deferred
lookup, changed token, transient retry and repeated SSO-click regressions. Root
typecheck, changed-file Biome, whitespace check and web build passed (existing chunk
advisory). No actual authentication, password change or invitation acceptance was
performed. Browser visual verification of these entry states remains outstanding;
the normal signed-in demo does not exercise the bootstrap authentication flow.

## Twenty-third implementation pass: Run statistics and normal run inspection

The Run statistics bot setting now retries failed reads locally, without a write.
Its editor lifetime is keyed by bot, so a late save for the previous bot cannot
replace the selected bot's setting. Deferred-save and read-retry regressions pass.
Analytics is an external Grafana link, not a date-filter report in this application;
its existing URL/access/link tests were included. All 16 run-statistics/analytics
tests, root typecheck, feature Biome, whitespace check and web build passed (existing
chunk advisory).

Normal run `run_000u` was opened through chief's activity in the local demo. Summary,
story and expanded Details were inspected at desktop and 390px; the drawer closed
back to the same bot profile. Screenshot: /private/tmp/run-details-mobile-20261027.png.
No run was started/stopped and no statistics tool was enabled. The normal run visual
gap from pass 8 is now inspected. Closing the drawer returned focus to the document
rather than its Work details link; shared drawer focus recovery remains a concrete
follow-up. Viewport override reset. Bot statistics setting visual and additional
run permission/state checks remain outstanding.

## Twenty-fourth implementation pass: Drawer return focus

The shell records an activated feature-drawer link in the retained work area, even
when a pointer click does not focus the anchor. Responsive reparenting no longer
overwrites that opener with the drawer's own resize handle. Close restores only a
still-connected opener on the return route, then clears the reference. Modified
clicks that open another browser tab are excluded.

Browser reproduction: open chief's Work details at desktop, resize to 390px, close.
Accessibility state now confirms Work details has focus (previously the document).
Screenshot: /private/tmp/run-return-focus-mobile-20261027.png. Viewport reset.
Navigation registry tests passed 19 cases; app navigation/focus tests passed 9,
including both retained and removed openers. Root typecheck, Biome, whitespace and
web build passed (existing chunk advisory). The removed-opener regression was added
and run after the build; production code was unchanged. This closes the concrete
focus gap from pass 23, not the remaining all-page audit.

## Twenty-fifth implementation pass: Bot activity hierarchy

The Bot Activity tab now leads with recent work and its detail/chat links. Desktop
preview follows; the configuration summary is a closed disclosure rather than a
full metadata panel before the activity. Removed the summary's duplicated Last
status row (the profile header already reports it). Model, schedules, channel,
connector and creation metadata remain accessible in the disclosure, including the
schedule settings shortcut. No bot configuration or authorization changed.

All 69 Contacts tests, root typecheck, changed-file Biome, whitespace check and web
build passed (existing chunk advisory). Inspected populated desktop and 390px views,
opened the summary, followed its schedule shortcut into Settings and returned to
Activity. No schedule or desktop was started. Screenshot:
/private/tmp/bot-activity-mobile-20261027.png. Viewport reset. Initial activity feed
loading/error semantics remain an identified follow-up: useRunFeed currently offers
no initial-loading state to distinguish pending reads from no runs.

## Twenty-sixth implementation pass: Activity loading and read recovery

The shared run feed now exposes loading and explicit reload without discarding
already-loaded history. A successful first page initializes its older cursor even
when the first attempt failed; subsequent refreshes retain the pagination position.
Older-page success clears a previous page error, and scope changes reset its pending
indicator. A regression fails the initial request, retries, then follows the recovered
older cursor. Existing stream ordering and stale-scope tests remain passing.

Bot profiles use this state to distinguish pending/failed reads from truly empty
activity. They no longer show Never ran while loading or after a failed read, and
show a local retry alongside the activity error while retaining any existing cards.
All 456 tests across Runs, Contacts and Chats passed, as did root typecheck, feature
Biome, whitespace checks and web build (existing chunk advisory). No runtime action
was started. The private chat consumer still reports a feed error without a retry
control; wiring the new reload state there remains a follow-up. Broader page and
visual acceptance remains in progress.

## Twenty-seventh implementation pass: Private-chat activity recovery

The private-chat activity error now includes a local Retry action backed by the
shared run feed. It retains the selected bot scope and does not remount the
conversation, send a message or start a run. The error component is shared by the
actual chat pane and regression harness. The regression fails the initial read,
retries, verifies the recovered activity card and checks both requests use the
same bot scope. Existing activity filtering and stream tests remain passing.

All 276 Chats tests passed, as did root typecheck, changed-file Biome, whitespace
checks and the production web build (existing chunk-size advisory). No browser
visual check was performed for this small error-state addition. The coverage
ledger still requires the broader page/detail/role and visual audits; this pass
does not close the overall objective.

## Twenty-eighth implementation pass: File preview recovery and identity

File previews now offer Retry inside the open panel. Each workspace/path identity
owns its own preview state, so replacing a file entry cannot retain old bytes,
source mode or remote-image consent. New reads clear stale content; a cancelled
read cannot write a late error into a reopened preview. Existing byte limits,
authorized range reads and inert rendering remain unchanged.

All 115 Files tests, root typecheck and production web build passed; changed-file
Biome and whitespace checks passed. Added regressions cover failed-read retry and
replacing an open file with a different path. In the local demo, opened kpis.md
from Files, inspected the mobile 390px preview and closed it; focus returned to
Preview file. Screenshot: /private/tmp/file-preview-mobile-20261027.png. Viewport
was reset. No uploads or downloads were performed. Visual inspection also exposed
a remaining hierarchy issue in the file details: extensive provenance metadata
precedes Preview/Download, and filename/path repeat. That detail-panel hierarchy
remains follow-up work; overall page acceptance remains incomplete.

## Twenty-ninth implementation pass: File detail hierarchy

File details now lead with one filename/path and Preview/Download. A parent-owned
identity lets the shared preview render actions without repeating that identity
or nesting another bordered card. Verification status stays visible; type, size,
source explanation, verification audit and reference timestamp move into File
information. Current-byte caveat and provenance links remain accessible. The new
label is present in all five catalogs. Updated existing assertions for the single
visible path; no authorization, deletion or file-reading behavior changed.

All 115 Files tests passed after updating two old path selectors; root typecheck,
web build and Biome passed. The final action-row styling was inspected in the
local demo at desktop and 390px widths. Expanded information retained the source
and audit notes. Screenshot: /private/tmp/file-details-mobile-20261027.png. The
viewport was reset. The file detail remains inline below the list on mobile;
full lifecycle/permission and wider page acceptance remain in progress.

## Thirtieth implementation pass: Mobile file navigation

At 640px and below, opening a listed or linked file hides the collection controls
and results, leaving its detail with Back to files. Closing restores the existing
list state rather than remounting it, and returns keyboard focus to the opener
when available. Desktop retains the side-by-side collection. The back label is
translated in all five catalogs.

A 390px demo check verified detail-only presentation and Back returning focus to
the exact kpis.md row. Screenshot: /private/tmp/files-mobile-navigation-20261027.png;
viewport reset. An initial typecheck caught an accidentally changed no-workspace
branch; corrected before final verification. Final root typecheck, all 115 Files
tests, production web build, Biome and whitespace checks passed. Full page and
role-state acceptance remains in progress.

## Thirty-first implementation pass: Board read recovery

Board errors now offer a local Retry. The retry targets the failed page: newest
for refresh failures, the retained cursor for older-page failures. It is disabled
while a relevant read is pending. Existing posts and the unsent composer draft
stay mounted. Workspace-discovery failures are shown with their own reload rather
than a misleading no-workspace empty state.

Two regressions cover initial-read recovery preserving an unsent draft (no post
API call) and older-page recovery preserving current posts and retrying the exact
cursor. All 19 Board tests passed, along with root typecheck, web build, feature
Biome and whitespace checks. This turn did not perform a new browser visual
check; prior Board layout evidence still applies only to its inspected states.
The broader detail/role/visual acceptance remains incomplete.

## Thirty-second implementation pass: Integrated audit and invitation correction

Repository lint checked 2526 files without changes and docs:check passed. The Web
integration run covered 256 files / 1828 tests: 1827 passed; the existing tenancy
invitation regression failed because the new retry classification treated a 401
rejected invitation token as a transient connection failure. Gateway auth-service
and error mapping confirm token_rejected is 401. Invitation preview now treats
that response as invalid while retaining retry for transient failures. All 17
invitation/tenancy tests then passed. This is a corrected focused rerun, not a
claim of a second full-suite run.

Code inspection identified the next concrete Skills issue: version-history
errors replace already loaded history, have no local retry, and successful older
page reads do not clear historyError. This remains pending. The full-page
completion audit still requires the ledger's visual and role-state coverage.

## Thirty-third implementation pass: Skill history recovery

Skill version history keeps loaded records visible alongside read errors. Local
Retry history retries the newest read or the failed older cursor as appropriate,
without closing the detail. Initial read loading is distinct from failed reads;
newer refreshes reset older loading, and stale request finalizers cannot unset
current loading. Successful retries remove the error. All five catalogs include
the action label.

Two regressions cover first-read recovery and retained v2 while an older-page
request fails, followed by successful v1 recovery using the same cursor. All 26
Skills tests passed, with root typecheck, web build, feature Biome and whitespace
checks. No skill was installed, assigned, confirmed or otherwise changed in a live
workspace. This turn did not add browser visual evidence; broader Skills role,
detail and mobile acceptance remains pending.

## Thirty-fourth implementation pass: Skill detail hierarchy and mobile navigation

Skills now keep stage, enabled bots, version and Assign ahead of a closed Source
and verification disclosure. Origin, full hash, provenance and listing date remain
available there; version history remains visible. At phone widths, a selected
skill hides the unrelated install header, search, starter list and confirmation
queue, with Back to skills restoring the existing list. Confirmation controls and
scan findings are unchanged. New presentation rules live in feature-owned CSS.

All 26 Skills tests, root typecheck, production web build, feature Biome and
whitespace checks passed. Inspected the demo detail at 390px, expanded the audit
information and returned to the list; screenshot
/private/tmp/skill-details-mobile-20261027.png. Viewport reset. No skill mutation
was submitted. Keyboard focus returns to the page rather than the selected row;
focus continuity and broader role-state acceptance remain follow-ups.

## Thirty-fifth implementation pass: Skill detail focus continuity

Opening a skill focuses its detail region; closing or using Back restores focus
to that skill's current list button when it still exists. Row references are
removed on unmount rather than retaining detached elements. Search remains owned
by the parent view. A regression searches, opens a detail, checks focus inside it,
closes and checks both restored focus and preserved query.

All 27 Skills tests passed. Typecheck caught a missing explicit useRef initializer;
corrected it and reran root typecheck and web build successfully. Feature Biome
and whitespace checks passed. Gateway role-policy inspection confirms Skills
reads require Member and mutations require Admin; the next UI role audit must
check every mutation entry against these policies. Overall acceptance remains
incomplete.

## Thirty-sixth implementation pass: Skills workspace-role affordances

Added a skills.manage action mapped to the existing Admin-only install policy.
The Skills UI evaluates it for the displayed workspace, hides installation and
mutation menu entries from readers, disables confirmation/rejection and detail
mutation controls, and guards the shared mutation function. Readable records,
scan findings and history remain visible, with a translated Admin/Owner note.
Gateway authorization is unchanged. Five role-action catalogs and five Skills
catalogs include the new labels.

A regression uses a session whose highest role is Owner but whose role in the
current workspace is Member. It verifies installation is absent, confirmation,
rejection, assignment and stage controls are disabled, and history remains
readable. The affected Skills/contracts/route suites passed 35 tests, and Gateway
role-action alignment passed 111 tests. Web build and feature Biome passed. A
Testing Library option rejected by TypeScript was removed before rerunning root
typecheck. This adds role-state evidence, not full visual acceptance for every
role or completion of the wider objective.

## Thirty-seventh implementation pass: Observation save-state continuity

Observation edit fields, Cancel, detail Close and selection buttons now stay
locked while a mutation is pending. This prevents a late save result from
silently closing a different draft. On failure, the original revised text remains
and editing/cancel become available again. Batch confirmation's Cancel is also
disabled during its request, avoiding an apparent cancellation of an already
submitted operation. No mutation or review rules changed.

A deferred-save regression verifies the pending locks, rejects the save and
checks the preserved draft, error and restored controls. All 64 Knowledge tests
passed; root typecheck and build passed before the final disabled list-button
attribute, whose feature tests and Biome were then rerun. Whitespace check passed.
This turn added no browser evidence or live memory mutation. Broader knowledge
lifecycle, permissions and visual acceptance remain in progress.

## Thirty-eighth implementation pass: Observation history request lifetime

Observation version requests now carry a local sequence invalidated by detail
close or selection changes. Both responses and errors must match the current
sequence before updating UI, preventing a late result from replacing another
entry's history or reporting an obsolete failure. A loading output accompanies
history reads and older-page loading disables its repeat action.

A deferred rejection regression opens Versions, verifies loading, closes the
detail and rejects the old request; no stale alert or reopened detail appears.
All 65 Knowledge tests passed, with root typecheck, web build, changed-file Biome
and whitespace checks. No live observation mutation or browser visual check was
performed. Broader page acceptance remains incomplete.

## Thirty-ninth implementation pass: Repository integration verification started

Rechecked lint (2526 files, no changes) and documentation consistency: both pass.
Started the full npm test gate. The sandbox denied localhost listening, causing
EPERM in integration fixtures; stopped that restricted run with exit 130, then
restarted with approved execution permissions. The authorized run is still live
in exec session 28990, logging to /tmp/page-repository-tests-unrestricted.log.
Its outcome is pending and must be collected before another full run is started.
No passing full-suite claim is made here.

Updated the coverage ledger to reflect the latest Files, Skills, Board, Knowledge
and shell evidence. Remaining lifecycle, role and visual states remain explicit;
no area was promoted to complete solely because its focused tests passed.

## Fortieth implementation pass: Agent access role accuracy

Agent access now offers key creation only when the authenticated session is the
protected root, matching ADR-0031 Q2 and the existing service-principals route
policy. Non-root Owners, Admins and Members retain the safe installation prompt
and receive the accurate root requirement. Creation also guards pending/rejected
calls locally. The role explanation now states that the key's assigned permissions
apply rather than claiming it inherits the operator's role. Five locales updated.

Tests explicitly mark issuance fixtures as root and check all three non-root
roles see no creation control or principal API call. All 28 Account tests passed;
root typecheck and web build passed. No real key was created or copied. The
repository-wide run remains live in session 28990; its log contains an origin-wait
20ms wall-clock deadline failure and requires final collection and focused
investigation, not an assumed pass. The full run began before this Account change;
its outcome must be paired with the focused Account verification.

## Forty-first implementation pass: Full-gate result and Agent access layout

The authorized full npm test run completed with 8581 passed and 3 failed tests
across 914 files (912 files passed). Failures: origin-wait's 20ms real-clock acquire
expectation and two stable script cases exceeding their 5s timeouts. Started one
focused, single-worker rerun of those two unchanged files; it remains live in
session 78364, log /tmp/page-repository-timing-recheck.log. Do not start a duplicate
or infer success while it is pending. No sidecar/runtime or deployment code was
changed to bypass these failures.

Agent access now places Copy prompt before a closed disclosure containing the full
installation text. Copy content and secret separation are unchanged. Checked the
390px non-root view and opened the disclosure; no key was issued or copied.
Screenshot: /private/tmp/agent-access-mobile-20261027.png; viewport reset. All 28
Account tests, root typecheck and web build passed. Full acceptance remains open.

## Forty-second implementation pass: Task template read recovery

The single-worker retry from pass 41 completed: both unchanged test files passed,
47 tests total (86.94s), recorded in /tmp/page-repository-timing-recheck.log.
This is focused evidence consistent with timing sensitivity under suite load,
not a replacement successful full-suite result. No runtime/stable test was edited.

Task templates now distinguish loading, failed reads and a genuine empty list.
A failed read has an explicit Retry action; retry preserves an open editor draft.
While editing, the template list is hidden so another row cannot replace the
editing identity while the form still holds the previous template's useState
snapshot. Cancel returns to the list. Five locale catalogs were updated.
A regression verifies failed-read recovery retains the draft and issues only GETs.
All 11 task-kind tests, root typecheck, web build, scoped Biome and diff whitespace
checks passed. Browser verification of this pass remains pending; no template was
created, changed or archived in a running workspace. Overall acceptance is open.

## Forty-third implementation pass: Template editor mobile flow

Inspected the real demo template dialog at desktop and 390px. On mobile, the
long list introduction occupied the top of the editor, and opening/cancelling
editing left focus on the dialog container. The introduction now stays on the
list; the editor focuses its first enabled input. Returning to the list restores
focus to the specific New/Copy/Edit control using its stable template key, even
though the list controls remount. Existing template content remains unchanged.

Verified copy opens with the expected populated fields; Cancel returns to the
unchanged list and focuses Copy into a new kind. No create/update/archive request
was submitted. Screenshot: /private/tmp/task-template-editor-mobile-20261027.png.
Viewport reset. All 11 task-kind tests passed; the focused dialog suite (5 tests)
passed again after adding the cancel focus assertion. Root typecheck, web build,
scoped Biome and diff whitespace checks passed (existing build chunk advisory).
Overall page-by-page acceptance remains open.

## Forty-fourth implementation pass: Template mutation lifecycle

Archive now serializes requests and disables New/Copy/Edit/Archive while pending;
failed requests retain the list and restore controls. A ref guards even repeated
clicks before rendering. A response after dialog unmount cannot trigger list reads
or update dialog state. Loss of workspace management permission removes an open
editor immediately and clears its draft; the highest role in another workspace
does not keep management controls visible. Gateway authorization is unchanged.

Added delayed archive-failure/double-click and live role-change regressions.
The network rejection test initially expected a raw fixture error; corrected it
to assert the transport's actual connection message. Typecheck also caught an
unsupported Testing Library `exact` option (including the pass 43 cancel test);
replaced it with anchored name patterns. This corrects pass 43's overbroad claim
that its final test edit was typechecked. Final root typecheck and all 13 task-kind
tests passed after the correction. Web build passed, with its existing chunk-size
advisory. No live template archive or permission change was performed.

## Forty-fifth implementation pass: Member onboarding continuity

Invite/Create entry buttons now remain disabled while either form submits, so a
pending account or invitation cannot be hidden by switching forms. Submit handlers
also reject repeated submissions while busy; failure retains fields and restores
navigation. MemberOnboarding is keyed by the selected workspace so drafts and
one-time result panels cannot leak into another workspace after navigation.

Regression tests cover delayed account failure/repeated submit and a late result
after workspace switching. All 22 Members tests passed. Root typecheck and web
build passed; web typecheck passed again after the final scope regression was
added. Scoped Biome and diff whitespace checks passed. No real account, invitation,
permission, password or clipboard operation was performed. This pass changes
pending-state behavior; previous mobile evidence remains, with broader lifecycle
and visual acceptance still open.

## Forty-sixth implementation pass: Approval inbox reconnect ordering

Audited grouped inbox reads and found overlapping reconnect/refetch responses
could overwrite a newer snapshot: an older response could restore already-cleared
requests. Each refetch now owns a request sequence; only the newest request may
publish its result, error or loaded state within the active cursor lifetime.
Group decision policy and backend authorization were not modified.

A regression delivers two reconnect responses out of order and verifies that the
newer empty inbox remains empty when the older pending snapshot arrives. All 54
approval tests passed, including existing group decisions, cursor paging, SSE and
409 reconciliation cases. Root typecheck, web build, scoped Biome and whitespace
checks passed. No real approval was decided. This is data-state evidence, not
completion of the remaining group-action/permission and rendered-state audit.

## Forty-seventh implementation pass: Board edit recovery and focus

Board post actions now guard concurrent submissions with a synchronous pending
ref, including history reads. Failed edits retain the draft; Cancel clears the
operation error and restores the original text. Opening an editor focuses its
textarea; leaving it restores focus to that post's menu. Existing mine and
canModerate affordances remain unchanged and their regressions pass.

Added a delayed failure/double-submit/cancel regression. All 20 Board tests passed,
including own-post versus other-post actions and moderator hide/unhide controls.
Root typecheck/build passed before the final focus-return edit; final web typecheck,
Board tests, scoped Biome and whitespace checks passed afterwards. Browser demo
checked mobile editing at 390px and desktop cancel focus restoration; no post was
saved, withdrawn or moderated. Screenshot:
/private/tmp/board-edit-mobile-20261027.png. Viewport reset. Remaining overall
route/state acceptance is not implied by this page-level evidence.

## Forty-eighth implementation pass: Invitation and sign-in entry

Invitation forms now disable switching between creation and sign-in while a
request is pending. The SSO invitation path now sets busy before starting, blocks
duplicate starts, clears an earlier error, and unlocks on failure, matching the
ordinary sign-in screen. Credential helper text uses start alignment to match its
fields instead of centering multi-line guidance on mobile.

Added delayed SSO failure/double-click coverage. All 19 invitation/sign-in/tenancy
tests passed; root typecheck and web build passed. The helper alignment was then
checked with scoped Biome, whitespace validation and the actual demo render.
Browser checked signup at 390px, switching to existing-account sign-in, expired
invitation messaging and its sign-in link, plus mobile/desktop sign-in. No username,
password, account or invitation acceptance was submitted. Screenshots:
/private/tmp/invite-mobile-20261027.png and
/private/tmp/sign-in-mobile-20261028.png. Viewport reset. Broader page acceptance
remains open; these checks do not assert success for every authentication state.

## Forty-ninth implementation pass: Integrated Web gate and budget recovery

Collected the complete Web run after pass 48: 256 files and all 1844 tests passed
(81.38s), log /tmp/page-integrated-web-20261028.log. Repository lint passed across
2526 files, and docs consistency passed (traceability only). This replaces the
older failed Web-only integration outcome with current successful Web evidence;
it does not replace the full-repository timing-failure record from pass 41.

After that run, budget panel reads gained a local retry in all five locales.
Saving locks both limit inputs and Cancel; failure preserves the draft, and Cancel
clears its error. Save/Continue handlers guard pending and role state; exhausted
budgets still cannot continue, and increasing a limit does not resume work.
Added budget read-retry and delayed-save-failure regressions. All 49 Costs tests,
root typecheck, web build, scoped Biome and whitespace checks passed after these
new changes. No real budget was changed and no parked run was resumed. Budget
visual/lifecycle acceptance and the remaining page matrix are still open.

## Fiftieth implementation pass: Budget editor navigation

Inspected the actual Costs demo at desktop and 390px, including opening the
workspace budget editor. Fields and buttons fit; opening/removing the inline form
previously lost the active control. Editing now focuses Weekly limit, and Cancel
or a successful save returns to that workspace's Edit limits button after the
pending state clears. Regression assertions cover both save and cancel focus.

All 49 Costs tests passed. Root typecheck and build passed; final web typecheck
passed again after the final focus-effect/test adjustment. Scoped Biome and diff
whitespace checks passed. Browser confirmed focus entering the form and returning
on Cancel; screenshot /private/tmp/budget-edit-mobile-20261028.png. No value was
submitted and no parked work resumed. Viewport reset. Full page/state acceptance
remains open.

## Fifty-first implementation pass: Missing and denied-page exits

MissingPage and ForbiddenPage now use the shared primary ButtonLink for Back to
chats rather than legacy anchor classes, which rendered as ordinary text. Long
missing addresses wrap on mobile. Direct denied Trash access also has a Back to
chats action, usable even by a Guest who cannot enter Computer. It still does not
mount the archived-workspace reader when permission is absent.

Inspected the unknown-route page at 390px, followed Back to chats successfully,
and inspected the populated Trash at 390px without restoring anything. Screenshots:
/private/tmp/missing-page-mobile-20261028.png and
/private/tmp/trash-mobile-20261028.png. Viewport reset. All 41 navigation/Trash tests
passed, covering forbidden route fetch suppression, Member direct denial, role
loss, restore failure/duplicate protection and paging. Root typecheck/build,
scoped Biome and diff whitespace checks passed. These checks cover fallback route
and Trash behavior; feature-specific missing/deleted object states remain in scope.

## Fifty-second implementation pass: Workspace creation continuity

New workspace now synchronously rejects duplicate submits and invalid names,
locks the name/network fields while pending, keeps failed drafts, and clears name,
domains, selected network mode and error on explicit close or successful creation.
Failures are announced with role=alert. WorkspaceNameField accepts disabled, also
used by rename while pending; rename guards pending, role and archived state.

Added a delayed failure regression covering duplicate creation, close prevention
while pending, draft retention and a clean reopened dialog. All 32 Workspace tests
passed; root typecheck and web build passed. The dialog then gained the shared
scroll body: at 390x667 the restricted-sites form remains reachable while Close
stays visible. Final dialog regression, scoped Biome and whitespace checks passed.
Browser only opened/toggled/closed the local form; no workspace or network setting
was created. Screenshot: /private/tmp/workspace-create-mobile-20261028.png.
Viewport reset. Closing from the switcher currently returns browser focus to the
page rather than the workspace trigger; this follow-up is still open, along with
the remaining overall state/route acceptance.

## Fifty-third implementation pass: New workspace return focus

Closed the pass 52 focus follow-up. Workspace scope records the persistent opener;
the switcher focuses its trigger before opening the dialog instead of retaining
a menu item that unmounts. Explicit dialog cancellation returns focus to that
connected opener via the dialog close-focus hook. Successful creation clears the
cancellation flag and retains navigation to the new private chat.

The dialog regression now asserts return focus. All 34 workspace/scope tests,
root typecheck and web build passed; scoped Biome and whitespace checks passed.
Browser verified both paths: switcher > New > Close returns to the workspace
trigger; directory New > Close returns to the directory button. No workspace was
created. Screenshot: /private/tmp/workspace-create-return-20261028.png. Overall
remaining page/state acceptance remains open.

## Fifty-fourth implementation pass: Maintenance drafts survive refresh

Knowledge maintenance's combined reload previously reapplied server settings and
replaced the topic array on every poll/filter change. That overwrote unsaved daily
settings and retriggered the topic-candidate effect, resetting selected notes and
the draft title. Settings now track local dirtiness until a successful save, with
inputs locked during the save. Candidate reads depend on the selected topic and
its label, not the identity of every refreshed topics array, preserving choices
when the same topic is returned. Runtime maintenance policy is unchanged.

A regression edits settings/title and unchecks a note, refreshes through the flag
view, then verifies all choices remain and no mutation was sent. All 66 Knowledge
tests passed; root typecheck and web build passed. Scoped Biome and whitespace
checks passed. No live maintenance request, model job, setting or document draft
was submitted. The remaining maintenance read-failure/partial-data and visual
states still require acceptance; this pass does not claim those are complete.

## Fifty-fifth implementation pass: Maintenance read recovery

Initial maintenance fetch failure now renders an explicit error and retry instead
of treating default zero counts and absent settings as a successful empty result.
A failed refresh preserves the last successful snapshot and local drafts. Read
errors are separate from action errors, and request sequence guards prevent older
reloads from replacing newer snapshots. Retry labels are available in all five
locales. This changes no maintenance policy or approval behavior.

The initial failure/retry regression verifies that settings and topic controls
are absent until a successful read and that retry sends no settings mutation.
All 66 Knowledge tests passed, along with repository typecheck and the web build.
Scoped Biome and whitespace checks passed. No live maintenance action was sent.
Rendered failure-state acceptance and the broader page audit remain open.

## Fifty-sixth implementation pass: Maintenance pagination isolation

An older flag-page request could append rows after a filter change or refresh.
Pagination now captures the snapshot generation and discards obsolete results
and errors. A synchronous pending guard and disabled Load more control prevent
repeated requests while preserving the current page on failure.

A delayed-response regression switches filters before resolving pagination and
verifies that the old row never appears and loading controls recover. All nine
maintenance tests passed. Repository typecheck reached the web stage, where the
new test's inferred mock types needed correction; after correction the web
 typecheck passed. Scoped Biome and whitespace checks passed. No live mutation
was performed. This pass did not rerun the full suite or build.

## Fifty-seventh implementation pass: Task creation action hierarchy

The create route no longer repeats a New task action in its page header. Its
Back to tasks link is now visible on desktop as well as mobile; the list route
retains New task. This keeps creation's submit action distinct from navigation.
The existing create regression now checks both entry/exit links. All 62 Tasks
tests and web typecheck passed, with scoped Biome and whitespace checks.

Browser verification inspected the current desktop create form and 390x844 mobile
form, then used Back to tasks and verified the list's New task entry returned.
Screenshots: `/private/tmp/task-create-desktop-20261028.png` and
`/private/tmp/task-create-mobile-20261028.png`. No task was created or started.
The stopped local preview was restarted on port 5181; an error-page tab could
not recover via navigation, so the verified preview is now tab 5. Viewport was
reset. Broader detail/role/error acceptance remains open.

## Fifty-eighth implementation pass: Task recovery acceptance

The task audit now has direct regressions for a transient selected-task read
failure recovering through Retry loading tasks (without claiming deletion), and
for a failed create retaining both text fields and resending the same complete
request identity. The existing tests cover explicit acceptance, delivery artifact
requirements, conflicts preserving drafts, duplicate submissions, stale workspace
responses, paged filters and manual versus immediate/scheduled creation.

The audit found a concrete remaining gap: initial related-thread/run/file reads
silently become empty arrays on failure in WorkspaceTasks.load. These optional
pickers need an explicit partial-read error and a retry that does not replace the
goal draft. This is the next task-page fix; the task area is not yet accepted.

All 64 Tasks tests passed. The added tests initially used unsupported Testing
Library `exact` options; these were corrected to anchored accessible-name regexes,
and web typecheck then passed. Scoped Biome and whitespace checks passed. No
runtime behavior or live data was changed by this acceptance pass.

## Fifty-ninth implementation pass: Related task items recover independently

Task association reads now collect individual results instead of silently
substituting empty arrays for failures. Successfully loaded chats, work and files
remain available; failed categories are named in the advanced form with a local
Retry related items action. That retry only refreshes association choices, never
the goal draft or selected IDs. A request generation and mounted guard prevent
obsolete reads from updating another editor. All five locale catalogs include
the new message and retry label.

The regression fails related chats while related work succeeds, edits both goal
fields, retries, and verifies the chat choices return without losing either draft
field or submitting a create. All 65 Tasks tests, web typecheck and production
web build passed (existing chunk-size advisory). Scoped Biome and whitespace
checks passed. This closes the concrete gap identified in pass 58; browser
acceptance of the partial-failure presentation remains to be recorded.

## Sixtieth implementation pass: Route inventory and entry recovery

The current inventory contains 20 feature route modules. Analytics is an external
Grafana entry, not an internal screen. Account owns workspace directory/detail;
Tasks includes create/detail and templates; Connections has channels/apps/databases;
Knowledge has documents/observations. The inventory specifically identifies
`fileReader` and `appOpen` as independent entry screens, not just overlays already
covered by Files. Authentication remains outside the feature registry and in scope.

Before the entry changes below, the integrated Web run passed all 257 files and
1852 tests (`/tmp/page-final-web-20261028.log`). Repository lint passed 2527 files;
docs consistency passed, which proves traceability only. No full-repository npm
test success is inferred from this frontend run.

HTML report reads and published-app entry failures now offer in-place retries.
Unsupported non-HTML types do not offer a pointless read retry. The app entry
requests another ticket only after explicit retry of a failure and retains its
one-submit-per-successful-ticket guard. All five app-share locales include the
retry label. Regressions cover HTML failure/recovery at the same path and app
entry failure followed by exactly one successful ticket submission. The focused
Files/App Shares run passed 17 files and 137 tests; scoped Biome and whitespace
checks passed. Rendered error-state inspection remains open for these entries.
Web typecheck also passed after the entry changes. The integrated run above
precedes these two additions; only the scoped run includes them.

## Sixty-first implementation pass: Entry failure visual acceptance

Browser inspection of the missing-HTML demo path at 390x844 found that view
switches still looked usable without any loaded content, and the shared preview
error recommended only downloading. The reader now disables those switches until
content exists and explains retry or Show in Files in all five locales. Its three
tests and web typecheck passed; scoped Biome and whitespace checks passed.

The published-app demo reports its expected unavailable-container error. Its
entry card was stretched to nearly the full mobile page by shared flex styling.
The feature now gives it content height and a bounded width with side gutters.
Both mobile and desktop were inspected after this CSS change, and Try again
returned to the explicit error without navigation or duplicate content. This
was only the local demo; no ticket was posted to a real app. Viewport was reset.

Evidence: `/private/tmp/html-reader-error-mobile-20261028.png`,
`/private/tmp/app-entry-error-mobile-20261028.png`, and
`/private/tmp/app-entry-error-desktop-20261028.png`. The error-state visual gap
from pass 60 is closed for these entries; full page-goal completion is not implied.

## Sixty-second implementation pass: Board history lifecycle

Successful edits or moderation now invalidate the open history snapshot so it
cannot continue presenting an old version list as current. Opening History again
fetches a fresh snapshot. The regression exercises a rejected history read,
retry through the menu, successful edit, snapshot removal and a fresh history
request. Existing author-only Edit/Withdraw and moderator-only Hide/Unhide tests
remain in the passing feature run. All 21 Board tests and web typecheck passed;
scoped Biome and whitespace checks passed. The new test was corrected to use the
actual Versions accessible label and reacquire the menu trigger after edit mode.

Local demo desktop/mobile checks opened, hid and reopened History and confirmed
focus returned to the post options trigger. No posts were edited, withdrawn or
moderated in the browser. Screenshot:
`/private/tmp/board-history-mobile-20261028.png`. Viewport was reset. Earlier
passes cover list/composer recovery, failed edit retention and responsive layout.

## Sixty-third implementation pass: Group approval recovery

Grouped approval decisions now use the shared small secondary buttons, a
synchronous pending guard and an accessible error alert. A rejected group action
keeps the group in place and can be retried with the same group key and decision.
The new regression verifies both requests and row retention. All 55 Approvals
tests and web typecheck passed after correcting the shared Button disabled prop;
scoped formatting and whitespace checks passed. No real approval was decided.

The Board source audit confirms empty-state copy is shown only after a successful
empty read, withdrawn posts leave the list, workspace selection keys the Board,
and history/menu permissions remain based on mine and canModerate. Combined with
passes 2, 31, 47 and 62, the core Board review is covered; final shared regression
still applies.

One concrete approval role follow-up remains: the inbox spans workspaces, but
persistent-decision UI currently consults the selected workspace by default.
Its bounded bot lookup provides each request's workspace; use that identity for
row/group persistent controls and verify mixed-workspace roles. Gateway policy
remains the authority and is not changed by this UI work.

## Sixty-fourth implementation pass: Cross-workspace approval roles

Read ADR-0022 A3 and W4 before aligning the UI: persistent approval decisions
belong to an Admin in the request's workspace. The inbox now passes the asking
bot's workspace from its existing bounded lookup to both group and single-row
controls. An explicitly unresolved inbox workspace offers no persistent action;
chat cards retain their selected-workspace default unless a caller supplies one.
Role notes use the same computed permission and decision handlers check it too.
No Gateway policy, approval rule or network allowlist was changed.

Mixed-workspace Member/Admin regressions verify the egress group and individual
allow controls despite an Owner role elsewhere. The legacy Always inbox fixture
was updated to provide its actual bounded bot lookup. Root-level test cleanup
also now covers the appended group recovery tests, preventing DOM leakage between
tests. All 57 Approvals tests, 21 common member-role tests and web typecheck passed.
Scoped Biome and whitespace checks passed. No real approval was decided.


## Sixty-fifth implementation pass: Management lifecycle audit

Skills installation and assignment now lock editable fields and Cancel while a
mutation is pending. A synchronous guard serializes management mutations, and the
Install skill entry is disabled during another mutation. A failed install retains
the exact content/hash/assignment draft and unlocks the form; the regression
verifies this without installing anything outside the test fixture.

Inspected the member role test's actual assertions (Admin can choose Guest/Admin,
not Owner), workspace archive/restore assertions (no archive before confirmation,
restore stays in the detail), and Member read-only approval/limit assertions.
Together with the earlier onboarding, scoped-directory, retry and responsive
passes these close the named lifecycle checks, without treating test titles alone
as proof. All 83 Skills/Members/Workspaces tests and web typecheck passed; scoped
Biome and whitespace checks passed. No live install, role change, archive or
restore occurred. Board's coverage row now records its completed feature audit;
final shared regression remains separate from that finding.

## Sixty-sixth implementation pass: Skills assignment modal

Replaced the unstyled native open dialog with the shared modal, bounded to 480px
and the viewport, with an internally scrolling body and touch-sized choice rows.
Opening moves focus into the choices; closing returns it to the originating skill
row. Pending mutations block dismissal. Assignment errors stay inside the modal,
retain selections, and clear when a new assignment starts. The close label is
localized in all five catalogs.

All 30 Skills tests and web typecheck passed. The new regression covers modal
focus, failed-save feedback, preserved selection and focus after Cancel. Local
demo desktop/mobile inspection confirmed the overlay and focus behavior; mobile
Cancel returned to the selected skill without a mutation. Screenshot:
`/private/tmp/skills-assignment-mobile-20261028.png`. No live assignment changed.

## Sixty-seventh implementation pass: Embedded memory confirmation

The remaining native open dialog belongs to LearnedMemoryScreen, embedded by chat
information and bot profiles. Replaced it with the bounded, scrollable shared
modal. Cancel receives initial focus, closing restores the originating Forget
button, pending mutations prevent dismissal, and failures remain inside the
confirmation instead of behind its overlay. A synchronous mutation guard prevents
duplicate operations. Existing irreversible-forget confirmation text and Gateway
semantics are unchanged. No real memory was forgotten.

The new regression exercises cancellation focus and a failed forget, retaining the
confirmation and its error. All 89 Knowledge/member-role tests passed using the
root Vitest configuration; web typecheck and scoped formatting passed. Embedded
modal desktop/mobile visual inspection remains pending. An initial full-web run
used the workspace script's forced jsdom environment and failed five Node-only
manifest/upload assertions; the root-config run is tracked separately and is not
represented as successful until its process completes.

Integrated verification follow-up: the root-config full web run completed with
1860 passing tests and one failing new memory-modal assertion because its test
file lacked the jest-dom matcher import when that run started. The import is now
present and the subsequent 89-test Knowledge/member-role run passed, including
that assertion. This is a full run plus a focused correction, not a fully green
single integrated run. Repository lint (2527 files), documentation consistency,
and the production web build all passed; the build retains its chunk-size advisory.
Logs: `/tmp/page-integrated-web-20261028c.log`,
`/tmp/page-memory-modal-tests-final.log`, `/tmp/page-final-lint-b.log`,
`/tmp/page-final-docs-b.log`, `/tmp/page-final-build-b.log`.


## Sixty-eighth implementation pass: Integrated regression and confirmation visuals

The root-config complete web run passed: 257 files, 1861 tests
(`/tmp/page-web-final-d.log`). This includes the corrected memory-modal regression.
Desktop and 390x844 demo inspection then found the confirmation buttons needed
spacing and its close label named the unrelated version panel. Added a wrapping
button row, destructive styling and a five-locale confirmation-specific close
label. The subsequent Knowledge/i18n run passed all 313 tests
(`/tmp/page-memory-final-e.log`). Mobile Cancel restored focus to the originating
Forget button and left its memory intact. Evidence:
`/private/tmp/memory-confirm-mobile-20261028.png`. No forgetting was submitted.

Re-read the actual workspace assertions: refused Enter preserves the prior
selection and URL, retry enters only after authorization; archived entries refuse
entry, failed archive lookup retries without a false missing state; archive waits
for confirmation and restore stays in place; Members cannot edit approval mode,
execution limits or archive. Re-read the member-role options assertion: an Admin
can choose Guest/Admin but not Owner. These prove those specific controls, not
all page states; the coverage ledger now narrows the outstanding checks accordingly.


## Sixty-ninth implementation pass: Member mutation lifetime and empty states

MembersScreen now keys its panel by the resolved workspace, preventing pending
member-management state and errors from carrying into another workspace. Mutations
have a synchronous duplicate guard; unmounted panels do not reload or report late
failures. Added regressions for a pending removal followed by a workspace switch,
a failed removal retaining the member and allowing retry, and read failure not
claiming an empty list before a successful retry. No real member role or access
was changed.

The 56-test Members/Workspaces run and web typecheck passed; the subsequently
added empty-state assertion passed in the seven-test members file. Logs:
`/tmp/page-members-lifecycle-final.log`, `/tmp/page-members-lifecycle-types.log`,
`/tmp/page-members-empty-final.log`. Scoped Biome and whitespace checks passed.
Together with earlier desktop/mobile and onboarding verification, this closes the
Members feature audit. Final shared regression after subsequent edits is still
separate; other page coverage rows remain open.


## Seventieth implementation pass: Skills installation and list layout

Desktop/mobile install-form inspection found missing visible labels and focus lost
to the page when its opener became disabled. Added persistent labels, initial
content-field focus and return focus after closure/completion. The existing cancel
regression now checks both focus transitions and no installation request. All 30
Skills tests and web typecheck passed (`/tmp/page-skill-install-tests.log`,
`/tmp/page-skill-install-types.log`).

Scrolling the mobile page exposed absent skill-column styles, which compressed
names and ran column headings together. Added aligned fixed-tail desktop columns
and a container-query stacked layout for narrow list panels, including desktop
split detail. Long names/descriptions wrap; labels stay with their values. Desktop
and 390x844 rendering were inspected after styling. Screenshots:
`/private/tmp/skill-install-mobile-20261028.png`,
`/private/tmp/skill-list-mobile-20261028.png`,
`/private/tmp/skill-list-desktop-20261028.png`. Cancel returned focus to Install
skill; no install or review decision was submitted. Scoped Biome and whitespace
checks passed. This closes the Skills feature audit; final shared regression is
still separate.


## Seventy-first implementation pass: Task acceptance and revision focus

Inspected concrete assertions for saved edits not dispatching work, explicit Run
using the saved version/key, deletion requiring confirmation, terminal tasks being
read-only until explicit reopen, Member creation restrictions, transient read
retry, and lost-create retry preserving the complete draft and request identity.
These complement the earlier template and live-refresh audits.

Local demo desktop blocked-task inspection showed the reason and next action;
mobile delivered-task inspection showed the review controls, output caveats and
result links. Opening Request changes initially left focus on the opener; it now
focuses feedback, and Cancel restores the opener. The existing acceptance test
now asserts opening/canceling never dispatches work and verifies both focus moves.
All 65 Tasks tests, web typecheck, scoped Biome and whitespace checks passed.
Logs: `/tmp/page-task-focus-final.log`, `/tmp/page-task-focus-types.log`.
Screenshots: `/private/tmp/task-review-mobile-20261028.png`,
`/private/tmp/task-revision-mobile-20261028.png`. No task was accepted, submitted,
deleted or run in the browser. The Tasks feature audit is closed; final shared
regression after later edits remains separate.


## Seventy-second implementation pass: Approval workspace lookup recovery

Approval persistent controls depend on resolving the asking bot's workspace. A
failed bounded bot lookup previously silently left those controls unavailable.
Added an explicit error and local retry, retaining the fail-closed permission
behavior. The existing name-map hook remains compatible for other callers; the
new lookup form exposes error/retry state and ignores an obsolete API client's
response. Only the bot ids on the current page are requested.

A regression fails the lookup, verifies Allow all is unavailable, retries, and
verifies the control recovers without deciding any approval. All 61 Approvals and
bot-lookup tests plus web typecheck passed (`/tmp/page-approval-recovery-tests.log`,
`/tmp/page-approval-recovery-types.log`). Reviewed the assertions for settled-row
removal, explicit Always confirmation and authoritative reconciliation after a
competing 409 decision. No live approvals or rules were changed. The final grouped
and error visual audit remains open, rather than claiming full feature completion.

## Seventy-third implementation pass: Scoped approval lookup errors

The demo approval feature currently implements individual requests only, not the
new grouped endpoint; it therefore cannot prove grouped rendering through ordinary
demo navigation. Keep that visual gate open. While auditing the lookup recovery,
found that a late failure for the previous page could incorrectly mark the current
page as failed. Errors are now tracked by failed bot ids, so only ids rendered by
the current page contribute to its warning. Added a delayed-failure/page-switch
regression. Error banners also wrap their text and retry control at narrow widths.

All 62 Approvals/bot-lookup tests and web typecheck passed; scoped Biome and
whitespace checks passed. Logs: `/tmp/page-approval-lookup-scope.log` and
`/tmp/page-approval-lookup-scope-types.log`. No approvals were decided. Grouped and
error-state browser evidence still requires a suitable demo fixture; test success
has not been substituted for that evidence.


## Seventy-fourth implementation pass: Grouped approval visual acceptance

Created a read-only visual harness using the real App and demo Gateway; the
fixture supplies a synthetic three-request group and a one-shot bot lookup
failure. Every non-GET is refused. Source and reproduction instructions are in
`spikes/page-polish-20261027/approval-states.html` and `approval-states.md`; the
served temporary copy was removed after inspection.

Actual rendering exposed the inbox li's inherited flex direction placing the
whole group banner beside the approval body. The inbox now stacks these blocks;
the group banner and its actions wrap, and group errors take their own row.
Desktop and 390x844 screenshots show readable group count and separate batch vs
individual controls. Retrying the lookup removed the error and restored names and
site-allow controls without a decision. Evidence:
`/private/tmp/approval-group-error-mobile-20261028.png` and
`/private/tmp/approval-group-desktop-20261028.png`. Scoped Biome/whitespace checks
passed. The prior 62-test approval/lookup and typecheck pass still covers behavior;
this follow-up changes CSS and the standalone visual fixture only. Approvals now
has feature audit evidence; final shared regression remains separate.


## Seventy-fifth implementation pass: File lifecycle acceptance

Reviewed concrete assertions for Admin-only uploaded-file deletion, no delete
before confirmation, Guest upload controls absent, failed uploads retrying the same
session key, lost part responses not sending a part twice, cancellation stopping
completion, and disk-full reporting without automatic retry. Preview tests retain
metadata and distinguish a stopped workspace from a missing file; list tests cover
loading, empty, filtered-empty and error recovery.

Uploaded-file confirmation now puts initial focus on Cancel, restores focus to
Delete uploaded file on cancel, clears stale errors, and synchronously prevents
duplicate delete requests. The existing lifecycle test now covers these focus
transitions and a failed delete retaining detail before a successful retry. All
116 Files tests and web typecheck passed (`/tmp/page-files-lifecycle-tests.log`,
`/tmp/page-files-lifecycle-types.log`). Scoped formatting passed. No real file was
uploaded or deleted. Combined with earlier desktop/mobile and reader verification,
this closes the Files feature audit; final shared regression remains separate.

## Seventy-sixth implementation pass: Run workspace permissions

Inspected cancellation/refused-cancellation, initial read recovery, missing-run,
marking permissions and statistics read-retry/scoped-save assertions. Found a UI
permission defect: a role in the selected workspace could skip the run-thread
lookup and expose management controls for a different workspace's run. Read
ADR-0022 A11/A12 and W3/W4/W11 before correcting it.

The run now resolves its thread regardless of the selected role. Cancellation and
continuation use the resolved thread workspace or bot workspace, and an explicit
unresolved scope keeps authenticated controls unavailable. Standalone components
without a role provider keep their documented legacy behavior. The Gateway's
policies are unchanged. A mixed-workspace regression verifies the actual thread
lookup and no Cancel/Continue for a Member there despite an elevated role elsewhere.

All 140 Runs/statistics/member-role tests and web typecheck passed; after tightening
the regression's lookup assertion all 22 member-role tests passed again. Scoped
Biome and whitespace checks passed. Logs: `/tmp/page-run-scope-tests.log`,
`/tmp/page-run-scope-types.log`, `/tmp/page-run-scope-role-final.log`. No real run
was cancelled or continued. Run permission lookup failure recovery and its final
visual states remain to audit before closing this feature row.

## Seventy-seventh implementation pass: Run related-detail recovery

Run bot/thread lookups now report a localized partial-detail warning and expose a
local retry instead of silently leaving related names/controls absent. Each lookup
keeps its cancellation guard; retry does not rerun, cancel or continue work. The
new test fails the thread lookup once, retries it, verifies the actual subsequent
GET and asserts no POST occurred. All 141 Runs/statistics/member-role tests and web
typecheck passed (`/tmp/page-run-retry-final.log`, `/tmp/page-run-retry-types.log`).
Scoped formatting and whitespace checks passed.

Inspected the local failed-run drawer on desktop and at 390x844: failure reason,
bot identity, elapsed time, command/event story and collapsed details remain
readable; finished work offers no cancellation control. Screenshot:
`/private/tmp/run-failed-mobile-20261028.png`. No live run was touched. Partial
lookup error/retry visual inspection is still outstanding; this is not yet the
complete Runs feature audit.


## Seventy-eighth implementation pass: Run lookup visual acceptance

Added a read-only standalone fixture using the real App and the demo failed run,
with one deliberately failed thread GET. Every non-GET request is refused. The
mobile warning and retry remain visible above the actual run failure, keeping the
two conditions distinct. Retry removes only the lookup warning and preserves the
failed status, elapsed time and event story. Desktop narrow-drawer rendering was
also inspected. No new implementation issue was found in this check.

Evidence: `/private/tmp/run-lookup-error-mobile-20261028.png` and
`/private/tmp/run-lookup-error-desktop-20261028.png`. Reproduction source and notes:
`spikes/page-polish-20261027/run-lookup-states.html` and `.md`. The temporary served
copy was removed, and the browser returned to the ordinary demo. The prior 141-test
Runs/statistics/member-role and typecheck results remain current because this pass
changes only the visual fixture and ledger. This completes the Runs feature audit;
the final shared regression and remaining feature audits are still outstanding.

## Seventy-ninth implementation pass: Cost-rule submission continuity

Reviewed actual budget assertions for workspace-specific roles, local read retry,
failed-save draft retention, positive limits and explicit continuation after raising
an exhausted budget. Found a separate rule-editor lifecycle issue: during creation
its fields and Cancel remained usable, so a successful pending request could erase
new input. Disabled all rule fields, Cancel and New rule while a mutation is pending;
a synchronous guard prevents duplicate submissions, including two submits before
React renders the disabled state. Creation also rechecks its role capability.
Closing the sheet still preserves the parent-owned pending draft.

Added a delayed-request regression covering duplicate submission, all three select
controls and threshold/Cancel locks, a network failure retaining the value, and a
successful retry. All 50 Costs tests in six files passed and web typecheck passed
(`/tmp/page-cost-final-tests.log`, `/tmp/page-cost-final-types.log`). Initial test
assertions were corrected to use the component's actual button-based select API
and the transport's user-facing network error. Scoped Biome and whitespace checks
passed. No real budget or alert rule was changed. Final rule-editor visual review
and the shared regression remain outstanding.

## Eightieth implementation pass: Cost-list recovery and rule-sheet visuals

Inspected the actual rule editor on desktop and at 390x844. Fields, primary/secondary
actions and the close control fit without clipping. Cancel returns to the rules
list without creating a rule; closing the sheet restores focus to Manage rules.
Saved `/private/tmp/cost-rules-mobile-20261028.png`. No rule or budget was changed.

Read the unpriced/empty/loading assertions and filtered-report/ranking recovery
assertions. Found alerts and rules had error text but no read-retry action (PageBar
provides only pagination). Added independent localized Retry alerts and Retry rules
buttons. A regression fails both initial reads, recovers rules while retaining an
open threshold draft, then recovers alerts and verifies that every request is GET.
Mutation errors remain separate from read errors. All 51 Costs tests in six files
and web typecheck passed (`/tmp/page-cost-retry-tests.log`,
`/tmp/page-cost-retry-types.log`). Scoped Biome passed. Error-state visual review
and final shared regression remain outstanding.

## Eighty-first implementation pass: Connection setup submission safety

The full Web regression through pass 80 passed: 257 files, 1870 tests
(`/tmp/page-web-integrated-latest.log`). This precedes the setup change below.

Inspected setup and connection lifecycle coverage and found the setup credential
fields remained editable while connecting. Locked those fields during the request
and added a synchronous pending guard to prevent two connection submissions before
React renders disabled controls. The setup flow key now includes workspace identity,
so switching workspace cannot reuse another workspace's credential draft.
A delayed failure test verifies one request, locked fields/Back, retained input on
failure and successful retry. All 68 integration tests in 11 files and web typecheck
passed (`/tmp/page-channel-setup-final.log`, `/tmp/page-channel-setup-types.log`).

Inspected the actual demo's Telegram setup, default bot selection and provider
instructions. At 390x844 the long guide scrolls within its dialog and both Back and
Connect remain reachable. Closing restores focus to Connect Telegram. Saved
`/private/tmp/channel-setup-mobile-20261028.png`; no credentials were entered, no
provider link opened and no connection request sent. Scoped formatting passed.
Remaining integration role/lifecycle assertions still need final audit before
closing the feature row; the full regression above does not cover this new change.


## Eighty-second implementation pass: Integration lifecycle audit

Read the actual lifecycle assertions, rather than relying on test names: missing
runtime keeps diagnostics behind details and offers Retry; a missing plugin does
not erase a saved connection; no-bot setup disables Connect; disconnected and
unlinked accounts offer their distinct recovery; archived workspace connections
show stopped and no lifecycle commands. Test-message success is shown only after
the command succeeds, and partial delivery retains its explicit recovery warning.
Member cases omit maintainer enable controls and blocklist/admission controls.
App authorization opens without an opener; canceled app/database credentials are
cleared, failed submission retains editable non-secret details, and catalog and
account reads recover independently. These assertions were included in the 68-test
integration run from pass 81, which remains current with no further code change.

Together with the previous desktop/mobile catalog and setup inspections, this
closes the integration feature audit. This does not imply a live provider test or
a production account change; final shared regression is still pending.


## Eighty-third implementation pass: Account, app-share and Trash audit

Read actual Account assertions for failed display-name save preserving the draft,
login-name preservation, explicit editor cancel and focus return, invalid photo
rejection before upload, preview/discard and identity refresh. Password mismatch
makes no request; refusal clears secrets while keeping the user signed in; success
adopts the rotated session token and clears all fields. SSO-only and mixed-login
accounts receive the appropriate explanation instead of an unusable form. Agent
key tests check root-only creation, retryable refusal, failed clipboard reporting,
and separation of the key from the installation prompt and browser storage.

Read App-share assertions for Guest fetch suppression, Member stop confirmation,
port validation before a mutation, independent initial-read retry, old-workspace
response suppression and one-use entry tickets sent in a POST body rather than the
address. Read Trash assertions for loading/error/empty separation, disabled retry
while loading, duplicate restore prevention, retained failure, ignored completion
after navigation, paging clamp after restore, and removal of controls on role loss.
A restore sends only the explicit restore request and does not replay bot work.

These assertions all passed in the pass-81 complete Web run (1870 tests); their
implementation has not changed since that run. Combined with earlier recorded
mobile/desktop/focus and entry-error inspections, the Account/App-shares and shared
Trash/fallback feature audits are closed. Feature-specific missing objects remain
part of their owning feature audits. No real password, account, share or archived
workspace was changed. Final shared regression remains pending.

Bot-detail audit started after the three closures above: inspected the distinction
between failed profile lookup and genuinely missing bot, no message action for a
missing bot, SOUL draft retention through conflict and navigation, save refusal
without an invented version conflict, exact proposal diff before explicit Apply,
and stale proposal/version mismatch disabling Apply. These are current assertions
included in the integrated Web gate. Remaining bot configuration, scheduling and
role-state checks are next; the Bots feature row is not yet closed.

## Eighty-fourth implementation pass: Bot-specific role scope and schedule actions

Inspected schedule behavior: timezone and next occurrence, validation before save,
drafts surviving navigation/background timer refresh, saved-entry-only immediate
runs and paused explanations. Found that schedule actions used the selected
workspace's role instead of the bot's workspace. Scoped configure/run-now checks
to bot.workspaceId and added a mixed-workspace Owner/Guest regression. Synchronous
pending guards now serialize Save and Start; Start also checks permission, paused
state and exact saved-entry identity before dispatch. A delayed failure regression
proves one immediate run request and a usable retry after failure.

Audited the remaining bot-detail useCan calls and applied the same explicit bot
workspace to profile configuration/run visibility, identity, SOUL, approval rules,
models, diary and version restoration; the vision capability uses its supplied
workspace. RoleNote allowed overrides now match their scoped controls. Bot-list
creation and workspace-level navigation retain their selected-workspace semantics.
Gateway enforcement and model behavior are unchanged.

All 94 Contacts/member-role tests in 14 files passed after the complete change
(`/tmp/page-bot-scope-final.log`); web typecheck passed
(`/tmp/page-bot-scope-types.log`). Scoped Biome passed. No real schedule, bot
configuration or model probe was executed. The Bots feature remains open pending
its final visual/state review and shared regression.

## Eighty-fifth implementation pass: Bot app settings recovery

Inspected the demo bot's Activity and Settings and scrolled the settings at 390x844.
Profile, schedules, app selection and test-chat sections fit within the viewport;
advanced instructions remain collapsed in the ordinary view. The app Save action
was unnecessarily enabled for an unchanged selection, unlike adjacent forms.
It now compares the selection with the saved baseline, disables unchanged saves,
and guards duplicate/pending, unauthorized and unavailable-catalog submissions.

Also found failed app reads silently hid the section. Initial loading and failed
reads now have explicit states and a localized local retry; genuinely unconfigured
integrations still omit the section. Read errors after initial success are visible
without discarding selection. Permission explanations follow the bot workspace.
Regression assertions cover unchanged/saved disabled state and a failed initial
read followed by GET-only recovery. All 73 Contacts tests passed before the final
read-error guard addition; the four BotApps tests passed after it. Web typecheck
passed after correcting the baseline to the contract's readonly array type.
Logs: `/tmp/page-bot-apps-final.log`, `/tmp/page-bot-apps-recheck.log`,
`/tmp/page-bot-apps-types.log`. Scoped Biome passed.

The actual mobile demo now exposes Save apps as disabled before editing; screenshot
`/private/tmp/bot-settings-mobile-20261028.png`. No settings, schedules, apps or
model work were changed in the browser. Error-state visual verification remains
outstanding, so the Bots feature audit remains open.


## Eighty-sixth implementation pass: Bot/Costs read-error visual acceptance

Created a read-only fixture using the real App and mock Gateway. It fails selected
GETs exactly once and refuses every non-GET. Bot app lookup failure stays in a
visible section; at 390x844 its text and Retry fit alongside the other settings.
Retry restores the app options and the unchanged Save button remains disabled.
Costs alerts failure preserves totals/budgets and exposes local Retry. Recovery
shows the successful empty alert state; the separately failed rule list retains
its own warning. The rule sheet warning/Retry fit on mobile and desktop, and Retry
restores its empty state and count without any mutation.

Screenshots and reproducible source are listed in
`spikes/page-polish-20261027/settings-read-states.md`. The temporary served copy was
removed. These inspections close the outstanding error-state visuals for Bots and
Costs; combined with the prior scope, lifecycle and responsive evidence their
feature audits are complete. No production request or configuration change was
made. Final shared regression and the other feature rows remain pending.


## Eighty-seventh implementation pass: Knowledge audit and maintenance mobile layout

Read actual document assertions for search/no-results vs empty library, explicit
publication, draft preservation through navigation and queue retries, and conflict
rebasing without replacing local text. Read observation pending-save/closed-history
and maintenance tests for stale page suppression, settings/selected-note draft
preservation, initial read retry without mutation, trusted-note-only document
proposals, and explicit organise/accept/undo. Role assertions show Member read-only
curation with version access and Admin controls; maintenance checks are explicitly
workspace-scoped.

Visual inspection found the maintenance organise action row overflowed at 390px:
the main content measured 421px scroll width within 375px client width. Feature-owned
CSS now wraps actions and long labels, and aligns the daily checkbox with its label
with consistent field/action spacing. Afterward all measured maintenance containers
fit and main scroll/client widths both equal 375px. Desktop still puts the two
organise actions on one row. Screenshot:
`/private/tmp/memory-maintenance-mobile-20261028.png`.

All 90 Knowledge/member-role tests in nine files and web typecheck passed
(`/tmp/page-knowledge-audit-tests.log`, `/tmp/page-knowledge-audit-types.log`), followed
only by the visually checked checkbox-spacing CSS. Scoped Biome and whitespace
checks passed. No maintenance, model, publication or memory mutation was performed
in the browser. Together with previous document/observation/forget visual checks,
this closes the Knowledge feature audit; final shared regression remains pending.


## Eighty-eighth implementation pass: Management surface lifecycle audit

Read Vault assertions for Member read-only controls, unusable tokens without request
definitions, cleared secret values after refusal/cancel, no browser-storage or URL
secret persistence, request-definition draft retention until explicit cancel, read
retry with GET only and old-workspace response suppression. Prior desktop/mobile
catalog and credential-dialog evidence is recorded in passes 15–16.

Read Computer/desktop assertions distinguishing passive preview from explicit
start/takeover, keeping a hold when the viewer closes, explicit Return control,
resuming an existing hold without another takeover, region switching without
mutation and error retry without opening the wrong screen. Roster failure is not
zero bots; Member views hide configuration. Desktop-tools/Web-search unavailable
capabilities show no enable action, and their local read retries do not enable
anything. Workdir pending fields/Cancel are locked, failed save keeps the draft,
and Cancel restores the saved value and focus. Actual controls use workspace-scoped
permissions and suppress management for archived workspaces.

Read Network assertions for expired nonselectable profiles, Owner-editable rows,
no unauthorized overlap fetch, failed-read recovery, retained pending edit and
focus on cancel, unsubmitted selection retention across independent settings,
connectivity results cleared when the target changes, explicit host-remove
confirmation, and a refused or unsuccessful repair reported honestly. Earlier
profile desktop/mobile inspection and recovery evidence is in pass 17.

All 106 tests in these six feature areas (23 files) passed again
(`/tmp/page-admin-surfaces-tests.log`). No implementation changed in this audit,
so the existing typecheck remains applicable. These three feature rows are closed;
final shared regression remains pending. No real network, credential, desktop,
host cleanup or policy operation was performed.


## Eighty-ninth implementation pass: Workspace and authentication closeout

Read actual authentication assertions for session restoration, wrong-password retry,
throttling, expired sessions, temporary outages without signing out, startup read
retry and no browser credential persistence. Invitation assertions cover expired,
revoked and used links, transient read recovery, token-change form reset, duplicate
SSO prevention and non-secret username retention after rejection. Earlier mobile
entry screenshots remain applicable.

Read workspace assertions for archive confirmation/restore, Member read-only
controls, scoped member reads, network read retry without mutation, archived lookup
failure versus missing, keyboard tab navigation with rename-draft preservation,
name limits and pending creation/cancel/focus. Inspected Tools & network and
Lifecycle at 390px; only the intentionally scrollable navigation strips overflow,
not the page. Team & approvals also fits its content. Removed implementation-facing
confirmation wording from the Lifecycle hint in all five locales. Screenshot:
`/private/tmp/workspace-lifecycle-mobile-20261028.png`. No settings were saved.

A repeated regression exposed a genuine pending-pin race: a new directory page
cleared the optimistic state before the pin request finished. Page reconciliation
now retains pending entries. The pin test explicitly changes the role filter while
the request is pending and verifies the disabled Unpin state remains, followed by
rollback after refusal. All 58 workspace/auth tests passed after the fix
(`/tmp/page-workspace-auth-recheck.log`), followed by all 12 workspace-management
tests with the explicit refresh assertion (`/tmp/page-workspace-pin-refresh.log`).

Before this final small fix, current full web regression passed 257 files / 1,874
tests, and root typecheck, lint, docs consistency and web build passed
(`/tmp/page-web-final-current.log`, `/tmp/page-final-*-current.log`). Build retains
the existing chunk-size warning. The root full test run is still in progress at
this record; its result must be collected from session 63317 and
`/tmp/page-repository-final-current.log`. It started before the pin fix, so targeted
post-fix evidence above does not replace final integrated regression. Chat/shared
consistency and final diff review remain outstanding.


## Ninetieth implementation pass: Chat consistency and integrated review

Rechecked the demo transcript at desktop and 390px: a single author/time row,
compact inline approval actions, technical facts in the Details drawer, readable
mobile wrapping and an unobstructed composer. Opening/closing Details preserves
the chat and returns focus to the trigger; no approval was decided. Final screenshots
are retained in `spikes/page-polish-20261027/chat-final-{desktop,mobile}-20261028.png`.
The workspace Lifecycle screenshot is retained in the same directory.

Read chat assertions for literal long-message excerpts, explicit expansion retained
on events, deep-link expansion, unsent drafts preserved through diagnostics,
old failure removal after retry progression and no mutation during view changes.
Inspected the current shared role and workspace-focus diffs, chat activity read
retry, run workspace lookup and file-detail changes. The contracts change adds only
`skills.manage` with Admin scope matching the existing Gateway skills mutation
policies; it does not expand server permissions. The route registry has 20 feature
route files; grouped settings/detail routes are included in the coverage ledger.

The standard full root test command completed with 913 passing / 2 failing files,
8,620 passing / 2 failing tests. Failures are in unchanged tests: stable release
active-run refusal exceeded its 5s timeout, and desktop-proxy epoch interruption
checked its result after a fixed 60ms before it arrived. This is not a clean gate.
A complete same-scope rerun with `npm test -- --maxWorkers=2` is running as session
13019, log `/tmp/page-repository-final-low-concurrency.log`; collect that result
before claiming completion. No tests are excluded or timeouts increased.

Post-pin-fix web typecheck and workspace Biome passed; `git diff --check` is clean.
Final shared regression is pending this whole-repository result and final lint,
document consistency and build refresh after the last small change. No deployment,
commit, push or production operation was performed.


## Final gate collection in progress

The post-fix delivery lint, documentation consistency and web build all passed
(`/tmp/page-delivery-lint.log`, `/tmp/page-delivery-docs.log`,
`/tmp/page-delivery-build.log`). The low-concurrency complete regression has already
passed both previously failing files: desktop-proxy (12 tests) and stable release
(40 tests). The whole run is not yet terminal, so the completion decision remains
pending session 13019. Preserve and poll that session; do not restart it.


## Final acceptance — 2026-10-28

The whole-repository regression completed successfully on the final implementation:
`npm test -- --maxWorkers=2`: **915 test files, 8,622 tests passed**, exit 0,
515.08 seconds. This includes all web, UI, contracts, backend and script T0/T1
tests selected by the unchanged root test script. No tests were excluded beyond
the script's normal container/real-model tier exclusions, and no assertions or
timeouts were weakened. The earlier default-concurrency failures remain recorded
above; reducing worker concurrency allowed both previously failing files and the
rest of the suite to pass together. Log: `/tmp/page-repository-final-low-concurrency.log`.

Final gates: root typecheck passed before the final workspace-only fix; web
typecheck passed after that fix. Root lint, documentation consistency and web build
passed after the final implementation. `git diff --check` passed. The build emits
the existing large-chunk advisory; no build error remains. Logs are
`/tmp/page-final-typecheck-current.log`, `/tmp/page-workspace-final-types.log`,
`/tmp/page-delivery-lint.log`, `/tmp/page-delivery-docs.log` and
`/tmp/page-delivery-build.log`. This final documentation update does not change
executable code.

Completion audit: all 20 feature route modules and their nested settings/detail
flows map to the coverage table. Each area has recorded desktop/mobile evidence
and tests for its relevant loading, empty/error recovery, draft and authorization
states. The final shared/chat review and full-suite result close the remaining
acceptance items. Earlier 'pending' notes are historical checkpoints superseded
by the named later passes and this final acceptance, not remaining work.

The goal is complete as a local implementation and verification task. Changes are
uncommitted in `codex/page-experience-polish` at `/private/tmp/deskmates-page-polish`.
The demo preview is `http://127.0.0.1:5181/demo.html`; no production settings,
credentials, approval decisions, deployment, push or merge were performed. PR #99
was the previously merged chat work, not this broader page-polish change.

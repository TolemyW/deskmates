# ADR-0008: Bot screens on one desktop with one shared browser login

Date: 2026-09-24
Status: Accepted
Implementation: candidate complete; see [executed verification](../design/bot-desktops-ui-results-2026-09-24.md).
Live milestone acceptance: not signed off.
Source: operator requested independent bot screen previews and desktop entry in one shared environment, then explicitly required one login shared automatically by all bots.
Amends: ADR-0004 display routing only; ADR-0006 amendment 1 screen transport.

## Context

The operator requires shared files, tools **and browser login**, while each bot
has its own visible screen and the UI can preview and enter it. A previous draft
of this ADR proposed an X server and browser profile per bot. The explicit shared-
login requirement rejects that draft. Its independent-profile approach is not
implemented. One workspace per bot also fails this requirement.

Chromium's [user-data documentation](https://github.com/chromium/chromium/blob/main/docs/user_data_dir.md)
states that one instance cannot show windows on multiple X displays, and two
running instances cannot share a user-data directory. Instead, retain one X
server and one Chromium and arrange bot windows in different monitor-sized
regions of that desktop. x11vnc's installed `-clip` option supports separate
viewers for regions of the full desktop. These are screens of one computer,
not isolated operating-system sessions or separate browser identities.

A disposable real-Docker probe (`spikes/shared-screen-desktops`) observed two
1280x800 Chromium windows at distinct positions, a cookie set in A visible in B,
and 12 successful concurrent clicks per window. Root-display evidence shows
both distinct windows with browser chrome. This validates the core mechanism,
not model acceptance or arbitrary GUI application compatibility.

## Decision

1. **Keep the shared browser and profile.** A workspace has one Chromium process
   tree, one persistent `/profile`, one X display, filesystem, shell and egress
   policy. Each run gets a separate top-level browser window in its bot's screen
   region. Bots automatically share cookies and origin storage, with no copying,
   synchronization service or new bot access-control boundary. Session storage
   remains tab-specific according to browser behavior, as it was before.

2. **Allocate stable bot screen slots.** The first implementation provides six
   1280x800 regions on a 3840x1600 desktop (three columns, two rows). Six is an
   initial resource/design limit, not a measured optimum. Persist unique
   `(workspace, slot)` assignments keyed by bot ID; renaming, run completion,
   restart or list order never silently changes a bot's screen. A screen is per
   bot, not per thread or run. Both scheduling lanes use that bot's region, so
   the visible window within one bot can change with its active run. Exhaustion
   is an explicit capacity error. No hidden reassignment or extra container.

3. **Create and attribute windows by exact CDP target.** Shared-monitors runs
   receive a validated slot in their start payload; record mode and slot in run
   configuration. The coordinator creates a top-level window in that rectangle,
   records the returned target ID, and selects exactly that target. Never infer
   its identity from whichever new page appeared first during parallel creation.
   Existing target leases, takeover epochs, egress, approvals and untrusted
   wrappers remain. Explicit new tabs also create a window in the assigned region. Browser tools
   still operate on the selected page; shared
   business records and files still need lost-update checks. Pop-up and
   manually moved/maximized windows require explicit routing/containment tests
   before claiming every graphical workflow remains inside its bot's screen.

4. **Watch without a hold; retain workspace-wide human takeover.** Each region
   has an x11vnc/noVNC endpoint sharing the underlying desktop. A second password
   grants server-enforced view-only access. Watching never takes a browser lock.
   X11 still has shared input/focus, so human takeover retains the existing
   workspace-wide browser hold; it does not promise that other bots continue
   browser work during manual typing. Show that scope in the UI before takeover.
   Handback or hold expiry terminates embedded control transports before they
   can continue sending input. The hold suppresses agent captures as before;
   operator live views remain available. Shell access remains a soft boundary.

5. **Publish screens through the existing egress proxy.** Workspace containers
   have no host port bindings. The dual-network egress container runs fixed-target
   TCP relays for the full desktop and six region endpoints, published only on
   host loopback. Each relay forwards only to its matching port on the named
   workspace container. The provider reads the proxy's actual port map on create
   and attach. The HTTP forward-proxy and CDP ports remain unpublished. This is
   the ADR-0006 inbound exception; do not call the workspace completely isolated
   without naming it. Missing or invalid screen configuration must not become an
   arbitrary destination proxy.

6. **Embed noVNC through the operator origin.** Authenticated screen APIs return
   status or issue one-use WebSocket tickets, redeemable for 30 seconds (an initial
   operational value). Bind tickets to the request Origin, fixed screen target
   and view/control mode. Transport runs only on the operator listener. The UI
   keeps tickets and VNC credentials in memory; ordinary metadata, SQLite and
   logs exclude them. RFB view-only credentials enforce read-only behavior even
   if a client removes its UI restriction. Close active control sockets on
   handback/expiry and all sockets on Gateway shutdown; tickets do not survive
   restart. The operator UI's existing forwarded HTTP/WebSocket origin is enough
   for remote access, without extra per-screen SSH forwards. Existing direct
   workspace noVNC links remain the legacy path; their reusable control password
   is not claimed to be revoked by the new embedded-transport close operation.

7. **Provide previews and desktop entry in a consistent UI.** Use React/Vite,
   Tailwind and locally owned shadcn-style Radix/CVA primitives. Sidebar navigation
   includes a desktop overview; conversations show a card per member, with a
   real read-only live preview, state and `Open desktop`. Open into an embedded
   dialog/panel, with view/control mode and return-control action. Hidden or
   unmounted previews close their connections. Rendering cards never provisions
   new containers; explicit start or an agent run provisions them. Existing
   attach/readiness repair semantics remain. Disconnected,
   stopped and legacy-image states are explicit, never filled with fake frames.
   Keep existing approvals, drafts, credential gating and SSE recovery semantics.

8. **Roll out with explicit image compatibility and evidence.** Newly created
   workspaces use `shared-monitors-v1`; provider handles expose region addresses
   only when the image carries the matching capability label, the container enables
   that mode and every expected port exists. Gateway env alone cannot make an old
   image appear compatible.
   Existing images retain their shared screen and show a UI update-required
   state, rather than pretending to have independent screens. Conversion uses
   the existing operator restart with its active/parked-run protection and
   preserves the shared profile volume. Do not replace shared images or restart
   the operator's active environment during development. Account for six VNC
   servers and the larger framebuffer in resource measurements.

## Verification

These rows specify required evidence, not a claim that the listed suites passed.

| Item | Concrete meaning | Required verification | Metric |
| --- | --- | --- | --- |
| 1 | A's login is immediately present in B; one browser/profile; shared files persist | Real `shared-screen-desktops` probe, then T2 shared-login and profile restart | Login intervention count; Chromium process-tree count |
| 2 | Stable slot after restart; no collision; seventh request reports capacity; cards do not allocate | T1 `screen-slots.test.ts`, `screen-routes.test.ts`; T2 image dimensions/regions | Peak RSS; allocated screen count |
| 3 | Parallel creation selects the returned target, not the peer; window and screenshots belong to the bot; bounds remain correct | Coordinator T0/T1; actual pinned-MCP T2 including new tabs and popup cases; versioned X02/X03 | Wrong-screen attribution/input count (zero); interference rate |
| 4 | View password cannot inject; watching does not hold; takeover pauses both bots; handback closes embedded control | T1 screen routes; real RFB and takeover T2 | Forbidden input/capture count (zero); takeover wait |
| 5 | Internal workspace has no published ports; proxy maps loopback; host HTTP and VNC work; sibling workspace cannot connect | Provider T1 and actual Docker T2 | Reachability checks; wrong-target connections (zero) |
| 6 | Ticket replay, expiry, origin mismatch, unauthenticated issue and sandbox access denied; close and shutdown revoke transport | T1 `screen-routes.test.ts`; real browser WebSocket/RFB over forwarded operator origin | Unauthorized access and credential leakage (zero); connection latency |
| 7 | Labeled live cards open the correct screen; view/control and recovery work; hidden previews close; forms and drafts still work | Web component regressions and real-browser UI QA | Preview freshness; active stream count |
| 8 | Legacy runtime is explicit; conversion preserves profile and rejects active/parked work; new image passes health checks | Workspace restart tests; T2 old/new image checks and resource sampling | Startup time, RSS, run success and wall time |

Existing X04 keeps its workspace-wide takeover oracle. Run fresh X02/X03 and
chief/group acceptance with the desktop mode recorded. Historical single-browser
results do not prove the new window layout. This intentional display-routing
change is not a claim of model-quality or speed improvement.

## Consequences

Independent screen views and automatic shared login coexist without browser
profile synchronization or per-bot containers. These are regions of a shared
desktop: arbitrary native windows can be moved across boundaries and the mouse
pointer is shared. The first implementation must not advertise isolated virtual
sessions or per-bot human takeover. Per-run windows, popup containment, framebuffer
cost and full-screen behavior need real-runtime checks, not only fake Docker.

The installed x11vnc help confirms that `-viewpasswd` takes plaintext and needs
`-passwd`; the older ADR-0006 draft's encrypted-file example must not be copied.
Use the protected `-passwdfile` format with `__BEGIN_VIEWONLY__` instead.

## Amendment 1 (2026-10-13): 720p regions

The owner asked for a lower desktop resolution. Each bot region and the single-screen desktop
are now 1280x720 (720p) instead of 1280x800; the shared-monitors desktop is 3840x1440 (three
columns, two rows), and each run's Chromium window is placed and sized to its 1280x720 region.
Decision 3's layout is otherwise unchanged. `DESKMATES_SCREEN` still overrides the single-screen size.

| Item | Concrete meaning | Required verification | Metric |
| --- | --- | --- | --- |
| A1 | Regions, x11vnc clips and window bounds are 1280x720 on a 3840x1440 desktop | T0 `packages/sandbox-docker/src/workspace-entry.test.ts`, `packages/sidecar/src/mcp-proxy/desktop-window.test.ts` | Region size in the workspace entry script |

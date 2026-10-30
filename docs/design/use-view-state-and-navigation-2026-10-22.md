# Everyday chat state and navigation — 2026-10-22

The owner requested quieter everyday history and a coherent sidebar before visual polishing.
This is an owner-requested presentation amendment to the earlier chat-reading rules: historical
outcome cards need not remain in Use. The transcript, run states and audit records stay intact.
No scheduling, model, role, approval or storage contract changes.

## Reading rules

| Content | Use | Tune |
| --- | --- | --- |
| Human and bot replies, delivered files | Visible, existing text folding | Visible |
| Pending or not-yet-loaded approval | Visible and actionable | Visible |
| Current no-reply, paused-recipient or undelivered-handoff notice | Brief localized explanation until later conversation progress | Original recorded reason |
| Completed approval and decision echoes | Omitted | Visible |
| Current failed/stopped/cancelled attempt without later progress | Visible | Visible |
| Failure belonging to an earlier human request | Omitted; this makes no success claim | Visible |
| Failed attempt followed by a live or successful attempt of the same bot on the same explicit round or trigger | Omitted; the successor supplies the current state | Visible |
| A different bot or unrelated background job succeeds | Does not resolve a current failure | Exact independent statuses |
| Successful cross-chat handoff with a quoted reply | Attributed result | Result and protocol disclosure |
| Handoff process, generic system notices, elsewhere activity history | Omitted | Visible |
| Technical protocol and stack disclosure | Omitted | Available with original text |

The header uses the same unresolved-failure rule as the timeline. It does not keep an old
failure as a bot's current idle state, and a newer internal summary job cannot hide a real
unresolved failure or become the user's current work. Filtering precedes grouping and date separators. Pending
approvals, current waits, paused-thread controls, stop controls and send errors remain visible.
An explicit deep link to a hidden system message reveals that exact message.

## Sidebar states

The everyday Work group follows the work loop: Chats, Tasks, Approvals, then Bots and Board.
Files stays under Resources. Tune adds resource configuration and system operations in their
existing groups; it does not interleave these with the daily work loop. Pin ordering and role
visibility do not change.

- Desktop expanded: workspace, labelled navigation groups, then a fixed footer containing
  connection/release, Help, the named Tune control, and account/role information.
- Desktop compact: the same order and destinations with explicit names/tooltips. The Tune
  control has a recognizable settings icon rather than an unexplained bare switch. Account
  and role controls occupy separate slots and cannot overlap. Group boundaries remain visible.
- Narrow desktop: keep the chosen expanded/compact state. Clamp expanded width to the space
  available without turning a usable 200-pixel sidebar into icons. Restore the preferred width
  when space returns. Mobile uses its existing labelled menu without overwriting that choice.

Expanded/compact presentation follows one state attribute, not independent viewport rules for
the logo, navigation and footer. Only navigation scrolls; the footer never shrinks or scrolls
out of reach. An explicit collapse/expand control supplements the drag/keyboard separator.
Use/Tune changes destinations and diagnostics, not sidebar geometry or saved width. Navigation
is selected by the active route, with one selected destination, and keeps the current link in
view when the view changes. Existing pinned-first chat ordering remains unchanged.

## Verification

Regression fixtures cover recovered/current/other-bot failures, an internal model job after an
ordinary failure, current routing blockers and later conversation progress, approval decisions,
view switching with an unsent draft and no write requests, original-record preservation, neutral
system previews and responsive preference restoration.

Local browser checks use the production application with its bundled mock Gateway. At 1280 ×
720 and 1024 × 768, expanded navigation keeps the footer expanded too. A manual compact rail
has separate account and role slots. The owner clarified that available sidebar width, rather than a viewport breakpoint, must
control labels and alignment. The final 850 × 600 check therefore keeps a chosen expanded
sidebar expanded (clamped to 230 pixels), including its labelled footer; returning to 1280
restores the saved width. At 390 × 844 and 390 × 600 the labelled mobile menu remains
usable; the short menu scrolls within the viewport and its last destination opens and closes
the menu. In the group-chat fixture, toggling Tune exposes the recorded system notice, toggling
back hides it, while the unsent draft and actionable approval remain. No approval was decided,
no model was called, and no stable state changed. Screenshots and fixture records are retained
in the private lab's 2026-10-22 stable lifecycle and presentation acceptance material.

Full gate results are recorded after final checks below. A first complete attempt passed 8,315
tests but failed the existing avatar-upload test with a socket EPIPE. Its isolated eight-test
repeat passed without code changes to the Gateway or that test. Preserve both observations;
do not describe the first complete attempt as a pass.

The final actual-width implementation (`eb03875`) passed the complete gate: typecheck,
lint (2,463 files), documentation consistency, 886 T0/T1 files with 8,318 tests, and the web
production build. The existing production chunk-size advisory remains. No Docker T2 or new
real-model T3 campaign was needed or run for this presentation-only change. Stable was not
upgraded. The private lab retains failed, intermediate and final check logs separately.

# Chat details and presentation summaries

Chat information uses the same modal drawer as file previews and run details.
Escape closes it and returns focus to the information button; membership removal
is exposed by Manage. Navigation and chat-list separators accept pointer dragging,
arrow keys and Home/End, persist widths locally, and preserve minimum content
widths. Compact navigation keeps named icons; phones retain the single-column flow.
Right drawers also resize from their left edge.

Approval cards show an explicitly labelled AI summary when present, with the
actual risk/tool/target still visible. Original arguments, instruction and decision
reason are collapsed together. ADR-0028 generates summaries for new long tool
approvals using separate recorded, tool-free DEFAULT_MODEL jobs in the sidecar.
Historical records are not backfilled; failures retain the original disclosure.
Summary output never changes the action or decision and is never posted as chat.

## Conversation hierarchy

Single-bot chats show one title; group headers keep the member count and an entry
point to chat information. Live work appears once in the transcript as a clickable
status row, including current tool activity and queued counts. Expanding it shows
per-run context, total elapsed time, run links and the existing scoped Stop actions.

Human messages use their right-aligned bubble as identity, with timestamps on
hover/focus (always visible on touch devices). Bot replies use an open reading
layout. Consecutive replies suppress repeated identity metadata unless addressing
information needs to remain visible.

Decided approvals remain as compact receipts in both Use and Tune. Expanding a
receipt shows the original action and an audit disclosure containing the decision
messages. Message deep links open both disclosures. Pending approvals retain all
action, risk and decision controls; no Gateway records or approval rules change.

The default navigation is the 64px icon stage; explicit saved preferences still win.
The chat list defaults to 260px. Chat approval actions are compact: Allow once and
Deny stay visible, while Always opens from a secondary menu and retains its scope
confirmation. Generic tool risk and wait details are disclosed on demand; egress,
continuation and unclassified warnings remain visible. A run already explained by
a pending approval uses a Work details disclosure instead of repeating its wait.
Inline workspace paths are filename preview links. Missing
computer screens no longer add a placeholder to the header. Composer spacing is
reduced and the persistent keyboard shortcut footer is omitted.

Reading metadata is secondary: group rows use one icon and allow two title lines;
chat timestamps show minutes (full local date/time in the title), run links appear
on hover or keyboard focus and remain visible on touch devices. Latest-reply badges
are omitted without changing message folding or run attribution. The member control
shares the header row; the connected state uses a labelled dot, while reconnecting
states retain text. Completed approval summaries omit actors and tool identifiers;
expanded cards retain the original decision and audit fields, including expiry.
Supported prose files open their preview by filename, with download in that drawer;
unsupported files remain directly downloadable. No file path is classified as a final
deliverable solely from its position in a message.

Pending chat approvals use a border-accented confirmation strip. Details opens the
shared detail pane (docked on wide layouts, modal drawer on narrow layouts), keeping
technical facts and raw input out of the transcript. Closing restores focus to the
trigger. Redirect instructions and persistent rules live in the secondary menu;
Allow once and Deny remain adjacent to the action. Inbox presentation and backend
risk classification, decision requests, role checks and rule scopes are unchanged.

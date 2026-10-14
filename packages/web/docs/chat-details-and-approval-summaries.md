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

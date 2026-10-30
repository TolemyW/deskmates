# Chat reading browser check

Use the retained isolated preview, with model dispatch drained. Read the active CUA documentation
and bind the actual test conversation tab first. Do not point this check at a production account
or a conversation containing a person's unsent draft. The fixture must have a visible, folded
historical bot reply and an empty composer.

Import `browser-check.mjs` inside the CUA Node session and pass the bound tab plus the exact
accessible expand/collapse labels observed in its current snapshot. The function operates only
through that CUA tab. It checks native keyboard activation, literal draft retention, accessible
expansion and stable scroll position, then restores the folded state and clears its own probe.
It never presses Send. Review resulting UI state and capture a screenshot with the surrounding
conversation; put the receipt and images in the task's private evidence folder.

Also inspect the latest reply, actual addressing badges, output values and limitations in the
existing accepted task at both available desktop widths. Verify through the isolated Gateway's
read-only runtime/run endpoints that no model run was added. Keep prior receipts and static
bundle inventories. Record results in `docs/design/chat-reading-results-2026-10-21.md`.

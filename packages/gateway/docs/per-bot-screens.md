# Per-bot screen transport (ADR-0008)

`screen-slots` persists a stable slot per bot (six per workspace). Screen status,
explicit start and view/control ticket APIs live on the authenticated operator
listener. `/api/desktop-stream` upgrades require a one-use ticket tied to the
request origin and a fixed provider address; it is not a general network proxy.
The Gateway bridges only bounded binary frames. Handback closes embedded control
sockets immediately; the one-second sweep also closes them after hold expiry.
Read-only previews use a distinct server-enforced VNC credential and never take
browser control. Neither credential leaves the Gateway: the proxy performs the RFB
VNC-authentication handshake upstream and offers the browser `None` (ADR-0022
amendment 1, C7), so a ticket carries no password. New-mode runs receive and record their assigned screen slot.


Explicit membership changes emit `thread_members {threadId}` after a successful
transaction, only when membership changes. Human join-by-mention emits the same
notification alongside its normal message/run frames. Rejoining uses sequence zero
and a fresh SDK session; membership removal never deletes the workspace or files.

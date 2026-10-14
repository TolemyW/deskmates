# Desktop workbench (ADR-0008)

React/Vite now uses Tailwind v4 and locally owned shadcn/ui-style components in
`src/components/ui`: Radix Dialog and Slot, CVA variants and Lucide icons.
`components.json` configures future shadcn additions; the components remain source
in this repository, not a runtime dependency on a hosted design system.

The Desktops route and conversation member cards embed real noVNC frames. Opening
is read-only; Take control acquires the existing workspace hold. Closing the
panel keeps that hold until Return control (or expiry). One Chromium/profile
supplies every bot's login; manual takeover pauses the whole workspace.

The browser obtains an authenticated one-use, 30-second screen ticket and uses
its WebSocket subprotocol on `/api/desktop-stream`. No password or operator
credential goes in that WebSocket URL. Reverse proxies must forward WebSocket
upgrades on `/api/desktop-stream` to the operator listener. Vite already does so.
Off-screen/hidden views disconnect; metadata refreshes every five seconds only
while visible. Legacy workspaces show an image-update message.


Identical SSE subscriptions share a physical EventSource within one browser tab.
The approval badge and workspace-lock hook therefore reuse the global stream,
leaving HTTP/1 connection capacity for member mutations while two conversation
tabs are open. Credentials, thread filters and retry policies remain separate;
the final unsubscribe closes the connection and cancels its reconnect timer.

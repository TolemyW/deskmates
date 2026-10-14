# Web interaction closeout: management and screen recovery

`#/manage` is available from **Workspaces & bots** after initial setup as well as on an empty
deployment. It creates additional workspaces and bots and edits existing bot model overrides.
The model fields use deployment defaults from `GET /api/config`, accept custom IDs and show the
effective configuration. Clearing an override sends `null` to `PATCH /api/bots/:id`. This is not
a model-provider catalog or a claim that any arbitrary model ID is available upstream.

For a held browser, **Open screen** shows the shared screen again without releasing or renewing
the hold: the dialog's `DesktopView` asks `POST /api/workspaces/:id/takeover/open-screen` for a
fresh one-use ticket. Lock state is refreshed after SSE reconnect.

**One path from every machine (ADR-0022 amendment 1, C7).** The workspace noVNC is published on
the Gateway host's `127.0.0.1` (ADR-0006 amendment 1) for the Gateway alone. The page never sees
its address or password: the shared screen, like the bot desktops, streams over the same origin's
`/api/desktop-stream` WebSocket, and the Gateway answers x11vnc's VNC challenge itself. So the
takeover screen works the same from the Gateway host and from a colleague's machine, and it closes
when the hold ends.

See `docs/runbooks/m2-web-interaction-test-handoff-2026-09-23.md` for the eight review scenarios.

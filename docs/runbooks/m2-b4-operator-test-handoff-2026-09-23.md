# M2 B4 operator authentication test handoff

Date: 2026-09-23

## Delivered surface

The Gateway now runs one shared control-plane context behind two listeners. The sandbox listener
serves `/healthz`, `/v1/*` and run-authenticated `/internal/*`; the loopback operator listener
serves authenticated `/api/*`, `/api/events` and `/hooks/*` for the production UI. Operator and
run credentials are not interchangeable. `/hooks/*` uses its existing per-bot path token. The web UI
holds the operator credential in memory, uses a Bearer header for fetch, and uses `?token=` only
for EventSource. Production configuration requires at least 32 bytes; the development launcher
prints an ephemeral credential when `.env` leaves it empty.

This does not alter a Gateway process that is already running. Restart it with the new variables
to activate the split listeners. A reverse proxy should serve the built UI on the operator origin,
map `/api/*` and `/hooks/*` on that origin to `127.0.0.1:<OPERATOR_PORT>`, and leave `/v1/*` and
`/internal/*` on `<GATEWAY_BIND>:<GATEWAY_PORT>` for workspace traffic.

## Focused evidence completed

- Full `npm run typecheck`: passed.
- Gateway configuration plus automatic `/api/*` route walk, listener separation and
  cross-credential checks: 14 tests passed.
- Focused direct-message and browser-origin Gateway checks: 7 tests passed.
- Focused web credential gate, API Bearer header, SSE URL, takeover, thread, run and approval
  checks: 56 tests passed.
- Focused webhook checks: 6 of 7 passed. The one stale B5 assertion expected only `message_bot`;
  the request now also carries the three knowledge tools. It is not an operator-auth failure.
- Biome checks on the B4 files and `git diff --check`: passed.

No Docker, real model or acceptance suite was run for this handoff.

## Pending deployment checks

1. Start the built Gateway with distinct real ports and verify from a workspace container that
   `GATEWAY_PORT` returns 404 for `/api/*`, while the operator port returns 404 for `/v1/*` and
   `/internal/*`.
2. Put the production reverse proxy in front of `OPERATOR_PORT`; verify Bearer-authenticated API
   calls and a real browser EventSource reconnect using the query credential, and confirm access
   logs do not record that credential.
3. Start a real workspace, take over its browser, and verify noVNC rejects no password and a wrong
   password, accepts the password carried in the URL fragment, and never sends it in the HTTP URL.
4. Restart the Gateway and reattach the workspace to confirm the in-memory VNC password is
   recovered from the container environment and is absent from the SQLite database.
5. Run the ADR-0006 container isolation and acceptance checks together with the B5 stack after the
   provider image and reverse-proxy configuration are ready.

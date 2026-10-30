# Operator authentication and listeners (M2 B4)

ADR-0006 separates the two trust surfaces while keeping one control-plane state. `GATEWAY_PORT`
on `GATEWAY_BIND` serves only `/v1/*`, `/internal/*` and `/healthz`. `OPERATOR_PORT` on
`OPERATOR_BIND` serves `/api/*`, `/auth/*` and `/hooks/*` for the production web UI. `/api/*`
requires a signed-in browser session (below) or `Authorization: Bearer <GATEWAY_OPERATOR_TOKEN>`.
No credential is accepted in a URL, `GET /api/events` included (ADR-0022 decision 4 retired
`?token=`). `/hooks/*` keeps its per-bot path token. Run tokens remain valid only for their own `/internal/runs/:runId/*` calls and
the model proxy. Requests sent to the wrong listener get 404.

`GATEWAY_OPERATOR_TOKEN` is required in production and must contain at least 32 bytes. Startup
fails when it is absent or shorter. `npm run dev:gateway` is the one exception: its development
launcher generates and prints an ephemeral credential when `.env` has none; it is not written to
disk and changes when that launcher restarts. The operator listener keeps automatic request
logging disabled.

## Browser sign-in and sessions (ADR-0022 P1)

People sign in with a login name and password; the shared operator token remains only as the
single-tenant maintenance bridge for machine clients (channel adapters, the acceptance stack,
scripts). P1 serves exactly one tenant, the Default Tenant, which owns every workspace.

- **Accounts.** There is no signup route. Platform maintenance creates the first Owner, and any
  later account, on the Gateway host:
  `node packages/gateway/dist/auth/cli.js bootstrap-owner --login <name> --name "<display>"`,
  run from the Gateway's working directory so `.env` and a relative `GATEWAY_DB` resolve as they
  do for the Gateway; it prints the database it opened and refuses a missing one. In a checkout,
  `npm run auth -- …` uses the same `.env` and database as `npm run dev:gateway`
  (`scripts/gateway-dev-env.mjs`). Other commands: `create-user --role owner|admin|member`,
  `reset-password`, `disable-user`, `enable-user`, `revoke-sessions`, `list-users`, and
  `grant-maintainer` / `revoke-maintainer` for platform maintenance (never the last active
  maintainer; `docs/runbooks/multi-tenant.md` section 2). Passwords are read from stdin, hashed
  with Argon2id (`AUTH_ARGON2_*`, OWASP baseline by default) and never logged. A password assigned
  by `create-user` or `reset-password` is temporary: the account may only inspect or end its
  session and change that password until the person replaces it. A password the person chooses
  during invitation sign-up or `bootstrap-owner` does not trigger this gate. Until an account
  exists the UI says so and nobody can sign in.
- **Sessions.** `POST /auth/login` returns a 256-bit opaque token only as an HttpOnly,
  `SameSite=Lax`, `Path=/` cookie (`__Host-deskmates-session`, `Secure`); the database keeps its
  SHA-256. Sessions survive Gateway restarts and expire after 7 days unused or 30 days after
  sign-in (`GATEWAY_SESSION_IDLE_TTL_SECONDS`, `GATEWAY_SESSION_ABSOLUTE_TTL_SECONDS`). Every
  request re-reads the session, user, membership and tenant, so a revocation applies to the next
  request. `GATEWAY_SESSION_COOKIE=insecure-dev` drops `Secure` (and renames the cookies) for
  plain-HTTP development only; production needs HTTPS in front of the operator listener.
- **CSRF.** Every cookie-authenticated `POST`/`PATCH`/`PUT`/`DELETE` needs an `Origin` naming the
  request's own host (or one of `GATEWAY_ALLOWED_ORIGINS`) and the session's CSRF token in
  `x-deskmates-csrf`, which `GET /auth/session` and the login response return. Sign-in itself needs
  the pre-login token `GET /auth/session` hands an anonymous browser, bound to an HttpOnly
  pre-login cookie. No route grants credentialed CORS.
- **Routes.** `GET /auth/session`, `POST /auth/login`, `POST /auth/logout` (this session),
  `POST /auth/logout-all` (every session of the user), `POST /auth/password` (current password
  required; revokes the user's other sessions and rotates this one). Failed sign-ins answer one
  uniform 401 and are throttled per login name (5) and client address (30) per 15 minutes (429).
- **Live connections.** An SSE stream or desktop ticket/WebSocket opened by a session closes when
  that session is revoked in this process, and within one sweep (15 s) when the revocation or an
  expiry is written by another process such as the CLI.
- **Attribution.** Task acceptance records `user:<id>` for a signed-in person and keeps the
  historical `human:web` label for the shared operator credential. Other actor fields
  (message `authorId`, approval decider, takeover holder) are unchanged in P1.

**Serving the built UI (`WEB_DIST_DIR`).** Set `WEB_DIST_DIR` to the output of
`npm run build -w packages/web` (`packages/web/dist`) and the operator listener serves it at `/`:
files by path with their content type, `index.html` for any other GET that is not `/api/*`,
`/hooks/*`, `/v1/*`, `/internal/*` or `/healthz` (those keep their 404), and a 404 for a missing
file under `assets/` or with an extension. Hashed `assets/*` get
`Cache-Control: public, max-age=31536000, immutable`; `index.html` and everything else get
`no-cache`, so a new release is picked up on the next load. Static files need no credential —
they are the public bundle and hold nothing secret — while every `/api/*` route keeps requiring
the operator token (`static-ui.test.ts` walks the route table to prove it). Paths are decoded
once and refused on any dot segment, backslash or NUL, and a symlink leading outside the directory
is not followed. Startup fails when the directory is missing or has no `index.html`. Unset, no UI
is served. The sandbox listener never serves it.

**LAN access.** With `WEB_DIST_DIR` set, `OPERATOR_BIND=0.0.0.0` (or the host's LAN address)
lets colleagues open `http(s)://<host>:<OPERATOR_PORT>/` and sign in. The UI uses
relative `/api` URLs and opens its desktop views over the same origin's
`/api/desktop-stream` WebSocket, so nothing else needs to be reachable. The bind is exposure, not
the boundary: a session is still required, but browsers keep the production `Secure` session
cookie only over HTTPS, so a LAN deployment needs a TLS reverse proxy in front (or the explicit
`insecure-dev` cookie mode, which sends the session cookie in plain HTTP). Never expose
`GATEWAY_PORT` to users.

For a reverse proxy, serve the built operator UI on the operator origin (or proxy `/` to the
operator listener with `WEB_DIST_DIR` set) and send `/api/*` and
`/hooks/*` from that origin to `127.0.0.1:<OPERATOR_PORT>`. Keep
`<GATEWAY_BIND>:<GATEWAY_PORT>` for workspaces' `/v1/*` and `/internal/*` traffic; do not route
`/api/*` to it. The current code does not reconfigure an already running Gateway: restart the
process with the new variables to activate the split.

# Published workspace apps (ADR-0035)

A bot that starts a web app or API in its workspace can publish its port with `app_publish`;
signed-in Members of that workspace open it in their own browser on an origin of its own. Status:
Proposed. Code: `src/app-shares/`, policies in `src/api/route-policies/app-shares.ts`,
configuration in `src/config/app-shares.ts`, relay in `images/egress/app-relay.mjs`.

## Configuration

Off unless both `APP_SHARE_BASE_URL` and `APP_SHARE_OPERATOR_URL` are set. The base host must be a
DNS name that is neither the operator host nor a parent of it; the Gateway refuses to start
otherwise. `APP_SHARE_PORT` (8790) and `APP_SHARE_BIND` (`127.0.0.1`) place the app listener, a
third listener beside the sandbox and operator listeners. A publication's URL is
`<scheme>://<32 hex>.<base host>/`. Locally, `http://apps.localhost:8790` works without DNS because
browsers resolve `*.localhost` to loopback; forward both the operator and app ports through an SSH
tunnel to reach a remote Gateway the same way. When configured, every run's config carries
`appShareVersion: 1` and the sidecar offers `app_publish`.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `POST /internal/runs/:runId/app-shares` | the run token | publish `{ port, label }` for the run's workspace; same port again relabels; at most 10 active |
| `GET /api/workspaces/:id/app-shares` | Member | `{ enabled, shares }`, each active one probed through the relay |
| `POST /api/workspaces/:id/app-shares/:shareId/open` | Member, a signed-in person | a one-use 30-second ticket and the app origin's `/__deskmates/enter` |
| `DELETE /api/workspaces/:id/app-shares/:shareId` | Admin | stop sharing; open connections close at once |

Publishing and revoking are audited as `app_share.publish` (the bot, with the run) and
`app_share.revoke` (the person).

## The app listener

- Any `Host` that is not a known label under the base host is 404.
- `POST /__deskmates/enter` takes the ticket in a form body, only with `Origin` equal to
  `APP_SHARE_OPERATOR_URL`, sets the host-only `deskmates-app` cookie (`__Host-deskmates-app` on
  HTTPS) and redirects to the requested path.
- Every other request needs that cookie's grant, rechecked each time against the publication, the
  session and the person's Member role there. Without it a page links to
  `<operator>/#/apps/<share>?ws=<workspace>&path=<path>`.
- Unsafe methods and WebSocket upgrades with a foreign `Origin` are 403. Deskmates cookies are
  stripped from the forwarded `Cookie`; the app's `Set-Cookie` loses `Domain` and may not name a
  Deskmates cookie. WebSocket and SSE pass through.
- The Gateway reaches the app through the egress proxy's keyed relay on host loopback; a stopped
  service is a 502 page, and the list reports it `unavailable`.

The app process belongs to the workspace: the bot starts it detached, the Gateway never starts or
restarts it, and after a container restart a bot must start it again under the same URL.

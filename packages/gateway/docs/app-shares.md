# Published workspace apps (ADR-0035)

A bot that starts a web app or API in its workspace can publish its port with `app_publish`, and
a Member can publish a running port from the Files page; signed-in Members of that workspace open
it in their own browser on an origin of its own. Status: accepted, owner-decided 2026-10-14. Code:
`src/app-shares/`, policies in `src/api/route-policies/app-shares.ts`, configuration in
`src/config/app-shares.ts`, relay in `images/egress/app-relay.mjs`.

## Configuration

Off unless both `APP_SHARE_BASE_URL` and `APP_SHARE_OPERATOR_URL` are set. The base host must be a
DNS name that is neither the operator host nor a parent of it; the Gateway refuses to start
otherwise. The operator host may be an IP literal. `APP_SHARE_PORT` (8790) and `APP_SHARE_BIND`
(`127.0.0.1`) place the app listener, a third listener beside the sandbox and operator listeners.
A publication's URL is `<scheme>://<32 hex>.<base host>/`. Locally, `http://apps.localhost:8790`
works without DNS because browsers resolve `*.localhost` to loopback; forward both the operator
and app ports through an SSH tunnel to reach a remote Gateway the same way. When configured,
every run's config carries `appShareVersion: 1` and the sidecar offers `app_publish`.

Both URLs name what the browser sees. Behind a TLS reverse proxy they carry `https:` and the
proxy's public port, while the listener itself speaks plain HTTP on loopback:

- An `https:` base names the grant cookie `__Host-deskmates-app` and marks it `Secure`. The browser
  accepts it because it sees HTTPS; the plain hop from the proxy to the listener does not matter.
- The listener matches the `Host` header exactly, port included, so the proxy must pass the
  browser's `Host` unchanged (Caddy's `reverse_proxy` does by default).
- An unsafe request's `Origin` must be `https://<label>.<base host>[:port]`, and the entry form's
  `Origin` must equal `APP_SHARE_OPERATOR_URL` with its port.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `POST /internal/runs/:runId/app-shares` | the run token | publish `{ port, label }` for the run's workspace; same port again relabels; at most 10 active |
| `GET /api/workspaces/:id/app-shares` | Member | `{ enabled, shares }`, each active one probed through the relay |
| `POST /api/workspaces/:id/app-shares` | Member | a person publishes `{ port, label }` with the same rules; the row has no bot or run and names `publishedBy` |
| `POST /api/workspaces/:id/app-shares/:shareId/open` | Member, a signed-in person | a one-use 30-second ticket and the app origin's `/__deskmates/enter` |
| `DELETE /api/workspaces/:id/app-shares/:shareId` | Member | stop sharing; open connections close at once |

Publishing and revoking are audited as `app_share.publish` (the bot with the run, or the
person) and `app_share.revoke` (the person). Opening an app is not audited. An app published from
a private chat is a workspace record: every Member of the workspace sees, opens and may stop it.

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
restarts it, and after a container restart a bot must start it again under the same URL. A
workspace whose egress proxy predates the app relay reports its apps as unavailable until the
proxy is recreated.

## Testbox: a nip.io name and a self-signed certificate behind Caddy

The stable deployment has no certificate and no wildcard DNS of its own. Owner decision
2026-10-14: enable app sharing there with `*.10.20.40.132.nip.io` and Caddy's internal CA, at
the next release activation. The operator UI is already `https://10.20.40.132:18443` (Caddy,
user unit `deskmates-stable-tls.service`, `shared/Caddyfile`, self-signed IP certificate) in front
of the operator listener on 18381.

1. Pick a free loopback port for the app listener, for example 18382 (`ss -ltn | grep 18382`
   prints nothing).
2. Add to the deployment's `shared/.env` (0600; the Gateway refuses to start if only one URL is
   set):

   ```
   APP_SHARE_BASE_URL=https://10.20.40.132.nip.io:18443
   APP_SHARE_OPERATOR_URL=https://10.20.40.132:18443
   APP_SHARE_PORT=18382
   APP_SHARE_BIND=127.0.0.1
   ```

3. Add a site to `shared/Caddyfile` on the same public port. Caddy chooses the site by SNI and
   `Host`, so the operator's IP site and its certificate stay as they are. `skip_install_trust`
   keeps a user-level Caddy from trying to install its root into the system store; put it in the
   existing global options block if there is one. A global `auto_https off` (the stable
   Caddyfile had one) also stops `tls internal` from issuing the wildcard certificate, and every
   app host then fails the TLS handshake; use `auto_https disable_redirects` instead, which keeps
   certificate automation and adds no port-80 redirect (found on Testbox on 2026-10-14).

   ```
   {
     skip_install_trust
   }

   *.10.20.40.132.nip.io:18443 {
     tls internal
     reverse_proxy 127.0.0.1:18382
   }
   ```

4. Reload Caddy (`systemctl --user reload deskmates-stable-tls`) and restart the Gateway
   (`systemctl --user restart deskmates-stable-gateway`), or let the release activation restart it.
5. Check from the host: `curl -sk https://0123456789abcdef0123456789abcdef.10.20.40.132.nip.io:18443/`
   answers the listener's 404 page "No published app answers at this address", which proves DNS,
   TLS and the proxy hop. `GET /api/workspaces/:id/app-shares` reports `enabled: true`.

What each person's computer needs:

- **DNS.** `<label>.10.20.40.132.nip.io` must resolve to 10.20.40.132 (`dig +short
  abc.10.20.40.132.nip.io`). Resolvers with DNS-rebinding protection (dnsmasq
  `stop-dns-rebind`, many home routers, Unbound `private-address`) refuse public names that answer
  with a private address; allow `nip.io` there or use another resolver. A fake-IP proxy such as
  Mihomo answers with `198.18.x` addresses instead: add `+.nip.io` to its fake-IP filter and a
  direct rule for it.
- **Trust.** Caddy's internal root is `~/.local/share/caddy/pki/authorities/local/root.crt` on
  the host (the Caddy user's data directory). Import it into the browser or system trust store.
  Without it every app host shows its own certificate warning; after accepting one, open the app
  again from Deskmates, because the warning interrupts the one-use entry form.
- **Same scheme everywhere.** Open Deskmates itself at `https://10.20.40.132:18443`; the entry form
  is refused from any other origin.

Rollback: remove the two `APP_SHARE_*` URL lines and restart the Gateway; the tool disappears from
new runs and every app URL stops answering. Publications stay in the database and work again when
the setting returns.

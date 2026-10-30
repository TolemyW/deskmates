# Analytics relay to Grafana (ADR-0046 amendment 1)

The built-in Grafana ([runbook](../../../docs/runbooks/grafana.md)) listens on the host loopback
only, under the sub path `/analytics/`, and signs in whoever the `X-WEBAUTH-USER` header names
from loopback (`auth.proxy`). The Gateway is the only client that sets that header: it relays
`/analytics` and `/analytics/*` on the operator listener to Grafana, for the root's own browser
session, and always names `admin`, whom Grafana creates as a Viewer. The relay forwards bytes; it
never reads the obs model or parses a body ([run observability](run-observability.md)).

Code: `src/api/analytics-routes.ts` (registration), `src/api/analytics-relay.ts` (headers,
streaming, bounds), `src/api/route-policies/analytics.ts` (policy), `src/config/observability.ts`
(`grafanaUpstream`).

## Configuration

`OBSERVABILITY_GRAFANA_URL` is the upstream: an `http` origin on a loopback host (`127.0.0.1`,
`[::1]` or `localhost`) with no path, query or credentials, for example
`http://127.0.0.1:18700`. Anything else stops startup, so a decision 6 value naming the host's
network address cannot send the identity header across a network. Empty turns the relay off: the
routes answer 404 and `GET /api/config` reports `analyticsUrl: null`. Set, `analyticsUrl` is
`/analytics/`; Grafana's own address is reported only by the root-only
`GET /api/observability/status`.

## Who passes

The routes are an operator route family in the guarded scope, with the policy access
`root_session` for GET, POST, PUT, PATCH and DELETE on both patterns
([generated matrix](../../../docs/generated/permission-matrix.md)).

| Caller | Answer |
| --- | --- |
| no session | 401, as every operator route |
| a signed-in person other than the root, an Owner included | 403 `root_only` |
| the operator credential, a service principal | 403 `root_only`: no bearer passes |
| a run token, any other bearer | 401 |
| the root `admin`, signed in | relayed |

An unsafe method needs a same-origin `Origin`, as everywhere, but not the session's CSRF header:
Grafana's own frontend cannot send it. The exemption is the fixed set `ORIGIN_CHECKED_ROUTES` in
`operator-auth.ts`, equal to the relay's two patterns (`analytics-routes.test.ts` checks it). The
session cookie is `SameSite=Lax`, and a Viewer can change nothing a forged request could reach.
Every relayed request spends the tenant's request budget, like every root route.

## What reaches Grafana

Removed from the request: hop-by-hop headers and those `Connection` names, every `X-WEBAUTH-*`
the browser sent, `Authorization`, the Gateway's session and pre-login cookies (Grafana's own
cookies pass), the CSRF and tenant selector headers, `Origin`, `Forwarded`, `X-Forwarded-*` and
`X-Real-IP`. Set: `Host` (Grafana's) and `X-WEBAUTH-USER: admin`. Method, path and query pass
unchanged, since Grafana serves the same sub path.

Back to the browser: status, headers and body as they come, less hop-by-hop headers; a `Location`
that points at Grafana itself (a loopback name with Grafana's port) becomes its path on the
Gateway's origin.

## Bounds and failures

| Bound | Value | Then |
| --- | --- | --- |
| response headers | 30 s | 502 `analytics_unavailable`, `reason: timeout` |
| inactivity on the upstream connection | 60 s | 502 before headers; afterwards the response ends early |
| request body | 16 MiB | 413 `payload_too_large`, declared or counted |
| upstream refuses or resets | | 502 `analytics_unavailable`, `reason: unreachable` |

A 502 body never names the upstream address or the socket error.

## WebSockets

Grafana Live is off (`GF_LIVE_MAX_CONNECTIONS=0`) and the relay upgrades nothing: an upgrade
request to `/analytics/*` reaches the operator listener's upgrade handler, which accepts only the
desktop stream and closes everything else.

## Tests

`src/api/analytics-routes.test.ts` (a fake upstream records what arrives: admission, stripped
headers, cookies, streaming both ways, Location, 502 without the address, the bounds, upgrades);
`src/api/operator-auth.test.ts`, `route-policy.test.ts` and `permission-matrix.test.ts` (route
walk and generated matrix); `src/config/observability.test.ts` (loopback origin only).

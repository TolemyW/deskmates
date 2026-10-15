# egress proxy image

Infrastructure-only HTTP forward proxy for a workspace. The workspace network is internal, so the
proxy is its only path to the public network. Ordinary destinations permit plain HTTP on port 80
and HTTPS `CONNECT` on port 443. The exact reserved name `host.docker.internal` also reaches the
operator-selected host address on any TCP port, preserving the documented host-service exception.
Other private names and IP literals remain denied, except the exact LAN origins (scheme, RFC1918
host or subnet, port) of a root-selected network profile, which arrive as `grants` in a version 2
policy document and never reach the proxy's own networks or the host target (`lan-grants.mjs`,
ADR-0027 amendment 1).

Build from the repository root:

```sh
docker build -f images/egress/Dockerfile -t deskmates/egress-proxy:dev .
npm run image:workspace
```

Set `EGRESS_PROXY_IMAGE=deskmates/egress-proxy:dev` for the Gateway (an empty value currently uses
that tag). The Gateway supplies the workspace allowlist and generates `DESKMATES_VNC_PASSWORD`; the
provider supplies `DESKMATES_EGRESS_PROXY` and all HTTP proxy variables. The proxy is provider-managed
infrastructure and is not launched or configured manually.

The provider sets `DESKMATES_HOST_TARGET` inside the proxy from its own operator-controlled process
environment (default `host.docker.internal`). The proxy resolves it once on its outbound network
at startup and pins that numeric address. Colima resolves the name to the macOS host. When the
default name is absent on native Linux, the proxy uses the managed outbound bridge gateway from
`DESKMATES_HOST_FALLBACK_IP`. An invalid or unresolvable custom target prevents proxy startup. This
configuration never comes from a workspace spec, page, bot, or allowlist. Workspace clients must
send the reserved name through the managed proxy; loopback remains local to the workspace.

The provider writes `/run/deskmates-egress/allowlist` over Docker exec stdin and signals PID 1. A
successful reload closes every existing connection and acknowledges the exact file hash. There is
no policy API or control socket on the workspace network. Each authorization carries a policy
generation across DNS resolution; if policy changes while DNS is pending, no upstream socket is
created. A parse, read or acknowledgement failure switches the in-memory policy to deny-all and
closes sockets immediately, before the provider's bounded acknowledgement wait expires.

Every proxy process start first overwrites that file with an empty deny-all policy, even when the
tmpfs happened to survive a container restart. The creation-time allowlist is never stored in the
container environment. `DockerProvider.create` applies and acknowledges the requested initial
policy before starting the workspace; after a daemon or proxy restart, Gateway attach reapplies the
current database policy. Until that happens, egress remains denied rather than reverting to an old
creation-time allowlist.

The proxy resolves an allowed hostname itself, rejects the request if any answer is non-public,
and connects to a selected numeric address. That pins the checked DNS result to the socket and
prevents a second resolution from rebinding to loopback, private, link-local, metadata or multicast
space.

An allowlist may instead hold the single entry `*`: any public hostname (ADR-0010). It never
widens beyond public addresses. IP literals in any spelling, `localhost` and `*.localhost` stay
denied by name, and every resolved address still goes through the same non-public check
(loopback, RFC 1918, link-local, CGNAT, the `198.18.0.0/15` benchmark range and the rest), so a
public-looking name that resolves inward is refused. `*` mixed with other entries is a parse error,
which fails closed like any other bad policy; replacing the policy without `*` denies new
connections at once. The reserved host exception is unchanged.

The proxy resolves names with its container's DNS servers. By default that is Docker's embedded
resolver, which forwards to the host's. Where the host resolver answers public names with fake IPs
(a Mihomo-style resolver returning `198.18.0.0/15`), every public destination is correctly denied.
Two Gateway settings change how the proxy resolves; both are applied when the proxy container is
created, so an existing workspace needs its proxy recreated to pick up a change. The workspace
container itself keeps no resolver.

- `EGRESS_PROXY_DNS` (comma-separated IP addresses) becomes the proxy container's DNS servers. It
  helps only where the fake answers come from the host's resolver configuration. It does not help
  where every packet to port 53 is intercepted, whatever server it is addressed to (a TUN-mode
  proxy such as Mihomo on Testbox, measured 2026-09-28): the proxy still sees fake IPs.
- `EGRESS_PROXY_DOH_URL` (ADR-0010 decision 4a) is a JSON DNS-over-HTTPS endpoint, e.g.
  `https://223.5.5.5/resolve`. The provider passes it to the proxy container only, as
  `DESKMATES_DOH_URL`, and the proxy then resolves every name with two HTTPS queries
  (`?name=<host>&type=A` and `type=AAAA`, `accept: application/dns-json`) instead of port 53. The
  host must be an IP literal: resolving the resolver's own name would go back through the
  intercepted path. Only type 1 (A) and 28 (AAAA) answer rows are used; CNAME and other rows are
  ignored. A transport or HTTP error, a redirect, malformed JSON, a non-zero `Status`, an address
  row whose data is not an address of its type, no address at all, or no reply within 5 seconds
  fails the request closed. The answers go through the same non-public check, so a DoH answer in
  `198.18.0.0/15` or a private range is still denied, and the proxy connects to the checked
  address. An invalid value stops the Gateway at startup (and the proxy, if one ever received
  it). When both settings are set, DoH decides the proxy's lookups; `EGRESS_PROXY_DNS` then only
  affects the reserved host target's one-time startup resolution.

Inbound, the proxy runs fixed relays to the workspace container only: the screen relays on 6080
to 6086 and the app relay on 6090 (`app-relay.mjs`, ADR-0035 decision 4), each published on host
loopback for the Gateway. An app relay connection must start with `DESKMATES-APP/1 <key> <port>\n`,
where the key is `DESKMATES_APP_RELAY_KEY`, generated by the provider per proxy container. The relay
answers `OK\n` and pipes to `<workspace container>:<port>`, or `ERR <reason>\n` for a wrong key,
a port below 1024 or in 6080 to 6086, or nothing listening. Which ports are published is the
Gateway's record; the relay carries no egress and never chooses a host.

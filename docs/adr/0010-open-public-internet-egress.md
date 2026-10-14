# ADR-0010: Open public-internet egress for trial workspaces

Date: 2026-09-28
Status: accepted by the product owner on 2026-09-28 for the internal trial deployment
Amends: the egress rule in `AGENTS.md` and ADR-0006's managed egress proxy
Amendment 1 (2026-09-28): DoH resolver (decision 4a); corrects the fake-IP finding in Problem
Amended by: ADR-0027 amendment 1 (decision 2's later decision on intranet sites: root-selected network profiles; `*` still never implies LAN access)
Amended by ADR-0020 (2026-10-03): `*` is the default for a new workspace, and a locked workspace asks on a first visit instead of failing; decision 1's "It is not a default" no longer holds

## Problem

The stable deployment on Testbox is an internal trial: people give bots tasks on
real websites they did not list in advance. Today a workspace reaches only the
hosts on its allowlist, and an allowlist entry is an exact hostname or
`*.suffix`. There is no way to say "any public site", so every new site needs an
operator edit before a bot can open it. The owner decided the trial workspaces
browse the open public internet.

A second, host-specific defect blocks this regardless of policy. On Testbox
public names resolve to Mihomo fake IPs in `198.18.0.0/15`. The egress proxy
correctly treats that range as non-public, so every public destination is
denied. A container on that host using the default resolver gets `198.18.0.84`
for `example.com`.

Correction, measured on 2026-09-28 (amendment 1): the original text said a
container with `--dns 223.5.5.5` or `--dns 8.8.8.8` fixed this. That was a
misreading. Those fetches succeeded because the host's Mihomo TUN routes fake
IPs, not because the answers were real. Every plain DNS query, UDP or TCP on
port 53, to any server (Docker's embedded DNS, 223.5.5.5, 8.8.8.8,
119.29.29.29), is intercepted by the TUN and answered with a fake IP, so a
different port-53 resolver cannot help and the proxy still denies. What does
work: DNS-over-HTTPS to an IP-literal endpoint is not intercepted. From a
container, `https://223.5.5.5/resolve?name=example.com&type=A` returns real
answers (Google-style JSON, `{Status, Answer: [{name, type, TTL, data}]}`) with a
certificate valid for the IP, and direct connections to the addresses so
obtained succeed (example.com, www.baidu.com, github.com: 9 of 9, 0.06 to
0.9 s). Some destinations (ghcr.io, `*.githubusercontent.com`) are reset on the
direct path; the trial reaches what the host's direct network reaches.

## Decisions

1. **An allowlist may hold the single entry `*`: any public hostname.** It is
   set only through the operator API or UI, per workspace, like every other
   entry; the agent still cannot edit it. It is not a default: a new workspace
   starts with the allowlist its creator gives it.
2. **`*` never widens beyond public addresses.** The proxy's resolved-address
   check still refuses loopback, RFC 1918, link-local, CGNAT, benchmark and
   other non-public ranges, so intranet hosts, the Docker bridges and cloud
   metadata stay unreachable. IP-literal destinations stay denied. The reserved
   host exception of ADR-0009 is unchanged. Reaching intranet sites needs a
   later decision.
3. **Every enforcement point reads `*` the same way.** The contracts matcher
   (`egressAllows`), the sidecar's tool-level checks and the proxy's policy all
   accept `*` as "any hostname that is not an IP literal". Live policy edits and
   revocation keep working: removing `*` denies new connections as it does for
   any entry.
4. **The proxy resolves through a deployment-configured resolver.** The
   Gateway setting `EGRESS_PROXY_DNS` (comma-separated IP addresses) becomes the
   egress proxy container's DNS servers. Unset keeps today's behaviour. An
   invalid value stops the Gateway at startup rather than producing a proxy
   that silently denies everything. The workspace container itself keeps no
   route and no resolver of its own. It stays valid on hosts that do not
   intercept port 53; it does not help where they do (see the correction above).

   4a. **Amendment 1 (2026-09-28): the proxy may resolve through
   DNS-over-HTTPS.** The Gateway setting `EGRESS_PROXY_DOH_URL` is an `https://`
   URL whose host is an IP literal (for example `https://223.5.5.5/resolve`); a
   hostname, another scheme or embedded credentials stop the Gateway at
   startup, because resolving the resolver's own name would go back through the
   intercepted path. The provider passes it to the egress proxy container only.
   The proxy then resolves every name with a JSON DoH query for A and one for
   AAAA, uses only the final A/AAAA rows (CNAME and other rows ignored), and
   fails closed on a transport or HTTP error, a redirect, a malformed body, a
   non-zero `Status`, no address at all, or no reply within 5 seconds. Every
   answer still goes through the unchanged non-public check, so a fake-IP or
   private answer is denied as before, and the proxy connects to the address it
   checked, never re-resolving the name. Unset keeps port-53 resolution. When
   both settings are set, DoH decides the proxy's lookups.
5. **An open-internet workspace is an untrusted-browsing workspace.** The
   default grouping rule applies unchanged: it holds no production credentials,
   and anything that must not meet page content goes in another workspace. The
   operator UI shows such a workspace as open internet so nobody mistakes it
   for a restricted one.

## Alternatives

- Keep per-site allowlisting for the trial: rejected by the owner; the trial is
  about tasks nobody listed in advance.
- Route the proxy through the host's Mihomo port: rejected; it listens on
  loopback only, belongs to another user's desktop session, and would make the
  deployment depend on a personal proxy's rules and uptime.
- Change the Docker daemon's DNS or the host resolver: rejected; the daemon and
  resolver are shared with unrelated services on that host.
- Allow private addresses under `*`: rejected; it would expose the host, its
  bridges and the office network to page-driven navigation.

## Verification (required before acceptance)

| Decision | Concrete meaning | Executable proof | Metric |
| --- | --- | --- | --- |
| 1 | `*` is accepted by operator validation and rejected from any agent path | contracts pattern tests; gateway workspace PATCH test; existing agent-cannot-edit test | Zero agent-originated allowlist changes |
| 2 | Under `*`, private, fake-IP and IP-literal destinations are denied | `images/egress` policy tests; `acceptance/m2-boundaries.container.test.ts` case with `*` | Zero successful non-public connections |
| 3 | Contracts, sidecar and proxy agree on `*`, and revoking it denies new connections | matcher table test shared by contracts and sidecar; proxy SIGHUP test with `*` removed | Identical verdicts on the shared table |
| 4 | `EGRESS_PROXY_DNS` reaches the proxy container; bad values fail startup | gateway config test; `docker-provider` create-body test | Proxy `HostConfig.Dns` equals the setting |
| 4a | `EGRESS_PROXY_DOH_URL` must be https on an IP literal and reaches only the proxy container; lookups use only A/AAAA rows, fail closed on any error, non-zero status, empty answer or timeout, stay subject to the non-public check, and the socket connects to the checked address | `images/egress/doh-lookup.test.mjs`; gateway config test; `docker-provider` create-body test | Zero connections to a non-public or unchecked address; DoH lookup failures counted as denials |
| 5 | The UI marks an open-internet workspace | web workspace view test | Label present exactly when `*` is present |

Live evidence on Testbox (public site reachable, private address denied, with
`EGRESS_PROXY_DOH_URL` set, since `EGRESS_PROXY_DNS` cannot help on that host)
is recorded in the release runbook when the first release is deployed.

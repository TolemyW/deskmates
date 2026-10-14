# ADR-0027: Operator-pinned private HTTPS targets per workspace

Date: 2026-10-11
Status: Accepted by the owner in the VendorDB knowledge-base campaign chat; focused container verification passed, release/live campaign verification pending.
Amends: ADR-0009 decision 4 and ADR-0020 decision 3 only for the explicit mechanism below.
Amendment 1 (2026-10-14, proposed, issue #124): online, durable, named network profiles admit
explicitly configured LAN origins (HTTP or HTTPS, custom ports, RFC1918 IP literals); decisions 6
to 14 below. It supersedes decision 4's startup-only rule and decision 1's HTTPS:443 and
no-IP-literal limits for profile grants only; `EGRESS_PRIVATE_TARGETS` keeps its exact meaning.

## Context

The owner authorized testing console.vendordb.lan and account.vendordb.lan at
10.20.36.35:443. The public-only proxy rejects this RFC1918 address even with
an exact hostname allowlist. Docker routing also overlaps the corporate address;
that host routing issue is separately corrected without changing other networks.
The owner approved a workspace-scoped private-target capability, normal certificate
trust and release validation, rather than a tunnel or an untagged stable hot patch.

## Decisions

1. An operator-only deployment setting `EGRESS_PRIVATE_TARGETS` is a bounded JSON
   array of `{workspaceId, hostname, address, port:443, expiresAt}`. Only exact
   lowercase DNS names and canonical RFC1918 IPv4 addresses are admitted. No
   wildcard, IP-literal hostname, loopback, metadata, CGNAT, public, reserved or
   IPv6 target is admitted. Expiration is mandatory. Nothing is configured by
   default; the setting is never writable through a bot or workspace API.
2. The provider selects entries for the exact workspace and sends them with its
   allowlist over the existing authenticated Docker exec stdin policy channel.
   The proxy connects to the pinned numeric address without DNS resolution only
   if that hostname is also explicitly in its allowlist, the port is 443 and the
   entry is unexpired. A `*` or suffix wildcard never enables a private target.
   HTTP and other ports remain denied for a private target. TLS remains end to
   end with original hostname/SNI and normal verification.
3. Policy publication is atomic and acknowledged by a hash covering both the
   allowlist and private entries. Reload, denial and restart retain the existing
   fail-closed behavior. Removing the hostname revokes open tunnels. Expiration
   closes its active tunnels as well as denying new connections. Invalid policy
   denies all; expired entries remain denied, without public-DNS fallback.
4. The setting is read at Gateway startup; changing it requires a Gateway restart
   and policy reapplication. Entries travel only to their configured workspace;
   model context and ordinary operator workspace responses do not gain the policy.
   No extra network interface, capability, host-network mode or host exception is
   introduced. Existing public-address and reserved-Gateway behavior is unchanged.
5. Enterprise CA trust and host routing are operator prerequisites, not reasons
   to disable certificate checks or rewrite target URLs. Preserve unrelated
   services. Test the exact released images before use and record live evidence.

## Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1 | Reject malformed, broad and special-address entries; bound input and require expiration | contracts private-egress tests; gateway config tests | invalid configurations rejected |
| 2 | Pin the exact host/address/port only under an explicit allowlist, without DNS fallback | proxy policy tests and private-egress container test | forbidden connections zero |
| 3 | Hash complete policy, invalidate on reload, fail closed, close expired tunnels | provider tests; proxy policy tests; private-egress container test | connections surviving revocation/expiry zero |
| 4 | Filter by workspace and preserve existing proxy transport/network isolation | provider tests; existing boundaries T2 | cross-workspace private grants zero |
| 5 | No TLS weakening; deployed managed browser reaches the approved origin | campaign live receipt after release; T2 TLS fixture | prerequisite pass or exact blocker |

This authorizes capability implementation, not a claim that any verification has
passed or that the knowledge-base campaign is complete.

## Campaign trust amendment (2026-10-11)

The owner explicitly approved temporary trust of the two current VendorDB leaf
certificates because the enterprise CA is unavailable today. This is a local
trust-on-first-use decision tied to the owner-supplied address, not verification
of identity by an enterprise CA. Limit it to the campaign workspace and current
certificate bytes; never import them as a CA or use ignore-certificate-errors.
The browser must continue to reject hostname mismatches, expired certificates
and replacement certificates. Remove these trust entries at campaign close or
when a verified CA becomes available. A changed certificate is a blocker, not
an automatic refresh. This amendment changes decision 5's CA prerequisite for
this campaign only, not the proxy mechanism or other workspaces.

Verification: Chromium 145.0.7632.6 in the existing v0.5.3 workspace image, with
an isolated NSS database and virtual test hosts: `P,,` trusted leaf loaded;
wrong hostname produced ERR_CERT_COMMON_NAME_INVALID; expired leaf produced
ERR_CERT_DATE_INVALID; untrusted replacement produced ERR_CERT_AUTHORITY_INVALID.
An NSS database mounted read-only failed even the positive control; the
successful test used a writable, disposable workspace-local database.
Scripts and receipts are in `spikes/vendordb-kb-campaign-20261011/`.

## Amendment 1 (2026-10-14, proposed): online LAN network profiles

Issue #124. Functional testing against a LAN service such as `http://10.20.30.24:23001`
needed host forwarding, a synthetic HTTPS wrapper, temporary certificate trust, a deployment
environment edit and a global Gateway restart. Decisions 1 to 4 explain why: grants were a
startup-only environment setting limited to exact DNS names, HTTPS on port 443 and mandatory
expiration. The owner asked for supported LAN test connectivity and for this ADR (and the
ADR-0006/0009/0010/0020 decisions it touches) to be amended before implementation. Everything
below is proposed until the owner accepts it; the owner choices it had to make are marked.

6. **Network profiles are durable configuration, changed online.** A network profile is a named,
   reusable set of grants stored in the Gateway database (`network_profiles`,
   `workspace_network_profiles`), not in the environment. It is created, replaced, deleted and
   selected through authenticated operator routes; no change needs a Gateway, workspace or
   browser restart. `EGRESS_PRIVATE_TARGETS` stays a startup-only compatibility source with
   exactly the meaning of decisions 1 to 4; an operator moving an entry online recreates it as a
   profile host rule (HTTPS, port 443) and removes the environment entry at the next planned
   restart. A workspace without a selected profile publishes byte-identical policy, so the
   upgrade reloads no proxy.
7. **Validate, commit, then publish what is durable.** A candidate profile or selection is
   validated whole before any row changes; an invalid one is rejected and changes nothing. One
   transaction writes the change, increments the profile's `revision` and writes the
   `AuditLog` row. The Gateway then publishes to each affected workspace, under the same
   per-workspace policy lock that allowlist edits and approval "allow this site" use, a policy
   recomputed from the database at that moment. Each publication therefore carries the latest
   allowlist and the latest grants, so concurrent allowlist and profile edits cannot lose one
   another; profile edits are also serialized among themselves and accept an optional
   `expectedRevision`, which turns a stale editor's write into a 409 conflict. Only workspaces
   that select the changed profile are published to, and a workspace whose new policy hash equals
   the one its proxy already acknowledges is not reloaded (the existing hash check). The
   response returns the profile's revision and, per affected workspace, `applied`, `unchanged`,
   `not_running` or `failed` with the acknowledged policy hash. Each outcome is audited as
   `network_policy.publish`.
8. **Partial publication fails closed and is visible.** A publication that is not acknowledged
   stops that workspace's proxy (the existing `updateEgress` rule): its workspace has no network
   route rather than a stale grant. The outcome is `failed` in the response and in the audit
   record, never success, and other workspaces' outcomes stand. The database stays the truth:
   the workspace's next sandbox use reattaches, restarts the proxy deny-all and pushes the
   current policy, and repeating the same request republishes. A reload still closes every
   existing external connection of the affected workspace, as today; the UI says so before a
   change. Preserving unrelated connections across a reload is a follow-up.
9. **What a grant may name.** A profile holds at most 64 rules of two kinds. A host rule is an
   exact lowercase DNS name pinned to one canonical RFC1918 IPv4 address; the proxy never
   resolves it. A subnet rule is a canonical RFC1918 IPv4 CIDR and admits IP-literal URLs inside
   it. Every rule lists its schemes (a non-empty subset of `http`, `https`) and its ports (1 to
   16 integers in 1..65535). No wildcard name, IPv6, loopback, link-local or metadata, CGNAT,
   multicast, public or reserved address is admitted, nor `host.docker.internal` or a
   `.localhost` name. Internal DNS resolution of unpinned names is not part of this amendment
   (proposed follow-up). Profiles and selections may carry an expiry; a grant's effective expiry
   is the earlier of the two, and a profile without one is persistent across restarts.
10. **One matcher, two enforcement points.** A request is admitted by a grant when its scheme,
    host and port (the scheme's default when absent) match an unexpired rule: the hook checks
    browser navigation and `curl`/`wget` URLs against the grants of the run's workspace, read
    with the allowlist from `GET /internal/runs/:id/egress` before each check; when that read
    fails the hook uses no grants. The opt-in browser CLI workflow keeps its public-origin rule
    (follow-up). The proxy forwards an absolute-form
    HTTP request to a granted `http` origin and tunnels a CONNECT to a granted `https` origin,
    connecting to the pinned or literal address on the granted port; URLs are not rewritten and
    TLS stays end to end with normal hostname and certificate verification (decision 5). An
    expired grant denies new connections and its open connections close at expiry.
11. **The public policy never implies LAN access; infrastructure stays denied.** `*` and every
    allowlist pattern keep ADR-0010 decision 2: only grants admit a private address or an IP
    literal, and a profile is the only source of grants besides decisions 1 to 4. The proxy
    refuses a grant whose target address lies in a subnet of one of its own networks (the
    workspace network and the outbound bridge, whose gateway is the host) or equals the reserved
    host target, so a profile cannot reach the Gateway, another workspace's proxy or the Docker
    host; the reserved host keeps ADR-0009's path only.
12. **Who owns profiles (owner choice, proposed).** A profile reaches into the deployment's
    private networks, an installation-level fact, as the environment setting was. Defining,
    replacing and deleting a profile, and selecting profiles for a workspace, is the root's alone
    (the operator credential or the protected account, ADR-0022 amendment 6). Workspace Owners
    and Admins read which profiles their workspace selects. Bots and run tokens have no route
    that creates, selects or broadens a grant, and an approval never adds one. Letting a
    workspace Owner choose among root-published profiles is a later owner decision.
13. **A workspace with a profile is a trusted-test workspace (owner choice, proposed).** It is
    labelled as such in its settings and its network response. Reuse across workspaces is
    explicit, one selection per workspace, and grants connectivity only, never cookies or files.
    Selecting a profile for an open-internet (`*`) workspace, or setting `*` on a workspace that
    selects one, is refused: an untrusted-browsing workspace never holds LAN reach (ADR-0010
    decision 5). Functional tests run in a workspace with an explicitly selected profile; their
    success is not evidence that the default network policy or isolation gates pass.
14. **Diagnostics name the failing layer.** A preflight for one URL reports policy denial, DNS,
    TCP, TLS or the HTTP response as the failing layer, executed from the workspace's proxy (the
    real network vantage point) with no model call and nothing persisted. Detection of
    Docker/LAN subnet overlap during deployment, a Docker-only test service adapter, and
    revalidating a cached handle's container topology after attach are follow-ups; disabling
    fresh-attach network validation is not a connectivity fix.

## Verification (amendment 1)

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 6 | Profiles persist in the database and change through operator routes without restart; a workspace without one publishes the old bytes | `gateway/src/network/network-profiles.test.ts`; `sandbox-docker/src/lan-egress.test.ts` | restarts needed for a policy change zero |
| 7 | Validation before mutation; revision and audit in one transaction; publication under the workspace lock from durable state; only selecting workspaces; unchanged hash, no reload; stale revision 409 | `gateway/src/network/network-profiles.test.ts`; `gateway/src/api/network-routes.test.ts` | lost updates zero; reloads of unaffected workspaces zero |
| 8 | Unacknowledged publication stops the proxy, reports `failed`, audits the outcome and leaves other workspaces applied | `gateway/src/network/network-profiles.test.ts` | failed publications reported as success zero |
| 9 | Malformed, broad and special-address rules rejected; schemes, ports and expiry bounded | `contracts/src/network-profile.test.ts`; `sandbox-docker/src/lan-egress.test.ts` | invalid grants admitted zero |
| 10 | Hook and proxy admit exactly the granted scheme, host and port, deny expired grants and close expired tunnels | `contracts/src/network-profile.test.ts`; `sidecar/src/hooks/pre-tool-use-lan.test.ts`; `sandbox-docker/src/lan-egress.test.ts`; `acceptance/lan-egress.container.test.ts` (T2) | forbidden LAN connections zero |
| 11 | `*` and patterns never admit a private target; the proxy refuses grants inside its own networks or at the host target | `contracts/src/network-profile.test.ts`; `sandbox-docker/src/lan-egress.test.ts` | infrastructure targets reached through a grant zero |
| 12 | Only the root defines and selects; Owners and Admins read; run tokens have no route | `gateway/src/api/network-routes.test.ts` | grants created or selected by non-root principals zero |
| 13 | Selection refused on a `*` workspace and `*` refused on a selecting workspace; trusted-test label returned | `gateway/src/api/network-routes.test.ts` | open-internet workspaces with LAN grants zero |
| 14 | Preflight reports policy, DNS, TCP, TLS or HTTP as the failing layer without a model call | `gateway/src/network/network-preflight.test.ts`; `acceptance/lan-egress.container.test.ts` | preflights with an unattributed failure zero |

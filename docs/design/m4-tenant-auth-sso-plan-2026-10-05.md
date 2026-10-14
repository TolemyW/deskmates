# M4 proposal: tenant isolation, persistent login and external SSO

Date: 2026-10-05
Status: Proposed; documentation only, no implementation or acceptance claim
Baseline: `main` at `153240e9d239aa1f7c46770dc5186dfc88c63e62`

Companion records: [ADR-0022](../adr/0022-tenant-isolation-and-user-sessions.md),
[test and migration gates](m4-tenant-auth-sso-test-plan-2026-10-05.md).

## Outcome and scope

Replace daily operator-token entry with revocable, persistent first-party sessions.
Separate a global User, their TenantMembership, and the tenant's Workspaces. Keep a
shared Gateway and SQLite with application-enforced isolation, and the existing
per-workspace container/network. Different logins alone are not tenant isolation.

Support local self-hosted passwords and a generic OIDC provider interface. Google
is an optional adapter; enterprise tenants can require their own SSO. Login always
ends in a Deskmates session, not a provider bearer token used as an application API
credential. Native SAML SP, SCIM, organization trees, billing subscriptions,
cross-tenant sharing or workspace moves, per-bot ACLs, Kubernetes, and a database
replacement are outside M4. SAML is supported only through a separately verified
SAML-to-OIDC identity broker, not direct metadata import into Deskmates.

This proposal extends M4 without closing deferred M3 gates or changing task
management into execution. No production IdP, OAuth app, secret, deployment or
runtime configuration is changed by this document.

## Current implementation edges that must migrate together

- `packages/gateway/src/api/operator-auth.ts` checks one global operator secret.
  The Web client stores it in sessionStorage; Disconnect is not server revocation.
- `api/events-route.ts` subscribes to a global bus with optional thread filtering;
  presence is global. Neither is an authorization boundary.
- Workspace listings, portions of connector listings, and Knowledge including FTS
  are global. Learned memory is workspace-scoped but callers still need authority.
- `packages/gateway/migrations/0027-tasks.sql` constrains `accepted_by` to
  `human:web`. New users require a migration, not merely a changed API response.
- Scheduler recovery crosses queued/resumable runs. `/api/runtime` exposes global
  active runs for upgrade drain and must remain a platform management capability.
- ADR-0013 maps connections in the Gateway and uses per-workspace runtime tokens
  with `allowedConnections`. The runtime has no native tenant field to rely on.
- Connector URLs currently permit trusted-operator private endpoints. Offering
  that power to an untrusted tenant creates an SSRF path to private infrastructure.
- Legacy takeover routes can return a direct noVNC URL/password and accept a body
  `authorId`. Revoking only a new WebSocket proxy does not revoke those old paths.

## Identity and resource model

| Entity | Proposed invariant |
|---|---|
| User | Global opaque ID, display profile and active/disabled state; identity is not tenant authorization |
| AuthIdentity | Unique provider/issuer + subject mapped to User; local password hash/reference separately managed |
| Tenant | Opaque ID, name, active/suspended status; only platform maintenance creates tenants in M4 |
| TenantMembership | Unique tenant + user, Owner/Admin/Member role, status and authorization version |
| Workspace | Non-null tenant_id; no cross-tenant move or sharing |
| AuthSession | Hash of random token, user, authentication provenance, idle/absolute expiry and revocation |
| TenantAuthGrant | Session + tenant + provider identity/policy version + auth_time/expiry; evidence of required tenant SSO |

A user may join several tenants. Each request selects exactly one tenant; a path
or header is only a selector and is verified against active membership. Avoid a
single mutable session-wide currentTenant that makes two browser tabs interfere.
The UI's saved last tenant/workspace is only a preference. Switching scope clears
cached data and ignores late responses belonging to the old scope.

All members can access the tenant's workspaces. Workspaces still share browser
profiles, files and credentials among their bots (ADR-0004). Use a separate tenant
for a personal private space. Gateway roles do not constrain what a member or bot
can do with a third-party login already shared inside a workspace.

- Owner: Admin powers plus ownership transfer and tenant closure; protect the last
  Owner against removal or demotion, including concurrent updates.
- Admin: tenant membership/invitations, workspace configuration, connections,
  egress policy and authorized high-risk approvals.
- Member: use bots, threads, runs, files and task editing/explicit acceptance;
  cannot change persistent authorization rules or approve their own L2 actions.
- Platform maintenance: deployment/drain, host paths, upstream credentials,
  provider adoption, global price/catalog configuration and tenant provisioning.
  This is distinct from tenant administration; never give admins a global token.

The approval policy is a proposed amendment to ADR-0002's broad thread-member
approval wording: human role checks are tenant-scoped; bot membership remains
routing/soft trust, never a per-bot ACL. Review the existing bot-decider policy
explicitly and prove it cannot provide a tenant member an alternate privileged
approval path before enabling a second tenant.

Tenant admins may change only their own memberships and grants. They cannot
reset a global user's password, disable that global account, revoke unrelated
tenant sessions, or enumerate a user's other memberships.

## Login, invitation and session contract

Bootstrap is a maintenance CLI or short-lived, single-use setup flow bound to an
intended account. An unconfigured service stays locked; the first public visitor
cannot claim it. Registration is closed by default. Invitations bind tenant,
verified target identity, maximum permitted role, expiry and one-time consumption.
No SMTP is required for an administrator to securely deliver an activation link;
absence of SMTP is not permission to enable arbitrary signup. Concurrent invite
acceptance is atomic. Email matching needs verified trusted claims or a prebound
subject; matching strings alone is insufficient.

Use a mature password library with Argon2id, calibrated on the deployment,
rate limits and non-enumerating errors. Maintenance-authorized CLI recovery is
available for self-hosting; do not promise email reset without mail delivery.
Credential reset or login-method changes revoke other sessions.

Use at least 256 random bits for opaque session tokens, persist only their hashes,
and rotate after login/privilege elevation. Proposed defaults (not calibrated):
7-day idle and 30-day absolute expiry, configurable; sensitive actions require
recent reauthentication. Persistence survives Gateway restart within those bounds.
Use `__Host-` cookies with Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain.
Production requires HTTPS; explicit localhost development mode may use a different
cookie name and must not weaken production. Never store sessions in localStorage,
query parameters, logs or artifacts.

All cookie-authenticated mutations require Origin validation and a session-bound
CSRF token, including logout/invitation/role changes. Protect login itself with
pre-session/login-CSRF defenses; do not blanket-exempt `/auth`. Prefer same-origin
UI/API and no wildcard credentialed CORS. Suggested routes are `/auth/login`,
`/auth/logout`, `/auth/logout-all`, `/auth/session`, and provider start/callback
routes. Existing business `/api` paths can keep their shape behind one principal
and authorized tenant context.

Logout revokes the current session immediately; logout-all revokes all of that
user's sessions. Global user disable revokes global access; tenant membership
removal/demotion revokes that tenant's applicable grants, streams, tickets and
control leases without affecting other tenants. No revocation waits for page
refresh. Single-process M4 needs a tested live-connection registry; multiple
Gateway processes require coherent revocation propagation before support claims.

## Generic OIDC and enforced enterprise SSO

Use a maintained OIDC implementation: authorization code + PKCE, one-time state,
nonce, exact registered redirect URI, signature/JWKS, issuer, audience, expiry and
replay checks. Pin issuer and discovery endpoints in platform-approved provider
configuration; do not fetch an arbitrary user-supplied URL. Handle key rotation
without disabling verification. Bind the login transaction to the starting
browser session, tenant/provider and safe relative return path.

Identify users by issuer + subject, never email. An external identity cannot
silently merge with a same-email local account or another issuer. Linking requires
an existing authenticated account and fresh verification of both identities.
Provider identifiers must also distinguish configured trust domains safely.
Google asks only for openid/email/profile. Google login does not grant Drive
access: workspace integration OAuth is a separate consent and credential flow.

Tenant policy is `local_or_sso`, `sso_optional`, or `sso_required`, backed by allowed
providers, policy version, maximum authentication age and explicit JIT policy.
Entering an enforced tenant requires current evidence from that tenant's allowed
issuer, not merely a globally valid local session or a previous login to another
tenant. Switching tenant, policy changes, downgrade/fallback endpoints, API tokens
and account recovery must not bypass enforcement. Local login may still identify
a user globally, but provides no enforced-tenant grant. Fail closed on IdP outage.
Default JIT is off; if enabled, it is bounded to an approved tenant/provider and
minimum role, never inferred Admin/Owner from an untrusted claim or email domain.

SAML-only organizations use a separately operated broker (for example Keycloak)
that accepts SAML and presents OIDC. Broker identity linking must obey the same
no-email-auto-link rule. Broker deployment, trust/certificate rotation and an
end-to-end SAML test are separate dependencies; mock OIDC does not certify SAML.

Local logout always revokes Deskmates access. IdP-wide logout is a distinct user
choice and capability. If OIDC back-channel logout is supported, validate signed
issuer/audience/event/time/sid or sub and replay defenses before matching sessions.
Without SCIM or an IdP push signal, IdP disable is not instantaneous local
revocation: use administrator removal and bounded enterprise auth age, disclose
the window, and do not market real-time deprovisioning.

## Complete tenant boundary

Keep SQLite and explicitly acknowledge it has no native row-level security. Every
tenant-owned persistent object carries tenant_id, with composite uniqueness and
foreign keys such as (tenant_id, id) and (tenant_id, workspace_id). Runs' bot and
thread references must resolve to the same workspace. Validate every Task JSON
reference; serialization is not a bypass around referential checks.

Store operations require TenantContext/WorkspaceContext; put scope conditions in
SQL for read/write/delete, search, count, paging and export. Missing context fails
closed with no default tenant. System-wide iteration uses separately named APIs,
not a global store accidentally reachable from an operator route.

Before coding, enumerate every route, table, derived index/cache and background
entry point in a coverage manifest. Cover workspaces, bots, threads/messages,
conversation sessions, routing walks, runs/events/usage/model requests,
approvals/rules, locks/origin queues/screens, tasks, triggers/channel bindings,
connectors/validations/receipts, integration connections/tokens/OAuth state,
Knowledge/versions/proposals, memories/episodes/confirmations, cost alerts and
secrets. Explicit global exceptions are identity/authentication records and
platform configuration/public catalogs; global auth sessions hold separate tenant
grants. Unclassified resources block the second-tenant gate.

Knowledge becomes tenant-shared; learned memory remains workspace-scoped. FTS and
fallback LIKE queries, snippets, counts and cursor validation scope candidates
before ranking/paging, rather than global top-K followed by filtering. Rebuilds,
exports and caches retain scope and authorization version where needed.

Files use a tenant/workspace-owned namespace (e.g.
`tenants/<tenant>/workspaces/<workspace>/`), including Knowledge versions/exports.
Authorize ownership before traversal/symlink checks; use race-safe file opening,
not a realpath check followed by a replaceable ordinary open. Tickets bind actor
and scope. Untrusted HTML/SVG/JS must not execute under the application cookie
origin: isolate origin or strict sandbox/CSP; raw downloads use attachment and
nosniff. Task artifact links remain references to mutable bytes, not immutable
verified delivery.

Retain Gateway-owned workspace connection mapping and runtime allowedConnections.
Namespace runtime names server-side; authorize tenant/workspace before every
secret read or execute. Runtime admin credentials never enter a tenant API or
container. Proxy runtime unauthenticated download URLs through authorized file
handling. Integration OAuth state binds tenant/workspace/user/session/provider,
expiry and one-time consumption; callback rechecks membership and resource state.
Revoking a connection revokes its runtime grant, not just its UI row.

Hosted tenants cannot register arbitrary private Connector URLs. Use approved
endpoints or platform-approved private proxies. Validate resolved IPv4/IPv6 and
every redirect; reject metadata, loopback, private/admin networks and rebinding.
Hostname-only checks are insufficient.

Container/network/volume/snapshot ownership includes tenant and workspace. Reattach,
recreate and cleanup verify both against a migration manifest and fail closed on
conflict. Labels support ownership checks, not a security boundary by themselves.
Keep internal workspace networks and egress proxy isolation; never rename by
deleting a persistent volume.

## Streams, desktops and background execution

SSE uses same-origin cookies, never `?token=`. Server-derived tenant/workspace
envelopes filter before delivery; events without threadId resolve run → bot →
workspace. Missing ownership is rejected. Last-Event-ID/replay and reconnection
remain scoped. Presence counts qualified approvers for the relevant scope, not
all open browsers across the installation.

Desktop HTTP and raw WebSocket upgrades independently check session, membership,
workspace, Origin and a short-lived single-use ticket. Bind tickets to session,
user, tenant, workspace, bot, view/control capability and takeover epoch. A human
lock is not permission for another user to control it: leases record holder user
and session. Revoke tickets and close streams/control leases immediately when
authorization ends. Retire direct VNC/password routes in multi-tenant mode or
move them behind the same revocable proxy. Derive author/audit identity from the
principal, never body authorId.

Keep separate operator and sandbox listeners and authentication stores. Browser
cookies and scoped machine tokens cannot use internal run/model routes; run
tokens cannot use operator routes or another run. Future machine credentials are
hashed, expiring, revocable and tenant/workspace/scope bound. The old global bearer
may be a time-bounded single-tenant maintenance bridge only; disable its tenant
access before admitting another tenant.

Persist tenant/workspace/resource and actor/service identity in jobs; revalidate
relationships and tenant status on dispatch, retry, recovery and continuation.
Idempotency keys include tenant + operation + key; receipts also bind workspace.
Removing a human does not automatically delete already delegated tenant schedules,
but pending human approvals and new human capabilities become invalid. Tenant
suspension prevents new starts/resumes and requires an explicit drain/cancel policy
for in-flight work. Webhook/channel routing derives ownership from configured
bindings, never payload-selected tenant IDs.

Tenant-aware fair scheduling and concurrency/queue/disk/request quotas prevent
one tenant exhausting the installation. Existing cost alerts are soft thresholds;
hard budgets require reservation/settlement and an explicitly measured error bound.
Logs/traces and tenant-visible audit queries carry scope, redact credentials, and
avoid cross-tenant existence leaks or cache collisions.

## Migration and rollback

1. Allocate forward-only migration numbers from the actual merge-time sequence.
   Freeze writes, stop new jobs, drain or explicitly terminate active runs. Back up
   consistent SQLite/WAL, volumes, Knowledge, runtime credential state and recovery
   key material. Rehearse on a copy, never the only production database.
2. Create Default Tenant and bind the existing operator via secure bootstrap.
   Backfill known legacy resources; do not guess ownership by request or email.
   Orphans/conflicts are reported and block multi-tenant enablement.
3. Rebuild tables for NOT NULL/CHECK/composite FKs, scoped indexes and FTS. Run
   foreign_key_check plus application relationship checks. Preserve task versions,
   states, references and historical `human:web` as a legacy operator fact. Add
   real user attribution for new acceptance without attributing old acts to the
   new Owner. Management still starts no execution.
4. Files/DB cannot move in one transaction. Persist a manifest, validate checksums,
   copy or idempotently move, then switch references. Resume after interruption;
   retain sources until verified. Preserve browser state and old volumes through
   controlled ownership adoption/recreation.
5. Ship sessions in single-tenant mode first. A second tenant stays inaccessible
   until every boundary/test gate passes and the global bearer/direct VNC escape
   paths are closed. A feature flag is not partial isolation acceptance.
6. Before multi-tenant writes, rollback may restore a coherent backup. Afterward,
   never run an old tenant-unaware binary on the new database. Stop writes, use a
   compatible recovery path or restore with disclosed data loss; invalidate all
   sessions/tickets on restore so old capabilities cannot resurrect.

## Delivery phases and dependencies

P1: Identity/provider interfaces, session and tenant-grant schema, bootstrap/local
login, restore/logout UI, CSRF and cookie SSE, single tenant only.

P2: Membership/roles/enforced-SSO policy, complete resource manifest, scoped stores,
Knowledge/FTS/files/audit and migration. Reference and ownership checks are atomic.

P3: Scheduler/recovery/run credentials, webhooks/channels, runtime/OAuth, desktop,
presence/revocation, Docker lifecycle, cache and quota boundaries.

P4: Invitation/switch/member UI, generic enterprise OIDC verification, optional
Google adapter, recovery rehearsal and deployment runbook. Enable second tenant
only after the full gate. Broker SAML has its own gate and may remain deferred
without blocking local + OIDC launch; never claim it verified when deferred.

Independent PRs are appropriate. Preserve existing task behavior; do not bundle
unpublished task patches, unrelated E2E repairs or platform upgrades. Report
account-login delivery separately from isolation acceptance. See the test plan for
objective phase gates and required evidence.

## Review decisions and security limits

Review the proposed role/approval amendment, session TTLs, tenant quota values,
SSO maximum authentication age, and in-flight suspension policy before their
implementation gates. Unknown deployment-specific IdP settings are setup inputs,
not grounds to weaken enforced-SSO semantics.

This is application isolation plus workspace file/network separation. It does not
protect against a malicious host administrator, compromised Gateway/Docker daemon
or shared kernel. Shared master keys/runtime admin credentials remain platform
trust points. Strong hostile-code isolation would require separate nodes/VMs and
credential domains, outside this proposal.

## References

- [Shared workspace](../adr/0004-shared-workspace-by-default.md)
- [Authentication and workspace networks](../adr/0006-operator-api-auth-and-workspace-networks.md)
- [Integration runtime](../adr/0013-saas-integrations-through-an-integration-runtime.md)
- [Task semantics](../adr/0021-workspace-task-management.md)
- [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)
- [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)
- [OIDC back-channel logout](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- [Keycloak identity brokering](https://www.keycloak.org/docs/26.8.0/server_admin/)

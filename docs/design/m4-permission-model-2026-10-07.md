# M4 permission model

Date: 2026-10-07
Status: a description of what the code on branch `claude/m4-tenant-isolation-p2-p4` enforces, for
the owner's review before any new permission logic lands (owner, 2026-10-07: "first write the
whole permission model down and make it consistent, then add logic"). It adds no rule. The route
tables (section 7) are generated from the code into `docs/generated/permission-matrix.md`;
`packages/gateway/src/api/permission-matrix.test.ts` fails when they or the route table disagree.

Updated 2026-10-10: the owner decided findings C1 to C8 ([ADR-0022 amendment 1](../adr/0022-tenant-isolation-and-user-sessions.md)).
Section 3 now states the agreed rule, section 5 the changed approval and takeover rules, and
section 6 records each decision; the generated tables follow `ROUTE_POLICY`.

Related: [ADR-0022](../adr/0022-tenant-isolation-and-user-sessions.md) (tenants and sessions),
[ADR-0002](../adr/0002-sidecar-is-the-sdk-host-process.md) amendment 2 (who decides approvals),
[ADR-0004](../adr/0004-shared-workspace-by-default.md) (bots share a workspace), ADR-0006 (listeners and
credentials), ADR-0011 (learned memory), ADR-0020 (egress approvals).

## 1. The two boundaries

There are exactly two security boundaries, and every check in this document serves one of them:

1. **Tenant.** Nothing of one tenant is readable, writable or reachable from another: data,
   events, runs, desktops, credentials, containers. Enforced by the server on every request; a
   foreign identifier looks exactly like a missing one (uniform 404).
2. **Credential class.** Each kind of credential works only where it is meant to: a browser
   session on the operator listener, a run token on the sandbox listener for its own run, the
   operator credential on the operator listener in the Default Tenant, a webhook token for one
   bot's webhook.

Everything inside a tenant is a **role** decision (who may use or configure it), not a boundary
between people. Everything inside a workspace is **shared** among its bots (ADR-0004): SOUL,
working directory, thread membership and the deciding bot are soft distinctions. A workspace
separates bots, never people: every member of a tenant sees all of its workspaces. People who
must not see each other's work belong in different tenants.

## 2. Principals

| Principal | Authenticated by | Accepted on | Acts as |
|---|---|---|---|
| Anonymous browser | Pre-login cookie and its CSRF token | `/auth/*` sign-in routes only | Nobody; may sign in, accept an invitation, start SSO |
| Signed-in person | `__Host-deskmates-session` cookie, CSRF token on unsafe methods, same Origin | Operator listener (`/api`, `/auth`, screen WebSockets) | Their membership role in the tenant the request selects (`x-deskmates-tenant`, or `?tenant=` on `/api/events`), checked against their memberships and tenant grants on every request |
| Platform maintainer | A signed-in person whose account has `platform_role = maintainer` | Platform routes, plus whatever their own memberships allow | Installation-wide maintenance; **not** a member of any tenant by virtue of the flag |
| Operator credential | `Authorization: Bearer <GATEWAY_OPERATOR_TOKEN>` | Operator listener | Owner of the Default Tenant plus platform maintenance; ignores any tenant selector, so it never reaches another tenant (in both `single` and `multi`) |
| Service principal | `Authorization: Bearer deskmates-sp.<...>`, looked up by SHA-256 on every request (ADR-0022 amendment 2) | Operator listener `/api` only; never the sandbox listener or the model proxy | Its tenant role, `admin` or `member` (never Owner; ADR-0022 amendment 1 A10), in its one tenant; a selector naming another tenant is refused; its messages are `service:<id>` and spend its own run and daily cost budget |
| Run (bot) | Short-lived run token | Sandbox listener: `/internal/runs/<its run>/*` and the model proxy | Its bot, inside its run's workspace and tenant |
| Webhook caller | Bot webhook token in the path | `POST /hooks/:botId/:token` | Starts a background run of that one bot |
| Identity provider | Single-use OIDC state bound to the starting browser | `/auth/oidc/callback` | Evidence for a login, link or step-up; never a principal on its own |
| Integration provider | Single-use OAuth state (bound to the starting session) | `/api/integrations/oauth/callback` | Completes one connection grant |
| Maintenance CLI | Shell access to the Gateway host and database | The database file | Everything; it is the root of trust (bootstrap, tenants, users, SSO, backup) |

Chat channel adapters (WhatsApp) authenticate with the operator credential, so they act in the
Default Tenant only (finding C4).

## 3. Roles inside a tenant

The agreed rule (owner, 2026-10-10; [ADR-0022 amendment 1](../adr/0022-tenant-isolation-and-user-sessions.md),
"Admins own the group; Members use side chats"): every act that changes a group's shared state
is an Admin's; a Member views everything and talks to a bot in a side chat of their own.

- **Member** views and uses side chats: reads everything in the tenant (every workspace, thread,
  run, task, memory entry, cost and Knowledge document, other people's side chats included);
  opens a **side chat** (a one-bot `chat` thread on the web channel that they opened, marked by
  `threads.side_chat_actor`; never a bot's canonical private chat, never a group) and posts only
  in their own side chats while they hold one bot; answers approvals once (`allow_once`, `deny`);
  cancels runs and answers turn-continuation asks only in their own side chats; takes over the
  browser through the screen proxy and views
  desktops; proposes Knowledge; acknowledges cost alerts.
- **Admin** owns the group: cancels any run and answers any turn-continuation ask; posts in
  group chats and bots' private chats and opens those private
  chats; creates chats with several bots; adds and removes thread members; sets thread
  deadlines; creates, edits and accepts tasks (and the composite submit); answers approvals
  persistently (`allow_always`, "allow this site"); curates memory (edits `MEMORY.md`; edits,
  forgets, undoes and confirms learned-memory entries of any scope; closes task notes; runs
  consolidation; reviews memory suggestions). An Admin also configures the tenant: creates and
  changes workspaces (including the egress allowlist) and bots (including SOUL, connections,
  webhook tokens); creates and deletes approval rules; registers connectors and integration
  connections; sets cost alert rules; reviews and edits Knowledge; manages Members and invites
  Members.
- **Owner** is an Admin who may also change anyone's role (including making another Owner) and
  invite Admins. The last active Owner can never be demoted or removed.
- Anyone may leave a tenant (except its last Owner).
- **Platform maintenance** (not a tenant role): prices, the integration runtime and provider
  adoption, action tier overrides, Knowledge version cleanup, and, from the CLI only, tenants,
  users, passwords, SSO providers, tenant SSO policy, backup and restore.
- **Service principal**: carries a tenant role like a person (ADR-0022 amendment 1 A10): `admin`
  (the default from an Admin or Owner) or `member` (lowered at creation, or the CLI default),
  never Owner and never platform maintenance. It is checked exactly like a person of that role,
  side chats included (actor `service:<id>`); no route has an exception for it.

What a person may do never depends on which bot or workspace inside the tenant they touch. A
side chat limits what its Member does to the group's threads and configuration; it does not
limit the machine: the bot's run uses the workspace's one browser, files and shell (ADR-0004),
and the bot's own tools are unchanged.

## 4. Where each check happens

| Check | Enforced by | Tested by |
|---|---|---|
| Session, user, membership, tenant and grant still valid | `operator-auth.ts` on every `/api` request | `auth-routes.test.ts`, `session-store.test.ts` |
| Route is classified; role is enough; every tenant-owned id belongs to the request's tenant | `route-policy.ts` preHandler | `route-policy.test.ts`, `tenant-boundary.test.ts` (walker) |
| Lists, counts, search and cost reports contain only the tenant | Scoped SQL in each store | `tenant-boundary.test.ts` |
| Rows cannot point across workspaces or move between tenants | Triggers (migrations 0029, 0031) | `tenant-boundary.test.ts`, `migration-0029-0032.test.ts` |
| Events, presence, live connections | `events-route.ts`, `presence.ts`, `live-connections.ts` | `tenant-execution.test.ts` |
| SSO evidence for `sso_required` tenants | `session-store.ts` (`loginAdmitsTenant`) | `oidc.test.ts` |
| Run token only for its own run | Sandbox route preHandlers | `tenant-execution.test.ts` (RUN-01), `operator-auth.test.ts` |
| Who decided, who acted | `actor.ts` (principal, never the body for a person) | `tenant-boundary.test.ts` (AUDIT-01) |
| Membership changes and invitations | `auth-service.ts`, `invitations.ts` | `tenancy-p4.test.ts` |
| This document matches the code | `permission-matrix.ts` | `permission-matrix.test.ts` |

## 5. Rules that are not a route

- **Approvals.** Any member of the run's tenant answers once from the UI (`allow_once`,
  `deny`); a persistent answer needs an Admin, because its effect is configuration:
  `allow_always` stores a rule and "allow this site" adds the host to the workspace allowlist
  (ADR-0020; ADR-0022 amendment 1 A3). Any bot that is a member of the approval's thread decides
  with `approval_decide`, including, in a one-member thread, the requesting bot from a later run
  (ADR-0002 amendment 2 A2: a soft boundary, unchanged). A stored rule answers before anyone is
  asked.
- **Presence.** An approval waits live only while someone of the run's tenant has the event
  stream open.
- **Takeover.** Any member may take the workspace browser. The lease belongs to the session that
  took it: nobody else may take it over or open its control screen; it ends on hand back, logout,
  revocation or loss of membership; an Admin may free a browser someone left held. The screen is
  served through the Gateway's screen proxy only: no route returns the noVNC address or
  password; the holder gets a one-use ticket, the proxy authenticates to the workspace's VNC
  server itself, and the stream closes when the lease ends (ADR-0022 amendment 1 A8).
- **Desktop tickets** are bound to the session and tenant that opened them.
- **SSO.** A tenant with `sso_required` admits only a sign-in from a provider it links, no older
  than that link's maximum authentication age; a password or another tenant's provider never
  substitutes. Identity is issuer + subject, never email. A signed back-channel logout token
  from the IdP ends the sessions and step-up grants of the IdP session (`sid`) or user (`sub`) it
  names.
- **Invitations** bind tenant, role (Member, or Admin from an Owner; never Owner) and one exact
  identity; consumption is atomic and single-use.
- **Bots.** A run reaches only its own workspace (browser, files, memory, connectors, egress) and
  its tenant's Knowledge; `message_bot` reaches bots of the same workspace only; Knowledge from a
  bot is a proposal an Admin reviews; a learned memory write of scope `rule` is refused
  (ADR-0011 item 1).

## 6. Consistency review

Each rule in sections 3 to 5 was checked against the others. What holds without exceptions:
tenant scoping (no route, stream, job, credential or container crosses it), credential classes,
the last-Owner rule, invitations never exceeding the inviter's own power, and attribution.

Places where two rules disagree, or a rule is missing. The table below is the review as written
on 2026-10-07. The owner decided all eight on 2026-10-10 (ADR-0022 amendment 1):

- C1: decided (b). A Member answers once (`allow_once`, `deny`); `allow_always` and "allow this site" are an Admin's; bots unchanged.
- C2: decided (b), widened. Memory curation is configuration: `MEMORY.md`, learned-memory entries of any scope and suggestion review are Admin; Members read.
- C3: decided with C1. Persistent answers and approval rules are both an Admin's.
- C4: decided (a), keep. Channel bindings stay per workspace under the operator credential; several people's accounts under one workspace is out of scope.
- C5: decided (a), keep. Tenant SSO stays platform-only.
- C6: decided (a), keep. Full tenant visibility, actions restricted; isolation is a second tenant, never a per-person audience.
- C7: decided (b). Takeover is served through the screen proxy only; no route returns the noVNC address or password, and access ends with the lease.
- C8: decided (a), keep. The operator credential stays the Default Tenant's Owner for scripts and adapters; attribution stays self-declared until channels move to service principals.

Two further points the owner decided the same day, after the first implementation:

- Run cancel: decided. A Member cancels only a run of a side chat they opened; any other run is 403 `run_outside_own_side_chat` (ADR-0022 amendment 1 A11).
- Turn-continuation answers: decided. A Member answers only in a side chat they opened, with the same refusal (A12).
- Service principals carry a tenant role, `admin` or `member`, and are checked like a person of that role, with no route exception (A10).
- People are managed by people: the member, invitation and account routes refuse every service principal (`people_only`); profile and avatar stay self-service for every person (A13).

| # | Finding | Today | Options |
|---|---|---|---|
| C1 | **Approval answers persist configuration that a Member may not edit directly.** `allow_always` creates an approval rule and "allow this site" extends the egress allowlist; creating a rule or editing the allowlist needs an Admin. Bots in the thread can do the same. | Allowed: a decision carries its persisted effect (ADR-0020 already names an answered ask as an allowlist writer). | (a) Keep and state it as the rule. (b) Members and bots may answer once (`allow_once`, `deny`); persistent answers need an Admin. This is the deferred approval role split. |
| C2 | **Behaviour-shaping text has two levels.** Editing SOUL needs an Admin; editing a bot's `MEMORY.md`, editing a learned memory entry (including an existing `rule`-scope one) and accepting memory suggestions need only a Member. ADR-0011 item 1 says rules change "only through the operator API", which every member now is. | Mixed. | (a) Memory curation is use: keep Member, and state that SOUL is the only configuration text. (b) `MEMORY.md` and `rule`-scope entries are configuration: Admin. |
| C3 | **Approval decisions are not role-restricted, but approval rules are.** Listing rules is Member, creating and deleting is Admin, yet C1 lets a Member create one. | See C1. | Resolved together with C1. |
| C4 | **Chat channels have no tenant.** Adapters use the operator credential, which is pinned to the Default Tenant, so another tenant cannot connect WhatsApp. | Default Tenant only. | (a) Keep; channels are a Default Tenant feature. (b) A per-tenant service credential for adapters (new principal, ADR needed). |
| C5 | **Tenant SSO is platform-only.** An Owner cannot link a provider or change their tenant's policy; a platform maintainer does it from the CLI. All other tenant configuration is Admin. | Platform only (ADR-0022: providers are platform-approved). | (a) Keep: trust anchors are platform decisions. (b) Owners choose among already-approved providers and set their own policy. |
| C6 | **No per-workspace audience for people.** Every member sees every workspace, thread, run and cost of the tenant. | By design (section 1). | (a) Keep: use a second tenant. (b) Workspace membership for people (a permission subsystem the architecture rules avoid between bots; would need an ADR). |
| C7 | **Takeover hands out the direct noVNC address and password.** Anyone who took over once keeps a working VNC password until the container is recreated, independent of the lease. | Allowed (owner decision 2026-10-07: no extra restriction for now). | (a) Keep. (b) Screen proxy only. |
| C8 | **The operator credential is an Owner of the Default Tenant with no person behind it.** Its actions are recorded as `human:<authorId from the body>`. | Allowed (owner decision 2026-10-07). | (a) Keep. (b) Platform routes only in `multi` (reverted on 2026-10-07). |

## 7. Generated route tables

The route tables are generated from the code into
[docs/generated/permission-matrix.md](../generated/permission-matrix.md): `/api` routes from
`ROUTE_POLICY`, every other route on either listener from `permission-matrix.ts`.
`packages/gateway/src/api/permission-matrix.test.ts` fails when that file, the route table or the
listeners disagree; the file says how to regenerate it. A route-policy change no longer edits this
document.


# ADR-0022: Tenant isolation and revocable user sessions

Date: 2026-10-05
Status: Accepted (under owner delegation, 2026-10-17) for the single-tenant scope that has shipped: decisions 1 to 6 as the design of the tenant layer, persistent revocable sessions (P1), the OIDC interface, the implementation choices listed below, and amendments 1 to 7. Exposing a second tenant is not accepted: decision 6's gate stays closed until E2E-02 on the deployed model, a migration rehearsal on a copy of a real deployment database and the real-provider SSO checks pass, and the owner reopens multi-tenancy, which the owner set aside on 2026-10-10 (amendment 1). Decision 2's tenant roles are superseded by amendment 6 (roles are per workspace; AGENTS.md).
Scope: M4 design review; the acceptance above is of the design, not of the second-tenant gates

## Implementation note (2026-10-05, updated 2026-10-07)

P1 (single-tenant persistent login) is implemented on branch `claude/awesome-mccarthy-kvo88w`
for review; results in
[m4-p1-user-sessions-results-2026-10-05.md](../design/m4-p1-user-sessions-results-2026-10-05.md).

P2-P4 are implemented on branch `claude/m4-tenant-isolation-p2-p4` for review; results in
[m4-p2-p4-tenancy-results-2026-10-05.md](../design/m4-p2-p4-tenancy-results-2026-10-05.md),
its follow-up [m4-p2-p4-tenancy-results-2026-10-07.md](../design/m4-p2-p4-tenancy-results-2026-10-07.md),
the [permission model](../design/m4-permission-model-2026-10-07.md) and the
[multi-tenant runbook](../runbooks/multi-tenant.md). T2 with two tenants on a real Docker daemon
and a real-browser check against Keycloak have run; E2E-02 (deployed model) and a migration
rehearsal on a copy of a real deployment database have not, so no second tenant may be exposed.
This ADR stayed Proposed until the delegated review of 2026-10-17 accepted its single-tenant scope (Status); the second-tenant gates remain open.

Owner decisions of 2026-10-07, which the implementation follows:

- ADR-0017 decision 2: a channel binding `(channel, external_key)` is unique per workspace, not
  per installation (migration 0031). The global key let one tenant's create return another
  tenant's thread. Accepted.
- ADR-0002 amendment 2 is unchanged: any member of the approval's thread decides, a human of any
  tenant role or a member bot. A role split for approvals is deferred until the complete
  permission model is agreed. That model and its consistency findings (C1-C8, each awaiting an
  owner decision) are in the permission model document.
- ADR-0006 decision 1 is unchanged in both tenancy modes: the operator bearer credential acts in
  the Default Tenant only and ignores a tenant selector, and desktop takeover still returns the
  direct noVNC address and password. The SSE feed accepts the tenant selector as `?tenant=`, a
  selector checked against the session and never a credential.

Choices the implementation made that the review should confirm (confirmed under owner delegation on 2026-10-17; the per-tenant concurrency limits named below were later removed by amendment 5, and the queued-run and request limits stay):

- Decision 3: an OIDC ID token's signature is always verified against the provider's JWKS,
  including for token-endpoint responses, where the library skips that check by default.
- OIDC Back-Channel Logout 1.0 is offered per provider (migration 0033). A logout token ends the
  sessions and step-up grants its IdP session (`sid`) or IdP user (`sub`) started, never a
  password session.
- The takeover holder is persisted with the browser lock (migration 0034) and survives a restart;
  only the holder gets an interactive desktop ticket.
- Per-tenant queued-run and API request limits and a per-workspace disk quota, all per process.
- Decision 3, 2026-10-09: a just-in-time Member (`--jit member`) was reachable only from a flow
  that named the tenant, which the sign-in page never does, so the first Keycloak trial on the
  stable deployment ended in `no_account` for every new person. A sign-in started without a
  tenant now targets the one active tenant that allows JIT for that provider; with two or more
  such tenants it targets none. This exposes nothing new: tenant ids are not secrets and the
  start route already accepted one from any client. Test: `oidc.test.ts`, "a sign-in from the
  page joins the only tenant that allows JIT, and none when ambiguous".

## Context

The current global operator bearer credential is inconvenient for daily login
and gives no distinction between people or tenants. Workspaces separate execution
environments, but Gateway resource lists, event subscriptions and presence remain
installation-wide. The proposed tenant layer must cover every path rather than
adding a tenant selector to the UI.

This proposal would amend ADR-0006 decision 1's operator bearer/SSE query token,
clarify ADR-0004 sharing inside a tenant-owned workspace, extend ADR-0013 connection
ownership, and change ADR-0021's future acceptance attribution while retaining
legacy facts. Human approval roles also require an explicit refinement of
ADR-0002's thread-member approval wording. Existing ADRs remain effective until
this proposal is accepted; implementation must not silently choose an alternative.

## Decision

1. Separate global User/AuthIdentity, TenantMembership and tenant-owned Workspace.
   Require server-authorized tenant/workspace context at every resource boundary,
   with scoped SQL and composite integrity checks. Retain SQLite and the thin
   Gateway; bot boundaries remain soft and a workspace remains shared.
2. Use persistent opaque, hash-stored, revocable sessions with secure cookies,
   CSRF/Origin defenses and secure bootstrap. Separate tenant roles from platform
   maintenance and retain independent operator/sandbox authentication domains.
3. Introduce a generic OIDC interface with issuer+subject identity, no email
   auto-linking, tenant-specific enforce-SSO evidence and bounded reauthentication.
   Local login remains available for self-hosting; Google is optional. SAML uses
   a separately verified OIDC broker, not a native M4 SAML implementation.
4. Apply ownership and live revocation to SSE/presence, desktop HTTP/WS/takeover,
   files/search/Knowledge, runtime/OAuth/connector credentials, background jobs,
   idempotency/caches, quotas and Docker lifecycle. Close legacy global-token and
   direct-VNC bypass paths before exposing a second tenant.
5. Migrate legacy data into one Default Tenant using a coherent backup and
   resumable manifest. Preserve task semantics and historical human:web attribution;
   future acceptance uses an authenticated principal. Never downgrade mixed-tenant
   data to a tenant-unaware binary or resurrect sessions after restoration.
6. Stage single-tenant login first and full tenant activation only after the
   complete coverage matrix and real browser/Docker/recovery gates pass. Report
   provider integrations independently; documentation and mock passes are not
   implementation or production acceptance.

## Verification

All tests below are proposed requirements, not recorded passes. Concrete cases
and target tiers are in the [test plan](../design/m4-tenant-auth-sso-test-plan-2026-10-05.md).

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | No missing scope or foreign tenant relationship can read/write; same-scope operations work | T1 DATA-01..03, ROLE-01..02, TASK-01 | Unclassified resource surfaces = 0; cross-tenant disclosures/writes = 0 |
| 2 | Restart restores valid sessions; revoked/expired sessions and wrong credential classes fail | T0/T1/browser/T2 AUTH-01..05, INV-01, RUN-01 | Revocation before next authorized operation; proposed 7/30-day idle/absolute defaults calibrated against deployment security/usability review |
| 3 | Tenant-required issuer evidence cannot be replaced by local/other-tenant login or matching email | T1/browser SSO-01..04; authorized integration SSO-05..06 | Unauthorized tenant grants = 0; real provider status separately reported |
| 4 | No event, file, desktop, job, credential or infrastructure escape crosses scope | T1/T2 FILE, EVT, DESK, JOB, INT, DOCKER, LIMIT, AUDIT cases | Cross-tenant events/control/actions = 0; fairness and revocation latency recorded |
| 5 | Migration/recovery preserves ownership/history and refuses unsafe enablement/downgrade | T1/T2 MIG-01..05 and TASK-01 | Reconciliation mismatches/orphans = 0 before enablement |
| 6 | Second-tenant gate cannot be bypassed by a partial flag; deployed behavior verified separately | T2 E2E-01, applicable T3 E2E-02 and phase-gate review | Required failed/blocked/not-run security cases = 0 |

## Consequences

The [full design](../design/m4-tenant-auth-sso-plan-2026-10-05.md) supplies schemas,
role boundaries, SSO flows, coverage inventory, migration and delivery phases.
Accepting it will require a change-table note in the canonical design and precise
amendments to affected ADRs; this proposed record does not mark old decisions
superseded prematurely. Recheck numbering against main at merge time.

No per-bot ACL, native SAML SP, SCIM, cross-tenant sharing, new database or stronger
host/kernel isolation is implied. Shared platform secrets and daemon/Gateway trust
remain explicit. Session TTL, SSO auth age, quotas and suspension behavior need
reviewed deployment defaults, never silent weakening of authorization.

## Amendment 1 (2026-10-10): Admins own the group; Members use side chats

Status: decided by the owner on 2026-10-10 in an interactive walkthrough of findings C1 to C8 of
the [permission model](../design/m4-permission-model-2026-10-07.md) (GitHub issue #14), and
implemented on branch `member-role`. ADR-0022 itself stayed Proposed until 2026-10-17: multi-tenancy is not a
product feature for now, and the second-tenant and real-OIDC gates are no longer pursued. The
rules below apply inside every tenant, the Default Tenant included.

### Context

Every person's act in a workspace moves state the whole group shares: the transcripts every bot
reads, the bots' memory, the approval rules and allowlist, the tasks, and the one computer
(ADR-0004). Until now a Member could do almost all of it. The consistency review found eight
places where the rules disagreed (C1 to C8). The owner's model resolves them: Admins own the
group; a Member views everything and talks to a bot in a side chat of their own without moving
the group.

### Decision

A1. **Every act that changes a group's shared state is an Admin's.** In `ROUTE_POLICY` that is:
    posting into a group chat or a bot's canonical private chat, opening a bot's canonical
    private chat (which may create or adopt it), creating any thread that is not a side chat,
    adding and removing thread members, setting a thread's deadline, the composite submit,
    creating, editing and accepting tasks, and the memory routes of A4. A Member keeps every
    read route, opens side chats and posts in their own (A2), answers approvals once (A3),
    answers turn-continuation asks, takes over the browser (A8), views desktops, proposes
    Knowledge and acknowledges cost alerts. Configuration that was already an Admin's (SOUL,
    workspaces, egress, connections, approval rules, cost rules, published Knowledge, people)
    stays an Admin's. The Web UI hides or disables what the session's role cannot do and names
    the role that can, from `ROLE_ACTIONS` (issue #14 items 3 to 5).

A2. **A Member's side chat** is a `chat` thread with exactly one bot member, on the operator UI's
    `web` channel with no external binding, that a Member (a signed-in person, or since A10 a
    `member` service principal) opened through `POST /api/threads`. It is not the bot's canonical private chat (it is never adopted
    as one) and not a group. The existing thread kinds are reused; the one new marker is
    `threads.side_chat_actor` (migration 0046), the opener's actor label `user:<id>`, null on
    every other thread. A Member may post only in a side chat they opened, while it holds one
    bot; a message whose mention would add a bot is refused, because adding a bot is an Admin's.
    Once an Admin adds a bot, the thread is a group and the Member's posting there ends. A side
    chat is recorded like every thread (run rows, ledger, usage, cost); nothing about it is
    temporary or hidden.

    What a side chat does and does not touch, stated plainly: it changes the group's machine,
    not its transcripts or configuration. The bot's run uses the workspace's one browser,
    profile, files and shell (ADR-0004), so a side chat can change login state, files and
    anything else on that computer, exactly as any run can. What the Member cannot do through
    it is post into the group's threads, add bots, or change configuration. The bot's own tools
    behave as in any run: it may still message another bot of the workspace or write learned
    memory within ADR-0011's rules. Those are soft boundaries between bots (ADR-0004), not a
    security boundary, and this amendment does not add one.

A3. **Persistent approval answers need an Admin (C1, C3).** A Member (person or `member`
    service principal) answers
    `allow_once` or `deny` through `POST /api/approvals/:id/decide`. `allow_always` (which
    stores an approval rule) and the egress "allow this site" answer (which extends the
    workspace allowlist, ADR-0020) are refused with 403 and the typed error `forbidden`
    (`details.reason: "persistent_answer_needs_admin"`), with no side effect. Bots deciding
    through `approval_decide` on the internal route are unchanged (ADR-0002 amendment 2, a soft
    boundary).

A4. **Memory curation is configuration (C2).** Editing a bot's `MEMORY.md`, editing, forgetting,
    undoing and confirming learned-memory entries of any scope, closing a thread's task notes
    (which writes memory), consolidation and memory-suggestion review are Admin routes. Members
    read memory and its history.

A5. **Channel bindings stay per workspace under the operator credential (C4, kept).** A chat
    channel adapter keeps acting through the operator credential in the Default Tenant, with a
    binding unique per workspace. Several people's WhatsApp accounts under one workspace is out
    of scope for now.

A6. **Tenant SSO stays platform-only (C5, kept).** Linking a provider and setting a tenant's SSO
    policy remain platform maintenance from the CLI.

A7. **Full tenant visibility, actions restricted (C6).** A Member sees every workspace, thread
    (other people's side chats included), run and cost of the tenant. The side chat marker is
    not an audience. People who must not see each other's work belong in different tenants;
    there is no per-person audience inside one.

A8. **Takeover is served through the screen proxy only (C7).** No route returns the noVNC
    address or password: the takeover answers with the lease (`{lock}`), the workspace view
    says only whether the shared screen exists (`takeoverScreen`), and a restart returns no
    address. The lease holder, and nobody else, gets a one-use, origin-bound
    `/api/desktop-stream` ticket from `POST /api/workspaces/:id/takeover/open-screen`. The
    Gateway's proxy answers the workspace x11vnc's VNC-authentication challenge itself with the
    password it holds in memory and offers the browser only the RFB `None` security type, so the
    password stays inside the workspace and the Gateway; bot desktop tickets work the same way
    (the view-only password is not sent either). Hand back, lease expiry, a new takeover epoch,
    logout, revocation and loss of membership close the proxied connection at once. The
    workspace image and the sidecar are unchanged; noVNC stays published on the Gateway host's
    loopback, for the proxy.

A9. **The operator credential stays (C8, kept).** It remains the Default Tenant's Owner plus
    platform maintenance, for scripts and adapters; its audit attribution stays self-declared
    (`authorId`) until channels move to service principals.

A10. **A service principal carries a tenant role like a person** (owner decision, 2026-10-10,
    replacing the first implementation's per-route bypass). Its role is `admin` or `member`,
    stored on the principal (`service_principals.role`, migration 0049; principals created
    before it are `member`). At creation it is the creating Admin's own role, so an Owner's or
    Admin's principal is `admin`, never `owner`; the create request may lower it to `member`,
    never raise it. The maintenance CLI names it with `--role` and creates a `member` without
    one. Rotation keeps it; the list and the CLI show it. There is no extra role kind and no
    route exception: the guard checks a principal exactly like a person of its role, and the
    handler checks of A2 and A3 apply to a `member` principal too, its side chats keyed on the
    actor `service:<id>`. A client that needs group threads, tasks or the composite submit uses
    an `admin` principal. Platform routes stay closed to every principal (amendment 2 S2).

A11. **A Member cancels only the runs of their own side chats** (owner decision, 2026-10-10).
    `POST /api/runs/:id/cancel` from a Member (a person or a `member` principal) is refused with
    403 `forbidden` (`details.reason: "run_outside_own_side_chat"`) and no side effect unless the
    run's thread is a side chat that Member opened and still holds one bot. A run of a group
    chat, a bot's private chat, a bus thread or no thread is the group's work, an Admin's to
    stop. Admins, bots and the internal routes are unchanged.

A12. **A Member answers a turn-continuation ask only in their own side chats** (owner decision,
    2026-10-10). `POST /api/runs/:id/continuation/decide` follows the same rule and refusal as
    A11; Admins are unchanged. A1's "answers turn-continuation asks" is narrowed accordingly.

A13. **People are managed by people.** The member, invitation and account routes
    (`GET /api/members`, `PATCH /api/members/:userId`, `GET`, `POST /api/invitations`,
    `DELETE /api/invitations/:id`, and `POST /api/accounts` from amendment 4) refuse every
    service principal, whatever its role, with 403 `forbidden` (`details.reason:
    "people_only"`): a principal has no user to attribute a membership change or a created
    account to, nor to check the last-Owner and invitation rules against. A `member` principal
    is already refused by its role. The self-service account routes of amendment 3
    (`/auth/profile`, `/auth/avatar`) stay for every signed-in person and refuse a principal as
    having no user (400 `no_user`); a principal's bearer never accepts an invitation. The
    other routes of amendments 3 and 4 and of the same release fit the Member model as they
    are: the read-only Files collection (`GET /api/workspaces/:id/assets`) is a Member read
    (C6); the bot inbox rail reads the canonical-inbox mark, and for a Member an unopened inbox
    opens their own side chat instead of creating the bot's private chat (A1, A2); cost-alert
    triage is acknowledgement, which stays a Member's.

### Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| A1 | A Member gets 403 with no side effect on every route moved to Admin, an Admin passes the role check on each and changes members, deadline, tasks and memory; posting in a group chat or a bot's private chat and opening a private chat that does not exist are 403 for a Member and succeed for an Admin; a Member keeps every read, cost-alert acknowledge and Knowledge proposal; `ROLE_ACTIONS` matches `ROUTE_POLICY`; screens hide or disable the moved actions for a Member and show them to an Admin | T1 `member-role.test.ts` "refuses a Member every shared-state route with 403 and no side effect", "lets an Admin past the role check on every one of them", "an Admin changes the group: members, deadline, tasks and memory curation succeed", "an Admin posts in a group chat and opens a bot's private chat; a Member may not", "reads every route and acknowledges cost alerts and proposes Knowledge"; T0 `role-actions.test.ts` "offers a Member side chats and one-time answers, and the group's shared state to Admins (ADR-0022 amendment 1)"; T1 `permission-matrix.test.ts`; T0 web `member-role.test.tsx` (composer, tasks, thread members, New chat) | Shared-state writes accepted from a Member = 0 |
| A2 | A Member's one-bot web thread is marked `sideChatActor: user:<id>` and they post in it; another Member cannot; a group, a bound or a multi-bot create is 403; a mention that would add a bot is 403 with no side effect; once an Admin adds a bot the Member's post is 403; a side chat is never adopted as the bot's private chat | T1 `member-role.test.ts` "a Member opens a side chat with one bot and posts in it; it is marked theirs", "a Member cannot turn a side chat into a group by a mention, and loses it when it becomes one", "a side chat is never adopted as the bot's canonical private chat", "another tenant's workspace or bot is the uniform 404 for a side chat, as for any route"; T0 contracts `thread.test.ts` "is a one-bot chat the actor opened as a side chat, and nothing else"; T0 web `member-role.test.tsx` "a Member posts in their own side chat" | Member posts outside their own side chats = 0 |
| A3 | A Member's `allow_always` is 403 `persistent_answer_needs_admin` with the database unchanged; `allow_once` and `deny` are 200; a Member's egress allow-this-site is 403 and leaves the allowlist; an Admin's adds the host; an Admin's Always is recorded; the approval card offers a Member no Always or Allow this site | T1 `member-role.test.ts` "a Member answers once or denies, never always", "a Member cannot allow a site; an Admin can, and the host joins the allowlist", "an Admin may always allow, which stores a rule"; T0 web `member-role.test.tsx` "a Member allows once or denies; Always is an Admin's", "a Member cannot allow a new site" | Persistent answers by Members = 0 |
| A4 | `PATCH /api/bots/:id/memory`, consolidation, entry edit, forget, undo, confirm, close-task and suggestion review are Admin routes, 403 for a Member; the learned-memory screen offers a Member no curation controls | T1 `member-role.test.ts` "every route moved to Admin is an Admin route in ROUTE_POLICY, with no bypass for any principal", "refuses a Member every shared-state route with 403 and no side effect"; T0 web `member-role.test.tsx` "a Member reads entries and suggestions but changes none" | Member memory writes = 0 |
| A5 | Channel bindings are unique per workspace and do not resolve across tenants; the operator credential creates and finds them | T1 `thread-channel-routes.test.ts` "creates a bound thread once and returns the same thread for the same key"; T1 `tenant-execution.test.ts` JOB-02 "a channel conversation key another tenant uses gives this tenant its own thread" | Cross-workspace binding hits = 0 |
| A6 | SSO providers and tenant SSO policy are managed only from the platform CLI; no tenant route changes them | T1 `cli.test.ts` "manages tenants, memberships, OIDC providers and tenant SSO policy (platform only)"; T1 `route-policy.test.ts` (no such tenant route exists) | Tenant routes that change SSO = 0 |
| A7 | A Member reads every workspace, thread (another Member's side chat included), run, task, memory and cost of the tenant, and nothing of another tenant | T1 `member-role.test.ts` "reads every route and acknowledges cost alerts and proposes Knowledge", "a Member opens a side chat with one bot and posts in it; it is marked theirs"; T1 `tenant-boundary.test.ts` DATA-02 "no list shows another tenant's rows; each shows the caller's own" | Cross-tenant disclosures = 0 |
| A8 | Takeover, workspace view and restart carry no address or password; open-screen gives the holder only a ticket without a password; the proxy authenticates upstream with the mode's password and offers `None`; the holder's control stream ends with hand back and lease expiry; non-holders are 403; a refused upstream drops the stream; a real x11vnc accepts the proxy's authentication; the Web takeover streams through the proxy with no password, from the LAN too, and drops the screen when the hold ends | T0 `vnc-relay.test.ts` (known-answer DES, both handshakes); T1 `screen-routes.test.ts` "takeover returns the lease and no noVNC address or password, and neither does the workspace view", "the lease holder controls the shared screen through the proxy; the stream ends with the lease", "the shared screen is the lease holder's only, and only while the lease is live", "authenticates upstream with the mode's password and offers the browser no authentication", "bridges a one-use origin-bound control ticket and closes it on handback", "drops the proxied connection when the upstream refuses the password"; T1 `takeover-routes.test.ts`, `tenant-execution.test.ts` DESK-01/02, `auth-routes.test.ts` AUTH-04; T2 `m1-takeover.container.test.ts`, `m4-tenancy.container.test.ts` DESK; T0 web `takeover.test.tsx`, `takeover-lan.test.tsx` | Responses carrying a VNC address or password = 0; control streams open after the lease ended = 0 |
| A9 | The operator credential acts as the Default Tenant's Owner with platform maintenance, keeps the body's `authorId` or `web`, and never reaches another tenant | T1 `service-principals.test.ts` "attributes its messages to service:<id>, whatever the body says", "a run token and the operator credential are not service principals"; T1 `tenant-boundary.test.ts` "a tenant Owner without platform maintenance cannot use platform routes" | Operator-credential requests outside the Default Tenant = 0 |
| A10 | An Owner's or Admin's principal is `admin`, `role: "member"` lowers it, `owner` or an unknown role is 400 with no side effect, rotation keeps the role and the list shows it; a `member` principal is 403 on group posts, thread members, tasks, submit, multi-bot creates and `allow_always`, and opens and posts in its own side chat marked `service:<id>`; an `admin` principal posts in group threads and creates tasks but stays out of platform routes; no `ROUTE_POLICY` entry has an exception; migration 0049 keeps every row and makes it `member`, admitting `admin` but never `owner`; the CLI creates `member` by default and `admin` with `--role`, lists the role and refuses `owner` | T1 `service-principals.test.ts` "takes its creator's role (an Owner's is admin), may be lowered to member, never raised to owner", "a member principal is held to the Member rules, side chats included", "an admin principal passes the Admin routes but never platform maintenance", "acts as a Member of its own tenant only: B's ids are the uniform 404, with no side effect"; T1 `member-role.test.ts` "every route moved to Admin is an Admin route in ROUTE_POLICY, with no bypass for any principal"; T1 `migration-0049.test.ts`; T1 `service-principal-cli.test.ts` "creates a Member by default or an Admin with --role, shows the role, refuses owner (ADR-0022 amendment 1 A10)"; T1 `submit-routes.test.ts` "binds a service principal's submission to agent:<id> and attributes its message" | Principals acting above their stored role = 0 |
| A11 | A Member's cancel of a group-chat run or another Member's side-chat run is 403 `run_outside_own_side_chat` with the database unchanged; a run of the Member's own side chat is cancelled; an Admin cancels the group run; the run view hides Cancel run for a Member outside their side chat with the role note, and shows it in their side chat and to an Admin | T1 `member-role.test.ts` "a Member cancels only runs of their own side chat; an Admin cancels any"; T0 `role-actions.test.ts` "offers a Member side chats and one-time answers, and the group's shared state to Admins (ADR-0022 amendment 1)"; T0 web `member-role.test.tsx` "a Member outside their own side chat may neither cancel nor continue the run", "a Member cancels and continues a run of their own side chat", "an Admin cancels and continues any run" | Member cancels outside their side chats = 0 |
| A12 | A Member's continuation answer on a group-chat run is 403 `run_outside_own_side_chat` with the database unchanged; on their own side chat's run it is recorded; an Admin's is accepted anywhere; the run view hides Continue and Stop for a Member outside their side chat with the role note | T1 `member-role.test.ts` "a Member answers a turn-continuation ask only in their own side chat; an Admin anywhere"; T0 web `member-role.test.tsx` "a Member outside their own side chat may neither cancel nor continue the run", "a Member cancels and continues a run of their own side chat" | Member continuation answers outside their side chats = 0 |
| A13 | A `member` principal is 403 on every member, invitation and account route and 400 `no_user` on profile and avatar; an `admin` principal is 403 `people_only` on the same people routes with the database unchanged, while an Admin person still lists members; a principal's bearer accepts no invitation; a Member's click on an unopened bot inbox creates their own one-bot side chat and never calls the private-chat resolver, an Admin's resolves the canonical inbox | T1 `service-principals.test.ts` "a member principal is refused every account, invitation and member route, and has no profile", "an admin principal is refused them too: people are managed by people", "a principal cannot accept an invitation"; T1 `profile-routes.test.ts`; T0 web `member-role.test.tsx` "a Member's click on an unopened inbox opens their own side chat, never the canonical one", "an Admin's click resolves the bot's canonical inbox" | People changes by service principals = 0 |

### Consequences

- Existing threads are group threads. Members lose posting in the group chats and bots' private
  chats they use today; announce this before it is activated on the stable deployment.
- ADR-0002 amendment 2 is narrowed for people: a human Member answers once; persistent answers
  are an Admin's. Bots are unchanged. The owner note of 2026-10-07 that desktop takeover still
  returns the direct noVNC address and password is replaced by A8.
- The CLI keeps the names on main, `grant-maintainer` and `revoke-maintainer`; the draft's
  `set-platform-role` is not adopted.
- Not decided here, from the 2026-10-09 draft: auto-archiving side chats, running side-chat
  runs with learning off, and an optional per-tenant scratch workspace for side chats. Run
  cancel and turn-continuation answers, first left open to every Member, are decided in A11
  and A12.

## Amendment 2 (2026-10-09): service principals

Status: implemented and shipped in v0.3.6 under GitHub issue #21 (part 1). The owner decided on
2026-10-09 that this needs no standalone ADR and is recorded here as an amendment to the
principal kinds of decision 2. The number 1 is reserved for the Member-role amendment of issue
#14 (findings C1 to C8), drafted first and still unpublished; code comments and migration 0039
already cite this one as amendment 2.

### Context

An external agent client (a CI job, another agent framework, an MCP client) needs to post
messages and read results through the operator API. Today it can only borrow a person's browser
session or the shared operator credential. The session is a person's, expires, and needs CSRF;
the operator credential acts in the Default Tenant only, with Owner rights plus platform
maintenance, and is not attributable to any one client. Neither is right for a machine client of
a second tenant.

This is also the proposed answer to permission-model finding C4 (chat channel adapters act
through the operator credential, so only in the Default Tenant), which is decided in issue #14.
If #14 settles C4 differently, this amendment still stands for external agent clients; only that
cross-reference changes.

### Decision

S1. **A service principal is a machine identity of one tenant.** It has a name, a tenant role
    (`member` as first shipped; since amendment 1 A10 `admin` or `member`, never `owner`, set at
    creation from its creator's role), a status (`active` or `disabled`), and an opaque bearer token of
    256 random bits behind the prefix `deskmates-sp.`. Only the token's SHA-256 is stored
    (migration 0039); the token is shown once, at creation or rotation. It is a new principal
    kind next to the signed-in person and the operator credential. It is not the operator
    credential and not a run token.

S2. **It is a credential class of the operator listener only.** `Authorization: Bearer <token>`
    on `/api/*` resolves it by hash on every request, like a session, and it acts in its own
    tenant with its role: tenant routes for that role (Admin routes only for an `admin`
    principal, amendment 1 A10), never Owner or platform routes. A
    tenant selector naming another tenant is refused (401); the token is never accepted in a URL
    (`?token=` stays refused). The sandbox listener and the model proxy never accept it.

S3. **Revocation is immediate.** Disabling is final; rotation issues a new token and the old one
    stops on the next request. A suspended tenant's principals stop too. Its event streams,
    desktop tickets and desktop lease register under a key bound to the token presented, so
    disabling or rotating closes them in this process, and the live sweep (which re-reads the
    stored hash) closes them in any other. A database restore clears every service principal
    token, like every other credential; an Admin rotates to issue a new one.

S4. **It spends its own budget.** Before one of its messages is posted
    (`POST /api/threads/:id/messages`), the Gateway counts the non-terminal runs whose
    triggering message it authored and the known (Gateway-priced) cost of those of its runs
    created today (UTC, the cost report's day). At the principal's `maxConcurrentRuns` or
    `dailyUsdCap` the message is refused with 429 and the typed error `budget_exceeded`, naming
    the limit. Both are soft operational limits, not security boundaries: a message that wakes
    several bots can pass the run cap by the extra runs it starts, runs that bots start by relay
    are the bots', and unpriced usage is unknown, not zero, so it does not count. Defaults are 2
    runs and USD 5 per day; both are guesses, to be calibrated against trial use.

S5. **Its acts are attributed to it.** Messages it posts carry the author `service:<id>`,
    whatever the request body says, as a person's carry `user:<id>`. The operator credential keeps
    its historical behaviour (`authorId` from the body, else `web`, and `human:web` where the
    ledger records an actor).

S6. **Admins manage principals of their tenant.** `GET` and `POST /api/service-principals`,
    `POST /api/service-principals/:id/disable` and `POST /api/service-principals/:id/rotate` are
    Admin routes in `ROUTE_POLICY`; `:id` resolves through a new owned kind, `servicePrincipal`,
    so another tenant's principal is the uniform 404. The maintenance CLI has the same four
    commands (`create-service-principal`, `list-service-principals`,
    `disable-service-principal`, `rotate-service-principal`) as platform maintenance.

### Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| S1 | Creation returns the token once with its role (`admin` from an Owner or Admin unless lowered to `member`; amendment 1 A10); the database holds its SHA-256 and never the token; invalid names and budgets are 400 | T1 `service-principals.test.ts` "an Admin creates a principal, sees its token once, and only the SHA-256 is stored", "refuses an invalid name or budget" | Tokens stored in clear = 0 |
| S2 | With tenant B's ids on every identified route a `member` principal of A gets the uniform 404 (403 on Admin routes) and the database is unchanged; Admin routes are 403 for a `member` principal and platform routes for every principal; a foreign selector and `?token=` are 401; the sandbox listener and model proxy are 401; a run token is not accepted on `/api` | T1 `service-principals.test.ts` "acts as a Member of its own tenant only", "cannot call Admin or platform routes", "cannot select another tenant, and is never accepted in a URL", "never works on the sandbox listener or the model proxy", "a run token and the operator credential are not service principals" | Cross-tenant disclosures/writes = 0 |
| S3 | After disable or rotate the old token is 401 on the next request and its registered live connections close; the sweep check is false for the old key; a suspended tenant's token is 401; a restore clears tokens and rotation restores access | T1 `service-principals.test.ts` "a disabled principal's token stops working on the next request and its streams close", "rotation ends the old token at once and the new one works", "a suspended tenant's principals stop working"; T1 `service-principal-cli.test.ts` "a restore clears every service principal token" | Requests accepted after revocation = 0 |
| S4 | At `maxConcurrentRuns` non-terminal runs, or once today's known cost reaches `dailyUsdCap`, a post is 429 `budget_exceeded` with no side effect; unpriced usage does not count; a person in the same tenant and thread is not limited | T1 `service-principals.test.ts` "refuses a message with 429 while it has its maximum of runs in flight", "refuses a message with 429 once today's known cost of its runs reaches the cap" | Budget refusals per principal per day (reported) |
| S5 | A principal's message is authored `service:<id>` despite a body `authorId`; a session's is `user:<id>`; the operator credential keeps the body's `authorId` or `web` | T1 `service-principals.test.ts` "attributes its messages to service:<id>, whatever the body says"; T1 `tenant-boundary.test.ts` AUDIT-01 | Unattributed machine messages = 0 |
| S6 | A Member gets 403 on all four routes; another tenant's principal id is the uniform 404 with no side effect; `ROUTE_POLICY` and the generated permission tables agree; the CLI creates, lists, rotates and disables, refusing bad input | T1 `service-principals.test.ts` "a Member cannot manage principals; another tenant's principal is the uniform 404"; T1 `tenant-boundary.test.ts` DATA-01 (the fixture seeds a principal per tenant); T1 `route-policy.test.ts`, `permission-matrix.test.ts`; T1 `service-principal-cli.test.ts` | Routes without an entry = 0 |

### Consequences

- Section 2 of the permission model gains the principal; its generated tables list the four
  routes.
- An approval a principal decides is recorded `human:service:<id>`: the decide route labels every
  operator-API decision as human, and the label still names the principal.
- A principal cannot accept a task: task acceptance accepts only `user:<id>` and `human:web`
  (ADR-0021), and this amendment does not change ADR-0021.
- An event stream a principal opens counts as presence for its tenant, as the operator
  credential's does (ADR-0002 definitions), so L2 approvals wait the short window instead of
  deferring at once.
- Not decided here: channel adapters moving off the operator credential (C4, issue #14),
  per-principal scopes narrower than Member, token expiry, and a Web UI for principals. The
  principal's role is decided in amendment 1 A10.

## Amendment 3 (2026-10-10): self-service account settings

Status: implemented for review under GitHub issue #26; Accepted under owner delegation (2026-10-17).
Number 1 stays reserved for the Member-role amendment of issue #14; number 2 is service principals.

### Context

A signed-in person sees their name and a name-derived avatar in the sidebar but cannot change
either, and cannot change their password from the UI, although `POST /auth/password` exists
(P1). `AuthUserView` carries `id`, `displayName` and `loginName`; `loginName` is null whenever
the session was opened through SSO, so the UI cannot tell from it whether the account has a
local password at all. Issue #25 (administrator-created accounts) needs the person to replace an
initial password through these settings.

Decision 1 makes a user a global person whose tenant rights are memberships. A display name and
an avatar belong to that person, not to a tenant, a bot or a workspace, the way UI preferences
already do (issue #22, migration 0045).

### Decision

P1. **Profile changes are the caller's own, and nothing else.** `PATCH /auth/profile`
    (`{ displayName }`), `PUT /auth/avatar` (the image as the raw request body),
    `DELETE /auth/avatar` and `GET /auth/avatar` act on the signed-in person whose session
    presents them. No route takes a user id; a body with any key other than `displayName` is
    refused. They sit behind the operator authentication hook with the `authenticated` route
    policy (any tenant role, same-origin and session CSRF on every mutation), and the handler
    refuses the operator credential and service principals, which have no person (400
    `no_user`). A profile change never touches login names, credentials, memberships, roles or
    platform maintenance.

P2. **A display name is free text a person chooses.** Trimmed, 1 to 128 characters, no control
    characters. It is not a login identifier: the local login name is unchanged and is reported
    separately. The change is visible on the next request, because every request re-reads the
    user row.

P3. **An avatar is a small image the Gateway stores and serves itself.** PNG, JPEG or WebP, at
    most 512 KiB (`AVATAR_MAX_BYTES` in contracts); the declared type must match the file
    signature, and SVG, GIF and anything else are refused. One avatar per person is stored as a
    BLOB in `user_avatars` (migration 0048) with its SHA-256; an upload replaces it in one
    statement, so a refused upload leaves the previous image. It is served only to its owner
    through `GET /auth/avatar`, with the stored type, `nosniff`, a `default-src 'none'; sandbox`
    content security policy and `no-store`. The session view names it as
    `/auth/avatar?v=<hash prefix>`, so a change is a new URL. The Gateway never fetches,
    stores or redirects to a remote image URL, including an IdP's `picture` claim. Without an
    avatar the UI keeps the deterministic name-based fallback.

P4. **A local edit wins over SSO.** An IdP's `name` claim seeds the display name once, when a
    just-in-time or invitation sign-in creates the account. Later SSO sign-ins never write the
    display name or the avatar, so a saved profile is not overwritten. Introducing claim
    synchronisation later needs a further amendment that keeps locally edited fields.

P5. **Password capability is reported by the Gateway, not inferred.** The session view gains
    `account`: `localLoginName` (the account's local login name, whichever way this session
    signed in, else null) and `password`, one of `available` (a local password exists and this
    session signed in with it), `sign_in_with_password` (a local password exists but this
    session came through SSO, which `/auth/password` refuses as before) and `identity_provider`
    (no local password; the IdP manages it). Both are read from `user_logins` and
    `local_credentials` on every session view.

P6. **Password change is unchanged and stays the one mechanism.** The settings page posts
    `POST /auth/password`; the Gateway still verifies the current password, revokes every other
    session and rotates this one. The browser adopts the returned session view (new CSRF token)
    in memory only. Passwords are never written to browser storage, logs or error reports.

### Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| P1 | Every role saves its own profile; a body naming another user id or any key besides `displayName` is 400 with no change; missing CSRF or a foreign Origin is 403; no credential is 401; the operator credential and a service principal are 400 `no_user`; memberships, role and platform role are unchanged | T1 `profile-routes.test.ts` "each role changes only its own display name", "refuses another user's id, unknown keys and a non-person", "refuses a change without CSRF or from another origin"; T1 `route-policy.test.ts`, `permission-matrix.test.ts` | Cross-account profile writes = 0; routes without an entry = 0 |
| P2 | A valid name is trimmed, stored, shown by `/auth/session` after sign-out and sign-in; empty, over-long and control-character names are 400; the login name stays | T1 `profile-routes.test.ts` "each role changes only its own display name", "refuses an invalid display name"; T0 `account-settings.test.tsx` "saves the display name and updates the identity" | Login names changed by a profile edit = 0 |
| P3 | PNG, JPEG and WebP up to the limit are stored and served back byte-identical to their owner only, with nosniff, CSP and no-store; a mismatched signature, SVG, GIF, empty or oversized body is refused and the previous avatar stays; removal restores the fallback; the URL changes with the content | T1 `profile-routes.test.ts` "stores, serves and removes an avatar", "refuses unsafe or oversized images and keeps the previous one"; T0 `account-settings.test.tsx` "rejects an unsupported file before upload and keeps the photo" | Unsafe image types stored = 0; remote image fetches = 0 |
| P4 | After a local rename, a later SSO sign-in with a different `name` claim leaves the saved display name | T1 `oidc.test.ts` "a later SSO sign-in keeps a locally edited display name" | Profile fields overwritten by SSO = 0 |
| P5 | A password session reports `available`; the same account through SSO reports `sign_in_with_password` and its local login name; an SSO-only account reports `identity_provider` and a null login name | T1 `profile-routes.test.ts` "reports the password capability from the account, not the session"; T1 `oidc.test.ts` the same capability after SSO; T0 `account-settings.test.tsx` "explains SSO-managed passwords instead of a form" | Password forms shown to accounts that cannot use them = 0 |
| P6 | Changing the password from the settings page adopts the rotated CSRF token for the next request, clears the fields, and the old password and other sessions stop working; mismatch and wrong current password show inline errors | T1 `auth-routes.test.ts` (existing rotation cases); T0 `account-settings.test.tsx` "changes the password and adopts the rotated session", "shows mismatch and wrong-password errors" | Passwords in browser storage or logs = 0 |

### Consequences

- The permission model's generated tables list the four routes as `authenticated`.
- A database backup carries avatars with the rest of `users`; a restore keeps them, since they
  are not credentials.
- Not decided here: avatars of other people (member lists keep the name fallback), login-name
  changes, administrator password reset, account deletion.

## Amendment 4 (2026-10-10): invite by link and administrator-created accounts

Status: implemented for review under GitHub issue #25; Accepted under owner delegation (2026-10-17). It changes the invitation identity of P4
(test plan INV-01) and builds on amendment 3's Account settings for the password change.

### Context

P4 binds every invitation to one exact identity. For a new local account (`local_new`) the inviter
must choose the recipient's login name, and the recipient then chooses only a display name and a
password. The owner asked for two understandable paths instead: share a link with which the
recipient chooses their own username and password, or have an administrator create the account
and hand over a username and an initial password, which the recipient replaces in Account
settings. P4 also answers every unusable invitation token identically, so a recipient cannot
tell an expired link from a used one.

### Decision

I1. **An open sign-up invitation binds a tenant and a role, not an identity.** A new target kind,
    `local_signup`, has no stored identity (`target_value` is null; migration 0047 rebuilds
    `tenant_invitations` to allow it). Whoever holds the link either creates a new local account
    by choosing a username and password, or, while signed in, joins with the
    account they already have. It is single-use and expires like every invitation; the token is
    still the only credential and only its hash is stored. Its role is fixed at creation and an
    invitation still never makes an Owner. The new account's display name defaults to its
    normalized username. An older client may still send a display name, which keeps its earlier
    meaning; the person can change it later in Account settings.

I2. **Account creation and acceptance are one transaction, and refusals spend nothing.** The
    username, optional display name and password are validated, and the password hashed, before the
    transaction. Inside it the Gateway refuses an existing username (409, reason
    `login_name_taken`), creates the user, login, credential and membership, and consumes the
    invitation; any failure rolls all of it back. An invalid username, a weak password or a taken
    username leaves the invitation open, and of concurrent acceptances exactly one consumes it. An
    existing account is never overwritten, re-passworded or linked by a matching name.

I3. **Issued `local_new` invitations stay valid.** A `local_new` invitation created before this
    change keeps its meaning until it is accepted, revoked or expires: it creates exactly the
    reserved login name. The API still accepts `local_new` (and `local_user`, `oidc_email`) for
    clients that send it; the People screen creates `local_signup` and `oidc_email` invitations
    only.

I4. **An Admin may create a local account with a generated initial password.**
    `POST /api/accounts` (`{ loginName, displayName?, role }`, Admin route) creates the person,
    their local login and a membership of the caller's tenant in one transaction. An Admin creates
    Members; only an Owner creates an Admin; nobody creates an Owner. The Gateway generates the
    initial password from 20 characters of a 57-symbol unambiguous alphabet (about 116 bits) with
    the operating system's random source, stores only its Argon2id hash and returns it in that one
    response. It is never in the member list, an invitation, a log line or a later response. An
    existing username is refused (409 `login_name_taken`); no route replaces another person's
    password. When `displayName` is absent, the normalized login name is used. Existing callers
    that send it are unchanged.

I5. **Tenant SSO policy still applies.** In a tenant whose policy is `sso_required`, creating a
    `local_signup` or `local_new` invitation, accepting a new-account invitation and creating an
    account are refused (403, reason `sso_required`) before anything is written; an `oidc_email`
    invitation remains the way in. An existing account that joins through a link still needs the
    tenant's SSO evidence to enter it, as with `local_user`.

I6. **A link holder learns why a link stopped working.** `GET /auth/invitations/:token` and
    acceptance answer a token that names a used, revoked or expired invitation with 410 and the
    reason (`used`, `revoked`, `expired`). An unknown token, and an invitation meant for another
    identity, keep the uniform 401. Only a holder of the 256-bit token learns its state.

### Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| I1 | An Owner or Admin creates a `local_signup` invitation without a login name; the recipient chooses a username and password and joins the invited tenant with the invited role, once; display name defaults to the username, while an older client may still supply one; a forged role or tenant in the acceptance is ignored; a signed-in person joins with their own account | T1 `member-onboarding.test.ts` "a sign-up link lets the recipient choose their username, once", "defaults an omitted display name and preserves an explicit one", "a signed-in person joins with the account they have"; T0 `invite-screen.test.tsx` | Accounts created outside an invitation or Admin action = 0 |
| I2 | Invalid username, invalid explicit display name, weak password and taken username leave the invitation open and create nothing; concurrent acceptances create one account; an existing account's password hash is unchanged | T1 `member-onboarding.test.ts` "refusals spend nothing and never touch an existing account", "concurrent acceptances create one account" | Invitations consumed by a refused acceptance = 0 |
| I3 | A `local_new` invitation still creates exactly its reserved login name; a row written before migration 0047 survives it unchanged | T1 `tenancy-p4.test.ts` INV-01 (existing `local_new` cases); T1 `member-onboarding.test.ts` "an invitation issued before migration 0047 is still accepted" | Issued invitations broken by the migration = 0 |
| I4 | An Admin creates a Member and gets the initial password once; an omitted display name defaults to the username and an explicit one remains compatible; it signs in, the database holds only its hash, the member list and invitation list never contain it; Admin creating an Admin is 403, anyone creating an Owner is 400; a taken username is 409 with the existing hash unchanged; another tenant's Owner sees nothing | T1 `member-onboarding.test.ts` "an Admin creates an account and sees its initial password once", "defaults an account's omitted display name and preserves an explicit one", "role limits, existing usernames and tenants"; T0 `members-onboarding.test.tsx` handoff panel | Plaintext initial passwords stored or returned twice = 0 |
| I5 | In an `sso_required` tenant, sign-up invitations, new-account acceptance and account creation are 403 `sso_required` with no row written | T1 `member-onboarding.test.ts` "an SSO-only tenant refuses local accounts" | Local accounts created in SSO-only tenants = 0 |
| I6 | A used, revoked or expired token previews and accepts as 410 with its reason; an unknown token is 401 | T1 `member-onboarding.test.ts` "a link holder learns why the link stopped working"; T0 `invite-screen.test.tsx` | Unusable-link support questions (reported) |

### Consequences

- `POST /api/accounts` is an Admin route in `ROUTE_POLICY`; the generated permission tables list
  it. The UI offers it with the existing `people.invite` and `people.inviteAdmin` role rules.
- No mail service is added: the inviter copies and sends the link or the login details.
- Not decided here: forcing a password change at first sign-in, administrator password reset,
  and expiring an unused initial password.

## Amendment 5 (2026-10-12): no run-concurrency caps; container limits bound a workspace

Status: implemented for review on branch `no-concurrency-caps`. Owner decision of 2026-10-12; the engineering detail is Accepted under owner delegation (2026-10-17). It
removes the concurrent-sidecar part of test plan LIMIT-01 and the run cap of amendment 2 S4.

### Context

Three caps limited how many runs execute at once: `WORKSPACE_MAX_CONCURRENT_RUNS` (default 2 per
workspace, raised to 4 by issue #69), `TENANT_MAX_CONCURRENT_RUNS` (default 4 per tenant,
LIMIT-01) and a service principal's `maxConcurrentRuns` (default 2, S4). In multi-bot work they
kept producing stalls: a long run, or a parked process still exiting, held one of two workspace
slots, and the bot it was waiting for sat queued at `workspace_capacity` (the 2026-10-11
campaigns measured waits of 10 to 48 minutes). Raising the defaults moves the stall to a larger
team, and at 4 the tenant cap equals the workspace cap, so both would have to keep rising
together. The owner's ruling is that a total usage budget and the Linux container's CPU and
memory limits are enough; capping concurrency in every layer adds stalls without adding
protection the container does not already give.

### Decision

N1. **The scheduler caps no concurrency of runs.** A queued run whose bot lane is free starts on
    the next pass, however many sidecars its workspace or tenant already runs. The ordering
    rules stay, because they keep a session and a thread consistent, not a resource: one run per
    lane per bot, a parked run holds its (bot, thread), one memory consolidation per workspace,
    durable walks in order. A suspended tenant and a workspace over its disk quota still wait.
    `WORKSPACE_MAX_CONCURRENT_RUNS` and `TENANT_MAX_CONCURRENT_RUNS` are no longer read, and
    `runs.config_json` records `workspaceMaxConcurrentRuns: null`.

N2. **A service principal has no run cap.** Its daily USD cap (S4) stays the only budget.
    `maxConcurrentRuns` leaves the API, the view and the CLI; migration 0055 drops the column.

N3. **The workspace container carries the resource bound.** `WORKSPACE_CPU_LIMIT` (cores,
    fractions allowed, default 4, 0 for none) becomes the container's `NanoCpus`;
    `WORKSPACE_MEMORY_LIMIT_MB` keeps its meaning and its 8192 default (raised from 4096 by
    issue #69). Both are recorded in `runs.config_json`.

N4. **Usage stays bounded as before.** ADR-0018 cost alerts remain soft thresholds; the hard
    budgets are the service principal's daily USD cap, `TENANT_MAX_QUEUED_RUNS`, per-run
    `RUN_TIMEOUT_SECONDS` and `DESKMATES_MAX_TURNS`, and the thread caps `relay_count` and
    `turn_budget` (ADR-0005). This amendment adds no new usage cap.

### Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| N1 | Six runs on the free lanes of three bots in one workspace all start while every earlier process is held, with no scheduler wait recorded; a second run on a busy lane of the same bot still waits; a held run of tenant A keeps neither A's other workspace nor tenant B from starting; the retired knobs change no config | T1 `capacity.test.ts` "starts every free lane's run in one workspace while another run's process is still held", "still runs one run per lane per bot"; T1 `tenant-execution.test.ts` "a held run caps nothing"; T1 `config.test.ts` "reads no run-concurrency cap" | `workspace_capacity`/`tenant_capacity` waits = 0 |
| N2 | A principal posts three messages that each start a run, all 201; its row has no `max_concurrent_runs`; migration 0055 keeps every other column and value; the CLI neither takes nor prints a run cap | T1 `service-principals.test.ts` "does not limit how many of its runs are in flight"; T1 `submit-routes.test.ts` "does not limit how many of the principal's runs are in flight"; T1 `migration-0055.test.ts`; T1 `service-principal-cli.test.ts` | Budget refusals other than `daily_usd` = 0 |
| N3 | The CPU knob parses cores, 0 and fractions and refuses negatives and non-numbers; the memory default is 8192; the Gateway passes both to the provider and records them; Docker receives `Memory` and `NanoCpus`, and neither when unset | T1 `config.test.ts` "caps a workspace container's CPU in cores"; T1 `gateway.test.ts` "gives the container a CPU ceiling from WORKSPACE_CPU_LIMIT"; T0 `docker-provider.test.ts` "create gives the container its memory and CPU ceilings" | Workspace OOM kills and CPU throttling from `resource_observation` (reported) |
| N4 | No new usage cap; existing caps unchanged | Existing tests of S4 daily cap, LIMIT-01 queue cap, ADR-0005 caps and ADR-0018 | Unchanged |

### Consequences

- A workspace that reaches its memory limit is OOM-killed as a whole: Chromium and every run in
  it fail together, where before the extra runs would have queued. Size `WORKSPACE_MEMORY_LIMIT_MB`
  for the busiest expected group, at about 1 GiB per live session plus the browser.
- One tenant can now start as many sidecars as its bots have free lanes. Host capacity is the
  number of busy workspaces times their container limits; the operator sizes the host for that.
  Fairness between tenants is no longer enforced by a count.
- Limits apply when a container is created. An existing workspace keeps its old limits until it
  is recreated, which the next release's new workspace image tag does.
- `GET /api/capacity` reports `sidecars.active` without a `limit`; the workspace view's
  `capacity` drops `limit` too.
- Design v0.3 §12's mitigation "the scheduler caps concurrent sidecars per workspace" is replaced
  by the container limits; the design document is not edited.

## Amendment 6 (2026-10-13): four workspace roles, private chats and the message board

Status: owner decisions of 2026-10-13 on GitHub issue #116, implemented with ADR-0031 decisions 7
to 10, which supply the schema; this amendment supplies the permission matrix. It supersedes the
tenant roles of amendment 1 (A1, A13 and P4's Owner-only role changes), A2's "nothing about it is
temporary or hidden" and A7 (full tenant visibility; "the side chat marker is not an audience").

### Context

Amendment 1 gave every person one role in the tenant and let Members read everything, other
people's side chats included. The owner asked for roles per workspace, a Guest who can ask a bot
about status without reaching the group's machinery, conversations that only their person reads,
and a board on which anyone in a workspace may leave a note. ADR-0031 added the tables:
`workspace_memberships`, the protected root account, `threads.private_to_user_id` and the board.
There is no legacy data: the only deployment is wiped at the baseline release (ADR-0031), so no
existing Member is converted to a Guest and no earlier side chat is retroactively promised to
have been private.

### Decision

W1. **Four roles per workspace replace tenant roles.** A person holds `owner`, `admin`, `member`
    or `guest` in each workspace, independently (ADR-0031 decision 7); the rank is
    guest < member < admin < owner. Every route that names a workspace's row checks the
    caller's role in that row's workspace. A route that names none uses the person's highest
    active role in the tenant (none counts as guest), and a list returns only rows of the
    workspaces where the caller holds at least the route's role. Another workspace's id, a
    missing id and a row the caller may not read are the same 404, except that a role too low
    for an existing row of the caller's own workspace stays 403 `workspace_role`. Service
    principals keep their machine role (`admin` or `member`) across their tenant (A10); the
    operator credential stays the Default Tenant's Owner (A9).

W2. **The root is the account `admin`.** The protected account of ADR-0031 decision 8 is Owner
    of every workspace and the installation's platform maintainer. On an empty database the
    Gateway creates it as login `admin`, password `admin`, and until the password is changed the
    session may only change it: `GET /auth/session` reports `passwordChangeRequired: true`, every
    `/api` route answers 403 `password_change_required`, and the Web UI shows the
    change-password screen instead of the app. The CLI `bootstrap-owner` creates the same
    account with login `admin` and a password the operator types, without a forced change; it
    takes no login name, and no other login name is ever the root. Tenant SSO configuration and
    service principals are the root's only (ADR-0031 Q2): their routes are `root` access, which
    the operator credential and the protected account pass and nobody else does.

W3. **Owner.** Everything in the workspace, including granting and removing Owner, demoting or
    removing an Admin, and transfer (promote, then demote). The last active Owner and the root's
    Owner membership cannot be demoted or removed (ADR-0031 decisions 7 and 8).

W4. **Admin.** Manages bots, group chats (create, add and remove bot members, deadlines, close
    task notes), tasks (create, edit, accept, submit), configuration (workspace settings,
    egress, restart, trash), connections, approval rules and persistent answers, cost rules,
    memory curation and published Knowledge (ADR-0031 Q2). People: invites, creates, removes and
    switches Members and Guests, and may promote a person to Admin or invite one as Admin.
    Demoting or removing an Admin, and anything that grants or removes Owner, stay the Owner's.

W5. **Member.** Reads the workspace's shared conversations, runs, approvals, tasks, memory,
    files, desktops and costs; posts in the workspace's shared `chat` threads (group chats and
    bots' canonical private chats) and in their own private chats; opens private chats with one
    bot; executes tasks through the composite submit (issue #116 comment of 2026-10-13); takes
    over the browser; stops and continues the runs they started (a run woken by their own
    message, or any run of their private chat); answers `allow_once` or `deny` to approvals of
    the runs they started; proposes Knowledge and acknowledges cost alerts. A Member creates no
    bot, no group chat and no thread with more than one bot, posts in no `bus` thread, adds no
    bot by a mention (403 `admin_owns_the_group`) and stores no persistent approval answer (A3).

W6. **Guest.** Reads the workspace list, its bots, its shared `chat` threads and their messages
    (original text) and the board; posts on the board; opens private status inquiries with one
    bot. Nothing else: no post in a shared thread (403 `guest_read_only`), no runs, run events,
    approvals, tasks, files, desktops, takeover, memory, costs, Knowledge, skills or delegation,
    and no `bus` thread. A Guest's live stream carries only the thread, board and workspace
    events of what they may read. The bounded tool-free status job that answers an inquiry (no
    shared SDK session, no browser, shell or file tools) is not built yet: posting in an inquiry
    is refused with 409 `status_inquiry_unavailable` and creates no run, and the Web UI shows the
    inquiry with a "not available yet" notice. Enabling it needs its own runtime change; until
    then no tool-enabled run ever answers a Guest.

W7. **Private chats are private to their person.** A private chat is a one-bot web `chat` thread
    a Member or Guest opens through `POST /api/threads`; it carries `private_to_user_id`
    (ADR-0031 decision 9). Only that person may read or act on it, its messages, runs, run
    events, run context, approvals and handoff cards, whatever anyone's role: Owners, Admins, the
    root, the operator credential and service principals get 404 for its ids, and lists and live
    streams leave it out. Aggregate cost and usage still include its runs; the per-run views do
    not. Its person answers its approvals once (W5); a persistent answer cannot be given there.
    An Admin's or Owner's one-bot chat is the bot's shared canonical chat, as before. A service
    principal's side chat stays visible to the workspace (ADR-0031 Q5). The audience is a
    product API and UI guarantee for people. It is not a boundary between bots: the bot's run
    uses the shared computer, and other bots of the workspace can reach what it leaves there
    (ADR-0004).

W8. **Creating a workspace.** A person who is Owner or Admin of at least one workspace, or the
    root, may create one; the creator becomes its Owner in the same transaction and the root
    is Owner too (ADR-0031 Q1).

W9. **People are managed per workspace.** `GET /api/members`, `PATCH /api/members/:userId`,
    `GET` and `POST /api/invitations` and `POST /api/accounts` name the workspace
    (`workspaceId`); without one they act on the tenant's only workspace and otherwise answer 400
    `workspace_required`. An invitation and a created account carry a workspace and a role other
    than Owner (`admin`, `member` or `guest`). The People screen always sends the selected
    workspace and shows each person's role there.

W10. **The message board.** `GET` and `POST /api/workspaces/:id/board` and the post routes are
    open to every current member of the workspace, Guests included. A post is inert: it creates
    no run, task, approval or learned-memory candidate, whatever it mentions. Its author edits
    and withdraws it; an Admin or Owner hides and unhides it, with no hard purge; every change
    keeps a version. The list is paged, newest first, at most 100 a page with a cursor for the
    next. A moderator also sees hidden posts; the author and moderators read a post's history.
    The composer names the audience ("everyone in this workspace, Guests included").

W11. **The Web UI follows the role in the selected workspace.** `GET /auth/session` lists the
    person's role in each workspace (`workspaceRoles`); `ROLE_ACTIONS` names the minimum
    workspace role of each action, `guest` and `root` included. Screens hide or disable what
    that role cannot do. A Guest's shared chats show a read-only notice instead of the composer;
    a private chat is listed only for its person.

### Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| W1 | One person is Admin of A and Member of B: an Admin route on B's bot is 403 `workspace_role`; lists show only rows of workspaces the caller belongs to; a Guest-only person is refused every Member route | T1 `workspace-roles.test.ts` "an Admin of one workspace acts there and is refused in another", "lists show only the caller's workspaces"; T0 `role-actions.test.ts` | Cross-workspace reads or writes accepted = 0 |
| W2 | A fresh database's root signs in with `admin`/`admin`, sees `passwordChangeRequired` and gets 403 on `/api` until the change; `bootstrap-owner` takes no login and creates `admin`; service-principal routes refuse an Owner who is not the root | T1 `protected-root.test.ts`; T1 `cli.test.ts` "bootstrap-owner creates the root as admin"; T1 `workspace-roles.test.ts` "service principals are the root's"; T0 web `password-change.test.tsx` | Root logins other than `admin` = 0 |
| W3 | An Owner demotes an Admin; the last Owner's demotion and any change to the root are refused | T1 `people-roles.test.ts` "an Owner demotes an Admin; the root stays Owner" | Workspaces without an Owner = 0 |
| W4 | An Admin switches Member and Guest, promotes a Member to Admin, invites a Guest and an Admin; demoting or removing an Admin and granting Owner are 403 with no change | T1 `people-roles.test.ts` "an Admin manages Members and Guests and promotes to Admin, nothing above" | Admin changes to Admin or Owner memberships = 0 |
| W5 | A Member posts in a group chat and a bot's canonical chat, opens a private chat, cancels a run they started and answers its approval once; creating a group chat, a binding or a canonical chat, a mention that adds a bot, cancelling another person's run and answering another person's approval are 403; a `member` principal may post in the group but not add a bot by a mention | T1 `member-role.test.ts` "a Member posts in the group but creates no group, binding or canonical chat (amendment 6 W5)", "a Member cancels only the runs they started; an Admin cancels any", "a Member answers only approvals of runs they started (amendment 6 W5)"; T1 `service-principals.test.ts` "a member principal is held to the Member rules, side chats included" | Member writes outside W5 = 0 |
| W6 | A Guest lists shared chats and reads their messages, posts on the board and opens an inquiry; posting in a shared chat is 403 `guest_read_only`, posting in the inquiry is 409 `status_inquiry_unavailable` with no run; runs, approvals, files, tasks, costs and takeover are 403; their stream carries no run event | T1 `guest-role.test.ts`; T0 web `guest-chat.test.tsx` | Runs started by Guests = 0 |
| W7 | A Member's private chat: its messages, runs, events, approvals and activity are 404 and absent from lists and streams for another Member, an Admin, the Owner, the root and the operator credential, a guessed id is the same 404 as a missing one; its person reads them. That aggregate costs still include its runs is not yet tested | T1 `private-audience-routes.test.ts` | Private bodies disclosed to anyone but their person = 0 |
| W8 | An Admin of one workspace creates one and owns it; a Member- or Guest-only person is 403 | T1 `workspace-roles.test.ts` "an Admin of one workspace acts there and is refused in another", "a person with no workspace role above Member creates no workspace (owner answer Q1)" | Workspaces created by Members or Guests = 0 |
| W9 | With two workspaces a People call without `workspaceId` is 400 `workspace_required` and with it acts in that workspace; the members list reports roles there; the Web People screen sends the selected workspace on every call | T1 `people-roles.test.ts` "people calls name their workspace"; T0 web `members` tests | People calls accepted without a workspace when there are several = 0 |
| W10 | A Guest posts, a Member reads it, the author edits and withdraws, an Admin hides and unhides, a Member cannot hide, a post mentioning a bot creates no run, a repeated request id returns the first post, pages follow the cursor, another workspace's post is 404 | T1 `board-routes.test.ts`; T0 web `board` tests | Runs created by board posts = 0 |
| W11 | The session lists workspace roles; `mayTakeAction` uses the selected workspace's role; the Web hides group creation from a Member and the composer from a Guest | T0 `role-actions.test.ts`; T0 web `role-gates.test.tsx`, `guest-chat.test.tsx` | Actions offered that the Gateway refuses (reported) |

### Consequences

- The tenant stays the installation domain without tenant roles (ADR-0031 Q1). `TenantRole` in
  contracts becomes the workspace role type; a session's `role` is the highest role it holds.
- A private chat is not visible to the people who manage the workspace; a problem in one is
  diagnosed from aggregate usage, or by its person.
- Bots are not separated by the audience; a person who must keep something from the bots of a
  workspace uses another workspace (ADR-0004).
- The Guest status job (W6) is the open item of this amendment: it needs a sidecar mode with no
  tools and no shared session before it can be enabled. Amendment 7 builds it.

## Amendment 7 (2026-10-14): the Guest status job, and the Web follows the roles

Status: implements the open items the owner listed on issue #116 on 2026-10-13 (the Guest
status-inquiry runtime, navigation a Guest cannot use, workspace creation checked against the
selected workspace, a Member's click on a bot). S1 to S4 replace W6's "not built yet" sentence;
the rest of W6 stands. Owner-decided (2026-10-14): S1's model is the default model, not the
cheap one; the job runs on the bot's background lane; S2 adds task status and progress; S8 and
S9 add the role badge and the role panel. The rest is Accepted under owner delegation (2026-10-17). Real-model answer quality is not measured.

### Context

Amendment 6 let a Guest open a private inquiry with one bot and refused every post in it,
because an ordinary run would hand the Guest's words to a bot with the shared computer, its
tools and its SDK session. ADR-0023 amendment 1 and ADR-0033 already run recorded, tool-free,
one-turn model jobs (`model-job.ts`, `presentation-summary.ts`); the status job is one more of
that shape, fed only with what a Guest may already read through the API. Separately, the Web
offered workspace creation by the role in the selected workspace, showed every navigation link
to a Guest, and opened a bot's shared canonical chat when a Member or Guest clicked the bot in
the chat list, although W5 to W7 give them a private chat of their own.

### Decision

S1. **A Guest's post in their own inquiry is answered by a status job, never by a bot run.**
    The post is stored as the Guest's message and queues one run of the inquiry's bot on the
    background lane (owner-decided 2026-10-14: a Guest's question never holds the lane a
    person's chat with the bot uses), attached to the inquiry thread, with
    `runType: status_inquiry`, the message as its trigger reference and the Guest as
    `requestedBy`. It is an ADR-0023 amendment 1 model job: one turn, no tools, MCP servers,
    plugins, skills, settings, SOUL, memory or SDK session, the 60-second job deadline, usage
    and price recorded like any run. It runs on the default model (`DEFAULT_MODEL`, frozen on
    the run at creation; owner-decided 2026-10-14), not the cheap model and not a per-bot
    override: `status_inquiry` is not in the cheap-model job list (ADR-0023 decision 2), and
    until the Gateway has a per-workspace default the installation default is the workspace's. The router is not called: no round, no mention routing, no
    wake of another bot, no learned-memory candidate, no outcome notice. The answer is appended
    to the inquiry as the bot's message carrying the job's run id; a job that returns nothing
    appends a `system` message saying no answer came and the question may be asked again.

S2. **The job reads a status projection, fixed by the Gateway, of what the Guest may read.**
    Built when the job starts: the workspace's name; its bots' names and roles; its shared
    `chat` threads that are no one's private chat (the eight most recently updated, each with
    title, bot members, last update and its last three messages, each cut to 400 characters);
    the board's five newest visible posts (cut to 300); the workspace's tasks (owner-decided
    2026-10-14: the ten most recently updated that are not deleted, each with its title, state,
    owner bot, blocked reason and next action, and the summary of its latest checkpoint: the
    units done with their outcomes, what is outstanding and the note, each cut; a checkpoint
    recorded by a run in someone's private chat is left out, and no evidence path, description,
    output, delivery, file or run detail is included); and the inquiry's own last six messages
    (cut to 600). At most 14,000 characters, wrapped as untrusted data with entity escaping, with
    the time it was built. Nothing else: no runs or their status, approvals, files or their
    contents, memory, Knowledge, costs, desktops, SOUL, `bus` threads or another person's private
    chat. A question about anything outside the projection is answered as unknown, never guessed
    (the instruction says so).

S3. **One open question per inquiry.** While a status job of the inquiry is queued or running,
    another post there is 409 `status_inquiry_busy` and stores nothing. A post repeated with
    the same `externalId` returns the stored message and queues nothing. Queue room
    (`assertQueueRoom`) and the workspace budget (ADR-0032) apply as to any run.

S4. **The inquiry stays its person's.** The job's run hangs off the inquiry thread, so W7's
    audience covers it: its message, run, events and usage detail are the Guest's alone, absent
    from Activity (a job is never listed there, ADR-0033 decision 1) and from everyone else's
    lists and streams; aggregate cost includes it. The Guest still reads no run or run event
    (W6): the answer and the failure notice arrive as thread messages.

S5. **Creating a workspace is offered by the highest role.** `workspace.create` in
    `ROLE_ACTIONS` is scoped to any workspace: the Web offers it to the root and to a person who
    is Owner or Admin of at least one workspace, whatever workspace is selected, which is what
    the Gateway checks (W8).

S6. **Navigation follows the read policy of the selected workspace.** Each link names the read
    action of its screen in `ROLE_ACTIONS`, checked against the route policy like every other
    action. A Guest sees Chats, Contacts and the Board; a Member sees every screen but People.
    The address of a screen whose link is hidden shows Chats instead. The Gateway still refuses
    whatever a stale link or a typed address asks.

S7. **A click on a bot opens the clicker's own private chat below Admin.** In the chat list a
    Member's or Guest's entry for a bot is their own private chat with it (a Guest's: their
    inquiry), created by the first click (`POST /api/threads`); the bot's canonical chat, which a
    Member may read and post in and a Guest may read, is listed under that entry's earlier chats.
    An Admin's or Owner's entry stays the canonical chat.

S8. **Every signed-in person sees their role in the selected workspace** (owner-decided
    2026-10-14). A badge at the top right of the shell names it: Owner, Admin, Member or Guest,
    and the administrator account as such; a Guest's reads "Guest · read-only". It is a label in
    the UI's language, never a permission.

S9. **The badge opens what each role may do, generated from `ROLE_ACTIONS`** (owner-decided
    2026-10-14). A panel lists every action of `ROLE_ACTIONS` that a workspace role takes, with a
    column per role (Owner, Admin, Member, Guest) saying whether that role may take it, computed
    by the same rank comparison as `mayTakeAction`; the person's own column is marked. Actions
    only the administrator account or a platform maintainer takes are listed apart. The rows are
    the table, not a hand-written list: an action added to `ROLE_ACTIONS` appears in the panel,
    and a test fails until it has a label in every locale. Because `ROLE_ACTIONS` is checked
    against the route policy (S6, W11), the panel says what the Gateway allows; where a handler
    narrows a route (`handlerCheck`), the row says so.

### Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| S1 | A Guest's post in their inquiry stores the message and queues exactly one `status_inquiry` run on the background lane attached to the inquiry, with no round, wake or session; the fake SDK sees no tools, MCP, session or plugins, one turn and the default model, also when the bot has its own model; the job is not a cheap-model kind; the answer is appended as the bot's message with the run id; an empty result appends the system notice | T1 `status-inquiries.test.ts`; T0 `job-models.test.ts`; T0 sidecar `model-job.test.ts` "a status inquiry has no tools and reads only its projection" | Tool calls in status jobs = 0 |
| S2 | The projection holds the shared chat, its message, the bot's name and role, a visible board post, and a task's title, state, owner bot and latest checkpoint summary, and leaves out another person's private chat, a bus thread, a hidden post, run status, SOUL, a deleted task, checkpoint evidence paths, a task description and a checkpoint recorded in a private chat | T1 `status-inquiries.test.ts` "the projection holds what a Guest may read and nothing else", "the projection carries task status and progress"; T0 sidecar `model-job.test.ts` "tells the model to answer only from the projection" | Projection fields outside S2 = 0 |
| S3 | A second post while the job is queued is 409 `status_inquiry_busy` with no message; the same `externalId` returns the first message | T1 `status-inquiries.test.ts` | Concurrent status jobs per inquiry = 0 |
| S4 | The job's run and messages are 404 and absent from lists for an Admin, the Owner and the root; the Guest's run routes stay 403; the Guest's stream carries the answer | T1 `status-inquiries.test.ts` "the answer is the Guest's alone" | Inquiry bodies disclosed to anyone but their person = 0 |
| S5 | Admin of A, Member of B, B selected: `workspace.create` is offered; a Member-only person is not | T0 gateway `role-actions.test.ts` "workspace creation follows the highest role (amendment 7 S5)" | Create offers the Gateway refuses (reported) |
| S6 | Every link's read action matches the route policy; a Guest's navigation shows Chats, Contacts and Board only; a hidden screen's address shows Chats | T0 gateway `role-actions.test.ts`; T0 web `navigation.test.tsx` "a Guest sees only what they may read" | Links offered that the Gateway refuses (reported) |
| S7 | With a canonical chat present, a Member's and a Guest's click on the bot opens or creates their own private chat; an Admin's opens the canonical chat | T0 web `guest-chat.test.tsx`, `thread-rail.test.tsx` "a Member's bot entry is their own private chat" | none |
| S8 | Owner, Admin, Member and Guest each see their role in the selected workspace; a Guest's reads "Guest · read-only"; the administrator account is named as such; switching workspace changes it; the words come from the locale's catalog | T0 web `role-badge.test.tsx` | none |
| S9 | Every `ROLE_ACTIONS` action appears once in the panel, in the workspace-role table or the administrator list; each cell equals `mayTakeAction` for a session holding that role; the person's own column is marked; every action has a label in every locale | T0 contracts `role-actions.test.ts` "the role matrix is the table"; T0 web `role-badge.test.tsx` | Panel cells that disagree with the route policy = 0 |

### Consequences

- A Guest's question costs one default-model call per post; there is no backfill and no retry.
- The answer can only restate what the projection holds. A Guest who needs more asks a Member
  or an Admin, on the board or outside Deskmates; widening the projection is a new amendment.
- The job shares the bot's background lane with cron, webhook and other jobs, so a Guest's
  answer can wait behind a long background run; a person's chat with the bot is never held.
- A new `ROLE_ACTIONS` action needs a panel label in all five locales before the Web suite
  passes.

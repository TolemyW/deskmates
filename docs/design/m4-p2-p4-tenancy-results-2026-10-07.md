# M4 P2-P4: tenant isolation follow-up: results

Date: 2026-10-07
Status: implemented on branch `claude/m4-tenant-isolation-p2-p4` for review. Not merged, not
deployed, not a milestone acceptance. ADR-0022 stays Proposed. This record follows
[the 2026-10-05 record](m4-p2-p4-tenancy-results-2026-10-05.md) and supersedes it where they
differ. The model-backed gate (E2E-02) and a migration rehearsal on a copy of a real deployment
database (MIG-01) have not run, so no second tenant may be exposed to real users.
Issue: [TolemyW/deskmates#5](https://github.com/TolemyW/deskmates/issues/5).
Permission model: [m4-permission-model-2026-10-07.md](m4-permission-model-2026-10-07.md).
Operating procedure: [multi-tenant runbook](../runbooks/multi-tenant.md).

## Owner decisions of 2026-10-07

1. Per-workspace channel bindings (ADR-0017 decision 2, migration 0031): accepted.
2. Approval role split: not now. The Member deny-only rule and the `bot_approval_decisions`
   column were removed before merge. Any member of the approval's thread decides, as ADR-0002
   amendment 2 says. The complete permission model was written first. It is generated from the
   route table and checked by a test, and lists eight consistency findings (C1-C8) for the owner
   to decide before any new permission logic.
3. Operator token and noVNC in multi mode: no extra restriction. The operator credential acts in
   the Default Tenant only, in both modes; takeover still returns the direct noVNC address and
   password. The `?tenant=` selector on `GET /api/events` stays.

These reverse three statements of the 2026-10-05 record: "Members may only deny approvals", "a
new tenant's bots may only deny", and "the operator credential is limited to platform routes and
the direct noVNC address/password is never returned".

## What changed since 2026-10-05

- **OIDC Back-Channel Logout 1.0** (`POST /auth/oidc/:provider/backchannel-logout`, migration
  0033).
  - Checks on the logout token:
    - JWKS signature with asymmetric algorithms only;
    - issuer, and audience = client id;
    - at most 300 s old;
    - `typ` is `logout+jwt` when present;
    - the back-channel logout event is present and there is no nonce;
    - `sub` or `sid` is present;
    - the `jti` is single-use.
  - What it ends: the sessions and step-up grants that IdP session (`sid`) or IdP user (`sub`)
    started, and their live connections. Password sessions are never ended.
- **Takeover holder persisted** with the browser lock (migration 0034). The same person holds it
  after a restart. A periodic sweep releases a holder whose session ended or who left the tenant.
- **Desktop tickets.**
  - An interactive (control) ticket requires the requester to be the recorded holder. Before
    this, any member could drive the desktop while someone else held the lease.
  - The WebSocket upgrade re-checks membership of the tenant the ticket was issued in. Before
    this, it only checked that the session was signed in somewhere.
- **Limits** (LIMIT-01), all per process; 0 turns each off:
  - `TENANT_MAX_QUEUED_RUNS` (200) at every intake;
  - `TENANT_API_REQUESTS_PER_MINUTE` (1200), a token bucket per tenant that does not count the
    event stream;
  - `WORKSPACE_DISK_QUOTA_MB` (off), which holds new runs of a workspace over quota.
- **Connector DNS pinning** (INT-02). The call connects only to the addresses that passed the
  public-address check, through an undici dispatcher with a pinned lookup. This closes the
  rebinding window recorded on 2026-10-05.
- **Login throttle memory** (PR #8 review). A refused attempt stored a bucket per new login name,
  so a limited address could grow the map without bound. The fix:
  - refusals are read-only;
  - only an admitted attempt stores anything;
  - the map holds at most `maxKeys` (20,000), evicting expired idle keys first, then the oldest
    idle ones, never a key with an attempt in flight.

## Verification

Linux, Node 22.22.0, Docker 29.6.2 (dockerd in this container), Chromium 141 / Playwright 1.56.1,
Keycloak 26.4 (`start-dev`). No IPv6.

### Commands

| Command | Result |
|---|---|
| `npm run typecheck`, `npm run lint` (834 files), `npm run docs:check` | PASS at `6b7dbd0` |
| `npm test` (T0/T1, all workspaces) | 3134 / 3135 at `6b7dbd0`. The one failure is `packages/sidecar/src/managed-proxy.test.ts` (`listen EAFNOSUPPORT ::1`, no IPv6 here), unchanged from `main` and recorded on 2026-10-05 |
| `npm test -w @deskmates/gateway` | 874 / 874 (113 files) at `1eaf4db`, the last code commit (only the sign-in start limit changed after `6b7dbd0`) |
| `npm run typecheck -w packages/web`, `npm run build -w packages/web` | PASS |
| `npm test -w packages/web` | 289 / 289 (42 files) |
| `acceptance/m4-tenancy.container.test.ts` (new T2) and `acceptance/t2-lists.test.ts` | 4 / 4 and 4 / 4 at `6b7dbd0` |
| `npm run test:container` (full T2, at `ccef468`) | 84 passed, 6 failed, 4 skipped (29 files). All six fail the same way on `origin/main` in this environment, see below |
| Keycloak spike, per-session logout | 15 / 15 |
| Keycloak spike, whole-user admin sign-out | 13 / 15 (IdP behaviour, see below) |
| T3 `npm run test:acceptance` | NOT RUN: no model endpoint, not authorized for this change |

T2 failures and their baseline on `origin/main` (worktree, same images, same daemon):

| Failing case | On `main` | Cause |
|---|---|---|
| m2-boundaries: unlisted egress / `*` reaches a public name (2) | same failure | the container cannot reach the public internet here (proxy answers 403) |
| m2-browser-inline-snapshot: allow a new public site | same failure | same |
| m2-browser: MCP coordination, screenshot timeout | same failure | screenshot never answered within 5 s on this host |
| workspace-image: bounded shutdown under 9000 ms, plus the next case (undefined handle) | same failure, 2 of 2 isolated reruns (9104 and 9314 ms); the branch measured 9028 to 9047 ms | host timing; the branch does not change `destroy` |

### Mutation checks (new)

| Guard removed | Failing tests |
|---|---|
| Read-only refusal in the login throttle | "a refused attempt stores nothing" |
| "Never evict a key with an attempt in flight" | "holds at most maxKeys ..." |
| Holder check on a control desktop ticket | DESK-01 "refuses control to a non-holder ..." |
| Tenant on the desktop upgrade check (with the sweep held) | the same test |
| Tenant label check in `DockerProvider.attach` | T2 DOCKER-01 |
| Back-channel logout nonce check; `jti` replay check | SSO-04 cases in `oidc.test.ts` |
| Pinned connector lookup | INT-02 pinned |

### Test plan cases changed by this round

| Case | Status | Evidence |
|---|---|---|
| SSO-04 logout | PASS (T1, and Keycloak) | `oidc.test.ts` "SSO-04: back-channel logout"; Keycloak sends the logout token itself and the Gateway ends the SSO session and the step-up grant, not the password session |
| SSO-05 real enterprise OIDC | PASS for Keycloak 26.4 | `spikes/m4-sso-keycloak-20261007`: discovery, code + PKCE, Keycloak's own login form, `sid` stored, password session refused in the `sso_required` tenant, step-up granted, forged logout token 400. A customer's own IdP is still to be checked at onboarding |
| SSO-06 Google / SAML broker | NOT RUN | not configured |
| FILE-01 | PASS | T1: B's request for A's file is 404 before any command runs; A's read runs only in A's sandbox, `nosniff`, attachment. T2: the same against two real containers, and the operator credential cannot read the second tenant's file |
| DESK-01/02 | PASS (T1, T2) | T1: holder persisted across a restart, non-holder control ticket 403, upgrade refused after leaving the ticket's tenant. T2 over the real noVNC bridge: B cannot start or open A's desktop, hostile Origin 401 and the ticket is spent, the member's ticket reaches the real VNC server (`RFB 003.00x`) once, replay 401, leaving the tenant closes the live socket |
| DOCKER-01 | PASS (T2) | containers, egress proxy and workspace network carry the tenant label on a real daemon; attach refuses either tenant's container for the other |
| INT-02 | PASS (T1) | a name that resolves nowhere reaches the checked address only through the pinned connection |
| LIMIT-01 | PASS (T1) | full queue refuses one tenant's work at every intake and not the other's; rate limit with retry hint for one tenant while another is served; disk quota holds new runs and releases them under quota |
| MIG-02 | PASS (T1) | `migration-failure.test.ts`: a failure at the start and at the end of each of 0028-0034 leaves schema, rows, the migration log and the FK pragma unchanged; the intact migration then applies once |
| E2E-01 two tenants with Docker | PASS (T2, no model) | `m4-tenancy.container.test.ts`: after a restart in multi mode, each tenant reattaches its own labelled container, nothing is recreated, sessions survive, lists stay separate, logout ends access at once |
| E2E-02 deployed model | NOT RUN | needs a model endpoint and authorization |
| MIG-01 | PARTIAL, unchanged | no copy rehearsal on a real deployment database |

### Keycloak: whole-user sign-out

Keycloak's admin **Sign out** of a user with two Keycloak sessions (one per browser) delivered
one back-channel logout request, not two, in all four runs. The Gateway's `onRequest` hook saw
one arrival. The Gateway handled that token correctly: it ended the Deskmates records of that
token's `sid`. The other browser's step-up grant stayed open. Signing out each Keycloak session in
turn delivers one token per session, and everything ends (15/15). The cause on the Keycloak side
was not determined. The runbook tells operators to also remove the person in People.

## Independent boundary review

A separate agent reviewed the gateway, sandbox-docker and contracts diff against `main`. It
traced each claim through the code and checked finding 1 with a scratch test. It found nothing
that lets one tenant read or change another tenant's data. Its findings and what was done:

| # | Severity | Finding | Fix | Test (fails without the fix) |
|---|---|---|---|---|
| 1 | Medium | An SSO sign-in whose ID token had no `auth_time` counted as authenticated at the callback, so an IdP session days old entered an `sso_required` tenant past its maximum authentication age | A missing claim counts as the epoch; a step-up also refuses it explicitly (openid-client already does when `max_age` is sent) | SSO-03 "an SSO sign-in without auth_time does not count as fresh" |
| 2 | Low | One tenant could hold the process-wide desktop cap (256) or open unlimited event streams, since both stay open and the request rate does not bound them | `TENANT_MAX_EVENT_STREAMS` (200), `TENANT_MAX_DESKTOP_CONNECTIONS` (32) | LIMIT-01 "one tenant's open streams and desktop connections cannot use up another's" (also fails when the cap counts other tenants' tickets) |
| 3 | Low | Anyone could start SSO sign-ins in a loop, each storing a transaction row for 10 minutes | 300 starts per client address per 10 minutes; at most 5,000 open pre-login transactions | SSO-01 "limits starts per client address, and open pre-login transactions overall" (both limits) |
| - | Hardening | The route guard skipped ids that were not strings, so a repeated query key reached the handler unchecked (and crashed `GET /api/bots` with a 500) | Such values are a 400 before the handler | DATA-01 "refuses a repeated query key or a non-string id" |

Checked by the reviewer and not reported: run tokens and sessions stay in their own credential
classes; the tenant selector always goes through membership, grant and policy checks; unsafe
methods need same-origin and CSRF; live connections close on logout, membership loss and
back-channel logout; the OIDC state, nonce, PKCE, identity and step-up rules; back-channel logout
token validation; desktop ticket binding; Docker attach labels. One observation was left as is:
the task routes answer a foreign thread or run id with `forbidden` instead of `not_found`.
Because ids are random, that tells a caller nothing they could not already guess.

## Not done, and why

- **E2E-02** and **T3** need a model endpoint and the owner's authorization for this change.
- **MIG-01** needs a copy of a real deployment database (Testbox), which is out of scope here.
- **SCIM** is out of ADR-0022's scope ("No per-bot ACL, native SAML SP, SCIM, ..."):
  provisioning stays explicit (invitations, CLI, JIT Member). Back-channel logout is the
  revocation path for SSO.
- **Multi-process Gateways** remain unsupported: revocation, quotas and the throttle are per
  process.
- **Client address behind a proxy.** The Gateway does not read `X-Forwarded-For`, so behind a
  reverse proxy the per-address sign-in limits are shared by everyone (runbook section 4).
- **C1-C8** in the permission model await the owner's decisions; no permission logic was added.

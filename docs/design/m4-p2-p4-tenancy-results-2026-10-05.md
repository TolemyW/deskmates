# M4 P2-P4: tenant boundary, OIDC/SSO and second-tenant gate: results

Date: 2026-10-05
Status: implemented on branch `claude/m4-tenant-isolation-p2-p4` for review. Not merged, not
deployed, not a milestone acceptance. ADR-0022 stays Proposed. Phases P2, P3 and P4 of
[the plan](m4-tenant-auth-sso-plan-2026-10-05.md) are implemented. The gates that need Docker
(T2), a real identity provider (SSO-05/06) or a deployed model (E2E-02) were not run, so the
P3 and P4 phase gates are **not** passed and a second tenant must not be exposed to real users
yet.
Follow-up: [m4-p2-p4-tenancy-results-2026-10-07.md](m4-p2-p4-tenancy-results-2026-10-07.md)
records the owner decisions of 2026-10-07, the T2, Keycloak and remaining-gap work, and
supersedes this record where they differ.
Issue: [TolemyW/deskmates#5](https://github.com/TolemyW/deskmates/issues/5).
Base: `main` at `3e873af` (P1 merge, PR #6).
Operating procedure: [multi-tenant runbook](../runbooks/multi-tenant.md).

## What changed

### P2: data boundary, roles, OIDC

- **Route manifest** (`packages/gateway/src/api/route-policy.ts`). Every `/api` route has exactly
  one entry: a tenant route with its minimum role and every tenant-owned identifier it takes
  (path, query, body, arrays); a platform route; or an authenticated route. A preHandler resolves
  each identifier to its tenant through one ownership module (`tenancy/ownership.ts`); a foreign
  or missing id gets the same `404 {code:"not_found",message:"Not found",details:{}}`. A route
  with no entry is refused at runtime, and a T1 test fails when a route is added without one.
- **Scoped stores.** Lists, counts, cost reports and Knowledge full-text search filter by tenant in
  SQL. Knowledge documents/proposals and cost alert rules/alerts carry `tenant_id` (migration
  0029, backfilled to `tnt_default`). Integrity triggers refuse cross-workspace thread members,
  runs, approvals, task owners, memory entries and connector receipts, and moving a workspace or
  Knowledge row to another tenant.
- **Roles.** Owner/Admin/Member per route; Members may only deny approvals; a new tenant's bots
  may only deny (`bot_approval_decisions`). Platform maintenance (`users.platform_role`) is
  separate from tenant roles; the first Owner is the platform maintainer.
- **Attribution.** A signed-in person is always `user:<id>`; a body `authorId` is honoured only
  for the operator credential.
- **OIDC** (`auth/oidc-service.ts`, `auth/oidc-store.ts`, migration 0030) on `openid-client` 6:
  code + S256 PKCE, single-use hashed state bound to the starting browser, nonce, exact redirect
  URI, issuer/audience/expiry and **JWKS signature checks** (the library skips the ID-token
  signature for token-endpoint responses by default; it is turned on). Providers are
  platform-registered with a pinned issuer; the client secret is encrypted in the Secrets Store.
  Identity is issuer + subject, never email. `sso_required` tenants admit only their linked
  issuers within a maximum authentication age measured from the IdP `auth_time`, re-read on every
  request. Linking needs a fresh session and `prompt=login`. JIT is off by default and creates at
  most a Member.

### P3: execution boundary

- **Events.** Each SSE event is resolved to its owning tenant and written only to that tenant's
  streams; unresolvable events are dropped. Presence counts a stream for its tenant and only for
  Admins/Owners. Live connections remember their tenant, so losing one membership closes that
  tenant's streams only.
- **Scheduler.** Tenant from the persisted workspace, never a payload; suspended tenants' runs
  wait; tenantless runs fail; `TENANT_MAX_CONCURRENT_RUNS` (default 4) caps one tenant's sidecars.
- **Channel bindings.** `(channel, external_key)` was unique across the installation: a create in
  tenant B naming tenant A's conversation key returned A's thread and members. Migration 0031
  makes it unique per workspace (ADR-0017 decision 2's binding is now scoped to its workspace).
  P2's walker did not catch this because the key is a natural key in the body, not an owned id.
- **Integration OAuth.** A grant started from a session completes only in that live session while
  it is still an Admin of the workspace's tenant.
- **Connectors.** Private URLs need platform maintenance; public connectors are called only when
  every resolved address is public (same table as the egress proxy) and redirects are refused.
- **Desktop.** The takeover lease belongs to the holder's session; nobody else can take it over or
  open its control screen; logout, revocation or membership loss releases it.
- **Docker.** Containers, egress proxies and workspace networks carry `deskmates.tenant`; attach
  refuses another tenant's label, or no label outside the Default Tenant.

### P4: second tenant

- `DESKMATES_TENANCY=single|multi`. Single refuses a database with two tenants; the CLI refuses
  `create-tenant`. Multi starts only after a clean preflight; the operator credential is limited to
  platform routes and the direct noVNC address/password is never returned.
- The migration runner refuses a database migrated by a newer Gateway (downgrade protection from
  this release on).
- Memberships API (`/api/members`) and invitations (`/api/invitations`, `/auth/invitations/*`,
  migration 0032) with atomic one-time consumption.
- `auth-cli backup|restore|preflight` plus tenant, membership, provider, link and policy commands.
- Web: team switcher with SSO step-up, SSO buttons and `sso_error` messages on sign-in, invitation
  page, People screen. Every request names its tenant (header; `?tenant=` for EventSource).

## Verification

Code under test: `01d9146`; this record adds documentation only. Linux, Node 22.22.0, Chromium 141.0.7390.37 / Playwright 1.56.1.
No Docker daemon and no IPv6 in this environment. Status per case: PASS, PARTIAL (what is and is
not covered), NOT RUN (with reason).

### Commands

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` (Biome, 829 files) | PASS, no diagnostics |
| `npm run docs:check` | PASS |
| `npm test` (T0/T1, all workspaces) | 3093 / 3094 tests, 290 / 291 files. The one failure is `packages/sidecar/src/managed-proxy.test.ts` (`listen EAFNOSUPPORT ::1`: no IPv6 here); `packages/sidecar` is unchanged from `main` and P1 recorded the same failure on its base |
| `npm run typecheck -w packages/web` | PASS |
| `npm test -w packages/web` | 289 / 289 (42 files) |
| `npm run build -w packages/web` | PASS (existing >500 kB chunk warning only) |
| Browser check `spikes/m4-p2-p4-browser-tenancy-20261005/browser-check.ts` | 11 / 11 PASS |
| `npm run test:container` (T2) | NOT RUN: no Docker daemon |
| `npm run test:acceptance` (T3) | NOT RUN: no model endpoint; not authorized for this change |

New or extended test files: `api/route-policy.test.ts` (2), `api/tenant-boundary.test.ts` (12),
`auth/oidc.test.ts` (20), `api/tenant-execution.test.ts` (13), `api/tenancy-p4.test.ts` (14),
`net/public-address.test.ts` (29), `tenancy/migration-0029-0032.test.ts` (1), `auth/cli.test.ts` (+1),
`config.test.ts` (+1),
`sandbox-docker/src/docker-provider.test.ts` (+2), Web `app-tenancy.test.tsx` (7), Web
`app-auth.test.tsx` (stream URL now names the tenant).

### Mutation checks

Each guard was removed and the tests re-run; the named tests failed, then the guard was restored.

| Guard removed | Failing tests |
|---|---|
| Route-policy preHandler | 5 of 12 in `tenant-boundary.test.ts` |
| Issuer check in `loginAdmitsTenant` (always admit) | 6 (SSO-03, SSO-04 and two `session-store.test.ts` cases) |
| `enableNonRepudiationChecks` (ID-token signature) | 2 (rogue-key cases of SSO-01 and SSO-04) |
| SSE tenant filter | EVT-01 "every event kind" |
| Workspace scope of `findByExternalKey` | JOB-02 channel binding |
| Per-tenant remount key in the Web app | none: the per-tenant API client and existing effect cleanups already drop the late answer, so this test does not prove the key on its own |

### Test plan cases

| Case | Status | Evidence |
|---|---|---|
| DATA-01 foreign ids, uniform 404, no side effect | PASS | `tenant-boundary.test.ts` walks every manifest route with B substituting A's ids in path, query and body; response equals the missing-id 404 byte for byte; full-DB snapshot unchanged; A's own call passes the guard |
| DATA-02 lists, counts, FTS | PASS | same file: no foreign id or sentinel in any list; Knowledge FTS, internal run Knowledge, cost report |
| DATA-03 integrity | PASS | same file: cross-workspace and cross-tenant inserts refused by triggers |
| ROLE-01 role matrix, platform routes | PASS | Member 403 with no side effect; platform routes 403 for a tenant Owner; foreign tenant selector 401 |
| ROLE-02 Owner transfer, last Owner, scoped enumeration | PASS | `tenancy-p4.test.ts`: Admin limited to Members; concurrent Owner demotions leave exactly one; foreign user id 404; removal closes the member's stream |
| INV-01 invitations | PASS | `tenancy-p4.test.ts`: exact identity, forged role ignored, replay refused, 3 concurrent acceptances create 1 account, expired/revoked/unknown refused, other tenant cannot list or revoke, unverified or different SSO email refused, no signup route; browser check (link once, second use refused) |
| SSO-01 code + PKCE, issuer + subject | PASS | `oidc.test.ts`: wrong issuer, audience, signature, nonce, expiry; wrong PKCE; replayed state; replayed code; callback from another browser; open redirects; unknown provider; missing CSRF; cross-origin; IdP error and outage |
| SSO-02 no auto-linking | PASS | matching verified email does not sign in; same subject at two issuers is two accounts; linking needs a fresh session, cannot steal an identity, revokes other sessions |
| SSO-03 tenant provider, policy version, auth age, JIT | PASS (T1 and browser, fake IdP) | `oidc.test.ts`; browser check step-up through a real redirect. Operator token cannot act in a tenant in multi mode (`tenancy-p4.test.ts`) |
| SSO-04 key rotation, reauthentication, logout | PARTIAL | rotated key accepted after the library's 60 s refetch cooldown and refused within it; rogue key refused; grant expiry = IdP `auth_time` + max age. Back-channel logout is **not offered** (route 404); not implemented |
| SSO-05 real enterprise OIDC | NOT RUN | needs an authorized real IdP configuration |
| SSO-06 Google / SAML broker | NOT RUN | not configured; unsupported until its own pass |
| TASK-01 | PASS (regression) | existing task suites unchanged and passing; task routes covered by the P2 walker |
| FILE-01 | PARTIAL | file routes are guarded by workspace ownership (walker); traversal/symlink cases are the existing T1 suites; no new symlink-race or T2 case |
| EVT-01 events | PASS | `tenant-execution.test.ts`: every event kind, run events without a thread, unowned events dropped, thread filter 404, `?tenant=` selector |
| EVT-02 presence | PASS | per tenant and only Admins/Owners |
| DESK-01/02 takeover | PARTIAL (T1) | lease not borrowed, screen only for the holder, released on logout and membership removal, Admin can free it; direct noVNC retired in multi mode. Raw WebSocket and noVNC checks need T2 |
| RUN-01 credential classes | PASS (T1) | run token reaches only its run; refused on operator routes and another tenant's run; session cookie refused on run routes |
| JOB-01 scheduler | PASS (T1) | suspended tenant's run (payload naming another tenant) never starts; resumes after reactivation |
| JOB-02 idempotency / natural keys | PASS (T1) | connector receipts are keyed per connector (one workspace); channel binding fixed and tested |
| INT-01 OAuth | PASS (T1, fake runtime) | swapped callback, signed-out and demoted sessions refused; state spent either way |
| INT-02 connector SSRF | PARTIAL | private registration needs platform; loopback, metadata, private and mixed answers refused before any request; redirects refused. Residual: the fetch resolves again after the check (rebinding window) |
| DOCKER-01 | PARTIAL (T0 stub daemon) | labels on container, proxy and network; attach refuses wrong or missing label. Real daemon: NOT RUN |
| LIMIT-01 | PARTIAL | per-tenant concurrent sidecar cap: another tenant's run starts while one tenant is capped. Disk and request-rate quotas not implemented |
| AUDIT-01 | PASS | actor is the principal; body `authorId` ignored for sessions |
| MIG-01 migration of the actual legacy schema | PARTIAL | `migration-0029-0032.test.ts` applies 0029-0032 over rows written at the 0028 level (Knowledge, cost alerts, OAuth states, a bound channel thread): row counts kept, all backfilled to `tnt_default`, FK check and preflight clean, new triggers hold. No copy rehearsal on a real deployment database |
| MIG-02 failure injection per step | NOT RUN | each migration is one transaction; per-step injection not built |
| MIG-03 orphan/ambiguous reporting | PARTIAL | `auth-cli preflight` reports tenantless and cross-workspace rows and blocks multi mode |
| MIG-04 coherent backup, restore invalidates authority | PASS (T1) | backup of a live WAL database; tampered backup refused; restore revokes sessions, grants, run tokens, transactions and invitations; previous DB kept. Docker volumes and runtime state are runbook steps, not tested |
| MIG-05 enablement and downgrade | PASS (T1) | single refuses two tenants; multi refuses an unclean preflight; newer-database refusal. Binaries older than this release cannot detect it |
| E2E-01 two tenants with Docker | NOT RUN | needs Docker |
| E2E-02 deployed model | NOT RUN | needs a model endpoint and authorization |
| REG-01 | PASS except the IPv6 environment case | full T0/T1 and Web suites above |

## Not done, and why

- **Gates.** T2 (Docker), SSO-05/06, E2E-01/02 and an independent boundary review are required
  before P3/P4 count as passed (test plan, "Phase gates"). None could run here.
- **Back-channel logout and SCIM** are not implemented; IdP-side disable does not end a Deskmates
  session (runbook section 3).
- **Multi-process Gateways** are unsupported: revocation and takeover holders are in-process.
- **Quotas** cover concurrent sidecars only, not disk or request rates.
- **DNS rebinding.** The connector address check is not pinned to the connection.
- **ADR text.** ADR-0022 stays Proposed. The channel-binding scope change (ADR-0017 decision 2)
  and the role refinement of ADR-0002 amendment 2 are recorded here and in ADR-0022's
  implementation note, pending the owner's review.

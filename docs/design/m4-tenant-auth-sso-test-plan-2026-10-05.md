# M4 tenant/auth/SSO verification and migration plan

Date: 2026-10-05
Status: Proposed test plan; all new cases below are NOT IMPLEMENTED / NOT RUN
Baseline: `153240e9d239aa1f7c46770dc5186dfc88c63e62`

[Design](m4-tenant-auth-sso-plan-2026-10-05.md) ·
[ADR-0022](../adr/0022-tenant-isolation-and-user-sessions.md) ·
[Canonical test tiers](test-strategy-2026-09-20.md)

## Fixtures, oracles and execution rules

Seed tenants A/B, each with two workspaces and bots/threads/runs/tasks/approvals,
Knowledge documents/versions, memories, files, connection/receipt and channel/job
records. Use distinguishable sentinel content and overlapping natural names,
external IDs, idempotency keys and search terms. Seed an Owner/Admin/Member per
tenant, one user in both with different roles, a disabled user, removed member,
expired session and a user with no memberships. Include two distinct IdPs whose
subjects/emails overlap, local accounts with matching emails, enforce-SSO and
optional-SSO tenants, and session grants with stale policy versions.

Every negative test asserts both no disclosure (response body, events, counts,
snippets, URLs, logs) and no side effects (DB rows, files, provider/runtime calls,
jobs, approvals, quota consumption or control lease). Test all ID locations:
path/query/header/body, nested JSON references, cursor and reconnect headers.
Pair each denial with a same-scope success so a broken/disabled endpoint cannot
masquerade as isolation. Use uniform unauthorized/not-found semantics and compare
observable existence leaks. Timing behavior requires a documented tolerance.

Build a reviewed coverage manifest enumerating every route, store operation,
table, FTS/cache/export, stream and background entry point with ownership source,
required principal/role, test ID and status. Every resource is tenant-owned,
workspace-owned or an explicit reviewed global exception. Zero unclassified rows
is a release gate. Use a route/store inventory check to catch newly added gaps.

T0/T1 stay offline with fake SDK/provider/IdP/runtime and deterministic clocks.
T2 uses real Docker, Gateway restart, real HTTP/WebSocket and browser automation,
without a model. T3 runs the repository's deployed-model acceptance where the
case exercises actual agent execution; deterministic auth tests do not prove
model behavior, and model success does not prove authorization. A production IdP
or SAML broker integration requires its own authorized test configuration and
separate evidence. Never use production accounts or secrets in committed fixtures.

The following filenames are implementation targets, not claims that tests exist:
`packages/gateway/src/auth/*.test.ts`, `packages/gateway/src/tenants/*.test.ts`,
colocated scoped-store/route tests, Web auth/tenant tests,
`acceptance/m4-tenant-boundaries.container.test.ts`,
`acceptance/m4-tenant-auth.acceptance.test.ts` and a dedicated browser test harness.
Map each case to its final file/command in the implementation PR.

## Executable case matrix

| ID / tier | Positive control | Negative/fault scenario and required oracle |
|---|---|---|
| AUTH-01 T1/Web | Bootstrap binds intended Owner; local login/refresh/restart restores unexpired session | Public first visitor cannot claim system; open signup denied; wrong/unknown user errors indistinguishable; throttling enforced |
| AUTH-02 T0/T1 | Valid password and unexpired token accepted | Hash-only DB, Argon2id parameters recorded; wrong password, idle/absolute expiry, fixation/reused pre-login ID rejected; raw secret absent from logs |
| AUTH-03 browser/T2 | Same-origin mutations and SSE work over HTTPS | Missing/wrong CSRF, hostile Origin, cross-site login/logout and credentialed CORS fail; production cookie flags verified; URL/sessionStorage contain no token |
| AUTH-04 T1/T2 | Other authorized tenant remains usable after one membership removal | Logout, logout-all, user disable, membership removal/demotion and password reset invalidate the correct scope immediately, including old cookies, tickets, SSE/WS and control leases; record revocation latency, require invalidation before next authorized operation |
| AUTH-05 T1 | Separate tabs hold A/B contexts without mutation | A late response after tenant switch cannot populate B UI; stale caches/in-flight requests cleared; no session-global currentTenant race |
| ROLE-01 T1 | Each role's allowed action succeeds | Member cannot edit auth rules, invite above privilege, manage connections/policy or self-approve L2; bot-decider route cannot bypass human policy; tenant admin cannot call platform drain or global account administration |
| ROLE-02 T1 | Authorized owner transfer is atomic | Last Owner cannot leave/be demoted, including concurrent operations; A admin cannot enumerate B memberships or revoke B sessions |
| INV-01 T1/browser | Exact verified identity consumes invitation once | Expired/replayed invite, mismatched/unverified email, unapproved subject, forged role and concurrent consumption rejected atomically; no mail service does not enable signup |
| SSO-01 T1 | Generic OIDC code+PKCE authenticates issuer+subject | Wrong issuer/audience/signature/nonce, expired ID token, wrong PKCE, reused code/state, altered callback/return URL rejected; no open redirect or arbitrary discovery fetch |
| SSO-02 T1 | Explicit reauthenticated identity linking works | Same email across issuers/local account never auto-links; subject collisions across issuers do not share account; invitation email alone cannot claim identity |
| SSO-03 T1/browser | Correct tenant provider grants access at correct policy version/auth age | Local login, A's provider, stale grant, recovery, machine token or fallback URL cannot enter B enforce-SSO tenant; IdP outage fails closed; JIT cannot create privileged membership |
| SSO-04 T1/integration | JWKS rotation and fresh required reauthentication succeed | Invalid new key rejected; stale policy/auth age denied; signed logout must validate event/issuer/audience/time and sid/sub; replay/forged logout cannot target arbitrary users |
| SSO-05 authorized integration | One real enterprise OIDC configuration completes start/callback, refresh of local session, tenant switch and logout | Record provider config identity without secrets, redirect/claim behavior, outage and disabled-user behavior; disclose deprovisioning window without SCIM; mock pass is insufficient |
| SSO-06 authorized integration | Optional Google login and separate broker SAML flow each complete their own gate | Google login cannot yield Drive grant; SAML broker account linking and key/certificate rotation verified independently; unconfigured/deferred remains NOT RUN |
| DATA-01 T1 | Same-scope list/get/create/edit/delete/search/export succeed | Substitute B IDs in A's requests for every manifest route, including Task JSON, bot/thread/run relations and batch writes; transaction fails without partial changes |
| DATA-02 T1 | Tenant FTS/LIKE/snippets/counts/pagination find local sentinels | Foreign data never appears in top-K, count, cursor, cost summaries, Knowledge history/proposals, memory fallback, cache or export; malformed/cross-tenant cursor rejected |
| DATA-03 T1 | Scoped interfaces accept validated contexts | Missing context, orphan ownership, direct global-store route and null tenant fail closed; composite FK mismatches rejected even below route layer |
| TASK-01 T1/Web | Create/edit/deliver/explicitly accept/reopen within workspace, conflict retains draft | Cross-tenant refs and stale version fail atomically; no mutation dispatches run/message; legacy human:web preserved, new acceptance uses principal not client actor; mutable artifact not called verified |
| FILE-01 T1/T2 | Owned preview/download and expected file bytes succeed | Traversal, encoded path, symlink to B, symlink replacement race, foreign artifact/snapshot/ticket denied; HTML/SVG cannot execute with app-cookie privileges; attachment/nosniff checked |
| EVT-01 T1/T2 | A gets its events, reconnects and resumes valid cursor | A gets zero B events including run events without threadId, replay/Last-Event-ID, lock/usage/approval events; unresolved owner dropped/denied |
| EVT-02 T1 | Qualified A approver presence keeps A approval live | B presence or unqualified A Member does not extend A approval; revoked connections immediately stop counting |
| DESK-01 browser/T2 | Authorized read-only view and explicit control ticket work | Raw WS upgrade with B IDs, hostile/missing Origin, expired/replayed ticket, wrong capability/user/session/epoch denied; second user cannot borrow existing human lock |
| DESK-02 T2 | Holder ends takeover and resumes normally | Logout/removal/demotion closes control WS and releases only holder lease; direct noVNC/password escape path unavailable; old direct capabilities cannot survive enablement |
| RUN-01 T1/T2 | Own run token reaches its permitted internal/model routes | A run token denied operator, other run/internal and B usage; cookie/machine token denied run listener; workspace cannot reach operator listener |
| JOB-01 T1/T2 | Cron/webhook/channel/retry/restart/continuation retains persisted tenant | Spoofed payload, mismatched resource owner, suspended tenant and orphan job cannot start sidecar; removed actor cannot supply pending approval; delegated schedules follow documented service-identity policy |
| JOB-02 T1 | A/B identical idempotency keys independently succeed once | No cross-tenant receipt/cache collision, no duplicate after retry/restart; connection/validation/receipt remain workspace-bound |
| INT-01 T1/T2 | Owned connection/runtime execution and OAuth callback succeed | Cross-tenant grants, callback state swapping/replay, session revocation mid-flow denied; allowedConnections preserved; revoke removes runtime grant; admin credential absent from sandbox/API |
| INT-02 T1/T2 | Approved public/private-proxy endpoints succeed | Loopback/metadata/private IPv4/IPv6, redirects and DNS rebinding blocked; runtime raw file URL never bypasses Gateway file authorization |
| DOCKER-01 T2 | Verified owned container/volume/network reattach and recreate preserve state | A cannot connect B/noVNC/runtime admin; wrong/missing labels or manifest conflict fail closed; cleanup cannot delete B volumes; no broad daemon prune |
| LIMIT-01 T1/T2 | B small work proceeds under normal quota | A queue/concurrency/disk/request exhaustion cannot starve B; fair scheduling and scoped counters measured; soft cost alerts never reported as hard cap |
| AUDIT-01 T1 | Authorized scoped audit reports true principal and operation | Body authorId cannot forge actor; A cannot read B trace/logs; tokens/cookies/passwords/OAuth codes absent from logs/error bodies |

## Migration, recovery and regression matrix

| ID / tier | Procedure | Acceptance oracle |
|---|---|---|
| MIG-01 T1/copy rehearsal | Migrate actual legacy schema including tasks, Knowledge, runtime maps and sessions; allocate next current migration number | Row counts, ownership coverage, FK check, Task states/versions/history, files/checksums and browser profile state reconcile; no attribution fabricated |
| MIG-02 T1/T2 | Inject failure after each schema/backfill/file-copy/pointer-switch/label step and restart | Resume is idempotent; no double ownership or silent deletion; source retained before verified switch; manifest reports incomplete steps |
| MIG-03 T1 | Seed orphan/ambiguous/cross-workspace relations and legacy anonymous actor | Explicit report and gate block; never guess owner by email/request or relabel historical actor as new Owner |
| MIG-04 T2 | Freeze/drain and coherent backup including WAL/volumes/runtime credential state; restore on isolated copy | Recover consistent resources with documented recovery point; sessions/tickets all invalidated; old credentials cannot resurrect authority |
| MIG-05 T1/T2 | Attempt enablement before full gate, and downgrade after second-tenant writes | Enablement refused before complete coverage/global-token retirement; tenant-unaware binary cannot be used on mixed-tenant DB; recovery/data-loss procedure explicit |
| REG-01 T0/T1/Web/T2 | Run existing operator/run-token, task, approval, memory, integrations, file/desktop and scheduler suites | Existing intended functionality preserved; expected contract updates documented; unrelated prior failures retained rather than silently waived |
| E2E-01 browser/T2 | Two real tenant browser sessions + Docker, task/file/connection flow, event stream, takeover, restart and revocation | Same-tenant happy paths succeed, all sampled opposite-tenant paths have zero disclosure/side effects before and after restart |
| E2E-02 T3 | Deployed-model smoke uses only owned workspace/connection, requests gated action and writes attributable delivery | Correct tenant/run ledger and approval provenance; no behavioral improvement claim from one smoke; record actual model usage and image/commit |

## Phase gates and stopping conditions

- P1 (single tenant only): AUTH-01..05, baseline ROLE/INV contracts, TASK-01 and
  REG-01 relevant paths; identity/provider/tenant-grant schema exists. Restore,
  restart, logout, cookie flags and CSRF verified. No second-tenant exposure.
- P2 (data boundary): complete manifest, ROLE/INV/SSO enforcement unit cases,
  DATA/TASK/FILE/AUDIT and MIG-01..03. Zero unknown ownership paths. Review approval
  policy amendment and composite constraints before runtime enablement.
- P3 (execution boundary): EVT/DESK/RUN/JOB/INT/DOCKER/LIMIT and AUTH-04 real
  connections pass. Fakes do not satisfy Docker, raw WS or browser cookie checks.
- P4 (second tenant): prior gates plus MIG-04..05, E2E-01, applicable E2E-02,
  SSO-05 for enterprise OIDC, deployment/recovery runbook and independent boundary
  review. Disable global bearer tenant access and direct VNC routes. Google/SAML
  claims require their own SSO-06 pass; otherwise state unsupported/unverified.

No skipped, quarantined, blocked or not-run security case counts as pass. A failed
boundary keeps second-tenant enablement closed; investigate and fix the authorized
implementation scope, rerun affected tests and aggregate regressions at final SHA.
A docs-only PR cannot satisfy any implementation gate.

## Commands and evidence expected from implementation

Run repository-prescribed checks at the final implementation commit:
`npm run typecheck`, `npm run lint`, `npm test`,
`npm run typecheck -w packages/web`, `npm test -w packages/web`,
`npm run build -w packages/web`; then targeted/full applicable
`npm run test:container` and `npm run test:acceptance` in their authorized
Docker/model environments. Use actual discovered test paths rather than assuming
this plan's target filenames already exist. Never start paid/external IdP/model
configuration or mutate production as a side effect of running this plan.

Every result artifact records commit, command, environment/image digests, fixture
seed, pass/fail/blocked/not-run per case, redacted logs and browser observations,
row/file/FK reconciliation and remaining risks. Record the exact tested commit,
not merely the branch. M3 deferred gates retain their own status. The documentation
publication reports only link/content validation and its actual CI outcome.

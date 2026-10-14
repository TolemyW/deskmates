# M4 P1: persistent user sign-in (single tenant): results

Date: 2026-10-05
Status: implemented on branch `claude/awesome-mccarthy-kvo88w` for review. Not merged, not
deployed, not a milestone acceptance. ADR-0022 stays Proposed. Only phase P1 of
[the plan](m4-tenant-auth-sso-plan-2026-10-05.md) is in scope; P2-P4 are not implemented.
Issue: [TolemyW/deskmates#5](https://github.com/TolemyW/deskmates/issues/5).
Base: `main` at `0ec78bb` (proposal merge).

## What changed

- **Schema (migration 0028).** `tenants` (one seeded `tnt_default`, policy `local_or_sso`,
  policy version), `users`, `user_logins` (ADR-0022's AuthIdentity: provider + issuer + subject,
  unique; named so ADR-0004 item 4's `identity*` guard still holds), `local_credentials`
  (Argon2id PHC strings only, CHECK-enforced), `tenant_memberships` (owner/admin/member, status,
  authorization version), `auth_sessions` (SHA-256 of the token only), `tenant_auth_grants`
  (session x tenant, provider/issuer, policy and membership versions, expiry). Every existing and
  new workspace gets `tenant_id = tnt_default`. The `tasks.accepted_by` CHECK admits `user:<id>`
  besides the historical `human:web`; existing rows are copied unchanged.
- **Gateway.** `/auth/session`, `/auth/login`, `/auth/logout`, `/auth/logout-all`,
  `/auth/password` on the operator listener only. `/api/*` accepts the session cookie (unsafe
  methods also need a same-origin `Origin` and the session CSRF token) or the operator token in
  `Authorization`; `?token=` is refused everywhere. Every request re-evaluates session, user,
  membership, tenant and grant. SSE streams and desktop tickets/WebSockets register with a
  live-connection registry and close on revocation. Task acceptance records the principal.
- **Maintenance CLI** (`packages/gateway/src/auth/cli.ts`): `bootstrap-owner` (only while no
  account exists), `create-user`, `reset-password`, `disable-user`/`enable-user`,
  `revoke-sessions`, `list-users`; passwords from stdin only.
- **Web.** Sign-in screen (login name + password), session restore on load, Sign out and Sign out
  on every device, user/role/tenant in the sidebar, cookie SSE. The tab-credential
  sessionStorage module is deleted.
- **Channels.** The WhatsApp adapter sends the operator token in the SSE request header.

Defaults (configurable, need the review ADR-0022 asks for): 7-day idle / 30-day absolute session
lifetime; Argon2id m=19456 KiB, t=2, p=1 (OWASP baseline, floor 7168 KiB); throttle 5 failures
per login name and 30 per client address per 15 minutes; live-connection sweep 15 s.

## Verification

Code under test: commit `0a9e501` (implementation `ba0f79c` plus ADR amendments); this record
adds documentation only. Linux, Node 22.22.0. Status per case: PASS, NOT RUN (with reason), or N/A (later phase).

### Commands

| Command | Result |
|---|---|
| `npm run typecheck` | PASS (exit 0) |
| `npm run lint` (Biome, 782 files) | PASS, no diagnostics |
| `npm run typecheck -w packages/web` | PASS |
| `npm run build -w packages/web` | PASS (existing >500 kB chunk warning only) |
| `npm test` (T0/T1, all packages) | 2765 / 2766 pass, 271 files. The one failure is `packages/sidecar/src/managed-proxy.test.ts` (`listen EAFNOSUPPORT ::1`): this container has no IPv6 loopback, and it fails identically on the untouched base `0ec78bb` (2709 / 2710 there) |
| T1 auth suites (`packages/gateway/src/auth/*.test.ts`, `api/auth-routes.test.ts`, config) | 51 new gateway cases PASS (8 files) plus 2 config cases; Web `app-auth.test.tsx` 12 cases PASS |
| Browser check (`spikes/m4-p1-browser-session-20261005/browser-check.ts`, Chromium 141.0.7390.37 / Playwright 1.56.1, production cookie mode, real listeners, file-backed SQLite, built UI) | 11 / 11 checks PASS |
| T2 `acceptance/m2-boundaries.container.test.ts` (edited: `?token=` on SSE now 401, header works) | NOT RUN. A Docker daemon was started, and the egress-proxy image built, but the workspace base image cannot build here: `npm install -g` inside `docker build` fails with `SELF_SIGNED_CERT_IN_CHAIN` behind this environment's TLS-inspecting proxy. Repairing that is out of scope (issue #5). Must run on a Docker host before release |
| `npm run test:acceptance` (T3) | NOT RUN: no model endpoint configured here, and P1 changes no agent behaviour |

### Test-plan cases for the P1 gate

| ID | Status | Evidence |
|---|---|---|
| AUTH-01 bootstrap, closed signup, login, restore, restart, uniform errors, throttling | PASS | T1 `auth-routes.test.ts` (5 cases incl. file-DB restart), `cli.test.ts`, `user-store.test.ts`; browser check (locked page, wrong password, reload, Gateway restart) |
| AUTH-02 hash-only DB, Argon2id parameters, idle/absolute expiry, fixation, no raw secret | PASS | T0 `passwords.test.ts`; T1 `session-store.test.ts` (token absent from every table, sliding idle, absolute cap, new token per login), `auth-routes.test.ts` (planted cookie not adopted); browser check (raw cookie absent from SQLite + WAL files) |
| AUTH-03 CSRF / Origin / login CSRF / cookie flags / no credentialed CORS / no URL or storage token | PASS | T1 `auth-routes.test.ts` (login CSRF 4 cases, mutation CSRF 5 cases, logout/logout-all/password CSRF, configured origin list, walk of every unsafe `/api/*` route), `operator-auth.test.ts`; T0 Web `app-auth.test.tsx`, `client.test.ts`, `events.test.ts`; browser check (`__Host-` HttpOnly Secure Lax host-only cookie as stored by Chromium, empty storage and `document.cookie`, SSE URL `/api/events`, cross-site fetch and form POST cannot mutate). HTTPS deployment not exercised: localhost is a browser secure context |
| AUTH-04 logout, logout-all, user disable, membership removal/demotion, password change invalidate the right scope incl. SSE, tickets, WebSockets | PASS (single tenant) | T1 `auth-routes.test.ts` (SSE closed on logout in < 500 ms, logout-all, password rotation, out-of-process disable closed within one sweep, demotion/removal, desktop ticket refused after logout and open desktop WebSocket closed), `session-store.test.ts`, `live-connections.test.ts`; browser check (idle second device returned to sign-in 80 ms after Sign out on every device). "Other tenant stays usable" needs a second tenant: P4 |
| AUTH-05 multi-tab tenant contexts, late responses after tenant switch | N/A in P1 | One tenant; no switch exists. Tabs share the cookie; sign-out in one tab ends the others on their next request or stream event |
| ROLE baseline: last-Owner protection, membership versioning | PASS | T1 `user-store.test.ts`, `session-store.test.ts` |
| ROLE-01 role-based route restrictions | N/A (P2) | Every active member has the operator token's former access in P1; stated in the gateway README |
| INV-01 invitations | N/A (P4) | No invitation route; accounts come from the maintenance CLI only |
| TASK-01 attribution, no client actor, legacy `human:web`, no dispatch | PASS | T1 `auth-routes.test.ts` (cookie -> `user:<id>`, bearer -> `human:web`, client actor field 400 with no write, run count unchanged), `migration-0028.test.ts`, `tasks.test.ts`; T0 Web `tasks.test.tsx` |
| MIG-01 (P1 slice): 0028 on populated DB | PASS | T1 `migration-0028.test.ts`: rows identical, tenant backfill, `foreign_key_check` empty, `integrity_check` ok, applies once |
| REG-01 existing suites | PASS except a pre-existing environment failure | see `npm test` row |
| SSO-*, DATA-*, FILE-*, EVT-02, DESK-*, RUN-01, JOB-*, INT-*, DOCKER-01, LIMIT-01, AUDIT-01, MIG-02..05, E2E-* | N/A (P2-P4) | Not implemented in this change |

### Review fixes (PR #6 review of `1582db7`, re-verified at `22f9cbb`)

The owner's review found four defects. Each fix has a test that fails without it (shown by
removing the fix and re-running).

| Finding | Fix | Test | Without the fix |
|---|---|---|---|
| 1. A reset, disable or logout during asynchronous password verification could be followed by a new session, or overwritten by a password change | After verification, re-read hash, user and session and write in one immediate transaction | T1 `auth-races.test.ts`: gated verifier; reset/disable/CLI-process write during sign-in; reset/logout/hash write during password change | 5 of the 9 race cases fail |
| 2. Concurrent guesses all passed the throttle before any failure was recorded | Attempts reserve budget when admitted, before hashing; `released()` for invalid input never clears failures | T0 `login-throttle.test.ts` (in-flight attempts); T1 `auth-races.test.ts` (6th concurrent sign-in and password-change guess refused before verification; 5 verifications) | the old API had no admission step |
| 3. Vite did not proxy `/auth`; `npm run dev:web` showed "Cannot connect to the Gateway" | `/auth` proxied like `/api` (Host kept) | T0 Web `vite-config.test.ts`; browser check with `VIA_VITE=1` | browser check stops on the "Cannot connect" screen |
| 4. `npm run auth` and `npm run dev:gateway` opened different files for a relative `GATEWAY_DB` | `scripts/gateway-dev-env.mjs` shared by both launchers (same `.env`, one absolute path); the CLI prints the file and refuses a missing one; the runbook runs it from `shared/` | T1 `scripts/gateway-dev-env.test.mjs` (relative path from two directories reaches one DB), `cli.test.ts` | the old launcher resolved against the repo root |

Results at `22f9cbb`: typecheck, lint, Web typecheck and Web build PASS; `npm test` 2780 / 2781
(274 files; the one failure is the same IPv6 `::1` environment failure as on the base); browser
check PASS in both modes (11 / 11 each): built UI from the Gateway (second-device sign-out
72 ms) and Vite dev server proxy (84 ms). T2 and T3 status unchanged.

### Not done, and why

- Approval decider, thread message author and takeover holder still come from the body or the
  shared label (`authorId`); deriving them from the principal is AUDIT-01 (P2/P3).
- No role checks between Owner/Admin/Member; no OIDC/Google/SAML; no scoped stores or second
  tenant; global presence. All later phases.
- The stable deployment serves plain HTTP on the LAN; production cookies need HTTPS (or the
  explicit `insecure-dev` opt-in). The runbook section "Before deploying the first release with
  browser sign-in" lists the owner's decision and the bootstrap step. Nothing was deployed.
- Client address for throttling is the socket address (`trustProxy` is off); behind a reverse
  proxy all clients share one address budget. Record it if a proxy is added.

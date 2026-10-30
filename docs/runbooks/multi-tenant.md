# Multi-tenant operation (ADR-0022 P2-P4)

How a platform maintainer turns a single-tenant Gateway into a multi-tenant one, connects an OIDC
identity provider, brings people in, and backs up and restores the database. Everything here is
platform maintenance: no tenant role reaches it over HTTP. Commands use the auth CLI from the
Gateway's working directory (the one holding `GATEWAY_DB`):

```
node <release>/packages/gateway/dist/auth/cli.js <command> ...   # deployment
npm run auth -- <command> ...                                    # checkout
```

Status: implemented and tested at T0/T1, at T2 against a real Docker daemon with two tenants,
and in a real browser against Keycloak 26.4
(`docs/design/m4-p2-p4-tenancy-results-2026-10-07.md`). Not yet verified: the deployed-model
two-tenant run (E2E-02), a migration rehearsal on a copy of the real deployment database (MIG-01)
and a customer's own enterprise IdP. Do not expose a second tenant to real users until those
pass and the owner accepts ADR-0022.

## 1. Before enabling a second tenant

1. Serve the operator UI over HTTPS with the default `GATEWAY_SESSION_COOKIE=secure`. Multi mode refuses
   to start otherwise.
2. Take a backup (section 5) and keep it off the host.
3. Run the preflight. It reports every reason the database cannot prove a tenant boundary
   (foreign key violations, tenantless workspaces, Knowledge or cost rows, cross-workspace
   members or runs):

   ```
   auth-cli preflight
   ```

4. Stop the Gateway, set `DESKMATES_TENANCY=multi` in its `.env`, and start it. It refuses to start
   while the preflight finds anything.

What changes in multi mode:

- The CLI's `create-tenant` works. In single mode it refuses, and a single-mode Gateway refuses to
  start on a database that already holds two tenants.
- Nothing else changes for existing callers. The operator bearer credential
  (`GATEWAY_OPERATOR_TOKEN`) always acts in the Default Tenant only, in both modes, and ignores a
  tenant selector; other tenants are reached only by signed-in people. Desktop takeover still
  returns the workspace's direct noVNC address and password to the person who takes over (owner
  decision 2026-10-07: no extra restriction for now).

Never go back to `single`, or to an older Gateway, once a second tenant has data: restore the
backup taken before enabling instead. From this release on, a Gateway refuses a database migrated
by a newer release.

## 2. Tenants and people

```
auth-cli create-tenant --name "Beta"
auth-cli list-tenants
auth-cli create-user --login bob --name Bob --role owner --tenant <tenant id>
auth-cli add-member --tenant <tenant id> --login alice --role admin
auth-cli set-tenant-status --tenant <tenant id> --status suspended   # runs stay queued
```

Inside a tenant, its Owners and Admins manage people from **People** in the UI:

- An Owner changes any role, including making another Owner; an Admin removes or keeps Members
  only; anyone may leave. The last active Owner can never be demoted or removed.
- A role change or removal ends that person's access to the tenant at once, including open event
  streams and desktop control. They sign in again after a promotion.
- Invitations: a one-time link bound to the tenant, a role (Member, or Admin when an Owner
  invites) and one identity: a new login name, an existing account (accepted from its own
  session), or an SSO login whose identity provider asserts the invited email as verified. There
  is no mail service: deliver the link yourself. A link is shown once; only its hash is stored.

### What each role may do

Each role includes everything in the columns to its left. Platform maintenance is separate and
adds nothing inside a tenant: "-" means the person's tenant role decides (a maintainer who is a
Member of a tenant is a Member there). The table states what the Gateway enforces today
(`ROUTE_POLICY`, generated into `docs/generated/permission-matrix.md`), as
the owner decided findings C1-C8 of issue #14 on 2026-10-10 (ADR-0022 amendment 1, "Admins own
the group; Members use side chats"). The Web UI hides or disables what the signed-in role cannot
do and names the role that can.

A **side chat** is a one-bot chat a Member opened themselves; it is not the bot's private chat
and not a group. A Member posts only there. Everyone in the tenant can read it, and the bot it
talks to still works on the group's shared computer (browser logins, files, shell); what the
Member cannot touch is the group's chats and configuration.

| Action | Member | Admin | Owner | Platform maintainer |
|---|---|---|---|---|
| See every workspace, bot, thread, run, file, task, cost and Knowledge document of the tenant | yes | yes | yes | - |
| Open a side chat with one bot and post in it | yes | yes | yes | - |
| Post in group chats and a bot's private chat; open a bot's private chat; start chats with several bots; add or remove bots in a chat; set a chat's deadline | no | yes | yes | - |
| Create, edit and accept tasks (Members read them) | no | yes | yes | - |
| Answer approvals once (Allow once, Deny) | yes | yes | yes | - |
| Cancel a run or answer its turn-continuation ask in a side chat you opened | yes | yes | yes | - |
| Cancel any other run or answer its turn-continuation ask | no | yes | yes | - |
| Answer approvals persistently: Always, "allow this site" | no | yes | yes | - |
| Take over and control the shared screen (through the Gateway's screen proxy only); view desktops | yes | yes | yes | - |
| Curate learned memory (edit, forget, undo, confirm, close task notes, consolidate), edit a bot's `MEMORY.md`, review memory suggestions (Members read) | no | yes | yes | - |
| Propose Knowledge; acknowledge cost alerts | yes | yes | yes | - |
| Leave the tenant (never its last active Owner) | yes | yes | yes | - |
| Create and change workspaces, including the egress allowlist; restart a workspace | no | yes | yes | - |
| Create and change bots: SOUL, model, schedules, avatar, webhook token | no | yes | yes | - |
| Create and delete approval rules | no | yes | yes | - |
| Register database connectors; connect and revoke integration accounts | no | yes | yes | - |
| Create and delete cost alert rules | no | yes | yes | - |
| Review (publish or reject) and edit Knowledge | no | yes | yes | - |
| See People; invite Members; remove Members | no | yes | yes | - |
| Change any role (including making an Owner); invite Admins; remove Admins and Owners | no | no | yes | - |
| Adopt and unadopt integration providers, set OAuth apps, override action tiers | no | no | no | yes |
| Set prices, read the runtime status, clean up Knowledge version files | no | no | no | yes |
| Tenants, users, passwords, SSO providers and policy, maintainers, backup, restore | no | no | no | CLI only; host access to the database, not the role, admits |

The operator credential (`GATEWAY_OPERATOR_TOKEN`) acts as an Owner of the Default Tenant and as a
platform maintainer, with no person behind it (finding C8, kept). A service principal carries a
tenant role like a person, `admin` or `member` (ADR-0022 amendment 1 A10), and the table applies
to it by that role: an Admin's or Owner's principal is `admin` unless created with
`role: "member"`; `auth-cli create-service-principal` makes a `member` unless given
`--role admin`. A client that needs group threads, tasks or submit needs an `admin` principal.
No principal of any role manages people: members, invitations and created accounts are refused
to it (`people_only`), and it has no profile or avatar (ADR-0022 amendment 1 A13).
Principals created before migration 0049 are `member`. Bots deciding approvals with
`approval_decide` are unchanged.

Before activating this on a deployment, tell the Members: they no longer post in the group chats
or in bots' private chats, and their Always and "allow this site" buttons are gone.

### Platform maintenance

Platform maintenance (`platform_role = maintainer`) is installation-wide and separate from any
tenant role. The bootstrap Owner holds it; nobody else does until a platform maintainer grants it
from the CLI. No HTTP route grants or revokes it:

```
auth-cli list-users                       # a trailing "maintainer" marks who holds it
auth-cli grant-maintainer bob             # a local login name
auth-cli grant-maintainer alice@corp.com  # an SSO person: the verified email of their login
auth-cli grant-maintainer usr_...         # or the user id from list-users
auth-cli revoke-maintainer bob
```

- The target must already exist; an SSO person exists after their first sign-in. An email that
  more than one person's login carries is refused; name the user id instead.
- `revoke-maintainer` refuses to remove the last active maintainer. Grant someone else first.
  A disabled account does not count.
- The Gateway reads the role on every request, so a grant or revocation applies to open
  sessions on their next call; the Web UI shows the change after a reload.

## 3. OIDC sign-in and enforced SSO

Register a provider once per issuer. The client secret is read from stdin and stored encrypted
with `GATEWAY_SECRETS_KEY`; `--public` registers a PKCE-only client:

```
auth-cli add-oidc-provider --id corp --name "Corp SSO" \
  --issuer https://idp.example.com/realms/corp --client-id deskmates \
  --redirect-uri https://deskmates.example.com/auth/oidc/callback
auth-cli list-oidc-providers
auth-cli set-oidc-provider-status --id corp --status disabled
```

The redirect URI must be exactly `https://<operator origin>/auth/oidc/callback` and registered with
the IdP. Issuers must use HTTPS (plain HTTP only on loopback, for development).

Let a tenant trust the provider, then decide its policy:

```
auth-cli link-tenant-sso --tenant <id> --provider corp [--max-auth-age 43200] [--jit member]
auth-cli set-tenant-policy --tenant <id> --policy sso_required
auth-cli unlink-tenant-sso --tenant <id> --provider corp
```

- `sso_required` admits only a sign-in from a provider the tenant links, no older than its maximum
  authentication age (default 12 h). A password, another tenant's provider or a matching email
  never substitutes. The operator UI no longer has a team switcher (owner decision 2026-10-10:
  multi-tenancy is not a product feature), so such a person signs out and signs in with the
  provider.
- A policy change, an unlink or a disabled provider ends existing grants on the next request.
- An external login is identified by issuer + subject only. It is never merged with an account by
  email; a signed-in person links it from a fresh session (the identity provider is asked to
  re-authenticate), which signs out their other sessions.
- `--jit member` lets an unknown subject of that provider join that tenant as a Member when the
  sign-in was started for it. The sign-in page names no tenant: a sign-in from it is for the one
  active tenant that allows JIT for the provider, and for none when two or more do (then an
  invitation decides). JIT never creates an Admin or Owner. Default is off.
- The IdP must be reachable from the Gateway; an outage fails closed.

### Back-channel logout

Register this URI with the IdP as the client's OIDC back-channel logout URL, with "session
required" on so logout tokens carry `sid`:

```
https://<operator origin>/auth/oidc/<provider id>/backchannel-logout
```

The IdP must reach it over the network; it is the only route on the operator listener an IdP
calls directly. A logout token must be signed with a key in the provider's JWKS (asymmetric
algorithms only), name this client as audience, be at most 5 minutes old, carry the back-channel
logout event and no nonce, and is accepted once. With `sid`, it ends the Deskmates sessions and
team step-ups that IdP session started; with `sub` only, everything that IdP user started. A
password session of the same person is not ended; only its SSO step-ups are.

Keycloak 26.4: signing out each Keycloak session sends one logout token per session. The admin
**Sign out** of a whole user delivered one token for a user with two Keycloak sessions in every
run (`spikes/m4-sso-keycloak-20261007`), so the other session's Deskmates step-up stayed open. To cut
someone off, also remove them in **People** (or `disable-user`).

There is no SCIM: disabling someone at the IdP ends a Deskmates session only if the IdP sends a
logout token. Keep `--max-auth-age` short for `sso_required` tenants.

## 4. Limits that protect one tenant from another

- Nothing caps how many sidecar processes a tenant or a workspace runs at once (ADR-0022
  amendment 5); `TENANT_MAX_CONCURRENT_RUNS` and `WORKSPACE_MAX_CONCURRENT_RUNS` are no longer
  read. Each workspace container is bounded by `WORKSPACE_MEMORY_LIMIT_MB` (default 8192) and
  `WORKSPACE_CPU_LIMIT` (default 4 cores). Size the host for the number of busy workspaces
  times those limits; a workspace that reaches its memory limit is OOM-killed as a whole.
- `TENANT_MAX_QUEUED_RUNS` (default 200) refuses new work (thread messages, webhooks, bot
  messages) with `queue_full` while a tenant has that many runs waiting.
- `TENANT_API_REQUESTS_PER_MINUTE` (default 1200) is one token bucket per tenant for the operator
  API, shared by all its people; over it, requests get `rate_limited` with a retry hint. The
  event stream is not counted.
- `WORKSPACE_DISK_QUOTA_MB` (default off) holds new runs of a workspace whose `/work`, `/home`
  and `/profile` exceed it (`waitReason: workspace_disk_quota`), measured with `du` in the
  container at most once a minute. Running runs are not stopped, and nothing is deleted.
- `TENANT_MAX_EVENT_STREAMS` (default 200) and `TENANT_MAX_DESKTOP_CONNECTIONS` (default 32;
  desktop tickets plus open desktop streams) cap the long-lived connections one tenant holds,
  which the request rate does not bound. Over them, a new stream or ticket gets `queue_full`.
- Set any of these to 0 to turn it off. All limits are per Gateway process.
- Not configurable: an SSO sign-in start is limited to 300 per client address per 10 minutes, and
  at most 5,000 sign-ins may be in progress at once. Together they bound the transactions an
  anonymous caller can store.
- The Gateway does not read `X-Forwarded-For`. Behind a reverse proxy every person has the
  proxy's address, so the sign-in start limit and the password throttle's per-address budget
  (30 failures per 15 minutes) are shared by everyone; the per-login-name budget is not.
- A tenant Admin may register connectors on public URLs only; the Gateway checks every resolved
  address before each call, connects only to the addresses it checked, and refuses redirects. A
  private-network connector needs a platform maintainer who is also a member of that tenant.

## 5. Backup and restore

The Gateway may keep running during a backup; SQLite's online backup includes the WAL:

```
auth-cli backup --out /backups/gateway-2026-10-05.sqlite
```

This writes the copy and `<file>.manifest.json` (migrations, row counts, SHA-256). The database is
not everything: also back up the workspace Docker volumes (`deskmates-<workspace>-profile|work|home`)
and the integration runtime's own state with their own tools, at the same time.

To restore, stop the Gateway, then:

```
auth-cli restore --from /backups/gateway-2026-10-05.sqlite
```

Restore verifies the manifest hash, moves the current database (and its WAL files) aside as
`<db>.pre-restore-<time>`, and revokes everything the backup carried: sessions and tenant grants,
run tokens, sign-in and OAuth transactions, and open invitations. Everyone signs in again; no old
cookie, token or link works. Start the Gateway after the restore.

## 6. Known gaps

- One Gateway process. Revocation reaches live connections through an in-process registry; more
  than one process needs shared revocation first.
- The takeover holder is stored with the browser lock. After a restart the same person still
  holds the screen; a holder whose session ended or who left the tenant is released by the
  periodic sweep, and an Admin can free a browser left held. Only the holder gets an interactive
  desktop ticket.
- Docker labels: sandboxes created before this release carry no tenant label and are accepted
  only for the Default Tenant.

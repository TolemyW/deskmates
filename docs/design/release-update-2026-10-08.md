# Testbox latest-code update — 2026-10-08

Owner request: update the code on Testbox to the latest version.

## Release and installation

Published annotated tag **v0.3.2**, revision
`ee817be7574c470231927779ba6e54c8920afa77`, the latest GitHub main observed
at the start of this request. This includes merged PRs #8 and #9: tenant/OIDC
implementation and bounded, fail-closed login throttle state. This is an
internal-trial patch, not M4 or second-tenant acceptance.

[Release CI](https://github.com/TolemyW/deskmates/actions/runs/37734889562)
passed typecheck, lint, documentation consistency, T0/T1, Web checks/build,
base publication and application-image smoke build. The same main revision's
[previous CI](https://github.com/TolemyW/deskmates/actions/runs/37601201660)
reported 294 root files / 3145 tests and 42 Web files / 289 tests; counts
overlap and must not be summed.

The tagged archive SHA-256 is
`0af3d3cf90e07c198c129955cbaa4bf002258c9535f7e7e9da7821ad188c6b04`.
All 1758 regular source files and the `CLAUDE.md` symlink were individually
verified on the server, with zero differences. No workstation `.env`,
credentials, `.git` history or `node_modules` were transferred. The old
`/home/owner/agent_workspace/deskmates` checkout has substantial uncommitted
changes and was preserved; the update uses the independent stable release
directory `/home/owner/Data/deskmates-stable/releases/v0.3.2`.

The initial npm preparation failed with `ECONNRESET` while downloading
`openid-client-6.8.8.tgz` from registry.npmjs.org; its separate preparation log
is retained. The documented install script then succeeded with
`npm_config_registry=https://registry.npmmirror.com` and `LOCAL_BASE=1`.
The lockfile and tagged source were not changed. Host typecheck, Web build
and image builds passed.

| Image | Installed ID |
| --- | --- |
| Base `amd64-afd228b644f2` | `sha256:bffdc561d23361c6d199f62981b7543cc55f476bc28ef505da16207f700a61f5` |
| Workspace `amd64-413c4579a5e3` | `sha256:37aec119ea2cf5771c8fa9c5dbf2251f03268b2ec829bdb2983f459c2e89de07` |
| Egress `amd64-7d91517883a7` | `sha256:37d262a80778dcdb693179d20da247b09c97ad1ca48a504d74096de865e2f9b6` |

The manifest's CI base ID is
`sha256:6aca67a8ae041e893cafb84c42529ac28b7e9734476f8d69fdfa6f44470905df`;
the documented host fallback retains its distinct ID in `images.txt`.

## Database-copy rehearsal

An online SQLite backup of the running v0.3.0 database was made on Testbox,
then copied again for migration. Only the second copy was opened by v0.3.2.
Migrations 0028–0034 applied successfully. Before/after counts match:
one workspace, six bots, one thread, ten messages, 18 runs, zero approvals,
tasks or integration connections. Integrity checks returned `ok`, foreign
key violations were zero, secure-cookie tenancy preflight was empty and the
single-mode startup check passed. The migrated copy has one Default Tenant,
no tenantless workspaces and no users. This is a copy rehearsal; no production
migration or account creation is implied.

Snapshot SHA-256:
`0187e7b7ed04bc82a4abb1ae67812a909c21668b07bab2230990bfaa63e99c0b`.
The copies and machine-readable rehearsal receipt remain on the server in
`upgrade-receipts/v0.3.2/`, outside Git.

## Container checks and activation boundary

Target-host patch T2 smoke passed **10 files / 29 tests**, using two workers
and the exact installed image IDs, without model credentials. The original
receipt, log and pass stamp are preserved as `.release/t2-smoke.*`.
The release-day full T2 was then started in the background with the existing
heavy-test lock, two workers and explicit workspace/fixture ownership journals.
Read later from its original receipt `.release/t2.json`, `t2.log` and the
`t2.passed` stamp, not from a repeat invocation: **30 files / 97 tests passed /
one skipped**, exit 0, 06:12:37Z to 06:19:04Z (387.18 seconds), against the
installed workspace and egress image IDs above. The new
`acceptance/m4-tenancy.container.test.ts` (ADR-0022 E2E-01) passed its four
tests in 25 seconds and `m2-boundaries.container.test.ts` its six. The
`sdk-shape` skip is the usual no-model skip. The run's ownership journal
`upgrade-receipts/v0.3.2/full-owned-workspaces.jsonl` names 23 workspaces; an
exact-name audit of their containers, networks and volumes found zero
leftovers. The four `deskmates-net-ws_*` networks present on the host belong to
the stable deployment's running trial workspaces, not to this test. No prefix
cleanup or daemon prune was performed.

The observed live release remains **v0.3.0**. v0.3.1, installed on 2026-10-06
and never activated, stays in `releases/` untouched; v0.3.2 replaces it as the
activation candidate, and the rollback pair is still v0.3.0 plus its
pre-upgrade database. Activation is pending the owner's
explicit transport choice in
[the deployment runbook](../runbooks/stable-release.md#before-deploying-the-first-release-with-browser-sign-in-adr-0022-p1):
HTTPS with secure cookies, or accepted `insecure-dev` cookies on the existing
LAN HTTP origin. The runbook states: "Which one is the owner's decision."
First-Owner bootstrap also needs an account and password handoff arrangement;
no password is requested in chat.

Stable `shared/.env` remains mode 0600, with secure cookies by default and
single tenancy. Its observed SHA-256 is
`ecf00c124a7d5022970f7400e5f8b71f90c0f762b6e052f65724b667e6af3aa7`.
No environment/secrets-key change, activation, integration-runtime interruption
or rollback occurred. Before activation, drain, back up both the production
database and the exact integration runtime's `/app/data`, and preserve v0.3.0
plus its pre-upgrade database as the rollback pair. Keep single tenancy;
second-tenant exposure and retained M4 gates are not authorized by this update.
No real model was called for this request.

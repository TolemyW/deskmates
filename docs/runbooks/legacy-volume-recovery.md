# Restart preflight and legacy-volume recovery

Issue #62 records the failed stable v0.5.3 → v0.5.6 upgrade: the old runtime was
removed before a profile volume without ownership labels was rejected. Its data
survived, but normal restart could no longer use the old runtime. That failure is
historical evidence, not a successful migration.

The Gateway now calls the provider's read-only `preflight` before explicit restart,
before the uncached open path removes stale-image containers, and before it creates
a sandbox that does not exist. A healthy current sandbox is reattached without
preflight, so a legacy volume does not block runs until a replacement is attempted.
An explicit restart whose cached container has already vanished from Docker
proceeds: there is nothing volatile left to preserve. Failure preserves
cached screen credentials, the runtime, named volumes and human takeover lock.
`volume_ownership_mismatch` identifies only the workspace and exact volume name;
it does not expose profile contents or secrets. Images are inspected, never pulled.
A failed preflight is retriable after the prerequisite is corrected; no rollback
is necessary because preflight makes no writes.

This is a prerequisite check, not a transactional Docker replacement. A daemon
failure, external resource mutation after inspection, or a new image failing its
health check after removal still requires operational recovery. It does not prove
browser profile format compatibility across browser versions. Keep a cold backup
and the old release; do not treat successful preflight as permission to deploy.

## Legacy recovery (separately approved maintenance)

Do not relabel a volume based on a matching name. Do not run a migration while its
browser or another writer is active. This change provides no automatic adoption or
in-place relabel command. Before any maintenance write:

1. Record the exact Docker daemon/context, release tags and immutable image IDs,
   tenant/workspace IDs, old container and proxy IDs, network ID, and each mounted
   volume's exact name, mount destination, driver and labels. Cross-check the old
   container's mount inventory against the workspace database and deployment
   history. A missing or contradictory ownership chain is a stop condition.
   Redact environment, screen passwords, tokens, cookies and profile contents.
2. Obtain approval for the exact resource inventory and downtime. Preserve the
   original failed-upgrade receipt. If the old runtime is still running, leave it
   running until a verified backup and maintenance plan exist.
3. In the approved quiet window, stop writers, take a consistent backup of all
   three volumes and the Gateway database, preserve the Gateway secrets key,
   permissions and numeric file ownership, and verify backup hashes and a restore
   into distinct scratch volumes on an isolated daemon. Never validate against
   production volumes or permit two browsers to write the same profile.
4. Recover through **new** explicitly labelled volumes populated from the verified
   backup, on an isolated rehearsal deployment with the same tenant/workspace
   identities. Required labels are `deskmates.managed=true`, `deskmates.workspace`
   equal to the exact workspace ID and `deskmates.tenant` equal to the tenant ID.
   Verify files, browser profile and sessions locally without exposing their
   contents. Retain original volumes untouched. Cutover of production names and
   runtime is a separate, inventory-specific maintenance operation; stop if its
   rollback cannot preserve originals.
5. Roll back a failed rehearsal by removing only its inventoried scratch resources;
   resume the original release/runtime on its original volumes. After an approved
   production cutover, restore the matched database/volume backup and previous
   tagged release together. Never reuse a volume already modified by a newer
   browser as an unverified rollback input.

## Release gate

The observed v0.5.3 → v0.5.6 transition needs an ownership audit wherever volumes
lack any required labels. This is metadata-driven: a version number alone does
not prove whether a volume needs recovery. Future transitions introducing volume
ownership or browser/SDK format changes must rehearse the exact old/new images
and copied data before the production upgrade. Legacy or foreign volumes must
fail without writes; current labelled volumes must pass and retain sentinels;
an unrelated workspace must remain untouched.

Deterministic regressions: `packages/sandbox-docker/src/preflight.test.ts`, Gateway
`sandboxes.test.ts` and `workspace-ops.test.ts`. Real Docker fixture:
`EGRESS_PROXY_IMAGE=<built-test-image> npx vitest run packages/sandbox-docker/src/preflight.container.test.ts`.
The T2 uses UUID-scoped scratch volumes, a real old process and synthetic login/file
sentinels. It verifies storage preservation, not a real site's authenticated login
or a browser-version migration. No model calls are made.

## Temporary access prerequisites (owner comment, 2026-10-12)

The continuing trial used temporary, workspace-local trust of two explicitly
approved peer certificates. Recreation discarded `/root/.pki/nssdb` because it was
outside `/profile`, `/work` and `/home`. Navigation then correctly failed closed
with `ERR_CERT_AUTHORITY_INVALID`. The operator checked that the live peer
fingerprints still matched the prior approvals, restored only the already-approved
NSS database in that exact workspace, and restarted only its idle container. This
is a documented limitation of temporary operator setup, not evidence of changed
certificates or a product guarantee of durable trust. The record is retained in
issue #62 comment 6122330574.

An administrator can call `GET /api/workspaces/:id/restart-preflight` before
recreation. It runs compatibility checks and returns possible volatile
prerequisites, without starting, stopping or changing a runtime. For Docker, the
bounded detector reads only the exact owned workspace's Engine filesystem-change
metadata. A non-deleted `cert8.db` or `cert9.db` at `/root/.pki/nssdb` outside the
replacement's mounted volumes is reported. It does not read database contents,
certificate bytes/nicknames, private keys, live endpoints or arbitrary root state.
A database's presence does **not** prove that it contains a public trust row or
that its contents were authorized. Metadata inspection failure refuses replacement
before mutation. Other root paths and arbitrary volatile prerequisites are outside
this detector's coverage; image-baked prerequisites are not writable-layer changes.

Explicit restart records the risk before destruction; successful removal records
`restoration_required`, even if the new runtime then fails to start. Automatic
stale-image replacement logs the identified prerequisite before removal and stores
the restoration requirement afterward. A removal error keeps the outcome explicitly
unknown. Requirements retain the old exact container ID and path in the workspace
record and operator Management view across Gateway restarts. They are historical
restoration evidence, not a live verification or an automatic clearance after
manual restoration.

Before restoring, the operator must locate the original authorization and an audited
backup belonging to the exact workspace, check the current exact peer fingerprints
against that authorization, and check expiry/revocation. Unchanged, still-authorized
peers are eligible only for the separately approved restoration procedure. Changed
peers, expired/revoked grants, missing approval records or ambiguous workspace
ownership require fresh authorization; keep TLS fail-closed in the meantime. An
unrelated workspace is never an eligible restoration destination. Do not import a
peer as a global CA, copy arbitrary root state, bypass certificate checks or restore
an arbitrary database merely because its path matches.

There is currently no durable inventory of the temporary setup's hostnames, peer
fingerprints, grant expiry/revocation or approved database digest. Consequently the
product cannot verify those conditions or safely perform restoration itself. This
patch adds visibility and instructions only. A supported durable peer-trust feature
still needs a separate design and explicit authorization.

Regressions cover read-only metadata detection, absent/deleted/persisted state,
foreign-tenant refusal before filesystem inspection, read failure before destruction,
preview without writes, durable post-recreation notice, failed new runtime creation,
automatic stale-image replacement, and operator guidance without a trust action.
The isolated Docker fixture uses a **synthetic invalid** `cert9.db` marker to prove
volatile loss detection and no automatic copy, while another tenant's real runtime
and profile sentinel remain intact. No certificate is installed or trusted by tests.
Real peer fingerprint/expiry decisions remain a manual prerequisite, not a tested
or implemented trust-management guarantee.


Replacement inventory is not the first container an attach lookup returns. NSS
inspection covers every exact managed workspace/infrastructure candidate selected
for replacement, including stopped leftovers. Explicit restart also verifies its
cached container ID belongs to that inspected workspace inventory; an absent or
foreign cached target fails before destruction. The stopped-leftover-first / running
NSS-runtime-later case has deterministic and isolated Docker regression coverage.
This does not make external daemon mutations between inspection and replacement
transactional.

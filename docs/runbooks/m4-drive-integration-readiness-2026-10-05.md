# M4 Drive integration readiness — 2026-10-05

Status: offline adapter readiness work; **real Google Drive acceptance BLOCKED**.
No Google account, folder, OAuth app or scopes have been authorized or bound.
No live OAuth was started, credential persisted, folder created, or Drive file
written. No parent ChatGPT Google Drive connector was used. The original offline
preparation made no deployment, GitHub push, model call, new service or security-
setting change. Source publication was authorized afterward; see the integration
note below. Publication does not authorize a Drive account or a live action.

Checkout baseline: `153240e` (`Record the verified v0.3.0 stable deployment`).
It was clean when this task started. The parent's referenced unpublished
31-file offline M4 patch was not in this checkout. This slice changes only
integration code/tests/UI and integration documentation; it does not implement
or rebase the memory slice. No commits were created during that initial phase.

## Pinned provider and runtime

- Runtime: OpenConnector **v1.7.0**, as recorded by the repository spike.
- Image: `ghcr.io/oomol-lab/open-connector@sha256:55b1c424b454451d61e34ea6e2f540e625569d8f4c31cc4c5ec8052dadda4c9b`.
- OCI source revision: `4505aed0c75b719fd13810d9cef00940fb05e16d`.
- Provider ID: `googledrive`, Google Drive v3 actions shipped in that image;
  no separate provider version is recorded. The OCI version label is `main`,
  so use the digest/revision, not that label, for identity.
- MCP protocol header: `2025-06-18`.
- Catalog summaries remain cross-checked against saved spike guides. Complete
  input/output JSON Schemas for `files.get`, `files.list`, `files.create` are now
  captured from the exact source revision in `drive-pinned-definitions.ts`.
  `RuntimeAdapter.actionDefinition` reads the runtime's authenticated raw
  `/api/actions/:id` definition; acceptance compares the entire normalized
  definition before any provider action, including types, required properties,
  additional-properties policy, operation classification and declared scopes.
- `spikes/openconnector/verify-drive-pinned.mjs` loads the unmodified pinned
  provider, real core input validator, executors and credential validator with
  synthetic credentials and mocked outbound HTTP. Four executions and full
  output-schema checks passed. This is source-level execution, not a running
  image/MCP HTTP server or real Google acceptance.

## Implemented and exercised offline

`packages/gateway/src/integrations/drive-acceptance-harness.ts` is a dependency-
injected acceptance procedure with no CLI, environment lookup or automatic
live entrypoint. Its only caller is `drive-acceptance.test.ts`, using the existing
Gateway, RuntimeAdapter and FakeIntegrationRuntime. Synthetic OAuth still uses
the existing workspace grant/state/revoke routes. A test-only action-result
callback models provider responses after the fake's existing token checks.

The procedure verifies exact action identities and parameter availability,
checks the supplied folder ID/type, enumerates only that folder, creates one
synthetic UTF-8 text file under it, verifies the returned file's parent/name,
downloads its bytes, and checks the delivered read-back bytes against SHA-256.
Every successful action must return an execution receipt. Failures retain safe
partial receipts, write-attempt status and any verified created file ID; never
blindly retry a possibly successful write. No folder creation,
permissions, sharing, deletion, native Docs export or arbitrary upload is in
this procedure. The pinned executor returns media at `data.file.downloadUrl`; transit IDs
are 32 lowercase hexadecimal characters with an optional short extension.
Both shapes are now source-verified and covered by local tests.

Narrow fixes:

- Drive fixture parameter names/types/required flags match recorded guides;
  notably `files.create.name` and `files.export` fields were incorrectly required,
  and upload text/parents were missing.
- Adapter rejects mismatched RPC IDs/error envelopes and catalog service/action
  identities. Interrupted response bodies become typed transport failures.
- Provider refusal execution IDs survive for attribution.
- Drive L2 approval contains a bounded redacted target/content preview; the
  actual operator approval card displays it safely. App login/Google SSO is
  described separately from a Drive access grant.
- `RuntimeAdapter.downloadTransit` accepts only the configured runtime's exact
  `/api/files/<id>` location, sends no credential, follows no redirect, enforces
  a 1 MiB byte cap while streaming and shares the adapter's request deadline.
  Download failures never retry the preceding provider write.

Offline cases cover grant/replay/denial/revoke/workspace scope, revoked access
while remote cleanup is unavailable, synthetic refresh/egress/provider
refusals, cross-origin/redirect/expired/interrupted/oversized transit, content
corruption, action binding, and another workspace continuing after a provider
failure. Synthetic `refresh_failed` and `egress_denied` results prove refusal
handling only; they do not exercise token exchange or network enforcement.

## Authorization packet for the parent

Ask for these concrete items; do not put secrets in chat, files tracked by git,
reports, command arguments or logs:

1. A named dedicated Google **test account**, operator-approved workspace and
   connection name, plus an **already-existing dedicated folder ID**. Confirm
   it contains only synthetic test data and permission to inspect that folder's
   metadata and list up to five children. Do not infer approval to create one.
2. Permission to create exactly one new `deskmates-m4-<unique-run-label>.txt`
   in that folder, then read its metadata/content and deliver those exact bytes
   into `/work/` of the approved workspace for operator download.
   Exact file content (UTF-8, final LF):
   `Deskmates M4 synthetic Drive acceptance artifact.`
   Cleanup/deletion is a separate authorization; retain the created file ID
   on any post-create failure rather than blindly rerunning creation.
3. Minimal requested scope, **after a reviewed provider update and new pin**:
   **`https://www.googleapis.com/auth/drive.file` only**. Do not request broad
   `drive` as a fallback. Google's API supports the trial's create/get/list and
   the provider's `about.get` validation using `drive.file`. That scope covers
   app-created or explicitly app-authorized files, not all files in an account.
   An existing folder ID alone is not an app authorization. Use an already
   app-authorized dedicated folder, or obtain separate explicit approval for a
   Picker selection through the same OAuth app or an app-created test folder.
   Neither bootstrap exists in this patch; no folder creation is authorized.
   Selecting a folder does not establish recursive access to pre-existing
   children. The trial must not depend on that assumption.

   **Pinned provider blocker:** its declared read scopes are `drive.readonly`
   and `drive.metadata.readonly`; write scope is `drive`, and OAuth defaults to
   all three. `OAuthClientConfigService.normalizeConfig` rejects `drive.file`
   as undeclared. A synthetic executor probe with `drive.file` passes because
   the core executor does not enforce that catalog list. This proves no local
   executor requirement for broad scope, not Google permission enforcement.
   Update the existing provider's declared/requested scopes and any catalog
   semantics, review and re-pin, regenerate full schemas and repeat the probe
   before asking for consent. No such upstream change is included here.

4. A test OAuth client and exact HTTPS Gateway callback URI supplied securely
   to the runtime by the operator; offline access/consent for the refresh test.
   Keep ordinary app login/Google SSO consent separate. Client secret and
   refresh/access tokens remain in the runtime's encrypted credential store;
   only IDs/names and redacted receipts reach the report.
5. Permission for one consent grant, a real expired-access-token refresh check
   without exposing tokens, then connection revoke and verification that access
   is refused. Distinguish deleting the runtime credential from revoking the
   Google-side consent grant; operator confirmation of the latter is separate.

## Real gates still open

| Gate | Required evidence / blocker |
|---|---|
| Authorized binding | All account/folder/scope/app details above are unapproved. Do not start OAuth. |
| Pinned runtime | Docker is available but has no cached images in this checkout environment. No image was pulled or service launched. Re-run pinned T2 when its isolated environment is available. |
| Full provider binding | Full pinned-source schemas and executor results are locally verified. Compare the deployed definition to the snapshot and verify HTTP/MCP envelope plus actual Google output before permitting a write. Any scope/provider revision needs a new snapshot. |
| Least-privilege scope | Existing provider configuration rejects `drive.file`. Reviewed provider update/re-pin plus app-authorized folder prerequisite required; no broad-scope fallback authorized. |
| Real grant/refresh/revoke | Real Google consent, offline refresh, invalid/revoked refresh and runtime/Google revocation behavior; current tests only use a fake. |
| Actual approval path | Live execute must pass through the sidecar's L2 hook and operator Allow once. The Gateway run execute route alone is not an approval gate. No Always rule or lowering override for this trial. |
| Production artifact delivery | The safe transit fetch helper is implemented; automatic execute-result-to-workspace delivery is **not wired**. The harness sink is a temporary local directory, not a sandbox. Implement/verify the bounded workspace writer and operator download before calling this delivered. |
| Transit topology | Runtime origin may differ from its internal Gateway address. Current helper fails closed unless the returned origin matches; any explicit origin mapping needs its own checked binding. Confirm expiry, byte identity and no private URL/token reaches a workspace. |
| Managed egress/isolation | Real runtime's Google OAuth/API and transit requests through the managed proxy, denial/failure isolation, and workspace inability to reach runtime/admin/transit directly. Do not infer this from browser egress or fake errors. TLS and isolation must remain enabled. |
| Human acceptance | Inspect the created file in the approved folder and download the artifact through the real UI; record hashes, receipts and operator decision. |

The owner's current instruction removes the natural 24-hour soak as an M4
acceptance gate. Genuine day/cooldown/restart and repeated-task observations
remain a **post-stable continuous verification task**. No injected timestamps
or short offline run here are presented as 24-hour evidence. This note records
the scope change; it does not create an automation or close other M4 gates.

## Reproduce offline

```sh
npm ci --ignore-scripts --cache /tmp/deskmates-npm-cache
npm rebuild better-sqlite3 --cache /tmp/deskmates-npm-cache
npx --no-install vitest run packages/gateway/src/integrations packages/testkit/src/fake-integration-runtime packages/sidecar/src/integration-tools.test.ts packages/sidecar/src/integration-approval-preview.test.ts packages/sidecar/src/approval-docs.test.ts packages/web/src/screens/integrations.test.tsx packages/web/src/screens/integration-approval-preview.test.tsx packages/web/src/screens/approval-card.test.tsx
npm run typecheck
npm run typecheck -w packages/web
```

The offline tests use no real model, provider, Docker service or Google grant.

## Scope evidence and remote reconciliation

Google's [scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
distinguishes the per-file non-sensitive scope from restricted full Drive
access. The method references explicitly list `drive.file` for
[create](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create),
[get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get),
[list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list), and
[about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get).
Use the [Picker documentation](https://developers.google.com/workspace/drive/picker/guides/overview)
for explicit selection. These sources support the minimum scope; the inability
to configure it is a provider restriction, not a Google API requirement.

Pinned source evidence is in
[`scopes.ts`](https://github.com/oomol-lab/open-connector/blob/4505aed0c75b719fd13810d9cef00940fb05e16d/src/providers/googledrive/scopes.ts),
[`oauth-client-config-service.ts`](https://github.com/oomol-lab/open-connector/blob/4505aed0c75b719fd13810d9cef00940fb05e16d/src/oauth/oauth-client-config-service.ts), and
[`executors.ts`](https://github.com/oomol-lab/open-connector/blob/4505aed0c75b719fd13810d9cef00940fb05e16d/src/providers/googledrive/executors.ts).
The evidence bundle records source hashes and synthetic requests/results without
credentials. No scopes were configured in a live runtime.

Read-only remote reconciliation found `origin/main` at
`0ec78bb1a9591120b334b857de720b659e9c615a` on 2026-10-05. Since this patch's
baseline, only four documentation files changed (ADR-0022, design index, auth
plan and test plan); no code conflicts. ADR-0022 is a proposal. Do not implement
its tenant/session model in this slice. Future adoption needs tenant-aware
connection ownership and OAuth state/revoke checks. App Google OIDC login
remains distinct from Drive authorization, even if the same Google account is
used. That read-only reconciliation made no merge/rebase/commit/push or
auth-implementation changes.

Integration note (2026-10-05): the owner subsequently authorized publication of
the unsubmitted source as one draft integration PR. Reviewed Drive source commit
`6a7bf00d09eda9ead8e646a89fab288725cc0b80` was cherry-picked into the integration
candidate alongside the reviewed offline acceptance, memory preparation and
equity preparation slices. The earlier no-publication statements and test totals
describe preparation history, not the final integration branch. New aggregate
results are recorded separately; none establish real Drive/OAuth acceptance.

## Validation recorded for this patch

See the accompanying HANDOFF and evidence manifest for the final frozen-tree
suite counts, exact patch hash, independent review disposition and remote
applicability check. Prior frozen offline validation passed 267 files / 2,740
tests; the reviewed patch adds recovery and schema tests. No T2/T3 or real Google
result is included in these counts. The pinned-source probe verifies three full
action schemas, four successful synthetic executions, invalid-input rejection,
provider `drive.file` configuration rejection, and the actual nested media shape.

Reproduce the source probe with Node 24's `--experimental-transform-types`, the
exact read-only OpenConnector checkout and its dependencies (`@cfworker/json-schema`
4.1.1, `jose` 6.2.3, `minisearch` 7.2.0 in this run):

```sh
node --experimental-transform-types spikes/openconnector/verify-drive-pinned.mjs /path/to/pinned-openconnector /path/to/evidence
```

Independent review found and prompted corrections to transit extension support,
nested media results, loss of post-write recovery facts and incomplete schema
preflight. These are checked by the reviewed patch's tests; real runtime wire,
consent, refresh, egress and workspace delivery remain open.

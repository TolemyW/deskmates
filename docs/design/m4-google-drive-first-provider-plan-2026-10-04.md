# M4 first real provider: Google Drive

Date: 2026-10-04. Status: planned, not connected or accepted.
Source baseline: `6bf09f1a7a0d98fcfe2fdc9c04e7e01923250c9c`.
Architecture: [ADR-0013](../adr/0013-saas-integrations-through-an-integration-runtime.md).

## Selected outcome and permission boundary

The owner selected Google Drive as the first real SaaS provider. The proposed
first journey uses one dedicated test folder for file reading, writing and
delivery. Provider selection does not identify an account/folder or authorize
an OAuth grant, credential entry, adoption/configuration change, or real write.
Confirm the concrete account, folder ID, permitted actions and requested scopes
at connection time; persistent access requires explicit action-time approval.
No credentials, private account identifiers or actual grants are recorded here.

Success for this slice means a bot can read an explicitly selected synthetic
input from the test folder, produce a bounded output there and return an
authenticated file reference that the operator can open. It does not imply broad
Drive search, sharing changes, permission changes, ownership transfer, deletion,
access to unrelated documents, or adoption of the runtime's whole action catalog.

## Reuse the existing boundary

- `packages/gateway/src/integrations/runtime-adapter.ts` remains the only
  OpenConnector protocol adapter; do not add Google vendor code to the Gateway,
  sidecar or a new hand-built connector.
- Existing authenticated operator routes support provider adoption, OAuth-app
  setup and workspace-bound connection start/callback. They are implementation
  surfaces, not evidence that the provider's live OAuth flow has passed.
- Workspace-scoped runtime grants and the existing five sidecar meta-tools carry
  the journey. Provider service/action identifiers, input/result shapes, required
  scopes and `operationType` must be read from the pinned runtime catalog before
  freezing the action manifest; do not guess them from historical examples.
- A SaaS write retains its L2 approval behavior. Do not lower tiers or add Always
  rules for this smoke. ADR-0013's never-lowerable Drive permission operations
  stay outside the selected action set.

## Next implementable local slice

1. Define a synthetic fixture manifest with a test-folder placeholder, input bytes
   and hash, output name/expected bytes or content assertions, maximum file size,
   allowed read/create/update actions and a run-specific nonce. Freeze it before
   execution. Do not insert real account values into tracked files.
2. Capture the selected pinned catalog contract and exercise it with the existing
   fake runtime. Cover action catalog filtering, own/foreign workspace connection
   checks, L2 approval/deny, credential redaction, untrusted output wrapping,
   download/upload transit and unauthorized path/permission actions.
3. Add a no-model live-provider harness with explicit prerequisites and a separate
   result file that cannot report acceptance when setup is absent. Use exact owned
   object IDs and host-observed runtime/provider responses; run-authored ledger
   payload labels alone cannot prove provenance.
4. Retain every attempted action and its outcome. A timed-out write is uncertain;
   never blindly repeat it or convert a missing response into a success. Reconcile
   by authorized read-only lookup where possible and preserve unresolved outcomes.
5. Freeze evidence requirements for later real execution: source tree, workspace
   and integration-runtime image digests, action manifest, scope approval receipt,
   connection/workspace/run IDs, OAuth/token-refresh result, input/output hashes,
   actual file reference and operator-open verification, with secrets redacted.

These steps are a plan for the next slice, not completed implementations in this
patch. Any configured-model journey needs its own approved campaign scope and
accounting; scripted/fake-model transport checks do not establish model quality.

## Live gates still required

Before connecting: supported Docker/runtime environment, pinned image, verified
callback and network topology, selected test account/folder and explicit OAuth
scope approval. Read secrets only through the supported secure setup flow.

Before calling the provider adopted: real token refresh, a real authorized read
and bounded write, exact folder/file binding, separate workspace refusal,
artifact-byte verification and operator access to the delivered file. Inspect
read/write transit behavior with the pinned runtime; the previous mock Gitea
container test is not a Google Drive pass. Do not deploy, release, broaden access
or clean up remote files without the applicable separate authorization.

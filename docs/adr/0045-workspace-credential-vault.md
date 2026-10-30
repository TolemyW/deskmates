# ADR-0045: Workspace credentials are used through references

Date: 2026-10-13
Status: Accepted (under owner delegation, 2026-10-17, as a design with two changes written into decisions 2 and 4; the owner selected tool-mediated fill/use on 2026-10-13). Implemented 2026-10-17 in code, with T0/T1 tests for every Verification row: the catalog and its Owner/Admin routes (migration `202610171523-workspace-vault.sql`), `vault_list`, `vault_fill` through the fixed `deskmates-sidecar vault-fill` command, `vault_request` with operator request definitions, redaction and capture suppression, the approval-mode behaviour of decision 4 (a human in `automatic`, the thread in `manual`, `mode:approve_all` in `approve_all`, exact-binding and origin checks in every mode) and the Vault page with its `approve_all` notice in all five locales. On 2026-10-19 all five cases of T2 `acceptance/m4-vault-browser.container.test.ts` passed: actual SDK with a scripted upstream, synthetic normally trusted HTTPS browser fill, in-flight takeover, same-document navigation refusal and normal capture/transcript canary checks (rows 5 and 7; `docs/design/vault-live-acceptance-2026-10-19.md`). This is model-free browser-path evidence, not real login or a universal secret-leak guarantee. Still unverified: row 6's HTTP-token TLS, DNS-rebinding and private-peer cases, row 2's recorded operator-form browser receipt, and the remaining foreign-frame/race cases. Private ADR-0027 targets stay unavailable to `vault_request`. Choices the text left open are in the implementation note at the end.
Builds on: ADR-0002 (tool approvals), ADR-0004 (shared workspace), ADR-0006 (operator authentication), ADR-0012/0013 (connector credentials), ADR-0020 (egress), ADR-0027 (private HTTPS targets).

## Context

The owner wants a Vault in each workspace where a person can enter usernames,
passwords and credentials that bots use when they encounter a login or another
authentication requirement. When offered direct secret retrieval or tool-mediated
fill/use, the owner selected the latter: the agent sees credential names and
references; a tool fills the password or supplies the token.

The Gateway already has an AES-256-GCM `SecretsStore`. There is no product Vault
catalog, browser credential-fill command or run-scoped credential-use contract.
Existing connector and integration credentials must keep their current paths;
adding a Vault must not expose them to bots.

This is a workspace resource, shared by its bots. It does not add permissions
between bots. A browser password necessarily reaches the shared browser, where
page scripts and a bot with shell/CDP access may recover it. Tool-mediated use
keeps the normal model/tool transcript free of plaintext; it does not make a
credential used inside the workspace inaccessible to that workspace.

## Decision

1. **A workspace owns the credential catalog.** Each entry has an opaque id,
   workspace id, name, optional non-secret purpose, type, exact HTTPS target
   origin, enabled state, revision and timestamps. Initial types are browser
   login (username and password) and HTTP header token. The username is secret
   payload too: discovery returns only the catalog metadata. Entries are visible
   to all bots in their workspace through a metadata-only tool; another workspace
   cannot discover or use them. There is no per-bot credential ownership policy.

2. **People maintain values through the operator UI.** A workspace Vault page
   supports create, replace, disable and delete. Writes use the existing
   workspace-scoped administrator policy (an Owner or Admin of the workspace,
   ADR-0022 amendment 6; changed on acceptance from the unnamed policy) and
   normal session/CSRF checks.
   Ordinary reads return metadata, never saved values; editing a name leaves
   the value unchanged, and replacing a value is an explicit operation.
   Forms clear secret inputs after submission and never save them to browser
   persistence, URLs, analytics, error reports or chat. Concurrent edits require
   the expected revision. Bots cannot create, edit, reveal or export entries.

3. **Reuse encrypted host storage, not workspace files.** Secret payloads are
   stored through the existing `SecretsStore`, with metadata in a separate
   catalog table. Without a configured encryption key, create/use fails closed.
   The catalog-to-secret binding is checked against the authenticated workspace
   before decryption. A replacement atomically changes the secret reference and
   revision; disable/delete prevents new uses immediately. A use already handed
   to an executor cannot be recalled. Deleted values may remain in historical
   encrypted backups; deletion is not a claim of backup erasure or upstream
   credential revocation. No permanent plaintext copy is written into the
   workspace, an environment variable, a shell command or a process argument.

4. **The agent requests use, never retrieval.** Proposed tools are `vault_list`,
   `vault_fill` and `vault_request`. The latter two carry a credential reference,
   revision and operation parameters, never a password or token. Their internal
   endpoints accept only a live token for that run, derive the workspace from
   the run, and recheck the entry at execution time. Metadata lookup is L0.
   Credential release is L2 by default under ADR-0002. An operator may explicitly
   preauthorize a defined use; simply storing a value is not preauthorization.
   Such a grant binds the credential revision, exact target and operation; a
   broad ordinary tool-name/origin glob alone cannot authorize credential use.
   A changed target, revision or operation requires a fresh matching decision.
   No credential approval grants permission for subsequent purchases, messages,
   data changes or egress widening.
   Added on acceptance (2026-10-17), against the workspace approval mode of
   ADR-0002 amendment 6: a credential release is a credential-bearing action, so
   in `automatic` it always goes to a human and never to the reviewer; in
   `manual` it asks the thread; in `approve_all` it is allowed by the mode and
   recorded as `mode:approve_all`, like every gated action there, and the Vault
   page says so when the workspace is in that mode. The exact-origin and
   revision checks of decisions 4 and 5 are not approvals and hold in every mode.

5. **Browser fill is a fixed execution command.** `vault_fill` names the current
   run's tab, target frame and username/password field references. The Gateway
   checks the run and the browser admission/takeover state before decrypting.
   It invokes a fixed, preinstalled sidecar command through `SandboxProvider`;
   bounded secret input is sent through stdin, never a shell string. The command
   attaches to the existing workspace Chromium and rechecks actual top-level
   and frame origins immediately before filling. Both must equal the entry's
   exact origin; cross-origin login frames and SSO require a separately bound
   credential. Stale fields, navigation or takeover invalidate the operation;
   neither the tool nor its retry navigates to another target. Passwords are
   filled only into password inputs. The result is a fixed status without
   values, page text, a snapshot or a screenshot. Fill does not submit a form;
   submission uses the existing browser tools and their approval rules. Filling
   can itself expose the secret to page JavaScript, so origin checking applies
   before fill, not merely before submission. The browser helper is execution
   plumbing, not another reasoning agent or a browser per bot.

6. **Token use is a bounded host-side request.** `vault_request` refers to an
   operator-maintained request definition: exact HTTPS origin, HTTP method,
   route, allowed parameter schema, credential header and declared effect tier.
   The model supplies permitted parameters, not a destination URL, header name,
   executable command or arbitrary header collection. The host inserts a Bearer
   or named API-key header after validation. No token goes in a URL or into the
   workspace. The request also passes the workspace egress policy and transport
   address checks; it cannot inherit the host's broader private-network access.
   Only public HTTPS or an explicitly configured ADR-0027 private HTTPS target
   is eligible, with normal TLS verification, peer pinning where required, and
   no redirect following. A private target stays unavailable until the host-side
   adapter has demonstrated equivalent enforcement. A request definition is L2
   unless its read-only semantics are explicitly classified; GET alone does not
   prove read-only. An uncertain write is not automatically retried. Repeated
   use requests carry a durable run/attempt/tool-call identity; recorded results
   are reused, and an interrupted in-flight operation is reported as unknown,
   never silently re-executed. This is a small credential-backed HTTP surface,
   not a second SaaS action catalog. Existing connectors/integrations stay on
   their own credential paths.

7. **Normal outputs do not carry secrets.** Audit records include the credential
   id/revision, workspace, bot, run, operation, target, approval/grant and bounded
   outcome, never values. Operator request bodies and executor stdin are excluded
   from request logging and error serialization. Vault-use tools enter SDK
   transcripts with references only. HTTP response headers containing credentials
   or cookies are not returned; bounded response bodies are untrusted, and known
   plaintext credential echoes must be removed before reaching any transcript,
   ledger or learned memory. An unsafe result is withheld. The browser path must
   test the ordinary later snapshot and screenshot paths too: suppress or mask
   credential-bearing captures before storing/forwarding them. Regexes and exact
   value scrubbing do not guarantee protection against a malicious page that
   encodes, transforms or renders a secret. That limitation is visible in the
   product boundary, not concealed by a passing canary test.

8. **Stored, attempted and authenticated are different states.** The UI shows
   configured/enabled state and the last use time/outcome. A successful fill
   means only that the fields were filled, not that login succeeded. Login success
   needs a subsequent page observation; HTTP success needs the operation's
   response semantics. Auth failures, missing fields, target mismatch, MFA and
   unknown outcomes are distinct from an empty Vault. MFA/passkey/CAPTCHA uses
   existing human takeover rather than new bypass or OTP-storage machinery.
   An account rejection is not silently retried with other entries. Cookie
   expiry does not erase the stored credential, and deleting a Vault entry does
   not log the browser out or invalidate an upstream token.

9. **The shared-workspace boundary remains explicit.** All bots in a workspace
   may use the same enabled credentials, subject to their target and action
   approvals. A browser-filled value and the resulting session can be recovered
   by code running in that workspace; this proposal does not promise otherwise.
   Production credentials belong in a separate, appropriately locked workspace,
   not the default open untrusted-browsing workspace. The feature does not
   weaken the grouping rule. Enforced inability for a hostile bot to recover a
   browser credential would require a different execution boundary and its own
   architecture decision.

10. **Preserve existing credential systems and keep the first scope bounded.**
    Connector service credentials, integration OAuth grants and model upstream
    keys are never included in the Vault discovery API or migrated into it.
    Initial scope excludes raw-secret reads, shell/environment injection,
    arbitrary files, SSH keys, certificates, TOTP seeds, passkeys, shared vaults
    across workspaces and automated password rotation. HTTP header tokens are
    covered only by decision 6, not unrestricted command-line use. The Vault is
    a distinct product module backed by the existing encrypted store; an external
    vault service is not required for this first implementation.

## Proposed contract and implementation order

These names describe the intended shape, not existing callable APIs:

- Operator catalog: `/api/workspaces/:workspaceId/vault`, with individual entry
  routes for metadata update, explicit value replacement, disable and delete.
- Run discovery/use: `/internal/runs/:runId/vault/*`; no raw-value read route.
- Gateway feature: `src/vault/`, its route policy and route module.
- Web feature: `src/features/vault/`, discovered by the existing registries.
- Contracts: metadata, references, bounded use requests and typed outcomes.
- Browser execution: a fixed command of the preinstalled sidecar binary.

Implement the catalog and browser login path first, including refusal paths and
output-leakage checks. Then implement bounded token-backed HTTP requests. A UI
that saves a token without a working use path must label it unavailable for use;
storage alone is not completion of the owner request. Add the migration at UTC
authoring time and after every migration on main (ADR-0030), not at design time.

## Verification

The rows below are required checks; the status and dated receipts distinguish
implemented tests from executed runtime evidence. Tests use synthetic secrets only.

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | Bots in one workspace list/use the same metadata; another workspace cannot see an entry or its username | T1 proposed `gateway/src/vault/scope.test.ts`, metadata canaries in API responses | Cross-workspace disclosures, target 0 |
| 2 | Only the scoped operator policy mutates; reads omit values; form persistence, CSRF and stale edits are checked | T1 proposed `api/vault-routes.test.ts`; Web feature tests; actual browser flow under `spikes/` with a recorded receipt | none |
| 3 | Missing key refuses writes; DB dump has no plaintext; references/revisions update atomically; disabled or stale uses fail | T1 proposed `vault/store.test.ts`, reuse existing SecretsStore tests; synthetic value scan | Plaintext persistent copies, target 0 |
| 4 | Run tokens cannot cross scope; target/revision/operation mismatch invalidates grants; saving alone gives no use grant | T1 proposed `vault/use.test.ts`; sidecar hook tests including broad Always-rule refusal and resume | Unapproved releases, target 0 |
| 5 | Actual shared browser is filled through fixed stdin command; takeover, wrong origin/frame, navigation and stale fields refuse; result contains no value | T2 proposed `acceptance/m4-vault-browser.container.test.ts` with a synthetic HTTPS fixture and actual SDK; live browser receipt under `docs/design/` | Wrong-target fills, target 0 |
| 6 | Fixed request definition, address validation, egress, TLS, redirect refusal, header injection and unknown-outcome handling all hold; no duplicate write after interruption | T1 proposed `vault/http-use.test.ts`; T2 owned HTTP/TLS fixture, rebinding/private-peer cases; exact call-count oracle | Duplicate writes and unauthorized targets, target 0 |
| 7 | Synthetic plaintext canaries are absent from operator logs, SDK transcripts, ledger, memory, response echoes and captured images in supported flows | T1 proposed `vault/redaction.test.ts`; T2 full-path browser/HTTP canary audit including screenshot inspection; record transformed-echo limitations rather than claiming universal secrecy | Observed normal-path plaintext leaks, target 0 |
| 8 | Filled is not logged-in; provider auth error/MFA/unknown remain distinct; deletion does not claim logout | T1 typed outcome tests; actual browser negative and takeover cases; UI state tests | False success claims, target 0 |
| 9 | Same-workspace sharing remains; documentation/UI describe recoverability and preserve production-workspace grouping | T1 scope tests, existing architecture boundary tests, review of UI/help text | none |
| 10 | Discovery excludes existing service credentials; no reveal/export/shell-injection API is introduced | T0 proposed Vault contract/route inventory invariants; T1 connector/integration regression tests | none |

## Consequences

- The owner's selected behavior is explicit: references and mediated use, not
  plaintext secret retrieval by the model.
- On acceptance this extends design v0.3 section 3.8: user-entered Vault browser
  passwords are encrypted on the host and transiently used in the workspace;
  cookies continue to live in the shared browser profile. It does not relocate
  connector/OAuth/model credentials or add security boundaries between bots.
- Ordinary login becomes possible without asking the user to type a password in
  chat, while MFA and other interactive authentication can still require takeover.
- Browser admission, redaction, screenshots, unknown external outcomes and
  operator-grant matching are part of this feature, not optional later cleanup.
- Acceptance of the detailed proposal and passing implementation/runtime checks
  remain separate. No source implementation, deployment or live credential use
  is performed by this design change.

## Implementation note (2026-10-17)

Where the tests are, by Verification row: 1 and 9 `gateway/src/vault/scope.test.ts`; 2
`gateway/src/api/vault-routes.test.ts` and `web/src/features/vault/vault.test.tsx`; 3
`gateway/src/vault/store.test.ts`; 4 `gateway/src/vault/use.test.ts`,
`contracts/src/vault.test.ts` and `sidecar/src/vault-tools.test.ts`; 5
`sidecar/src/vault-fill.test.ts` (T0/T1) and `acceptance/m4-vault-browser.container.test.ts`
(T2, five cases passed 2026-10-19; limits in the linked browser receipt); 6 `gateway/src/vault/http-use.test.ts`; 7 `gateway/src/vault/redaction.test.ts`
and `sidecar/src/vault-capture.test.ts`; 8 `gateway/src/vault/use.test.ts`; 10
`contracts/src/vault.test.ts` and `gateway/src/api/vault-routes.test.ts`. Operator reference:
`packages/gateway/docs/vault.md`.

Choices the decisions left open, for review:

- One `revision` counter moves on every change: name, purpose, origin, enabled state, value and
  request definitions. Any change therefore invalidates pending grants and Always rules; a model
  holding an old revision is told to list again.
- Both release tools are L2 for every entry and definition, a definition classified `read`
  included. Decision 6's declared effect decides whether an interrupted call reports `unknown`
  (write) or a network error (read), and is shown on the approval card; it lowers no tier.
- The explicit preauthorization of decision 4 is a person's Always answer on a release's approval
  card, stored as the exact matcher (tool, entry origin, `vault:<id> rev:<n> op:<operation>`).
  There is no separate preauthorization screen; a rule typed with a wider scope is refused
  (`rule_vault_not_exact`), and a broad deny rule still applies.
- "Always goes to a human" in `automatic` is read strictly: besides skipping the reviewer, a
  teammate bot's `approval_decide` on a release is refused there (`vault_human_only`). In `manual`
  a teammate may decide it as any other request (ADR-0002 amendment 2, a soft boundary).
- Field references are CSS selectors, optional: without them the command takes the one visible
  password input and the last visible text, e-mail or telephone input before it. A Playwright MCP
  snapshot `ref` belongs to that MCP session and cannot be resolved by a separate CDP client.
- An entry's origin must be an exact `https://` origin on a public hostname; LAN login pages and
  ADR-0027 private targets are not supported. `vault_request` refuses a host outside the
  workspace egress list instead of opening an egress ask.
- Capture suppression masks text-field values (textbox, searchbox, combobox, spinbutton lines of
  the accessibility snapshot), replaces images and withholds page-code output in browser-proxy
  results, and writes no run screenshot, while the run's tab shows the filled page. It does not
  cover the opt-in `browser_cli_workflow` captures or the desktop tools.
- No system-prompt text was added: a prompt change is a strategy change (AGENTS.md). Bots learn
  the tools from their descriptions; whether they use `vault_fill` at a login page, and do not
  ask for a password in chat instead, is unmeasured.

# Workspace credential vault (ADR-0045)

A Vault holds the credentials a workspace's bots use through references. A person enters a value
on the Vault page; a bot sees names, purposes, types, exact origins and revisions (`vault_list`)
and asks for a use: `vault_fill` fills a browser login into the run's own tab, `vault_request`
runs one operator-defined HTTP request with a token. No route or tool returns a saved value.

The Vault is a workspace resource, shared by all its bots. It is **not** a boundary between them:
a password filled into the shared browser, and the session it opens, can be read by page scripts
and by any code in the workspace with shell or CDP access. Tool-mediated use keeps the normal
model transcript, ledger, chats and screenshots free of plaintext; it does not make a credential
used inside the workspace inaccessible to that workspace (decision 9). Production credentials go
in a separate, locked workspace, never in an open untrusted-browsing one (ADR-0010).

## Storage (decisions 1 to 3)

- `vault_entries` holds metadata: name, purpose, type (`browser_login`, `http_header_token`),
  exact HTTPS origin on a public hostname, enabled state, `revision` and timestamps. The value is
  one AES-256-GCM blob in `secrets`, owned by the entry's workspace (`owner_kind = 'workspace'`);
  the username is part of the blob.
- Without `GATEWAY_SECRETS_KEY` the page says the Vault is unavailable and a create or
  replacement fails closed (`details.reason: "vault_unavailable"`).
- Every change needs `expectedRevision` and bumps the revision; a stale one is 409
  `stale_revision`. A replacement writes a new blob, repoints the entry and deletes the old blob
  in one transaction. Deleting an entry or its workspace deletes its blob (a trigger). A
  historical backup may still hold the encrypted copy; deletion neither signs the browser out nor
  revokes anything at the service.
- The one decryption checks the entry's workspace, enabled state and revision, and that the
  secret row is owned by that workspace, before it decrypts.
- Connector credentials, integration grants and model keys are never listed or migrated
  (decision 10).

## Operator routes (decision 2)

| Route | Role |
|---|---|
| `GET /api/workspaces/:id/vault` | Member: `{vault: {available, approvalMode, entries}}`, metadata only |
| `POST /api/workspaces/:id/vault` | Owner or Admin: create, with `username`/`password` or `token` |
| `PATCH /api/workspaces/:id/vault/:entryId` | Owner or Admin: name, purpose, origin, `enabled` |
| `PUT /api/workspaces/:id/vault/:entryId/value` | Owner or Admin: the explicit value replacement |
| `PUT /api/workspaces/:id/vault/:entryId/requests` | Owner or Admin: a token's request definitions |
| `DELETE /api/workspaces/:id/vault/:entryId?expectedRevision=` | Owner or Admin |

Session writes carry the normal CSRF check. A refusal names the field, never the value. The audit
record (`vault.entry_create`, `vault.entry_update`, `vault.value_replace`, `vault.requests_set`,
`vault.entry_delete`) holds metadata and revisions only.

## Run routes and tools (decisions 4 to 8)

`/internal/runs/:runId/vault/entries`, `.../entries/:entryId`, `.../fill` and `.../request`
accept only that run's live token; the workspace comes from the run. The tools are offered only
to a bot's run (never a Gateway job) in a workspace with at least one usable entry.

- `vault_list` is L0.
- `vault_fill` and `vault_request` release a credential: L2, never lowered by a tier override.
  The hook builds the approval's action from the Gateway's entry: target the entry's exact
  origin, dimension `vault:<id> rev:<n> op:fill` or `op:request:<definition>`. The Gateway uses
  only an approval of the same run, decided allow, for that exact action, and spends it once
  (`vault_uses.approval_id` is unique). Storing a value grants nothing.
- Approval modes (ADR-0002 amendment 6): `automatic` never sends a release to the reviewer, and a
  teammate bot's `approval_decide` is refused there (`refusal: vault_human_only`): a person
  decides. `manual` asks the thread as for any request. `approve_all` allows it and records
  `mode:approve_all`; the Vault page says so. The origin and revision checks are not approvals
  and hold in every mode. An allow rule answers a release only when it binds the tool, the exact
  origin and the exact dimension; Always stores exactly that, and a widened scope is refused
  (`rule_vault_not_exact`). A new revision needs a fresh decision.
- A fill checks the run, the human takeover state and the run's tab lease, then runs the fixed
  `deskmates-sidecar vault-fill` through the sandbox provider with the value on stdin only. The
  command attaches to the workspace Chromium, rechecks the top-level and frame origins and the URL
  immediately before filling, fills a password only into a password input, never navigates or
  submits, and prints only a status. A takeover during the fill turns the outcome into `takeover`.
- A request uses the operator's definition: method, route with `{param}` placeholders, allowed
  parameters, credential header and declared effect. The token is inserted last; the host must be
  on the workspace egress list and resolve to public addresses only (the connection is pinned to
  them); redirects are refused; TLS is verified normally. Private targets, ADR-0027's included,
  are unavailable. A body that echoes the token in a known form is withheld; no response header
  is returned. Nothing is retried; a write interrupted after sending is `unknown`.
- Every use is one `vault_uses` row with its typed status and the answer the tool got. A repeat
  with the same approval returns the recorded answer; a row left `in_flight` by a stopped Gateway
  becomes `unknown`, never a second execution.
- Outcomes are typed (`VAULT_USE_STATUSES`): `filled` means the fields were filled, not that a
  sign-in worked; one-time codes, passkeys and CAPTCHAs need a human takeover.

## Capture suppression (decision 7)

After a fill the run marks its tab (a file next to its browser state: tab id, URL, time; no
value). While the tab shows that page the browser proxy masks text-field values in snapshots,
replaces images with a notice, withholds page-code output and writes no run screenshot; the mark
ends when the tab leaves the page. This covers the ordinary paths only: a page that encodes,
transforms or renders the value is not recognized, and code in the workspace can read the shared
browser directly.

## Not verified here

The T2 `acceptance/m4-vault-browser.container.test.ts` (real Chromium, no model) and the full
path with the real SDK, a synthetic HTTPS origin, takeover during a live fill and screenshot
inspection have not run; see the status line of ADR-0045.

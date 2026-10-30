# Vault browser full-path T2 receipt

Date: 2026-10-19
Scope: the three browser TODOs of `acceptance/m4-vault-browser.container.test.ts`,
ADR-0045 decisions 5 and 7, and the browser part of issue #3. Actual Gateway,
DockerProvider, shared Chromium, MCP and Agent SDK 0.3.278; scripted Messages
upstream, synthetic credentials, no generative model or real account.

## Result

All five cases passed in the final source run: test time 43.52 seconds, total
45.50 seconds. The preceding run passed the same five behavior cases in
45.57 seconds; the final source additionally audits the SDK transcript and
learned-memory files for plaintext canaries. No product change was needed.

| Case | Actual observation |
|---|---|
| Fixed helper | The workspace's shared Chromium is filled by `deskmates-sidecar vault-fill`, with synthetic values arriving on stdin and only `{"status":"filled"}` returned. |
| Wrong target | The helper returns `target_mismatch` and leaves both fields empty on an origin mismatch. |
| SDK through Gateway | The real SDK calls the offered `vault_fill` MCP tool after navigating to the exact synthetic HTTPS origin. The hook binds the reference/revision/target; the Gateway invokes the fixed command. The browser independently reports a secure context and both expected field values. The form remains on `/login`; fill is not claimed as authentication. |
| Takeover and navigation | A real operator takeover during the provider's in-flight fixed-command execution changes the Gateway's epoch and produces typed `takeover`, not `filled`. A separate real-CDP interleave changes the document hash between the production helper's frame lookup and its fill function; the helper returns `navigated`, and both fields remain empty. |
| Normal output paths | Subsequent real MCP snapshot, explicit PNG screenshot and a page-changing key action run on the filled page. Snapshot values are masked, image output is replaced with the Vault notice, and no post-fill automatic screenshot reaches the ledger. Outbound model bodies, the run ledger, actual SDK files and learned-memory outputs contain neither plaintext canary. At least one SDK file exists, so the file audit is not vacuous. |

The takeover case starts the real provider execution before calling the real
operator takeover route and awaits both; it does not simulate a helper status.
As ADR-0045 decision 3 states, a secret already handed to execution cannot be
recalled. The result `takeover` invalidates success; it does not prove that no
value ever reached the page during that race.

The navigation case uses the production `vaultFill` and `cdpFillDeps` from the
pinned image, with one test-only scheduling interleave on the actual browser.
It is a same-document hash navigation. It does not establish the typed outcome
of every cross-document or cross-frame navigation race.

## HTTPS and isolation

The test creates a temporary self-signed fixture CA/certificate with a SAN for
`vault.example.test`, imports it with `certutil` into a fresh NSS database, and
copies that database into its newly created workspace container. Only that
container's entrypoint gains an exact fixture-host resolver mapping to
loopback and an exact fixture-host proxy bypass. Its HTTPS server chooses an
ephemeral container-local port. The owned container restarts before any test
run begins, retaining its single shared Chromium/profile.

TLS certificate verification remains enabled. A separate Playwright
navigation in the same Chromium verifies the HTTPS fixture before the SDK
case, and the SDK's browser navigation succeeds normally. No
`ignoreHTTPSErrors`, `--ignore-certificate-errors`, TLS-error callback or
network-response fabrication is used. This fixture is a browser-fill check;
its local resolver/proxy exception is not an egress-enforcement acceptance
claim.

The full-path test selects `approve_all` only for its newly created isolated
workspace. The Gateway still binds the credential revision, target, operation
and live run. Real account approval/MFA and human account setup were not used.
The isolated Gateway chooses ephemeral ports and a temporary SQLite database;
its workspace/container/network/volume identities are new. The test never
uses the stable database or changes the stable Gateway configuration.
Teardown removes only the resources the suite created. The final full-path
workspace's exact-label post-teardown audit found zero containers, networks
and volumes.

## Reproduction and provenance

Private lab material: **2026-10-19 Vault browser full-path T2**. It holds the
exact runner, raw logs for all attempts, the source inventory/hashes and the
exact-label cleanup receipt. Generated fixture keys and trust databases are
test-owned temporary material, not user credentials. The runner uses only
preinstalled dependencies and does not download anything inside a sandbox.

Workspace image:
`sha256:91fe465705fbb425f6c12ac1feae6296921be565e8c483e47e2f60e8f84ad996`.
Egress proxy image:
`sha256:0acc3f7b6dbeeaa10d25d7adc94c155a7eac573eae172558ce7562a483d04446`.
These are the release workspace/proxy images present on the test host; the
test-specific TLS fixture is installed only into the new container's writable
layer, not a release image or the stable service's workspace.

Final source SHA-256:

- `acceptance/m4-vault-browser.container.test.ts`:
  `6317749b55b0eac32cff0e8bf6b2e9c28c8cc1dfed957f682430fb5f19ecefdc`.
- `acceptance/vault-browser-fixture.ts`:
  `b6ec434e8bc42ca908ceca02ba78c4abcb2da47a1f82621e1466498b9bc010f8`.

The execution is the ordinary Vitest T2 file with the two image IDs pinned
through `WORKSPACE_IMAGE` and `EGRESS_PROXY_IMAGE`. The HTTPS fixture additionally
needs host `openssl` and `certutil`; both were already installed. Local
acceptance typecheck and Biome checks passed.

Earlier attempts are retained, including a test-key encoding error and an
incorrect fixture resolver rule that produced `ERR_NAME_NOT_RESOLVED`. In the
DNS attempt the Vault hook correctly refused the non-target browser tab; no
credential was released. Those attempts do not count as acceptance passes.

## Limits and still-open work

The normal screenshot path is protected here by withholding the image, so
there is no post-fill captured image to inspect or pass to the model. This
receipt does not claim that text matching detects an encoded, transformed or
arbitrarily rendered secret on a malicious page. Browser state remains
recoverable by code in the shared workspace, as ADR-0045 decision 9 specifies.
The opt-in browser CLI workflow and native desktop paths are outside the
Vault capture guard and outside this receipt.

This completes the three browser TODOs in this T2 file. It does not complete
the whole Vault ADR: the browser operator-form receipt, every foreign-frame
case, live HTTP-token TLS/rebinding/private-peer cases, real provider login
semantics and interactive authentication require their own evidence. No real
model behavior, account login or paid campaign was measured here.

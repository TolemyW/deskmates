# ADR-0013: SaaS integrations come from an integration runtime behind the Gateway

Date: 2026-09-29
Status: Proposed (drafted for the product owner; narrows ADR-0012 to receipted execution; refines design v0.3 §3.8 "MCP service")
Source: product owner direction on 2026-09-29 ("we have no resources to develop and test all of these interfaces"), the library evaluation recorded in this ADR's Context, and the spike it orders (`spikes/openconnector/`).

## Context

Design §3.8 gives connectors the shape "MCP service registered in the Gateway registry; the workspace gets an MCP endpoint and a short-lived token". ADR-0012 replaced that, for connectors, with a Gateway-mediated validate/submit/receipt contract. Both leave every integration to be written by us: an MCP server per service, or a service implementing five HTTP endpoints. With Slack, Google Drive and the rest of the SaaS surface ahead, that is work this project cannot staff, and each hand-written integration is also an untested one.

Two distinct needs were conflated in ADR-0012. Receipted execution (a bot-authored batch that must be validated, hashed, executed exactly once and receipted) is a narrow need that the VendorDB campaigns exposed. Ordinary SaaS actions (post a message, list files, create an issue) are a broad need that the field has already packaged.

### Library evaluation (2026-09-29)

Candidates were screened for: self-hosted with credentials on our host, open-source runtime, a prebuilt action catalog with OAuth handled, an MCP or HTTP surface an agent can call, and Node/TypeScript operability. Figures come from the GitHub API and from cloning and running the two finalists on 2026-09-29.

| Candidate | License | Verdict | Why |
|---|---|---|---|
| OpenConnector (oomol-lab) | Apache-2.0 | **Selected for the spike** | 1,589 providers with a uniform `ActionDefinition` carrying `operationType: read / write / destructive` (1,553 declare it); MCP surface is five meta-tools (`list_apps`, `list_connections`, `search_actions`, `get_action_guide`, `execute_action`), so a run never sees thousands of tools; AES-256-GCM credential store; 27 mainstream runtime deps; no telemetry found; core + OAuth + server + Slack + Drive tests ran locally, 984 of 992 passing with the 8 misses explained by skipped codegen and one PGlite flake. Risks: three months old (created 2026-06-29), long-tail providers are AI-generated with tests for about 11% of them, backed by one company (OOMOL Lab, four employees are half the commits). |
| Executor (UsefulSoftwareCo) | MIT | Rejected | 80% of 2,936 commits by one person; in a 2.0 beta rewrite (five betas in one week); no prebuilt catalog (bring OpenAPI/MCP); telemetry on by default for self-host; cloud-first (WorkOS, Autumn). |
| Nango | Elastic 2.0 | Rejected for this need | Most mature OAuth layer, but the free self-hosted edition excludes MCP, tool calling and prebuilt tools. Candidate for OAuth only if the selected runtime's OAuth proves weak. |
| Docker MCP Gateway | MIT | Rejected | Docker-backed, but the secrets engine is Docker Desktop only and the catalog's Slack server is archived. |
| Klavis | Apache-2.0 | Rejected | No push since 2026-06-01. |
| Composio, Arcade | SDK open, runtime not | Rejected | Credentials pass through, or auth depends on, the vendor cloud. |
| ToolHive, IBM ContextForge | Apache-2.0 | Not needed | Gateways without a catalog; they solve a problem the Gateway already solves. |

The evaluation is a snapshot; decision 8 keeps it revisitable.

## Definitions

- **Integration runtime**: the separately deployed open-source service that holds the provider catalog, runs OAuth and executes actions. OpenConnector at first; replaceable.
- **Action**: one operation of one provider in the runtime's catalog, identified by `<service>.<name>`, carrying `operationType`.
- **Connection**: the runtime's record of one authorised account for one provider (an OAuth grant or an API key).
- **Meta-tools**: the runtime's five agent-facing operations. The Gateway depends on their names and shapes and on `operationType`, and on nothing else in the runtime.

## Decision

1. **The integration runtime is a deployed service, not a dependency.** It runs as its own container next to the Gateway, pinned by image digest in the deployment, on a network only the Gateway can reach. No package of ours imports it; no workspace can reach it. Its own admin UI, if exposed, is on the operator side only.

2. **The dependency surface is the five meta-tools and `operationType`.** The Gateway module `packages/gateway/src/integrations/` is the only code that knows the runtime's HTTP or MCP shape. Replacing the runtime means replacing that module and writing a new ADR; nothing in contracts, the sidecar or the web changes except the ADR reference.

3. **Connections are scoped to a workspace.** Every connection the Gateway creates in the runtime is tagged with the workspace it belongs to; `list_connections` and `execute_action` for a run are filtered to that workspace's connections, and a run naming another workspace's connection is refused. Within a workspace every bot may use every connection: this is the design's soft boundary, not access control between bots.

4. **Credentials never enter a workspace.** OAuth tokens and API keys live only in the runtime's encrypted store on the host. An operator starts an OAuth grant from the Deskmates UI through a Gateway route that begins the runtime's flow and receives its callback; the resulting connection is tagged per item 3. The sandbox environment and the start request carry no runtime URL, token or connection secret.

5. **A run reaches the runtime only through the Gateway.** The sidecar offers five in-process tools, `integration_apps`, `integration_connections`, `integration_search`, `integration_guide` and `integration_execute`, which call `/internal/runs/:id/integrations/*` with the run token; the Gateway forwards to the runtime with the workspace filter applied. Results enter model context wrapped as untrusted external output; the ledger keeps the raw result. The run's tool list gains these tools only when the workspace has at least one connection.

6. **The risk tier of `integration_execute` follows the catalog, resolved by the Gateway.** Before the `PreToolUse` hook decides, it asks the Gateway for the action's `operationType`: `read` is L0; `write` is L2, because a SaaS write is an external side effect and usually not reversible; `destructive` is L2 and cannot be lowered. An operator may lower a specific `write` action to L1 in the registry when its effect is reversible in that deployment (a file created in a scratch folder). An Always rule may match `integration:<service> action:<id>`. The approval request carries service, action id, connection name and the action's description, never the input body.

7. **Every call is attributed in the ledger.** The `tool_call` and `tool_result` events carry service, action id, connection name and `operationType`; `integration_execute` also carries the runtime's execution id when it returns one. Attribution is by run and bot, a soft boundary.

8. **The runtime is pinned and upgraded like Playwright.** The deployment records the image digest; an upgrade passes a T2 smoke (an OAuth token refresh, one `read` action and one `write` action on a test account per adopted provider) before the digest changes. A provider is "adopted" when its smoke exists; only adopted providers are offered to runs by default.

9. **ADR-0012 is narrowed to receipted execution.** Its validate/submit/receipt contract, registry, receipts and idempotency stay for connectors whose submissions must execute exactly once with an authoritative receipt (database batches). Ordinary SaaS actions go through this ADR. A receipted connector may itself be implemented as an action of the runtime later; that is not decided here.

## Alternatives

- Write our own MCP servers per service: rejected by the owner; no capacity, and untested code per API.
- Attach the runtime's MCP endpoint directly to the sidecar with a token: rejected; the token and endpoint would sit in the workspace, and results would bypass the untrusted wrapper and the ledger attribution.
- Import the runtime as a library into the Gateway: rejected; 1.35 million lines of generated provider code inside our process, and no clean way to swap it.
- Choose Nango for OAuth plus our own actions: rejected for now; it reintroduces per-action development. Kept as the fallback if the spike shows the selected runtime's OAuth is not usable in our topology.

## Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | The runtime container is on the Gateway's network only; a workspace container cannot open a TCP connection to it; no package.json in `packages/` names it | T2 `acceptance/m3-integrations.container.test.ts` (connection refused from the workspace); T0 static check over `packages/*/package.json` | none |
| 2 | Only `packages/gateway/src/integrations/` references the runtime's routes or tool names; a fake runtime in `testkit` implementing the five meta-tools passes the same Gateway tests | T0 static grep test; T1 `integrations/runtime-adapter.test.ts` against the fake | none |
| 3 | A run in workspace A cannot list or execute with a connection tagged workspace B; both are refused with a typed error | T1 `integrations/workspace-scope.test.ts` | cross-workspace executions, exactly 0 |
| 4 | The sandbox env and start request contain no runtime URL, token or connection secret; the OAuth callback route stores nothing but the connection id and workspace tag in the Gateway database | T1 `integrations/oauth-routes.test.ts`; extension of the sidecar start-request test; "database dump contains no secret" test extended | none |
| 5 | The five tools exist only when the workspace has a connection; every result is wrapped as untrusted in model context and raw in the ledger; the run token reaches only its own run's routes | T0 `packages/sidecar/src/integration-tools.test.ts`; `operator-auth.test.ts` extension | none |
| 6 | Tier table holds for read/write/destructive; an override cannot lower destructive; the approval request carries no input body | T0 `risk-tier.test.ts` extension; T1 hook test with the fake Gateway; `approval-docs.test.ts` extension | L2 approvals per integration run (reported) |
| 7 | Ledger events carry the named fields; a count of executions from the ledger equals the fake runtime's log | T1 `integrations/attribution.test.ts` | unattributed executions, exactly 0 |
| 8 | The deployment manifest names the digest; the T2 smoke exists per adopted provider and is run by the upgrade runbook | Runbook step plus `acceptance/m3-integrations.container.test.ts`; the smoke itself is T3 on Testbox | smoke pass per provider per upgrade |
| 9 | Not machine-checked: ADR-0012's Status line says "narrowed by ADR-0013" | reviewer reads it | none |

## Spike questions this ADR depends on (`spikes/openconnector/`)

1. Token cost of the five meta-tools' descriptions and of a typical `search_actions` result in model context.
2. Whether connections can be tagged or namespaced per workspace in the runtime, or whether the Gateway must keep the mapping itself.
3. Whether the runtime's OAuth flow works with the callback URL our deployment exposes, for Slack and Google Drive test apps.
4. Five common actions each for Slack and Google Drive executed end to end; `operationType` correctness for those ten.
5. Whether `get_action_guide` output is usable as the approval request's description, or needs trimming.

## Amendment 1 (2026-09-29): what the spike settled

`docs/design/openconnector-spike-2026-09-29.md` ran OpenConnector v1.7.0 (digest `sha256:55b1c424…`) on an isolated network with a fetch-only MCP client and a mocked provider. It changes or fixes the following, without altering the numbered decisions:

- **Item 3, scoping mechanism.** The runtime has no tenant or tag field on a connection. It does enforce per-token `allowedConnections`, refusing a cross-scope execute with `connection_not_allowed` before any credential is read. So the Gateway keeps the workspace-to-connection table itself and holds one runtime token per workspace whose grant list it rewrites whole on every change; every execute passes an explicit connection name. The runtime's no-auth "virtual" providers are outside the grant model and are hidden unless adopted.
- **Item 5, result shaping.** Raw `search_actions` returns 20 results at roughly 3,600 to 9,500 tokens; `list_apps` without a query is about 101k tokens. The Gateway always passes a service, caps results at 5, re-encodes as compact JSON and lists only adopted providers, so a search costs about 1,600 tokens and the five tool definitions about 1,200. Provider text reached model context verbatim, including a forged closing tag, which confirms the wrapper.
- **Item 6, never-lowerable writes.** `googledrive.permissions.create` and `permissions.update` are `write` in the catalog but can share with anyone or transfer ownership; the registry marks them as not lowerable to L1, and the same list is reviewed per adopted provider. The approval request carries the catalog description (20 to 131 characters), `operationType` and `requiredScopes`, not `get_action_guide`, which is 1.2k to 4k characters of agent-facing text. Open: an approver cannot see which file or channel a delete or share affects without an input excerpt; decided when the first write action is adopted.
- **Item 4, OAuth shape.** Callback is the runtime's `<origin>/oauth/callback` or a per-app `redirectUri`; the Gateway route forwards `code` and `state` to the runtime, matching item 4 as written. Slack uses the user-token flow (actions run as the consenting human); a bot identity is an API-key connection. Google Drive needs `access_type=offline&prompt=consent`.
- **Item 1, deployment facts.** The runtime answers `/mcp` and `/v1` without authentication until the first runtime token exists, so the deployment creates the token before the container is reachable. The admin UI shares the API process and port and is separable only by network. Files an action downloads come back as a runtime URL that needs no token, so the Gateway fetches such files into the workspace itself. No outbound call left the host except to the mocked provider.
- Catalog size at v1.7.0 is 1,566 providers and 18,320 actions.

Still pending on the owner: Slack and Google OAuth apps, the grants and token refresh, the ten listed actions on test accounts, upload and download through transit storage, and provider traffic through the managed egress proxy.

## Consequences

- The Gateway gains an `integrations` module and OAuth start/callback routes; the sidecar gains five tools; `testkit` gains a fake runtime; the deployment gains one container and a digest to pin.
- Slack as a *channel* (humans messaging bots from Slack, `packages/channels`) is unchanged by this ADR and stays deferred; Slack as an *integration* (bots acting on Slack) comes through the runtime.
- The long tail of the runtime's catalog is not trusted by default: only adopted providers with a smoke are offered.
- Open: whether receipted execution (ADR-0012) should later be expressed as an action family of the runtime, so the Gateway has one integration path instead of two.

## Amendment 2 (2026-10-05): Drive acceptance proposal preview

Owner direction for the M4 integration acceptance slice supersedes item 6's
blanket exclusion of proposed input for Google Drive. A Drive L2 approval now
includes the proposed target (`fileId`, `parents`, `name`) and up to 4,096
characters of redacted outgoing parameters/content. A separate target summary
is bounded per field; truncation is explicit. Binary content is represented by
byte count and SHA-256. These are proposed action facts, never provider output.
The existing sidecar redactor and Gateway approval scrubber still apply. The
operator card renders the preview as text, never HTML. Other providers retain
the existing summary-only behavior. An Always rule remains provider/action-wide;
it is not a folder-scoped authorization. The dedicated-folder trial must use
Allow once, with no lowering override or matching Always rule.

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| A2 | Drive target and outgoing text are visible, bounded and redacted; denial prevents execution | `packages/sidecar/src/integration-approval-preview.test.ts`, `integration-tools.test.ts` | Drive writes executed after deny: 0 |
| A2 UI | Actual approval card shows target and outgoing content as inert text, marks truncation | `packages/web/src/features/approvals/integration-approval-preview.test.tsx` | none |
| A2 binding | Fake action parameters/scopes match the saved v1.7.0 guides; mismatched service/action and RPC identities are refused | `packages/gateway/src/integrations/drive-catalog-binding.test.ts`, `runtime-adapter.test.ts` | accepted identity mismatches: 0 |
| A3 catalog | The catalog is read through `list_apps` under the Gateway's own inert runtime token (`deskmates-catalog`, `allowedActions: ["none.none"]`, sentinel connection), minted once on the first catalog read, kept in `secrets` under owner kind `gateway`, re-minted once when the runtime no longer knows it; the admin `GET /v1/providers` is used only while the runtime has no token; a catalog the Gateway cannot read is reported as `complete: false`, never as empty | T1 `packages/gateway/src/integrations/provider-catalog.test.ts` against the fake runtime, whose `/v1/providers` refuses the admin token once a token exists as v1.7.0 does; the live 2026-10-09 probe on a throwaway v1.7.0 container is recorded below | catalog reads that fell back or failed (reported) |

This amendment does not adopt Drive on a real deployment or authorize a Google
grant. The offline harness and remaining real gates are recorded in
`docs/runbooks/m4-drive-integration-readiness-2026-10-05.md`.

## Amendment 3 (2026-10-09): the catalog is read with a runtime token

The stable deployment showed an empty Apps list with "the runtime's full list could not be read". The Gateway read the catalog with `GET /v1/providers` under the admin token, the one call the spike had not exercised. A throwaway OpenConnector v1.7.0 container on the test host showed the rule: until the first runtime token exists, `/v1/providers` and the MCP `list_apps` answer anyone, admin token included; once any runtime token exists (the stable deployment has the runbook's `bootstrap-lock`), both want a runtime ("local") token and the admin token gets `401 unauthorized: A valid local bearer token is required`. `GET /v1/providers/<service>/setup` keeps working with the admin token, so adopting by name was never affected.

Decision: the Gateway holds one inert runtime token of its own, `deskmates-catalog`, with the bootstrap lock's policy (`allowedActions: ["none.none"]`, the sentinel connection id, so it can execute nothing), minted on the first catalog read, stored in `secrets` under the new owner kind `gateway` (migration 0035) with the runtime's id in `integration_catalog_token`. The catalog is `list_apps {}` under that token: 1,566 entries, about 700 KB, read per operator request and never shaped into model context (`integration_apps` keeps listing adopted providers only). A token the runtime no longer knows is minted again once; the admin list remains the fallback for a runtime with no token at all. Minting also closes the runtime's unauthenticated window on deployments that skipped the runbook's bootstrap step. Verification row A3.

# Integrations and connectors

What it is: ways for a workspace's bots to reach systems beyond the browser, without the
credentials ever entering the workspace. A run gets an action, not a key. There are two kinds:

- **Apps** (SaaS integrations such as Google Drive) go through an integration runtime, a separate
  service next to the Gateway that holds the provider catalog, runs OAuth and stores the tokens.
- **Databases** are receipted connectors: every submission is validated, run once and receipted.
  The first one is `connector-postgres`, for one PostgreSQL-protocol database.

Where you find it: **Integrations** in the sidebar, for the current workspace. It has three
groups: Apps, Databases and Channels (see [Channels](channels.md)).

## Apps

If the Gateway has no integration runtime configured (`INTEGRATION_RUNTIME_URL`), the Apps group
says so and lists nothing. With one, every provider it knows appears.

1. A platform maintainer **adopts** a provider. Only adopted providers are offered to runs by
   default.
2. An Admin or Owner **connects an account** for this workspace: **Connect with OAuth** (needs the
   Gateway's public callback URL) or an API key, under a connection name. They also revoke it.
3. Bots in the workspace can then list connections, look up actions and execute them.

Reading is L0 and runs without asking. A write or destructive action is L2 and asks in the chat;
the approval shows a preview of what will be sent (see [Approvals](approvals.md)). A platform
maintainer may lower a specific reversible write to L1; a destructive action cannot be lowered.

Connections belong to one workspace. A run cannot use another workspace's connection.

## Databases

An Admin or Owner presses **Register a database** and gives the connector's name, URL and a
credential. The Gateway keeps both in its secrets store; the workspace never receives them. A bot
names the connector in its connectors list to use it.

A bot works with a database in steps: describe what the connector supports, validate a
submission, submit the validated content, then read its status and receipt. Submitting is bound
to a recent validation of the same content and is idempotent: a repeat with the same key returns
the existing receipt and executes nothing. The risk tier follows the validated effect: a read is
L0, a reversible change L1, an external effect L2 and asks.

## What this cannot do

- Within a workspace every bot may use every connection and every registered connector. The
  connectors list on a bot is a prompt-level choice, not access control. This is the design's soft
  boundary, not access control between bots. Put a credential that some bots must not use in a
  second workspace.
- Credentials never enter a workspace, but what a bot reads through an integration does: results
  come back into the shared computer's context like any other untrusted content.
- Receipts and validation prove what was submitted and what the connector reported. They do not
  prove the result was correct.
- A real SaaS provider is not yet accepted. Google Drive was selected as the first provider; its
  live account, folder and OAuth grant have not been authorized, and only offline checks have run
  (see the [M4 status ledger](../design/m4-status-2026-10-04.md) and the
  [Drive readiness note](../runbooks/m4-drive-integration-readiness-2026-10-05.md)). Treat Apps
  as a preview.
- ADR-0012 (connectors) and ADR-0013 (integration runtime) are proposed, not accepted:
  [ADR-0012](../adr/0012-connector-execution-contract.md),
  [ADR-0013](../adr/0013-saas-integrations-through-an-integration-runtime.md).

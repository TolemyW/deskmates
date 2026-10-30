# Connections

What it is: how people reach a workspace's bots, and what the bots can use beyond the browser,
without credentials ever entering the workspace. A run gets an action, not a key.

Where you find it: **Connections** in the sidebar, under Resources, for the current workspace
(the former **Integrations**; old links open its Apps tab). It has three tabs, each with a count of
what is connected:

- **Chat channels**: Telegram, WhatsApp, Slack and Discord. See [Chat channels](channels.md).
- **Apps**: services such as Gmail, GitHub or Notion that bots use through an integration runtime,
  a separate service next to the Gateway that holds the provider catalog, runs OAuth and stores
  the tokens.
- **Databases** (Tune view): receipted connectors. Every submission is validated, run once and
  receipted. The first one is `connector-postgres`, for one PostgreSQL-protocol database.

Members see every tab and what is connected; Owners and Admins connect and revoke. Guests do not
see Connections.

## Apps

The integration runtime can offer hundreds of apps, so the tab is built around what you came to
do:

- **In use**, at the top: each app this workspace has connected, with its number of accounts, how
  many bots may use it, and **Add account**. **Connected accounts** below it lists each account (for example `slack/team`)
  with **Revoke**. Bots use a connected app without seeing a key: reading runs without asking;
  anything that changes data asks for approval first and shows a preview of what will be sent (see
  [Approvals](approvals.md)).
- **Search all apps**: type a name (Gmail, GitHub) to find any app the runtime offers, connected,
  ready or not.
- **Ready to connect**: without a search, only apps this installation has enabled and this
  workspace has not connected yet, the release's featured apps first, then A to Z, 24 at a time
  with **Show more**. Category chips (Code, Documents, Communication, Project management, Data,
  Other) show how many apps each holds.

Each card has one action for your role: **Connect** (or **Add account**) for an Owner or Admin, or
none, with a note naming who can. **Connect** asks for a connection name (how bots tell accounts of
one app apart, such as `main` or `sales`), then either **Connect with OAuth**, which continues at
the provider in a new tab and needs the Gateway's public callback URL, or an **API key**, sent once
and never shown again.

An app that is not enabled on this installation shows **Needs the maintainer** and appears only in
search results. Enabling one is the platform maintainer's: in the Tune view they see **Include apps
not enabled on this installation** and **Enable** on such an app. A platform maintainer may also
lower a specific reversible write to L1; a destructive action cannot be lowered.

If the Gateway has no integration runtime (`INTEGRATION_RUNTIME_URL`), the tab says so once and
lists nothing.

Connections belong to one workspace. A run cannot use another workspace's connection.

## Databases

In the Tune view, an Admin or Owner presses **Register a database** and gives the connector's
name, URL and a credential. The Gateway keeps both in its secrets store; the workspace never
receives them. A bot names the connector in its connectors list to use it.

A bot works with a database in steps: describe what the connector supports, validate a
submission, submit the validated content, then read its status and receipt. Submitting is bound
to a recent validation of the same content and is idempotent: a repeat with the same key returns
the existing receipt and executes nothing. The risk tier follows the validated effect: a read is
L0, a reversible change L1, an external effect L2 and asks.

## Vault

The **Vault** page holds credentials the workspace's bots use without seeing them (ADR-0045). An
Owner or Admin adds a browser login (username and password) or an HTTP header token, each bound to
one exact `https://` origin; a token is usable only once a request definition (method, route,
parameters, header, effect) is added. Every Member sees the list, never a value. A bot lists the
entries and asks to fill a login into its own tab on that origin, or to run a defined request;
each use asks for approval: a person in **Automatic** mode, the chat in **Manual** mode, and no one
in **Approve all**, which the page says. A fill only fills the fields: the bot then submits with
the browser tools, and a one-time code or CAPTCHA still needs someone to take over the browser.

The Vault is shared by every bot of the workspace and is not private inside it: a password filled
into the shared browser, and its session, can be read by code running in that workspace. Keep
production credentials in a separate, locked workspace.

## What this cannot do

- By default every bot of a workspace may use every connected app; an Owner or Admin can limit a
  bot to some apps (see [Bots](bots.md#apps-this-bot-may-use)). That limits the bot's own calls,
  not what a teammate it asks can do. Every registered database connector is open to every bot;
  the connectors list on a bot is a prompt-level choice, not access control. Put a credential
  that some bots must never reach in a second workspace.
- The Apps list is ordered by the release's featured apps and the alphabet, not by what your
  team uses most; there is no recommendation.
- Credentials never enter a workspace, but what a bot reads through an integration does: results
  come back into the shared computer's context like any other untrusted content.
- Receipts and validation prove what was submitted and what the connector reported. They do not
  prove the result was correct.
- A real SaaS provider is not yet accepted. Google Drive was selected as the first provider; its
  live account, folder and OAuth grant have not been authorized, and only offline checks have run
  (see the [M4 status ledger](../design/m4-status-2026-10-04.md) and the
  [Drive readiness note](../runbooks/m4-drive-integration-readiness-2026-10-05.md)). Treat Apps
  as a preview.
- The Connections layout was checked with the bundled demo, not with real providers.
- [ADR-0013](../adr/0013-saas-integrations-through-an-integration-runtime.md) (integration
  runtime) is accepted as a design, but no provider is accepted until its live checks pass.
  [ADR-0012](../adr/0012-connector-execution-contract.md) (receipted connectors) is accepted.

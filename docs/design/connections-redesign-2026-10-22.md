# Connections: apps, chat channels and databases — redesign proposal, 2026-10-22

Status: accepted by the owner, 2026-10-22 ("用 Connections，Chat channels 放前面，然后全部做完吧"):
the name is Connections, Chat channels come first, and phases 1 and 2 are built. The owner also
asked how a large app catalog should be shown, from how people use it; that is the section "Apps
at scale" below. Question 3 (Members connecting channels) was not answered, so connecting stays
an Admin's or Owner's, as today. Phase 2's contract is
[ADR-0047 amendment 2](../adr/0047-per-connection-channel-identity-and-first-wave-providers.md#amendment-2-2026-10-22-a-setup-guide-in-the-manifest).

Trigger: the owner reported that "Integrations" is incomplete: Apps appear to be gone, and
Channels has no explanation or link, so nobody can tell how to connect anything. The owner asked
for a redesign informed by open-source Grok-bot-like projects.

## What a person meets today

Read from main at `b1a77d8` and the bundled demo (1280 × 900, Tune view).

1. **No entry in the everyday view.** Integrations is a System link with `audience: "tune"`
   (`features/integrations/feature.tsx`), so since the Use/Tune split (`b6f6aed`, 2026-10-19) a
   person in the default Use view has no way to find apps or channels. This is the "Apps are
   gone" report: the screen still exists, but only in Tune.
2. **Apps lead with an operator concept.** The catalog is "adopt one, then connect an account".
   Adopting is the platform maintainer's (`integration.adopt`, role `platform`); a workspace
   Admin sees Adopt buttons or a "not available on this server" note without knowing who can act.
   When `INTEGRATION_RUNTIME_URL` is unset, which is the stable default, the Apps section is an
   empty explanation. The page is one long scroll: Featured, the full catalog, Connected
   accounts, Databases, then Channels at the very end (2,072 px in the demo).
3. **Channels give no setup path.** Each method has one prose `description` and bare fields
   (`ChannelConnectionMethod` in `contracts/src/channel.ts`). Telegram says "Create a bot with
   @BotFather" with no link; Slack packs scopes, Socket Mode, events and two tokens into one
   paragraph; the older section prints a README path as code (`integrations.channels.steps`).
   There is no "open the bot in Telegram" link after connecting, no copyable Slack app
   manifest, and no statement up front of which bot will answer.
4. **Channels cannot be reviewed offline.** The demo Gateway has no channel routes, so the
   Channels section shows "Channel status could not be loaded" in every screenshot and UI check.
5. **Words collide.** "Apps" means SaaS integrations on Integrations and published web apps in
   workspace settings and Files (ADR-0035). "Connectors" (a bot's free-text list),
   "Databases", "Integrations" and "Channels" name overlapping things.
6. **The manual is behind.** `docs/guide/channels.md` still describes a separate WhatsApp
   service the operator starts with environment variables; channels have been connected from
   this page since ADR-0017 amendment 1 and ADR-0047 (Telegram, Slack, Discord, WhatsApp).

## Patterns from comparable open-source projects

Source review, 2026-10-22, from the projects' GitHub sources (their documentation sites were
not reachable through this environment's egress proxy, so only repository files were read).
Items not confirmed in source are left out.

| Project | Where it lives | What is worth taking |
| --- | --- | --- |
| OpenClaw (`ui/src/pages/channels/view.tsx`, `view.detail.tsx`, `hub-meta.ts`) | Settings › Connections › Channels; MCP under Agents | "Connected" with a count and refresh, then "Add"; rows show status chips (Running, Configured, Attention) and "last message N ago"; setup in a modal with a docs link built from the channel id; WhatsApp QR with Regenerate and "Link later"; a detail view with last probe, last error and a Probe button. Its sidebar "Apps" is a downloads page: the same word collision we have. |
| LobeHub (`docs/usage/channels/telegram.mdx`, `docs/usage/agent/connectors.mdx`) | A Channels tab on each agent; connectors from the composer's + | Telegram in six steps: BotFather, paste token, save (webhook registered for you), Test Connection, message the bot. States plainly that installing, authorizing and enabling for an agent are separate steps. |
| nanobot (`webui/src/i18n/locales/en/common.json`, `nanobot/channels/*/webui/`) | Sidebar Apps ("connect tools") and Channels | Each channel ships its own setup module with a `docsUrl` and an official link ("Open BotFather"); statuses Connected, Not verified, Needs setup, Connection failed, Manual setup; fields grouped into Credentials, Connection, Access, Behavior. |
| Chatwoot (`InboxChannels.vue`, `FinishSetup.vue`) | Settings › Inboxes | A four-step stepper whose third step is choosing who answers; a finish page with copyable webhook URL and token and a `t.me`/`wa.me` QR code to start a chat at once. |
| n8n (`CredentialConfig.vue`) | Credentials modal | "Need help filling out these fields? Read our docs" per credential; copyable OAuth redirect URL with the instruction where to paste it; "Connection tested successfully" or "Couldn't connect", Retry; "Connected as {account}"; a stale state for a link whose last test failed. |
| Dify (`web/app/components/integrations/routes.ts`, `(commonLayout)/tools/page.tsx`) | One `/integrations/*` area | Models, tools, MCP and data sources under one hub; the old `/tools` address redirects; empty states name the next action ("Add an MCP server"). |
| LibreChat (`MCPServerCard.tsx`, `features/mcp.mdx`) | Side panel MCP settings | Six explicit server states including "OAuth Required"; per-agent tool switches. Its dot-only status relies on aria labels: an example to avoid. |

Patterns adopted below: one hub with plainly named tabs; old addresses keep working;
connected-first then add; a small fixed set of states, each with a one-line reason and the last
check; a per-channel guided dialog with official links, copyable values, a test and a finish step
that opens the new chat; who answers chosen inside setup, not after. Anti-patterns avoided: the
same feature in several unlinked places, setup that only works from a terminal, unexplained
status dots, and listing what cannot be set up without saying so.

## Proposal

### Information architecture

- One navigation entry, **Connections**, in the Resources group of the Use view, after Files,
  readable by Members (`integrations.read` is already `member`); Guests do not see it. Resources
  rather than Work: a connection is set up once and then used through chats and bots, so it does
  not belong in the daily work loop of Chats, Tasks, Approvals, Bots and Board. Old
  `#/integrations` links keep working.
- Three tabs, each with "Connected" first and "Add" second:
  - **Chat channels**: talk to your bots from Telegram, WhatsApp, Slack or Discord.
  - **Apps**: let bots use Gmail, GitHub, Notion and other services.
  - **Databases** (Tune view): receipted connectors.
- Published web apps (ADR-0035) keep their place in Files and workspace settings and are renamed
  **Shared apps** wherever they appear, so "Apps" means one thing.
- A bot's profile shows, read-only in the Use view, where it can be reached ("Telegram
  @galaxy_ops_bot") and which app connections its workspace has, linking to Connections.

### Apps at scale: how people use the catalog

The integration runtime's catalog can hold hundreds of providers (OpenConnector lists about
1,600). A grid of all of them answers no question anyone asks. The page is built around the four
reasons people open it:

| Who, why | What they need first | How the tab serves it |
| --- | --- | --- |
| Anyone: "what can our bots use?" | The apps already connected, with account names | **In use** at the top: one row per connected app with its accounts, and for Admins Add account and Revoke |
| An Admin: "let the bots work with Gmail" | To find one named app fast | A search box that is focused first and matches name and service id over the whole catalog, with instant results |
| An Admin: "what could help?" | A short, actionable list | **Ready to connect**: only apps this installation has enabled, the release's featured apps first, then A–Z, with category chips that show counts and hide empty categories, 24 at a time with **Show more** |
| The maintainer: "enable a provider" | The whole catalog | In the Tune view, **All apps**, which adds the providers not yet enabled, each with **Enable** |

Rules that follow from that: an app nobody here can connect never fills the default list (it
appears only in search results and in All apps, marked **Needs the maintainer**); every card has
exactly one primary action for the viewer's role, or none with a note naming who can act; a
connected app says how bots use it (read actions run without asking, writes ask for approval);
and with no integration runtime the tab says once what is missing instead of rendering an empty
catalog. Featured apps are an ordering, not a separate section, so an app never appears twice.

### Apps tab

- Cards with logo, one-line purpose and a status chip: Connected (with account names), Ready to
  connect, or Needs the maintainer.
- A workspace Admin presses **Connect** on a ready app: OAuth or API key in one dialog, then the
  account appears under Connected with Revoke. Members see status and a note naming who can
  connect.
- Adopting is moved out of the everyday flow: a platform maintainer sees **Enable for this
  installation** in the Tune view; everyone else sees "Needs the maintainer" instead of an Adopt
  button they cannot use.
- When no integration runtime is configured, the tab says once, for every role, what is missing
  and links to the runbook section; it does not render an empty catalog.

### Chat channels tab

A guided dialog per provider, replacing the bare form:

1. **Who answers.** Pick the bot; the workspace's default bot is preselected (ADR-0051
   decision 9). Each connection is one account answered by one bot (ADR-0047 decisions 3 to 5).
2. **Set up on the provider.** Numbered steps with external links that open in a new tab (for
   example BotFather, the Slack app console, the Discord developer portal, WhatsApp Linked
   devices), copy buttons for values the provider needs (a Slack app manifest, the Cloud API
   webhook URL and verify token), and per-field help ("Where do I find this?").
3. **Connect and verify.** Connect runs the provider's identity check; the dialog shows the
   verified account ("@galaxy_ops_bot"), or the QR code for WhatsApp, or the provider's error in
   plain words with what to do.
4. **Try it.** Where the provider allows it, an **Open in Telegram** (or Slack, Discord) link and
   QR code for the verified account, so a person can message the bot from a phone at once, and
   **Send test** where `testMessage` is available. The dialog ends by saying where the
   conversations appear (Chats, read-only mirror) and how approvals work there, with **Go to
   Chats**.

The tab and each channel card have **Guide**, which opens that provider's section of the bundled
manual (`docs/guide/channels.md#telegram` and so on), so the help matches the installed release and
needs no network. It is outside the setup dialog, so opening it never discards typed credentials.

Connected channels list each account, the answering bot, its state from a fixed set (Connected,
Connecting, Needs attention, Stopped) with the plain-language explanation that exists today and
when it was last checked, and the actions that exist today (switch bot, replace
credentials, blocklist, disconnect).

### Contract change for phase 2 (needs an ADR-0047 amendment)

Add an optional `setup` to `ChannelConnectionMethod`, release-bundled with the plugin like the
rest of the manifest:

```ts
interface ChannelSetupGuide {
  steps: readonly {
    id: string; // stable, so the web can translate `<plugin>.<method>.<id>`
    text: string; // English; plain text, never Markdown or HTML
    link?: { label: string; url: string }; // https only, opened with rel="noopener noreferrer"
    copy?: { label: string; value: string }; // non-secret values only
  }[];
  docsUrl?: string; // https
}
// ChannelConfigField gains `help?: string`; ChannelIdentity gains `openUrl?: string` (https).
```

The Gateway validates the URLs when the plugin loads and passes the guide through unchanged; it
adds no provider-specific branch. The web renders it as text, links and copy buttons, and may
supply translations keyed by step id, falling back to the manifest's English. Secrets are never
a `copy` value.

## Phases

1. **Presentation (no contract change).** Connections in the Use view, three tabs,
   connected-first layout, role-aware states, "Shared apps" rename, demo channel routes and
   fixtures for Telegram, Slack, Discord and WhatsApp, the manual rewritten. Channel guidance
   stays the manifest's description, shown as a separate "How to connect" block.
2. **Guided channel setup.** The ADR-0047 amendment above, the four built-in manifests' guides,
   the dialog, `openUrl` after verification, field help, translations in the five locales.
3. **Later, separately decided.** Per-bot enablement of app connections (today every bot of a
   workspace may use every connection, by design), MCP servers as a third kind, the default bot
   explaining how to connect a channel in chat (a strategy change; secrets are never typed into
   a chat).

## Checks for each phase

- Web tests: navigation in Use for Members and not for Guests; tab state; connected-first order;
  role notes for Member, Admin and platform maintainer; old links redirect.
- Contract tests: manifest URLs are https; a guide with a secret field in `copy` is refused; the
  Gateway passes the guide unchanged and has no provider branch.
- Demo screenshots at 1280 × 800 and 390 × 844 in both themes, including each channel's dialog.
- No real provider account is used; live Telegram, Slack, Discord and WhatsApp acceptance remains
  as pending as it is today.

## Owner decisions, 2026-10-22

1. Navigation name: **Connections**.
2. Tab order: **Chat channels** first, then Apps, then Databases.
3. Members connecting a chat channel: no; connecting stays an Admin's or Owner's (owner,
   2026-10-22, after phase 2: "yes only owner and admin").
4. Build phases 1 and 2 now. Phase 3 items stay separate decisions.
5. Per-bot switches for apps: yes (owner, 2026-10-22); decided and built as
   [ADR-0055](../adr/0055-per-bot-app-access.md). MCP servers remain undecided: the owner asked
   what they would be, and the answer was put to them before anything is designed.

# Deskmates operator guide

This guide is for the person using the Deskmates web UI: signing in, setting up a team of bots,
talking to them, and stepping in when they need a human. It describes what the screens do today.
It is not the design; developers start at [`AGENTS.md`](../../AGENTS.md).

Deskmates runs named bots on a shared computer. A group of bots lives in one workspace: one
sandboxed computer with one browser, one filesystem and one shell, shared the way coworkers share
a machine. A thin control plane, the Gateway, schedules their work, asks a human before risky
actions, and records every run.

## Pages

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Sign in, the sidebar, Preferences, Use and Tune, roles in brief, your first workspace, the assistant and your first chat |
| [Workspaces and the shared computer](workspaces.md) | The workspace directory and settings, what bots in a workspace share, screens and takeover, which sites they may reach, files, the board, Knowledge, Skills and Computer, Trash |
| [Bots](bots.md) | The Bots list, the default bot, a bot's profile, instructions (SOUL), notes and experience, model, schedules, activity |
| [Chats and groups](chats-and-groups.md) | Private chats and groups, mentions, the chat owner, what chat history shows in Use and Tune, handoffs, failures, turn limits, runs |
| [Tasks](tasks.md) | Tracking work: states, owner, blockers, delivery and human acceptance |
| [Approvals](approvals.md) | What needs a human, the workspace's approval mode, Allow once / Always / Deny, new-site asks, the Approvals screen |
| [Connections](integrations-and-connectors.md) | Chat channels, apps through the integration runtime and how a large catalog is listed, registered databases, the Vault |
| [Chat channels](channels.md) | Talking to bots from Telegram, WhatsApp, Slack or Discord: guided setup, management, approvals |
| [Costs](costs.md) | What bots spent, how it is priced, cost alerts |
| [People and roles](people-and-roles.md) | Owner, Admin, Member and Guest in each workspace; private chats; invitations; your account |
| [Using Deskmates from another agent](using-deskmates-from-another-agent.md) | The `deskmates-agent-mcp` server for external agents |

Every page ends with a **What this cannot do** section. Read it before you rely on a feature for
anything that matters: several boundaries in Deskmates are deliberate soft distinctions, not
security boundaries.

## Where to find help in the app

- **Help** in the sidebar footer opens this guide inside Deskmates. The guide is bundled with each
  release of the web UI, so it describes the installed version and needs no GitHub access. **Back
  to work** closes it and leaves your chat, unsent message and scroll position as they were.
- **This screen**, at the top of the manual's topics, opens the page for the screen you were on.
- **About**, at the end of the topics, shows the running release and the guide's build, and links
  to the source code and issue tracker on GitHub.
- Empty lists say what to do next and which role may do it.

## Status

Deskmates is in milestone M4. Several features described here are merged and tested offline but
still wait for acceptance on a real deployment (visual review, real model, real SaaS provider,
live WhatsApp, the multi-tenant gates). Pages say so where it applies. The current evidence is in
the [M4 status ledger](../design/m4-status-2026-10-04.md).

## For the person who runs the deployment

Installing, upgrading and maintaining a Gateway is not covered here. See the runbooks:

- [Stable release](../runbooks/stable-release.md): install, upgrade, roll back, first Owner.
- [Multi-tenant operation](../runbooks/multi-tenant.md): tenants, SSO, backup and restore.
- [WhatsApp QR onboarding](../runbooks/whatsapp-qr-onboarding.md): linking a phone.

This guide is written in English and is the source for any later translation.

# ADR-0055: Per-bot app access: a bot may be limited to some of its workspace's connected apps

Date: 2026-10-22
Status: Accepted (owner answer of 2026-10-22 on the Connections redesign: "yes" to per-bot switches for apps). Decisions 1 to 6 are the engineering decisions that carry that answer. Implemented with T0/T1 tests for every Verification row; not exercised with a real provider.
Builds on: ADR-0004 (one workspace, shared everything; no access control between bots), ADR-0013 (SaaS integrations through the integration runtime), ADR-0038 (the directory guard, the one earlier owner-decided exception), ADR-0043 (bot fields editable after creation), [the Connections redesign](../design/connections-redesign-2026-10-22.md).

## Context

ADR-0013 lets every bot of a workspace use every app account the workspace connected: the five integration tools are offered to any run whose workspace has a usable connection, and the Gateway forwards a run's call with the workspace's runtime token. The only per-bot choice was a bot's connectors list, which is a prompt-level hint for receipted databases (ADR-0012).

Connecting an account is often meant for one job. A team that connects Gmail for its assistant does not mean the researcher, which reads untrusted pages all day, to be offered Gmail's send actions. The owner asked for per-bot switches. AGENTS.md forbids access control between bots unless an ADR decides it; ADR-0038 is the precedent for a narrow, owner-decided exception that is explicit about what it does not protect.

An app call is unlike a file or the browser: its credential never enters the workspace (ADR-0013), so a bot can only reach an app through the Gateway's integration routes with its own run token. A Gateway check there is therefore effective for that bot's own tool calls. It is still not isolation between bots: a bot that may not use an app can ask a teammate that may (`message_bot`, a mention), and everything an allowed bot reads through the app lands on the shared computer.

## Decision

1. **A bot's app access is "all apps" or a list of services.** A bot has `integrationApps`, absent meaning every app the workspace has connected (the default, and every existing bot), or a list of integration service ids (`gmail`, `github`), possibly empty. Stored as `bots.integration_apps_json` (NULL for all), migration `202610221437-bot-integration-apps.sql`. A service id must be a valid runtime service id; it need not be connected yet, so an Owner or Admin can allow an app before connecting it. Deleting or revoking a connection does not change the list.

2. **Only an Owner or Admin changes it**, through `PATCH /api/bots/:id` with `integrationApps: string[] | null` (`null` resets to all apps), under the existing `bot.configure` role action. The workspace's default bot cannot change it (ADR-0051 decision 3 keeps tools and access with a person). The change is audited like other bot updates.

3. **Frozen on the run.** When a run's first process starts, the Gateway writes `runs.config_json.integrationApps`: `"all"` or the bot's list at that moment. A resume or continuation keeps the frozen value, like every other knob (AGENTS.md: a saved change never reaches a run already going). A run without the key, from before this ADR, has all apps.

4. **What a limited run sees and may do.** The integration tools are offered only when the workspace has a usable connection of an app the run may use. `integration_apps` and `integration_connections` list only those apps. `integration_search`, `integration_guide`, the tier lookup and `integration_execute` refuse any other service before the runtime is asked, with `forbidden`, `details.reason` `app_not_enabled_for_bot` and the service, and the refusal is recorded like any failed integration call. Risk tiers and approvals are unchanged for the apps a bot may use.

5. **A soft distinction, said so.** This limits which apps a bot's own tool calls reach. It is not a security boundary between bots: a teammate that may use the app can be asked to act, and results are shared on the workspace's computer. The UI and the manual say this. Anything that must not reach an app account at all goes in a second workspace, as before.

6. **Where people set it.** A bot's Settings has **Apps this bot may use**: "All connected apps" or "Only these", with one switch per connected or enabled app; it is shown in the everyday view. Connections › Apps shows, for each app in use, how many bots may use it. Nothing else changes: the connectors list (ADR-0012) stays as it is.

## Alternatives considered

- **Per-app lists of bots.** The same data seen from the app; it makes a new bot's default unclear and splits one bot's tools across many records. Per-bot keeps the bot profile as the one place that says what a bot can do, and the Apps tab shows the reverse view.
- **A prompt-level hint only, like the connectors list.** Cheaper, but the bot could still call the app; the owner asked for a switch, and the app credential path makes a real check cheap.
- **A second workspace per app.** Already possible and still the answer for a hard boundary; too heavy for "only the assistant reads my calendar".

## Consequences

- `packages/contracts`: `BotDefinition.integrationApps`, the reason `APP_NOT_ENABLED_FOR_BOT`.
- `packages/gateway`: the column and its store, the patch field, the freeze helper, the filter in `IntegrationService`, the tool offer in `sidecarToolsFor`'s caller.
- `packages/web`: the bot Settings section and the count on the Apps tab; strings in five locales.
- Every run started after this records `integrationApps` in `config_json`, so a comparison can pair on it.

## Verification

| Decision | Means | Test | Metric |
| --- | --- | --- | --- |
| 1 | a new bot has no list (all apps); a list of service ids is stored and read back; an invalid id is refused; null resets to all | T1 `packages/gateway/src/integrations/bot-app-scope.test.ts` | bots with a limited list |
| 2 | an Admin's patch changes it and is audited; the patch is `bot.configure`, an Admin's; the default bot's routes refuse every field they do not name | T1 `packages/gateway/src/integrations/bot-app-scope.test.ts`; T1 `packages/gateway/src/api/workspace-roles.test.ts` (bot patches by workspace role); T1 `packages/gateway/src/default-bot/default-bot.test.ts` (unnamed fields refused) | none |
| 3 | attempt 1 freezes the bot's value; a later change does not reach a resumed run; a run without the key has all apps | T1 same file | runs with `integrationApps` absent after this ADR (target 0) |
| 4 | a limited run lists only its apps and is refused another app's search, guide and execute with `app_not_enabled_for_bot` before the runtime is called; a run allowed no connected app is not offered the tools | T1 same file | refusals by reason |
| 5 | the bot Settings section and the manual say it is not a boundary between bots | T0 `packages/web/src/features/contacts/bot-apps.test.tsx`; reviewers read `docs/guide/bots.md` | none |
| 6 | an Admin switches to Only these and saves the chosen services; a Member sees the setting read-only; the Apps tab shows how many bots may use each app | T0 `bot-apps.test.tsx`; T0 `packages/web/src/features/integrations/apps-tab.test.tsx` | none |

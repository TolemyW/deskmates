# Product-managed chat channels (issue #43)

Connections › Chat channels (`#/connections/channels`, `src/features/integrations/channels-tab.tsx`,
the first tab since 2026-10-22) renders release-bundled `ChannelPlugin` manifests from the Gateway.
It has no provider import or provider-specific branch: it renders the declared methods, fields,
capabilities and, since ADR-0047 amendment 2, each method's setup guide, and calls the generic
channel connect/command APIs.

The tab lists connected accounts first (account, answering bot, state with its one-line reason,
the account's open link from the method's `open` template, **Manage**), then one card per plugin
with its capability matrix, **Connect** and **Guide** (the manual's section, opened through the
shell's `openGuide`). **Connect** opens `ChannelSetupDialog` (`channel-setup.tsx`): who answers
(the workspace's default bot preselected), the method's numbered steps with links and copy values
(`{webhookPath}` filled by `channel-guide.ts`) and field help linked by `aria-describedby`, then
connect and try it, following the new connection in the tab's three-second refresh, including a
WhatsApp QR. Typed credentials live only in the dialog's state. Translations of manifest text use
`channelGuide.*` keys outside English and fall back to the manifest (`useGuideText`). **Manage**
opens the single-account card (`ChannelCard`: QR, webhook path, test, relink) or one account of a
multi-account plugin (`ConnectionItem`: rebind, replace credentials), each with the blocklist.
Dialogs here have no Radix trigger, so focus is returned to the opening button explicitly.

Plugin phases map to localized states in `channel-state.ts`; anything the page does not recognise
counts as disconnected, so it never claims a connection it has not seen. Raw plugin messages and
load failures sit behind **Technical details**. "Test message sent" appears only after the test
command succeeds. The demo Gateway serves a copy of the release manifests (`demo-channels.ts`).

A thread owned by an external chat channel (`isChannelMirrorThread`: any channel name other
than `web`; agent-submission `agent:*` threads are not channel names) is a read-only mirror
(ADR-0017 amendment 2). The chat pane shows its history and a "Via <channel>" badge, renders no
composer, member controls or approval buttons, and says replies are sent from that channel.
Approvals in it are decided from Approvals or from the phone. The Gateway refuses a person's post
there with `channel_thread_read_only` as well, so hiding the composer is not the only guard.

## ABI-2 plugins: several connections per provider (ADR-0047)

A plugin whose manifest has `apiVersion: 2` gets `ChannelConnectionsCard`
(`features/integrations/channel-connections.tsx`) instead. It lists every connection of that
plugin in the workspace, each with the verified account label and the bot that answers it, and
renders the manifest's capability matrix row by row (available, off in this version, not
supported) with no provider branch. Owners and Admins can add another connection when the
manifest allows several, reconnect or disconnect one, switch the answering bot (rebind: earlier
conversations stay with the old bot as read-only history and each person is told once), replace
credentials for the same account (relink), and manage the connection's blocklist of provider
sender ids. All of it goes through the connection-addressed routes
`/api/workspaces/:id/channel-connections/:connectionId/...`. The page's own strings are in all five
locales; field labels come from the plugin manifest. Covered by
`channel-connections.test.tsx`.

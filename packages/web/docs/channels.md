# Product-managed chat channels (issue #43)

Integrations renders release-bundled `ChannelPlugin` manifests from the Gateway. The screen has no
WhatsApp transport import or provider-specific lifecycle branch: it renders the declared methods
and fields, localizes stable field keys at the product boundary, and calls the generic channel
connect/command APIs. A workspace can connect one WhatsApp account to one default Bot through QR
or Business Cloud API, see status and the current QR, send a test message, reconnect, relink or
disconnect. QR and Cloud are mutually exclusive until Disconnect. Groups are not offered.

Each card says in ordinary words which of three blocked states it is in, with the action that
applies: the channel runtime is unavailable on this server (Retry; a saved connection is kept),
the workspace is not connected yet (Connect, or add a bot first), or the account is disconnected
(Retry) or unlinked (Link again). Plugin phases are mapped to localized labels; anything the page
does not recognise counts as disconnected, so it never claims a connection it has not seen. Raw
plugin messages and load failures sit behind **Technical details**. "Test message sent" appears
only after the test command succeeds.

A thread owned by an external chat channel (`isChannelMirrorThread`: any channel name other
than `web`; agent-submission `agent:*` threads are not channel names) is a read-only mirror
(ADR-0017 amendment 2). The chat pane shows its history and a "Via <channel>" badge, renders no
composer, member controls or approval buttons, and says replies are sent from that channel.
Approvals in it are decided from Approvals or from the phone. The Gateway refuses a person's post
there with `channel_thread_read_only` as well, so hiding the composer is not the only guard.

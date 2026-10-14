# Channels

What it is: a channel lets people talk to bots from another chat app. Today that app is WhatsApp.
A channel is a service that runs beside the Gateway, not inside a workspace. The Gateway holds
only the link between a chat here and a conversation there.

Where you find it: **Integrations** in the sidebar, group **Channels**, shows the two WhatsApp
options and how each is set up. Messages that arrive through a channel appear as ordinary chats
under **Chats**.

## WhatsApp, linked device (the main path)

This links Deskmates to a WhatsApp number the way WhatsApp Web does, by scanning a QR code. No Meta
business account is needed.

The person who runs the deployment:

1. Picks one workspace and one to six of its bots, and the phone numbers allowed to talk to them.
   An empty list admits nobody.
2. Starts the `deskmates-whatsapp-web` service next to the Gateway with those values and a private
   data directory.
3. Opens its page (through an SSH tunnel or the operator's HTTPS proxy), enters the operator
   token, presses **Connect WhatsApp**, and scans the QR from **WhatsApp > Linked devices > Link a
   device** on the phone.

After that, a direct text message from an allowed number arrives as a chat with the configured
bots; the bots' replies go back to the phone. Mention a bot with `@name` in the text, as in the
web UI. The linked session survives a normal restart of the service. Unlinking on the phone, or
**Log out** on the page, ends it. Steps: [WhatsApp QR onboarding](../runbooks/whatsapp-qr-onboarding.md).

## WhatsApp Business (Cloud API, optional)

A business number through Meta's Cloud API and a public webhook. It needs a WhatsApp Business
account, an app with an access token and a public webhook URL; the `deskmates-whatsapp` service
runs with those values. One sender on one business number is one chat.

## Approvals on the phone

An approval request in a WhatsApp chat is sent to the phone with its id. Reply `approve <id>` or
`deny <id> [reason]`. Only approvals of your own chat can be decided this way. **Always** is not
offered from WhatsApp; use the web UI for that.

## What this cannot do

- Direct text messages and approval replies only. No groups, media, history import, reactions or
  edits; non-text messages get a fixed notice.
- Which bots answer is fixed when the service starts. There is no bot picker on the connection
  page.
- Delivery is at least once and not lossless: a lost acknowledgment can repeat a reply, and the
  incoming queue does not survive a service crash.
- The Cloud API cannot send free-form text outside WhatsApp's 24-hour window; templates are not
  supported.
- The channel service holds the operator token and the WhatsApp session. It must never share a
  directory with a workspace; bots never see it.
- WhatsApp manual acceptance is pending: real-phone link, reply, approval, restart and unlink have
  not been accepted on a stable version (see the [M4 status ledger](../design/m4-status-2026-10-04.md),
  [ADR-0019](../adr/0019-whatsapp-linked-device-qr.md) and
  [ADR-0017](../adr/0017-whatsapp-channel-through-cloud-api.md)).

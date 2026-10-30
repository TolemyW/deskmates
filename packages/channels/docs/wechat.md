# WeChat (development, ABI 2)

Native iLink connection: scan with WeChat, bind the verified account to one Bot, and exchange
private text messages. No OpenClaw installation is needed. One external identity can belong to
only one connection across the installation. Several distinct identities may be connected.

## Build and connect

Live acceptance is pending ([readiness record](../../../docs/design/wechat-native-readiness-2026-10-27.md)).
The regular release manifest excludes WeChat until ADR-0047 gates W1–W8 pass. For an authorized
development account test, build a separate manifest:

```sh
npm run build -w packages/channels
node scripts/write-channel-plugin-manifest.mjs packages/channels/dist --development-wechat
CHANNEL_PLUGIN_MANIFEST="$PWD/packages/channels/dist/channel-plugins.development.json" \
CHANNEL_STATE_DIR="$PWD/data/channels-development" npm run dev:gateway
```

Use a separate development Gateway database/configuration. In **Connections → Chat channels**,
choose **Connect WeChat**, select the Bot, connect, then scan the QR and confirm in WeChat. Send
a private text message to check the response. A workspace Owner or Admin manages the connection.
There is no public webhook or provider token to paste into a form.

## Behavior and limits

- Private text in and text out. Groups and bot echoes are dropped; images, voice, video and files
  get a text-only notice without a download or model run. Mixed text/media posts only the text.
- Each person gets a separate read-only Web mirror. Approvals use `approve <id>` or
  `deny <id> [reason]`; the connection host verifies the sender and thread.
- Admission uses the existing per-connection blocklist. A blocked person gets no reply or notice.
- Replies require that person's inbound context token. No proactive send or test-send button.
  An unavailable context leaves replies queued until another message supplies it. Context expiry
  and quotas are not established by offline tests; failed sends remain queued.
- Inbound IDs and send receipts use the existing host. Delivery is at least once: an acknowledged
  send whose local receipt was lost can repeat. iLink acknowledges a client-generated ID with
  `ret: 0`; these acknowledged client IDs are the stored receipt references, not server IDs.
- Restart/reconnect retains authorization, long-poll cursor and per-thread chunk progress.
  Relink clears credentials/context and asks for another QR, accepting only the original account.
  Rebind keeps authorization but clears old thread/context state; the host fences old runs.
- Expired authorization asks for relink. QR refresh is bounded; additional verification-code
  challenges are explicitly unsupported. Use WeChat's account verification before retrying.
- Disconnect stops polling; the Gateway removes the private state. Revoke the authorization in
  WeChat separately if needed; no upstream logout API is claimed.

`wechat-state.json` is 0600 in the Gateway's 0700 connection directory, outside the bot workspace.
It contains credentials, contexts and cursors; do not copy it into a repository or a transcript.
Public status, identity claims and logs contain no bot token or context token. QR data is
transient and encoded locally. Authenticated HTTP redirects are refused.

The source is `src/wechat/`; only the existing pinned QR encoder is loaded through the provider
dependency registry. The Gateway and browser contain no WeChat transport code.

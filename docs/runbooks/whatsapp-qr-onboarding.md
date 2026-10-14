# WhatsApp QR onboarding

The QR adapter runs on the operator host alongside an isolated test Gateway.
It is not a workspace tool and must never share its session directory with bots.
ADR-0019 records the owner's QR-first choice; ADR-0017 still describes the optional
Cloud API transport. A new configuration file requires no Meta developer assets.

1. Choose an existing test workspace and one to six bots in it. Set its operator
   URL/token, `WHATSAPP_WORKSPACE_ID`, `WHATSAPP_BOT_IDS` and allowed sender phone
   numbers in a private 0600 environment file. Include the linked number itself
   if testing self-chat. Use the actual operator port, not the sandbox port.
2. Choose a unique private data directory and an unused loopback port using
   `WHATSAPP_WEB_DATA_DIR` and `WHATSAPP_WEB_PORT`. Build `packages/channels` and
   run `node --env-file=/absolute/path/whatsapp.env
   packages/channels/dist/whatsapp-web-main.js` from the test checkout.
3. Access the page through an SSH local port forward or operator HTTPS reverse
   proxy; the entire `/` and `/api/*` service must be on the same origin. Preserve
   the Authorization header. Never expose the Gateway sandbox listener or use
   the stable deployment's resources for a test.
4. Enter the operator token in the page, click Connect WhatsApp, and scan using
   WhatsApp's Linked devices menu. The token stays only in page memory; reload
   requires re-entry. QR rotation is normal. Do not log or retain QR material.
   If the server requires a proxy, standard HTTP(S) proxy environment settings
   are honored; `WHATSAPP_WEB_PROXY_URL` selects a dedicated proxy. Keep any
   proxy credentials in the private server environment, never in the page.
5. Send an allowed direct text message and verify its Gateway thread, message and
   run IDs. A bot response must visibly arrive on the phone. Transport send IDs
   alone establish provider acceptance, not phone delivery.
6. Trigger a narrowly scoped test approval; verify its notification and `approve
   <id>`/`deny <id>` decisions in the original thread. Other threads' approvals
   must remain untouched. Do not add an Always rule.
7. Normally stop/restart the service with the same private directory. It should
   restore the linked session without scanning again. Verify another message and
   record attempt/input/output/cache usage for actual model work. Use a fresh
   allowed task, preserve failed/partial runs, and stay within model authorization.
8. Unlink from the phone and verify the page leaves Connected, stops relaying and
   requests relinking. Log out locally to clear the old credentials and Signal
   keys. If the remote logout fails, also remove the device on the phone.

Record exact source/lockfile hashes and service/client versions, account identity
in a suitably private receipt, Gateway IDs, confirmed phone-visible outcomes and
any failure. Never record credentials, Signal keys, raw QR payloads or full
private chats. A no-model socket/QR preflight does not close the live acceptance.

Current boundaries: direct text and approval replies only; an explicit allowlist;
no groups/media/history import, no bot selector on the connection page. Gateway
outage retries are bounded and the inbound queue does not survive service crashes.
The dedicated page is separate from the main React operator UI. No stable release
or service has been upgraded merely by adding this implementation.

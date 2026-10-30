# ADR-0019: WhatsApp linked-device QR onboarding

Date: 2026-10-03
Status: Accepted for implementation by the product owner on 2026-10-03 ("implement QR onboarding first"); live-phone acceptance pending
Supersedes: ADR-0017's Cloud-API-only selection and rejection of a linked-device client. Its Gateway contracts, admission, thread routing and approval semantics remain in force.

2026-10-17 update: [ADR-0017 amendment 3](0017-whatsapp-channel-through-cloud-api.md) replaces
decision 4's explicit allowlist for the release plugin with allow-by-default admission and a
per-connection blocklist (owner ruling). The standalone QR service keeps the allowlist.

## Context

The owner expects an existing WhatsApp account to connect by scanning a QR code,
as with OpenClaw. Requiring a WABA, developer app, access token and public webhook
does not deliver that experience. QR onboarding is an explicit product decision,
not an assertion that linked-device clients are Meta's official Business API.

## Decisions

1. Add an operator-side `deskmates-whatsapp-web` service using a pinned Baileys
   release. Keep the existing Cloud API binary available. The Gateway has no
   WhatsApp vendor dependency or credential, and the service imports no workspace
   package except contracts. Baileys is an unofficial linked-device client;
   protocol compatibility and a real-phone journey require live verification.
2. Serve a dedicated connection page from this service. Its authenticated API
   starts QR login, exposes the current QR and connection status, reconnects and
   logs out. The browser holds its operator credential only in memory; QR data
   is never logged or put in URLs, local storage or the Gateway ledger. Bind to
   loopback by default; use an SSH tunnel or an operator HTTPS proxy remotely.
3. Persist linked-device credentials and Signal keys atomically in an operator
   data directory (0700, files 0600), outside every workspace and source tree.
   A directory ownership lock refuses concurrent services. Preserve the account
   across normal process restarts. Logout stops receiving/relaying first, clears
   the local session and requires a new QR. Never clear a session after a transient
   disconnect. A revoked/bad session requires explicit relinking.
4. Handle only newly notified direct text messages, including self-chat. Ignore
   history sync, groups, broadcasts, status, protocol events and our own outbound
   echoes. Resolve LID addresses only through verified phone-number metadata or
   the client's persisted mapping; never interpret a LID as a phone number.
   A persistent outbound message-ID cache separates self-chat commands from our
   own relays. Admission is the existing explicit phone-number allowlist in both
   directions, and an empty list admits nobody.
5. Reuse channel `whatsapp`, but namespace the external key by linked account
   (`web:<account-number>:<sender-number>`). A different account never inherits
   another account's cursors. Use transport message IDs as Gateway external IDs;
   duplicate events do not create another run. Approval commands can decide only
   the sender's own thread and never create Always rules. Only acknowledge a
   send after the client returns a message ID; an uncertain send can be retried
   and delivery remains at least once, not exactly once.
6. One socket is active per service. Fence callbacks by connection generation,
   serialize incoming work, suppress duplicate connect actions and use bounded
   backoff for transient disconnects. Pairing's restart-required transition
   reconnects with the newly saved credentials. Stop/logout cancels reconnects;
   stale events cannot republish a QR or reconnect a stopped socket. Retrying a
   Gateway outage preserves the same inbound message ID, never posts a new task.
7. Operator startup supplies the existing Gateway operator URL/token, workspace
   and bot IDs, allowed sender numbers and private state directory. This first
   version's page manages login, not dynamic bot reassignment. There is no model
   call on login and no deployment or release implied by this change.

## Verification

| Decision | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | Pinned operator-side client; Gateway has no vendor code and Cloud API remains optional | Package boundary test, pinned lockfile, build; live phone test records actual client version | dependency/version |
| 2 | Authenticated connection page; unauthorized requests disclose no QR | HTTP authentication/Origin/cache tests and connection-page smoke | refused API calls |
| 3 | Private atomic session storage survives restart and refuses concurrent ownership | Real temporary-directory persistence, permissions, corruption, concurrent-lock and logout tests | session restore/reset |
| 4 | Only admitted new direct text is relayed; no inferred phone number from LID | Message fixtures for history, direct/self/group/echo/LID/unsupported inputs | accepted/dropped |
| 5 | Account-scoped relay retains IDs and sender-scoped approvals; uncertain sends remain at least once | Existing relay tests plus QR transport tests for account keys, duplicate IDs, approvals and missing send ID | duplicates/send failures |
| 6 | One socket generation is active; stop/logout fences stale callbacks and retries | Injected socket lifecycle/retry tests including old-generation updates and logout during startup | reconnects |
| 7 | Operator configuration starts the adapter without WABA credentials or model calls | Configuration test with no WABA credentials; runbook and live journey with Gateway run/usage receipts | configured/live/unknown |

Unit/integration tests are prerequisites, not the live WhatsApp acceptance.
The live test must record QR linkage, inbound text, a visible reply, approval,
process restart/resume and phone-side unlink with IDs but no credential material.

Verification clarification (2026-10-04): meaning and executable evidence are
separate columns under ADR-0001. The live-phone acceptance remains pending.

## Amendment 1 (2026-10-11): QR is one method of the in-process channel plugin

ADR-0017 amendment 1 supersedes decisions 1, 2 and 7's separately operated-service shape. The
pinned Baileys runtime is now an official release-bundled plugin loaded through the Gateway's
generic `ChannelPlugin` contract. The generic Integrations UI owns QR display and lifecycle commands;
there is no second QR web application or operator token entry.

The transport invariants in decisions 3 through 6 remain: private atomic linked-device state,
direct newly notified text only, no inferred LID number, account-scoped external keys, idempotent
message IDs, one socket generation and bounded reconnect. Product scope is narrower than the old
startup configuration: one workspace connection chooses one default Bot, and group events are
ignored. QR and Cloud API are mutually exclusive connection methods for that workspace.

The live-phone row remains pending. Loading the plugin in-process does not establish protocol
compatibility, delivery reliability or WhatsApp policy compliance.

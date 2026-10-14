# ADR-0003: Identities own login state; bots borrow browsers through per-grant MCP instances

Date: 2026-09-20
Status: Superseded by ADR-0004 on 2026-09-20
Source: design v0.2.1 revision (C11 to C15) and the review that produced design v0.3

> **Superseded.** The product decision is that a group of bots shares one environment by default, so there is nothing to borrow and no grant to scope. See ADR-0004. The findings below about shared profile volumes remain true and are still the reason a workspace has exactly one Chromium.

## Context

Design v0.2 said both "one bot, one sandbox, login state only on the sandbox volume" and "a human logs in once over noVNC and later bots reuse it". Those contradict each other. The v0.2.1 revision resolved it by making identity a first-class object with its own host container, borrowed over CDP. That revision also proposed a custom CDP proxy for tab assignment and origin filtering, an exclusive-lease mode based on moving profile volumes between containers, and per-origin grants presented as a security mitigation.

## Decision

1. **Login state belongs to an identity, not a bot.** Identities are `private` (profile on the bot's own volume, M0) or `shared` (profile on a dedicated identity host, M2). Bots borrow shared identities through explicit grants.

2. **Sharing is done by borrowing the browser, never by sharing the profile volume.** Chromium's singleton lock and the single-writer Cookies (SQLite) and Local Storage (LevelDB) stores make a shared volume corrupt under concurrent use.

3. **No CDP proxy.** The identity host runs one Playwright MCP instance per grant, HTTP transport, attached to the host's local CDP port with that grant's `--allowed-origins`. The bot's sidecar registers it as a remote MCP server. Bots never see a CDP socket. Tool names carry the identity prefix, so which account a bot is using is explicit in the ledger and in approval rules.

4. **Identity host, grants, leases, and login probing are M2 scope.** M0 requires only that the sidecar's browser endpoint is configuration, so switching to a remote identity later is a config change.

5. **Per-origin grants are an operational control, not a security boundary.** The cookie jar is visible to every tab in the profile and in-page JavaScript can navigate anywhere. The security boundaries are: one identity is one trust domain, and L2 actions inside a shared identity still require approval.

6. **The exclusive-lease-by-volume-switching option is dropped.** Strict sites get an identity-level exclusive lease on the identity host, which the lease model already provides.

7. **One image, two roles.** The identity host runs the same image as a bot sandbox; the sidecar starts in `identity` role and does not run the SDK loop.

8. **Locks are identity × origin, held by the Gateway, acquired by the sidecar's PreToolUse hook.** Human takeover holds an `origin='*'` lease; all borrowers' browser tools return a wait message and screenshots stop.

## Open item

Whether Playwright MCP's `--allowed-origins` filter is page-scoped or context-scoped when several instances share the default context. Spike in the first week of M2. If context-scoped, each grant gets its own context with storageState sync; still no proxy.

## Consequences

- `packages/sidecar` gains an `identity` role and a lease client; `packages/gateway` gains the Identity Registry and four tables.
- `packages/sandbox-docker` provisions identity hosts with the same provider interface as bot sandboxes.
- AGENTS.md rule "one Chromium per sandbox" stays true; "profile lives on the bot's volume" is true only for private identities.

## Verification

None. Superseded; nothing in this ADR is implemented. The only surviving fact, that a Chromium profile cannot be shared between processes, is verified under ADR-0004 item 1.

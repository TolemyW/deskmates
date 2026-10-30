# @deskmates/gateway

The control plane. One Node.js process, two Fastify listeners, one shared service context and
SQLite database. The sandbox listener serves model and sidecar traffic; the operator listener
serves the authenticated HTTP/SSE API and webhooks used by the production UI.

Owns: bot registry, workspace registry (workspaces, browser locks), two-lane run scheduler, approval broker, run ledger, knowledge store (markdown + FTS5), thread router (members, mention wake, relay and turn caps; replaces the bot bus, ADR-0005), secrets store, egress rules, connector hub, cost pricing.

Rules:

- **Never imports the Agent SDK.** Model inference happens only in the sidecar.
- Never stores plaintext passwords, browser cookies, or long-lived upstream model keys in a readable form. Refresh tokens are encrypted with `GATEWAY_SECRETS_KEY`. Workspaces receive short-lived tokens only.
- **Never implements access control between bots in a workspace** (ADR-0004). Bots in one workspace share a browser and a filesystem by design. Isolation is a second workspace, created by an operator.
- Prices tokens itself from a price table. Do not trust `costUSD` reported by the SDK (S0: cost basis is `unknown` for non-Anthropic models).
- Talks to sandboxes only through the `SandboxProvider` interface from `@deskmates/contracts`.
- Every trigger creates a `runs` row before anything else happens.

Layout:

- `migrations/*.sql` — timestamped, forward-only, applied at startup; the first is the schema baseline ([docs/database.md](docs/database.md)).
- `src/api/` — routes. `src/scheduler/` — lanes and queue. `src/approvals/` — broker and rule matching. `src/ledger/` — runs, usage, events, pricing. `src/workspaces/` — registry and the workspace browser lock. `src/knowledge/` — docs and FTS. `src/threads/` — threads, members, messages, mention parsing, wake routing (parallel for mentions, in-turn for `@everyone` / unaddressed), `relay_count` and `turn_budget` caps, wake coalescing, `message_bot` as a `bus` thread. `src/secrets/` — encryption and token issuance. `src/egress/` — allowlists. `src/model-proxy/` — the endpoint a sandbox's `ANTHROPIC_BASE_URL` points at.
- Shared composition points stay small; a domain adds one sorted line, not a block (issue #53). `src/api/route-policies/<domain>.ts` holds each domain's operator route policies, aggregated in `src/api/route-policy.ts` from one sorted list that refuses a route claimed twice. `src/api/routes.ts` registers the operator route families from one sorted list behind the guard. `src/context.ts` (`buildContext`) wires domains together; a domain whose stores are built together has a `create...Module` function next to them (for example `src/threads/thread-module.ts`). `scripts/hotspot-budgets.test.mjs` fails when one of these files grows back.
- `src/triggers/` — the cron runner: the minute timer, the per-minute idempotency key and the overlap skip. Webhook delivery is a route, in `src/api/webhook-routes.ts`.
- `src/index.ts` — `buildGateway(config, provider)` builds the sandbox listener and owns `app.deskmates = {ctx, scheduler, lifecycle, cron}`. `buildOperatorGateway(app.deskmates)` builds the second listener over those exact services; it does not open another database or start another scheduler. The explicit `surface: "combined-test"` fixture registers both route families on one in-process app while retaining operator authentication. `buildGateway(..., {startCron: false})` leaves the cron timer stopped for tests.
- `src/test-support/` — a minimal fake `SandboxProvider` and an HTTP harness for T1 tests. Dev-only, and kept here on purpose: `@deskmates/testkit`'s fake provider models a sandbox's behaviour, while these tests need a script that plays a sidecar over HTTP against a live Gateway.

Configuration: read from the environment (`.env` in development) by `src/config.ts`, which
composes one reader per domain in `src/config/<domain>.ts`; see
`.env.example` and [docs/configuration.md](docs/configuration.md).

## Topics

Each feature documents itself in its own file under `docs/`. A new feature adds a file
`docs/<topic>.md` (kebab-case) and one line to this list, in its sorted place; it does not add
a section to this README.

- [Agent runtimes (ADR-0044)](docs/agent-runtimes.md): `DEFAULT_RUNTIME`, a bot's `runtime`, the OpenAI upstream protocol
- [Analytics relay to Grafana (ADR-0046 amendment 1)](docs/analytics-relay.md): `/analytics/*`, the root's session only
- [App sharing: published workspace apps (ADR-0035)](docs/app-shares.md)
- [Approvals](docs/approvals.md)
- [Channel connections (ADR-0047)](docs/channel-connections.md): ABI-2 host, identity uniqueness, rebind, blocklist, inbound images
- [Configuration](docs/configuration.md)
- [Connectors (ADR-0012)](docs/connectors.md)
- [Context and prompt-cache observability (ADR-0023 amendment 5)](docs/context-and-cache-observability.md): request shapes, CLI surface knobs
- [Database and migrations (ADR-0031)](docs/database.md)
- [Desktop tools: opt-in native LCU (ADR-0048)](docs/desktop-tools.md): opt-in LCU, no per-call approvals, the grouping exception
- [Final-reply idempotency and recipient context](docs/final-reply-idempotency.md)
- [Group routing and direct handoffs (M2 foundation)](docs/group-routing.md)
- [HTTP API (M0)](docs/http-api.md): operator routes, events, sidecar-facing routes, model proxy
- [Host resources: detect, show, repair, clean (ADR-0006 amendment 5)](docs/host-resources.md): `GET /api/runtime/resources`, Remove, Re-attach, pool headroom
- [Hybrid Knowledge and memory search (ADR-0041)](docs/hybrid-retrieval.md)
- [Image generation operation (ADR-0040 amendment B)](docs/image-generation-operation.md): `IMAGE_OPERATION_*`, `image_generate`
- [Implemented foundation (M0/M1 and M2 F1–F4)](docs/implemented-foundation.md): run flow, sandbox recreation
- [Integrations (ADR-0013)](docs/integrations.md)
- [Interaction development update (2026-09-30)](docs/interaction-update-2026-09-30.md)
- [Interrupted usage receipts (issue #72)](docs/interrupted-usage-receipts.md)
- [Look/OCR and speech operations (ADR-0040)](docs/look-and-speech-operations.md)
- [M1/M2 feature closeout operator APIs](docs/feature-closeout-apis.md)
- [Model jobs: vision probes, round triage and SOUL proposals (ADR-0023 amendment 1)](docs/model-jobs.md)
- [Model transport observations](docs/model-transport-observations.md)
- [Model upstreams (ADR-0039)](docs/model-upstreams.md): `MODEL_UPSTREAMS`, routing by model, local zero prices
- [Name lookups and bounded chat approvals (#113)](docs/name-lookups.md)
- [Network profiles (ADR-0027 amendment 1)](docs/network-profiles.md): online LAN grants, publication, preflight
- [Operations (M1)](docs/operations.md)
- [Operator authentication and listeners (M2 B4)](docs/operator-authentication.md): browser sign-in and sessions (ADR-0022 P1)
- [Optional origin coordination prototype (ADR-0007)](docs/origin-coordination.md)
- [Per-bot screen transport (ADR-0008)](docs/per-bot-screens.md)
- [Per-bot working directories (ADR-0038)](docs/per-bot-working-directory.md): soft write guard between bots
- [Private-chat handoffs (ADR-0024)](docs/private-chat-handoffs.md)
- [Reviewed knowledge and memory administration (B5)](docs/knowledge-and-memory-administration.md)
- [Run audit and ledger retention (ADR-0042)](docs/run-audit.md): failure classes, marks, `RUN_EVENTS_RETENTION_DAYS`
- [Run liveness: stall detection and live progress data (issue #9)](docs/run-liveness.md)
- [Run observability: collector, spool and the obs model (ADR-0046)](docs/run-observability.md): `OBSERVABILITY_*`, the sqlite sink
- [Run startup timeline and reply preview (ADR-0037)](docs/run-startup-timeline.md)
- [Run statistics for the bot itself (ADR-0050)](docs/run-stats.md): `run_stats`, per-bot opt-in, scoped by the run token
- [Run usage summaries for Costs (ADR-0032 amendment 1)](docs/run-usage-summaries.md)
- [Snapshot delivery experiment](docs/snapshot-delivery-experiment.md)
- [Takeover (M1)](docs/takeover.md)
- [Task templates, kinds, the kind view and related tasks (ADR-0021 amendment 4)](docs/task-kinds.md)
- [Thread pauses: reason, reset window and Resume (ADR-0005 amendment 3)](docs/thread-pauses.md)
- [Triggers (M1)](docs/triggers.md)
- [Upgrade drain and restart recovery (ADR-0029)](docs/upgrade-drain-and-restart-recovery.md): `waiting_platform`, the restart breaker, proxy-sourced usage, cron misfires
- [Web search on a self-hosted SearXNG (ADR-0049)](docs/web-search.md): `SEARCH_URL`, the per-workspace switch, the proxy, filtering and records
- [Workspace credential vault (ADR-0045)](docs/vault.md): references, not retrieval; fill, bounded requests, approval modes
- [Workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2)](docs/workspace-limits.md)
- [Workspace file download (ADR-0014)](docs/workspace-file-download.md)
- [Workspace file uploads (ADR-0014 amendment A5)](docs/workspace-file-uploads.md)
- [Workspace Files collection (ADR-0014 amendment A2)](docs/workspace-files-collection.md)
- [Workspace task management (ADR-0021)](docs/task-management.md): bot delivery (amendment 2)

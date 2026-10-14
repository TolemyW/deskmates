# Deskmates Design Document and Scenario Feasibility Evaluation

Date: 2026-09-20
Status: Draft v0.2 (revised from v0.1; updated 2026-09-20 with S0 verification results, see `docs/design/s0-spike-results-2026-09-20.md`)
Scope: A product benchmarked against xAI Grok Bot's "resident bot + own computer + browser operation", built on a thin-core self-developed route; and an evaluation of whether this design can support three business scenarios.

---

## 0. Document notes and v0.2 changes

This document has two parts. Sections 1 to 9 are the design document; sections 10 to 12 are the scenario evaluation.

The evaluation criteria are unchanged:

- **Feasibility rating**: high / medium-high / medium / medium-low / low, meaning the confidence of "delivering a shippable, measurable version within 6 months".
- **Platform coverage**: the share of the scenario's workload that the generic harness covers.

### Changes in v0.2 relative to v0.1

| Id | Change | Reason |
|---|---|---|
| C1 | Approval changes from "in-process suspend" to a dual mode of "short wait + persist and resume" | A process suspended for hours while the human is offline is unreliable |
| C2 | Scheduling split into an interactive lane and a background lane | Chat must not queue behind a two-hour cron task |
| C3 | Browser gains a human handover protocol, vision fallback, and a token-saving mode | The accessibility tree cannot see shadow DOM and canvas; long sessions cost many tokens |
| C4 | Credential policy unified into one description | v0.1's 3.8 and 3.10 contradicted each other |
| C5 | Egress policy changed to deny by default with a per-bot allowlist | Even L0 browsing can exfiltrate data through URLs; approval cannot stop it |
| C6 | Execution plane abstracted as a Sandbox Provider interface | Besides Docker it must also run on a Desktop VM or a hosted sandbox |
| C7 | New S0 verification week; total milestone length moves from 14 to 16 weeks | Three key assumptions must be proven first |
| C8 | Technology choices add the rejected hosted options such as Managed Agents | v0.1 did not explain why hosted options were not used |
| C9 | The tty interaction tool moves from the "domain layer" into the harness | All three scenarios need to run interactive CLIs |
| C10 | Two rows added to the risk matrix | Accessibility tree blind spots; resume failure |

### v0.2.1 revision (2026-09-20, answering "how does the container model share browser login state")

| Id | Change | Reason |
|---|---|---|
| C11 | Add identity objects and identity hosts; login state ownership moves from bot to identity | v0.2's 3.8 said "later bots use it directly", which contradicts "one bot one sandbox, login state only in the sandbox volume". In practice only the same bot persisted across runs; sharing across bots was impossible |
| C12 | Sharing mechanism fixed as CDP borrowing; shared volumes explicitly rejected | Chromium's SingletonLock and the single-writer limits of Cookies/LevelDB mean a concurrently shared volume always corrupts the profile |
| C13 | Browser lock granularity refined from "whole browser" to "identity x origin" | When multiple bots borrow the same identity, different sites should run in parallel |
| C14 | Data model adds identities / identity_grants / identity_leases / identity_events | Grants, leases, and audit must be persisted |
| C15 | Risk matrix adds shared identity blast radius and login loss | Sharing login state equals sharing credentials |

The mechanism of C11 has been indirectly verified by S0 test-c: one Chromium accepts multiple concurrent CDP clients with shared state. The unverified increment is cross-sandbox attach and origin interception in the identity proxy; recommended to fold into M1.

---

## 1. Background and goals

### 1.1 Benchmark target

Grok Bot (released 2026-08-11) product form: a group of resident agents with names and roles; each bot exclusively owns a persistent cloud computer (browser, filesystem, terminal), logs into the user's existing SaaS and websites, works automatically on schedule or on events, and only comes back to the human when approval is needed. Clients cover macOS, Windows, Linux, iOS, Android.

Its known weaknesses: cannot be self-hosted, single model vendor, memory is a black box and cannot be exported, no security isolation between bots, about one in five structured tasks fails.

### 1.2 Goals of this design

1. Reach Grok Bot's eight core capabilities (persistent computer, browser operation, resident triggers, connectors, approval gate, multi-bot collaboration, memory, clients).
2. Surpass it on the four weaknesses: self-hosted, model-swappable, memory that can be queried, edited and exported, per-bot isolation.
3. Keep the harness as thin as possible; use standard parts for the agent loop and browser operation; concentrate custom code in the product layer.
4. Connect with existing assets: a desktop VM, an external model proxy and skill marketplace, the database MCP server and database skill.
5. Replaceable execution plane: the same Gateway can run bots on Docker, Desktop VM, or a third-party hosted sandbox.

### 1.3 Non-goals

- No general multi-company governance platform (hard budget stops, multi-user RBAC, audit compliance). When needed, plug this harness into Paperclip as an adapter.
- No custom agent reasoning loop, no custom browser DOM understanding model.
- No mobile clients (first phase).
- No promise to replace human business judgment (see section 10).
- No trade execution (the quant scenario stops at research, not at order placement).

---

## 2. Overall architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Clients                                                      │
│  Web UI (preferred) · desktop client · Slack/Telegram │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTPS + SSE
┌───────────────▼──────────────────────────────────────────────┐
│  Gateway (control plane, single process, Node.js + SQLite)    │
│  ├─ Bot Registry     name / role / SOUL.md / MEMORY.md / connector allowlist │
│  ├─ Run Scheduler    interactive lane + background lane; chat · cron · webhook · bot │
│  ├─ Approval Broker  short wait / persist and resume; Allow once / Always / Deny │
│  ├─ Bot Bus          bot-to-bot messages, allowlist + relay cap │
│  ├─ Knowledge Store  team shared knowledge base (markdown + SQLite FTS) │
│  ├─ Run Ledger       run records, logs, screenshots, token cost │
│  ├─ Secrets Store    OAuth refresh tokens (encrypted), issues short-lived tokens │
│  ├─ Egress Policy    per-bot egress allowlist, deny by default │
│  └─ Connector Hub    MCP registry · Composio                   │
└───────────────┬──────────────────────────────────────────────┘
                │ Sandbox Provider interface (create / exec / attach / snapshot)
┌───────────────▼──────────────────────────────────────────────┐
│  Bot Computer (execution plane, one sandbox per bot)          │
│  Provider: Docker (default) · desktop VM · hosted sandbox (later) │
│  ├─ Sidecar          run lifecycle, tool interception, logs, screenshots, health reporting │
│  ├─ Agent Loop       Claude Agent SDK, model via the model proxy │
│  ├─ Browser Client   Playwright MCP / CLI, --cdp-endpoint points at an identity │
│  │                   default: this sandbox's private identity; shared: the identity host │
│  ├─ Shell + FS + tty /work persistent volume, /home/bot private memory, pty tool │
│  └─ Runtime Tools    connector MCPs (database, GitHub, Slack...)│
└───────────────┬──────────────────────────────────────────────┘
                │ CDP over identity proxy (auth · origin allowlist · lock · audit)
┌───────────────▼──────────────────────────────────────────────┐
│  Identity Host (one sandbox per shared identity, sole owner of login state) │
│  ├─ Chromium         single instance, --user-data-dir=/profile persistent volume │
│  ├─ CDP Endpoint     multiple bots attach concurrently, each opens its own tab │
│  ├─ Screen           Xvfb + noVNC, manual login / MFA / takeover │
│  └─ Keeper           session keepalive, expiry detection, encrypted storageState snapshots │
└──────────────────────────────────────────────────────────────┘
```

Design principles:

- **Thin control plane**: the Gateway only does registration, scheduling, approval, messaging, ledger, secrets, and egress policy; it does not touch model inference.
- **Standard parts on the execution plane**: the agent loop uses the Claude Agent SDK, the browser uses Playwright, desktop takeover uses noVNC.
- **One bot one sandbox, one identity one profile**: the bot's isolation boundary and the ownership boundary of login state are two different things. A private identity's profile lives in the bot's sandbox volume; a shared identity's profile lives only in the identity host's volume, bots borrow it over CDP, and no bot can get the profile files themselves. The Gateway holds only encrypted refresh tokens and issues short-lived tokens into the sandbox.
- **Every run is traceable and resumable**: every trigger writes one run; a run can stop for approval and resume from the same position hours later.
- **No egress by default**: each bot can only reach allowlisted domains; the allowlist is maintained by humans, and the bot cannot change it.

---

## 3. Core components

### 3.1 Bot definition

| Item | Location | Description |
|---|---|---|
| `SOUL.md` | Sandbox `/home/bot/` | Identity, role, tone, boundaries. Human-editable, versioned |
| `MEMORY.md` | Sandbox `/home/bot/` | Implicit rules. The agent may append; humans may edit or delete |
| `memory/YYYY-MM-DD.md` | Sandbox `/home/bot/` | Daily work notes, appended automatically when a run ends |
| `skills/` | Sandbox `/home/bot/` | Installed skills, from a skill marketplace or local |
| bot row | Gateway SQLite | Name, role, model, connector allowlist, egress allowlist, approval rules, cron, sandbox provider |

The three memory layers are unchanged: bot-private files, the team shared knowledge base, and the run ledger. All plaintext markdown or SQLite.

### 3.2 Agent Loop

- Uses the Claude Agent SDK. Default model `claude-opus-5`; a bot can switch to `claude-sonnet-5` to cut cost. Model requests are forwarded through the model proxy; the bot holds no upstream key.
- **Proxy requirements**: the Proxy must pass through `POST /v1/messages?beta=true`, the SSE response of `stream: true`, `tools` definitions, `cache_control` blocks, and the `anthropic-beta` and `anthropic-version` request headers. S0 confirmed with a local proxy that the SDK sends all of these to `ANTHROPIC_BASE_URL`.
- **Credential conclusion (S0 verified)**: subscription OAuth credentials forwarded through a third-party Base URL are rejected upstream (403). The Proxy must hold the upstream key itself and inject it at the exit. The sandbox holds only a short-lived token issued by the Proxy, injected via `ANTHROPIC_AUTH_TOKEN` (Bearer), and no upstream credential of any kind.
- **End-to-end conclusion (S0 verified)**: a full agent loop ran through the model gateway (Anthropic protocol); glm-5.3 and deepseek-v4.1-flash each completed two tool calls, with `cache_read_input_tokens` non-zero. The model-swappable goal holds. The SDK's `costUSD` is not trustworthy for non-Anthropic models; the Gateway prices cost itself per token.
- Input of each run: `SOUL.md` as the system prompt, `MEMORY.md` and the last 3 days of diary, this trigger's payload, the top 5 knowledge base search hits, and the list of available tools.
- Output: the final reply plus a structured "run summary": what was done, which files changed, which sites were visited, pending approval items, and rules suggested for appending to `MEMORY.md`.
- Session continuation: the SDK session id is saved per `(bot, thread)`. Approval resume and continued chat in the same thread both use the SDK's session resume. Reopen after a SOUL change.

### 3.3 Browser runtime

**Single-instance principle**: the sandbox runs only one headed Chromium with a CDP port open. Playwright, the human in noVNC, and the screenshot sidecar all connect to the same instance. The profile persists on a volume.

**Three driving modes, switched as needed**:

| Mode | Purpose | When |
|---|---|---|
| Playwright MCP (accessibility tree), launched with `--cdp-endpoint http://127.0.0.1:9222 --caps vision` | Exploring unknown pages | Default |
| Playwright CLI, `attach --cdp=http://127.0.0.1:9222` | Long sessions, regression, batch operations | After a stable flow is solidified; token-sensitive tasks |
| Vision fallback (screenshot + coordinate actions) | When the accessibility tree fails | Shadow DOM, canvas, image buttons, the step before a CAPTCHA |

S0 verified: all three can attach to the same Chromium; a button inside a closed shadow root is invisible in the accessibility tree, and a coordinate click can hit it. The image must preinstall the MCP and the CLI; no `npx` package pulls at run time.

The switching rule is executed by the sidecar: when MCP fails to find the target element twice in a row, a screenshot is attached automatically and coordinate clicks are allowed; stable flows are saved by the agent as scripts under `/work/scripts`, and only when a script fails does it go back to exploration.

**Human handover protocol**:

1. The human opens noVNC and clicks "take over"; the sidecar locks the browser, and all of the agent's browser tools return "a human is operating, please wait".
2. After finishing the CAPTCHA, QR scan, or second-factor verification, the human clicks "hand back"; the lock is released, and the agent receives one system message describing what the human did (one sentence typed by the human, may be empty).
3. During takeover the screen is not screenshotted and nothing enters the ledger, to avoid recording passwords typed by the human.

Every agent action is screenshotted automatically, stored in the run ledger, and replayable in the UI.

**Identity and login state sharing**

Login state belongs to an **identity**, not to a bot. An identity is a first-class object; a bot borrows it through an explicit grant, so that "who is doing the work" and "whose account is doing the work" can be separated. Identities come in two kinds:

| Kind | Profile location | Who can use it | Typical scenario |
|---|---|---|---|
| Private identity | The bot sandbox's own volume | Only that bot | Test accounts, one-off logins |
| Shared identity | A separate identity host sandbox | Multiple granted bots borrowing concurrently | Team Jira, corporate email, data platform consoles |

The sharing mechanism is **borrow the browser, do not move the profile**:

- The identity host runs a single-instance Chromium, `--user-data-dir=/profile --remote-debugging-port=9222`, with the profile on a dedicated volume.
- The bot sandbox's Playwright MCP uses `--cdp-endpoint` to point at the identity proxy instead of the local port. `connectOverCDP` yields the persistent default context, that is, the real profile's cookie jar; each bot opens its own tab with `newPage()`, sharing cookies while navigating independently without interference.
- S0 test-c verified that one Chromium accepts multiple concurrent clients with shared state. Here the clients merely extend from "three drivers in the same sandbox" to "multiple bots across sandboxes"; the mechanism is the same.
- Manual login, MFA, and QR scans go through the identity host's noVNC; one login is enough. TOTP secrets are stored in the Gateway Secrets Store and injected only into the identity host's sidecar, never handed to any bot sandbox.
- The egress IP is naturally consistent: the whole shared identity has only the identity host as its single exit, so the same session never appears active on multiple IPs and triggers risk controls.

**Why not a shared volume**: mounting the same profile volume into multiple sandboxes corrupts it directly. Chromium keeps `SingletonLock`, `SingletonSocket`, and `SingletonCookie` in the user data dir; a second instance tries to hand its request over to the first instance, and that handover fails across network namespaces. Even if the lock is bypassed, Cookies is SQLite and Local Storage is LevelDB, and neither supports multiple writers. A shared volume can only be used in an exclusive lease mode where "only one sandbox mounts it at any moment".

**Trade-offs of the three sharing methods**:

| Method | Fidelity | Concurrency | Where used |
|---|---|---|---|
| Identity host + CDP borrowing | Complete, including IndexedDB, Service Worker, extensions, device fingerprint | Supported | Default |
| storageState export and import | Lossy, excludes sessionStorage | Supported but sessions kick each other out | Backup; cloning into a disposable sandbox for dangerous operations |
| Exclusive lease (volume mount switching) | Complete | Not supported, serial queue | Brokerages, online banking, and other sites with strict device binding |

storageState currently captures cookies, localStorage, IndexedDB snapshots, OPFS, and virtual WebAuthn credentials, but explicitly excludes tab-level sessionStorage; sites that authenticate via sessionStorage remain logged out after injection. In addition, Playwright MCP cannot load storage-state when connecting over CDP, which also shows that login state should be held by the identity host rather than injected into a remote browser.

**Lock granularity**: refined from v0.2's "lock the whole browser" to **identity x origin**. When a human takes over, the whole identity is locked; when two bots operate a stateful flow on the same site at the same time (checkout, wizard, editing the same record), that origin is locked; tabs on different sites can run in parallel.

**Grants are enforced at the proxy, not in the browser**: the same profile's cookie jar is visible to all tabs, and the browser does not isolate by origin. Therefore "a bot may only use this identity for certain domains" must be enforced by the identity proxy intercepting navigation targets at the CDP layer, intersected with the egress allowlist of section 3.10. This is a soft boundary; in-page JS redirects can bypass it. The hard rule is: **one identity equals one trust domain**. Do not put a personal mailbox and a production system into the same profile for convenience; when isolation is needed, open two identity hosts.

**Expiry handling**: the identity host's Keeper periodically probes a lightweight logged-in endpoint. When login loss is detected, the identity is set to `needs_login`, all runs borrowing that identity move to waiting, and a "re-login required" notification is pushed to a human, instead of letting bots hit the login wall repeatedly.

### 3.4 Triggers and scheduling

Trigger sources are unchanged: chat, cron, webhook, bot messages, approval replies.

**Two scheduling lanes**:

| Lane | Trigger sources | Concurrency | Description |
|---|---|---|---|
| Interactive lane | chat, approval replies | 1 per bot | The user is waiting; takes priority |
| Background lane | cron, webhook, bot messages | 1 per bot | Long tasks, queued |

The two lanes can each run one run at the same time. Rules:

- Interactive runs and background runs share the sandbox but have independent SDK sessions.
- An interactive run can read `/work` and the run ledger, and can answer "how is the background task going".
- When an interactive run wants to write `/work` or operate the browser while a background run is using it, the sidecar returns "resource busy"; the agent tells the user and offers options: wait, or let the user cancel the background run.
- The background lane queue has a cap; if a cron fires while the previous round has not finished, it is skipped and recorded.

### 3.5 Approvals and permissions

The three risk tiers are unchanged: L0 read-only is allowed by default; L1 reversible writes are allowed by default with configurable approval; L2 external side effects require approval by default.

**Two ways of waiting for approval**:

1. **Short wait**: the sidecar intercepts the L2 tool call in the `canUseTool` callback and waits in-process, 5 minutes by default. Best experience when the human is online; run status `waiting_approval_live`. S0 verified that the callback can block for more than 20 seconds with no SDK-side timeout; the docs state it can hang indefinitely.
2. **Persist and resume**: on timeout or when the human is offline, the sidecar's `PreToolUse` hook returns `permissionDecision: "defer"`. This is a native SDK mechanism: the query ends immediately and returns the session id, the run status is set to `waiting_approval`, the pending action is persisted, and the process exits. After the human approves, the Gateway reopens the run with `resume: sessionId`; the SDK hands the deferred tool call back to the hook, allowing it now executes it, and the agent continues from where it was. S0 verified this across two independent processes. The mid-run summary is generated by the sidecar from the run ledger; the agent is not involved.

Decision options are unchanged: Allow once / Always allow / Deny. Always allow generates a rule; rules are stored in SQLite and can be revoked in the UI.

Auto Review rule matching dimensions: tool name, target domain, SQL statement type, amount threshold, file path.

### 3.6 Team shared knowledge base

Unchanged. Storage is markdown + FTS5, with optional database vector retrieval; writes need human review or distillation by a knowledge maintainer bot; all bots access it through `knowledge_search` and `knowledge_read`.

### 3.7 Multi-bot collaboration

Unchanged: Bot Bus, allowlist, relay cap 5, shared `/shared` volume, chief-of-staff pattern written in SOUL.

Addition: the Bot Bus message format is `{from, to, thread, body, attachments, relay_count}`; the fields align with mainstream inter-agent protocols, so cross-system interoperation later can be a mapping layer, not a rewrite.

### 3.8 Connectors and credentials (unified description)

| Kind | Where the credential lives | What the sandbox gets |
|---|---|---|
| MCP service | Gateway registry, injected per bot allowlist | MCP endpoint and a short-lived token |
| SaaS OAuth | Gateway Secrets Store, refresh token stored encrypted | A short-lived access token issued per run, invalid once expired |
| Browser login (private identity) | That bot sandbox's profile volume | A human logs in once in that sandbox's noVNC; only this bot can use it afterwards |
| Browser login (shared identity) | The identity host's profile volume | A human logs in once in the identity host's noVNC; granted bots borrow over CDP and cannot get the profile files |
| CLI tools | Image preinstalls psql, git, gh, python, node | No credentials; credentials go through the three rows above |

Rules: the Gateway database stores no plaintext passwords and no browser cookies; the sandbox stores no refresh tokens; the run ledger redacts tokens and cookies.

### 3.9 Observability

Unchanged: run ledger, SSE live logs, per-bot per-day cost aggregation with a soft cap.

Addition: each run records the usage count of each browser driving mode (MCP / CLI / vision), used to evaluate token overhead and fallback frequency.

### 3.10 Security

- **Sandbox isolation**: each bot has its own sandbox, its own volume, and its own network namespace.
- **Egress policy**: deny by default. Each bot has one domain allowlist, maintained by humans in the UI; the agent has no permission to modify it. Navigation outside the allowlist is intercepted even at L0 and turned into an approval, which is the only way to stop "page injection makes the bot splice data into a URL and send it out".
- **Prompt injection**: page content read by the browser and external text returned by tools are wrapped in "untrusted content" markers before entering model context; L2 actions must pass approval; no screenshots during takeover.
- **Audit**: all L1/L2 actions, approval decisions, and allowlist changes are written to an append-only log.

---

## 4. Data model (Gateway SQLite)

```
bots            id, name, role, model, soul_version, sandbox_provider,
                connectors_json, cron_json, created_at
threads         id, bot_id, channel, title, sdk_session_id, updated_at
runs            id, bot_id, thread_id, lane(interactive|background),
                trigger_kind, trigger_ref, status,
                sdk_session_id, resume_payload_json,
                started_at, finished_at, tokens_in, tokens_out, cost_usd, summary_json
run_events      id, run_id, seq, kind(tool_call|tool_result|screenshot|log|approval|takeover), payload_json, ts
approvals       id, run_id, action_json, risk_level, decision, decided_by, decided_at, wait_mode
approval_rules  id, bot_id, matcher_json, decision, created_from_approval_id
egress_rules    id, bot_id, domain_pattern, created_by, created_at
bot_messages    id, from_bot, to_bot, thread, run_id, body, relay_count, ts
knowledge_docs  id, path, title, body, source_run_id, approved_by, updated_at
knowledge_fts   FTS5 virtual table
connectors      id, kind, name, config_json
secrets         id, connector_id, bot_id, encrypted_blob, rotated_at
identities      id, name, kind(private|shared), owner_bot_id, host_sandbox_id,
                profile_volume, exclusive, status(healthy|needs_login|locked), last_check_at
identity_grants id, bot_id, identity_id, origin_allowlist_json, granted_by, granted_at
identity_leases id, identity_id, origin, holder_run_id, holder_kind(bot|human),
                acquired_at, expires_at
identity_events id, identity_id, run_id, bot_id,
                kind(navigate|login_required|takeover|snapshot), payload_json, ts
```

Run state machine:

```
queued → running → succeeded | failed | cancelled
              ↓
   waiting_approval_live → running        (short wait, process still alive)
              ↓
   waiting_approval      → running        (persisted, session resume)
```

---

## 5. Sequence of one run

1. The trigger reaches the Gateway, lands in the interactive lane or the background lane according to its source, and is written to `runs` with status `queued`.
2. The scheduler confirms that this bot has no in-progress run on that lane, sets `running`, and has the sidecar start the agent loop through the Sandbox Provider.
3. The sidecar assembles the context: SOUL, MEMORY, recent diary, trigger payload, knowledge base search results.
4. The agent executes. Every tool call passes through the sidecar: check the egress allowlist, check the risk tier, check the browser lock. L2 actions enter the short wait.
5. If the short wait times out, the run is persisted, set to `waiting_approval`, and the process exits. After the human decides, the Gateway reopens with session resume, injects the decision, and continues.
6. On completion the agent outputs a structured summary; the sidecar appends the diary, reports cost, and submits knowledge base entry suggestions.
7. The run is set to a terminal state and the client is notified over SSE.

---

## 6. Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Gateway | Node.js + Fastify + SQLite (better-sqlite3) | Single process is easy to deploy and matches the rest of the repo |
| Agent loop | Claude Agent SDK | Built-in tool calling, planning, error recovery, session resume; a model upgrade is a product upgrade |
| Sandbox | Sandbox Provider interface; Docker by default | Docker is the simplest to self-host; the interface is left for Desktop VM and hosted sandboxes |
| Browser | Single-instance Chromium + Playwright MCP / CLI + screenshot fallback | Tree mode is cheap and reproducible, the CLI saves tokens, vision covers blind spots |
| Screen | Xvfb + noVNC | Humans can take over, zero client install |
| tty | `tty_session` tool wrapping node-pty | Interactive CLIs, timeouts, control character handling |
| Connectors | MCP first, Composio to fill SaaS gaps | The MCP ecosystem is already the standard |
| Web UI | React + Vite | Same as the Cogbox frontend |
| Channels | Slack Bolt, grammY (Telegram) | Mature SDKs, added later |

Options considered and rejected:

- **Claude Managed Agents**: an agent runtime hosted by Anthropic; sandboxes and session logs live on the Anthropic side. Saves execution plane development, but cannot be self-hosted and cannot swap models, conflicting with goal 2. Kept as a future Sandbox Provider implementation for customers who do not require self-hosting.
- **Hosted sandboxes (Modal, Cloudflare Sandbox, etc.)**: less operations work than Docker, but introduce an external dependency. Added later through the Provider interface.
- **Fork OpenMausBot**: bound to the Electron desktop form; bots run on the user's own machine rather than on a separate computer.
- **Build on OpenClaw**: good channel and skill ecosystem, but its shared-host model conflicts with "one bot one computer", and several 2026 security analyses point to insufficient isolation.
- **Build directly on Paperclip**: complete governance capabilities, but large in size with many contracts, unsuited to fast trial and error. Kept as an upper-layer option.

---

## 7. Connection with existing assets

| Existing asset | How it connects |
|---|---|
| Desktop VM | Implement a `DesktopVMProvider`; the desktop app acts as one client |
| Model proxy and skill marketplace | Model proxy, usage metering, and the skill marketplace are reused directly; S0 verified proxy pass-through |
| Database MCP server | Built-in connector; bots access it with a service identity issued by the Gateway |
| Database skill / database guidance | Initial knowledge base content and bot skills |
| fund-tool | First CLI tool sample for the quant scenario |
| Paperclip | When multi-user governance is needed, wrap the Gateway as a Paperclip adapter |

---

## 8. Milestones

| Phase | Content | Acceptance |
|---|---|---|
| S0 (1 week) | Verify three key assumptions: (a) the SDK runs streaming + tool calling + cache through the model proxy; (b) an L2 action stops, the process exits, and session resume continues successfully; (c) one Chromium is used by Playwright and noVNC at the same time and handover does not conflict | **2026-09-20 result: all three passed.** (a) ran through the model gateway with two non-Anthropic models; (b)(c) see the results document. Scripts in `spikes/s0/`, conclusions in `docs/design/s0-spike-results-2026-09-20.md` |
| M0 (2 weeks) | Gateway skeleton, Docker Provider, single bot, SDK loop, Playwright MCP, web chat | One bot can log into a website and complete a form on a chat instruction, with screenshots in the ledger |
| M1 (4 weeks) | Two scheduling lanes, cron, webhook, dual-mode approval, egress allowlist, noVNC handover protocol, tty tool | The bot runs on schedule; on an L2 action it short-waits 5 minutes then persists, and resumes successfully after approval the next day; the agent continues after a human takes over and completes a CAPTCHA |
| M2 (4 weeks) | Multi-bot, Bot Bus, shared volume, knowledge base, MEMORY rules, vision fallback, Playwright CLI mode | The chief bot splits a task across two expert bots and aggregates; a shadow DOM page is operated through vision fallback |
| M3 (5 weeks) | Database connector, scenario images, Slack channel, cost dashboard, Desktop VM Provider | Each of the three scenarios runs one end-to-end flow; the cost dashboard can split tokens by driving mode |

16 weeks in total. M3 is one week longer than in v0.1, for the Desktop VM Provider.

---

## 9. Open questions

1. ~~Whether the model proxy passes through prompt cache related headers~~ S0 verified: the model gateway passes them through and returns cache hits after multiple turns. If a new proxy is built, implement it per the checklist in the S0 results document.
2. Whether the desktop VM is one VM per bot or one VM with multiple containers; the latter requires Docker inside the VM.
3. How the database MCP server's service identity is issued and rotated, and whether the database needs a new service account type.
4. Whether the knowledge base uses database vector retrieval from day one or FTS5 first. FTS5 first is recommended.
5. Which model's computer use capability the vision fallback uses, and whether it goes through the same Proxy.
6. Whether the 5-minute default short wait is appropriate, and whether it should be configurable per bot.

---

## 10. Scenario feasibility evaluation

### 10.1 Scenario one: automated product testing (web service + CLI service)

| Sub-goal | Coverage |
|---|---|
| Simulate a user walking through scenarios on the web | Covered by the harness (tree + CLI + vision, three modes) |
| Simulate a user interacting on the CLI | Covered by the harness (`tty_session` tool, moved into the harness in v0.2) |
| Generate test scenarios from requirements or a PRD | Covered by agent capability; the domain layer must supply test case templates |
| Assertions and verdicts | Needs the domain layer. There must be an explicit oracle |
| Repeatable regression | Needs the domain layer. Exploration results are solidified into Playwright scripts or CLI scripts, executed in CLI mode |
| Environment setup and reset | Needs the domain layer. Test data seeding, service start and stop, database snapshot rollback |
| Reports and defect tickets | Covered by the harness |

**Feasibility: high. Platform coverage about 75%.** (raised from 70% after the tty tool moved into the harness)

Limits unchanged: live agent exploration cannot serve as regression; assertions must be defined by humans or derived from the spec; exploration mode needs a budget; vision fallback mitigates but does not eliminate instability on canvas-type pages.

**Verification metrics**: script self-healing success rate, false positive rate, time from description to executable script per test case, number of real defects found in exploration mode, vision fallback trigger rate.

### 10.2 Scenario two: data platform development (import, governance, analysis)

| Sub-goal | Coverage |
|---|---|
| Connect to the database and execute SQL | Covered by the harness + existing assets |
| Data import | Needs the domain layer. Import wizard tool |
| Governance | Needs the domain layer. Rules are defined by humans first |
| Analysis | Covered by agent capability; accuracy depends on schema knowledge |
| Schema and business terminology knowledge | The harness knowledge base can carry it |
| Asynchronous execution of long tasks | Covered by the harness background lane; the interactive lane can query progress at any time (v0.2 improvement) |
| Protection against destructive operations | Covered by the harness approval broker; L2 rules configured by SQL type |

**Feasibility: medium-high. Platform coverage about 55%.** (the two scheduling lanes solved the problem of not being able to ask for progress during a long task)

Limits unchanged: NL-to-SQL accuracy is the ceiling; governance rules must be set by humans first; database engine errors must be distinguished from SQL errors; the import wizard is bound to the database version.

### 10.3 Scenario three: quant research group

The coverage table is the same as in v0.1.

**Feasibility: medium-low (autonomously producing strategies); medium-high (research assistant group). Platform coverage about 30%.**

Limits unchanged: statistical rigor can only be enforced by tools; report figures must come from run artifacts; data cost; research and trading physically isolated.

---

## 11. Overall conclusions

| Scenario | Feasibility | Platform coverage | Main domain layer work | Biggest risk |
|---|---|---|---|---|
| Automated product testing | High | About 75% | Oracle definition, script solidification, environment reset | Mistaking non-deterministic exploration for regression |
| Data platform development | Medium-high | About 55% | Schema knowledge base, import wizard, governance rules | NL-to-SQL accuracy on complex databases |
| Quant research group | Medium-low / medium-high | About 30% | Deterministic backtest engine, bias check tools, data sources | Statistical sloppiness and hallucinated results |

Three judgments are unchanged: the harness can reach the Grok Bot form within 16 weeks and surpass it on four points; scenario value is decided by the domain layer; the order of advancement is one, two, three.

A fourth point is added: **S0 is the gate for the whole plan.** If any of the three assumptions fails, what changes is the architecture, not the schedule. The cost of this one week is far lower than discovering in M1 that approval resume is unreliable.

---

## 12. Risk matrix

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Browser agent reliability is insufficient | High | Medium | Three-mode driving; scripts carry regression |
| Accessibility tree cannot see shadow DOM / canvas | Medium | Medium | Vision fallback; M2 acceptance includes a shadow DOM page |
| Session resume fails after approval is persisted | Low (S0 verified) | High | When resume fails, reopen a new session with the run ledger summary + approval result; cross-host needs a SessionStore or a persistent volume |
| Prompt injection attacks the bot through web content | Medium | High | Egress deny by default; untrusted content markers; L2 approval |
| Token cost runs out of control | Medium | Medium | Per-bot daily budget; CLI mode replaces long MCP sessions; Sonnet takes low-complexity tasks |
| Database engine instability is blamed on the bot | Medium | Medium | Error classification; engine errors go to defect tickets |
| Quant results are not reproducible | High | High | Report figures must come from run artifacts |
| Multi-bot mutual wake-ups run out of control | Low | Medium | Allowlist + relay cap |
| Model proxy does not support tool streaming or cache | Low (S0 verified) | High | Implement per the S0 checklist; if unsupported, connect directly in the short term with the key injected as a short-lived token |
| Agent misoperates while a human has taken over | Low | High | Browser lock; no screenshots during takeover |
| A shared identity amplifies the blast radius of a single injected bot | Medium | High | One identity one trust domain; grants per bot per origin; proxy layer intercepts navigation; L2 within a shared identity still needs approval |
| A shared identity losing login causes cascading failures across bots | Medium | Medium | Keeper probing; after setting `needs_login`, wait uniformly and notify a human, do not let bots hit the login wall repeatedly |

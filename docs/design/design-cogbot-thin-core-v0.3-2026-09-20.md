# Deskmates Architecture Blueprint v0.3

Date: 2026-09-20
Status: draft v0.3, supersedes v0.2 / v0.2.1 as the source of truth for architecture
Scope: architecture blueprint. Scenario feasibility evaluation still follows v0.2 sections 10 to 12; section 11 of this document keeps only the conclusion table.

### Current implementation and acceptance (2026-10-04)

<!-- current-status:start -->
M3 is closed under the owner-revised scope. M4 is in progress.
Task management (ADR-0021) is merged; runtime, real-model, statistical,
visual acceptance remain pending.
Natural 24-hour soak is not an M4 gate; validation continues after stable release.
<!-- current-status:end -->

This blueprint's dated changes and original milestone/verification tables retain
their historical scope. [M4 status](m4-status-2026-10-04.md) and the
[M3 owner scope decision](m3-owner-scope-closeout-and-m4-backlog-2026-10-03.md)
control the current milestone state; the original §8 criteria are not a claim
that M3 remains open. In particular, Accepted ADR status records a design decision,
not successful execution of every verification row.

Current interpretations of earlier blueprint text:

- ADR-0002 amendment 1 puts the L2 short wait in `PreToolUse`; `canUseTool`
  is the fail-closed backstop, including the flow in §3.5 and §5.
- ADR-0011 is Accepted and supersedes the per-item human-review memory flow in
  §3.1/§3.6; this says nothing about real-model memory quality or statistical gates.
- ADR-0020 supersedes the deny-by-default statements in §2, §3.3, §3.10 and §12:
  new workspaces default to public-internet `*`; locked workspaces ask on first
  visit. Private addresses/IP literals remain denied, and open workspaces must
  hold no production credentials.
- ADR-0005 amendment 2 answers open question 10: unaddressed human messages use
  owner-first routing; unaddressed bot messages wake nobody. The older walk
  behavior is an explicit opt-in strategy, not the current default.
- WhatsApp QR is primary, Cloud API optional, with live-phone acceptance pending;
  Slack remains deferred and Desktop VM remains unscheduled.

Based on:
- `design-cogbot-thin-core-v0.2-2026-09-20.md` (including the v0.2.1 identity model revision)
- `s0-spike-results-2026-09-20.md` (three architecture assumptions verified)
- `../adr/0002-sidecar-is-the-sdk-host-process.md`
- `../adr/0003-identity-model-and-browser-borrowing.md` (superseded by ADR-0004)
- `../adr/0004-shared-workspace-by-default.md` (in effect: one shared environment by default)
- `../adr/0005-group-threads-and-mention-wake.md` (in effect: threads have members, bots wake each other with @ inside a thread)

---

## 0. Changes in v0.3 relative to v0.2 / v0.2.1

| Id | Change | Source |
|---|---|---|
| C16 | The sidecar is defined as the SDK host process itself; risk tiers map directly onto SDK hooks and callbacks | ADR-0002, S0 test-b |
| C17 | The model is deployment configuration, not a design constant; cost is priced by the Gateway per token | ADR-0002, S0 test-a |
| C18 | ~~No CDP proxy on the identity host~~ | Whole row superseded by ADR-0004: the identity host no longer exists |
| C19 | ~~Identity host, grants, leases, liveness probe~~ | Whole row superseded by ADR-0004: the identity host no longer exists |
| C20 | ~~Per-origin grants classified as an operational control~~ | Whole row superseded by ADR-0004: the identity host no longer exists |
| C21 | ~~Drop the "exclusive lease by volume mount switching" scheme~~ | Whole row superseded by ADR-0004: the identity host no longer exists |
| C22 | ~~One image, two roles~~ | Superseded by C25: only the workspace role remains |
| C23 | ~~Explicit identity selection, tool names carry an identity prefix~~ | Superseded by C26: there is only one set of browser tools |
| C24 | Data model: run usage split per model, new price table, `run_events` gains `thinking` | ADR-0002 |

### v0.3.1 revision (2026-09-20, product decision: one shared environment by default)

| Id | Change | Reason |
|---|---|---|
| C25 | The unit of environment changes from "one sandbox per bot" to "one workspace per group of bots" | The product shape is a group of bots sitting in front of the same computer; sharing is the default, not a feature that needs a mechanism |
| C26 | Delete identity objects, grants, origin allowlists, per-grant MCP instances, the identity host role, `waiting_identity` | That machinery existed to restrict access between bots inside a shared browser, which is neither necessary nor enforceable under the shared computer model |
| C27 | Bots are distinguished by execution context: SOUL, working directory, prompt, ledger attribution. State explicitly that this is not a security boundary | Matches Grok Bot; per-bot permissions bring a lot of complexity |
| C28 | The unit of isolation is the workspace: to isolate, open a second one; no access control between bots | The cost of one container replaces a whole subsystem |
| C29 | Browser coordination reduced to one workspace-level lock plus tab ownership; the origin dimension is removed | Concurrency is a correctness problem, not a permission problem |
| C30 | Open questions 2 and 7 closed; M2 focus shifts to multi-bot concurrency inside one workspace | Origin filtering is no longer in the design; the real risk moves to bots stepping on each other |
| C31 | Goal 2 changes from "surpass on four points" to "surpass on three points, isolation at parity with Grok Bot" | ADR-0004 gave up bot-level isolation as a differentiator; the document states this honestly and does not dress workspace partitioning up as an advantage |
| C32 | Fix three statements that no longer hold under the shared model: TOTP invisible to the agent, connectors allowlisted per bot, cross-sandbox and origin items pending verification | Under the same container and same user, a bot with a shell can read any process environment and any file |
| C33 | Add the default workspace grouping rule and a memory estimate | Scenario 1 bots are exposed to injection, scenario 2 bots hold production credentials, so they cannot share a workspace; one sidecar process per run needs a budget on the order of 1 GiB |

### v0.3.2 revision (2026-09-20, group chat: threads have members, bots wake each other with @)

Based on ADR-0005. Wherever the design leaves behavior undecided, copy Grok Bot's public documentation; the list of what is copied and what is not is in the ADR's Precedent section.

| Id | Change | Reason |
|---|---|---|
| C34 | A thread changes from "belongs to one bot" to "has members, belongs to one workspace"; a one-member thread is the M0 chat, one code path | Group chat needs several bots in one thread; M0 builds its tables on this model so nothing migrates later |
| C35 | The transcript belongs to the Gateway (`thread_messages`); each bot has one SDK session per thread (`bot_sessions`); on wake, deliver the slice of messages that bot has not seen | The source of truth is in the control plane, the same principle as the knowledge base; a bot's session is only its own memory of the conversation |
| C36 | Wake rule: whoever is mentioned is woken, in parallel; `@everyone` or no mention wakes all members in turn by join order, and each bot may stay silent | Copied from Grok Bot; cost grows linearly with member count, same as Grok Bot; cost-saving measures decided after M2 measurement |
| C37 | Bot Bus folds into the thread model: `message_bot` delivers to a `bus` thread and wakes the other side; delete the `bot_messages` table; the chat thread of the originating run gets a handoff system message | Two mechanisms become one; the human sees the handoff where they are already looking, copied from Grok Bot |
| C38 | Two caps: `relay_count` limit 5 (chain depth) plus thread-level `turn_budget` 8 (bot messages between two human messages); the lane follows the thread, a chat thread wake goes to the interactive lane; new `thread_post` tool and run terminal state `silent` | Grok Bot has no caps and user feedback is exactly loops and waste; a thread a human is watching should not sit in the background queue |
| C39 | All ADRs gain a Verification table (ADR-0001 makes it mandatory); fill in terms that had no fixed meaning: human online, short-lived token, pricing for unknown models, browser lock v1 (tab ownership), the four assertions of full isolation, when `last_seen_seq` advances, `thread_post` is L1, in-turn wake meeting a busy member, cap alert form, payload truncation budget, `turn_budget` calibration rule; X03 oracle changes to no lost update | Review found several decisions with no decidable meaning or no test that would fail; a decision that cannot be decided is only a preference |
| C40 | [ADR-0008](../adr/0008-per-bot-desktops-in-a-shared-workspace.md) retains one shared browser/login and adds bot desktop regions, live UI previews and operator-origin screen access; human takeover stays workspace-wide | Operator clarified independent screens and mandatory shared login on 2026-09-23/24; implementation acceptance pending |

### v0.3.3 revision (2026-09-29, M3 scope)

| Id | Change | Reason |
|---|---|---|
| C41 | The Desktop VM Provider leaves M3 and is not scheduled in any milestone; section 7's integration row and open question 3 stay as the record of the idea | Product owner decision on 2026-09-29: no scenario needs a non-Docker execution plane and nothing about the desktop VM has been verified |
| C42 | M3 gains the context and memory workstream (`m3-context-and-memory-plan-2026-09-29.md`); learned memory follows [ADR-0011](../adr/0011-learned-memory-scopes.md) and the database connector follows [ADR-0012](../adr/0012-connector-execution-contract.md), both Proposed; the per-item human review of learned memory in §3.1 and §3.6 and the MCP-endpoint-in-workspace shape of §3.8 change when those ADRs are accepted | The two VendorDB campaigns and the recorded long-run token usage showed unbounded context and a review queue that grows with use |

### v0.3.4 revision (2026-10-02, channel scope)

| Id | Change | Reason |
|---|---|---|
| C43 | WhatsApp replaces the Slack channel in M3. Slack is deferred; reconsider it only with a design that presents each bot's overall work record, traceable to Gateway tasks/runs, delegation, approvals, outcomes and artifacts. | Product owner decision on 2026-10-02. Reply forwarding alone does not meet the intended Slack value. WhatsApp connection mechanism and channel semantics require a channel ADR and verification before implementation. |
| C44 | The WhatsApp channel follows [ADR-0017](../adr/0017-whatsapp-channel-through-cloud-api.md), amended by [ADR-0019](../adr/0019-whatsapp-linked-device-qr.md): QR-linked-device onboarding first, with Cloud API retained as an optional transport. The operator-side adapter owns credentials; the Gateway keeps only `(channel, externalKey)` and message `externalId`. §3.7's cost alert follows [ADR-0018](../adr/0018-cost-alerts-are-soft-thresholds.md). Live channel acceptance remains pending. | Lane B recorded the contracts; the owner requested QR onboarding on 2026-10-03. |

---

### v0.3.5 revision (2026-10-04, M4 management first)

| Id | Change | Reason |
|---|---|---|
| C45 | [ADR-0021](../adr/0021-workspace-task-management.md) adds workspace-scoped operator-maintained tasks with owner, blockers, chat/run/artifact references and explicit delivery versus human acceptance. No dispatch, sidecar tools or automatic task status inference is included. | Product owner approved implementing management first. Local implementation/testing does not close deferred M4 runtime/statistical gates or authorize a release. |

### v0.3.6 clarification (2026-10-04, implementation versus acceptance)

| Id | Change | Reason |
|---|---|---|
| C46 | M3 is closed under the owner-revised scope; M4 holds the deferred acceptance gates. ADR-0021 Task management is merged on main `6bf09f1`. | Dated scope/CI receipts are recorded in [M4 status](m4-status-2026-10-04.md); implementation does not imply runtime/model/statistical acceptance. |
| C47 | ADR-0001's verification/status check is executable and matches explicit decision IDs, including amendments, rather than counting rows. | Grouped rows were legitimate, while row counts could hide missing coverage; acceptance proof still requires its actual evidence. |

## 1. Goals and non-goals

### 1.1 Goals

1. Reach Grok Bot's eight core capabilities: persistent computer, browser operation, always-on triggers, connectors, approval gating, multi-bot collaboration, memory, clients.
2. Surpass it on three points: self-hosted, model-swappable, memory that can be searched, edited and exported. Isolation is at parity with Grok Bot: no defenses between bots, trust domains are partitioned by workspace; several workspaces can be opened, which is a configuration option, not a differentiator (ADR-0004).
3. Keep the harness as thin as possible: agent loop, browser driver and screen takeover are all standard parts; custom code concentrates in the glue layer of the Gateway and the sidecar.
4. Connect to existing assets: a desktop VM, an external model proxy and skill marketplace, the database MCP server and database skill.
5. Replaceable execution plane: the same Gateway can run the sandbox on Docker, Desktop VM or a hosted sandbox.
6. Bots in the same group share login state and files by default, and sharing depends on no extra mechanism.

### 1.2 Non-goals

- No multi-company governance platform. When needed, plug this harness into Paperclip as an adapter.
- No in-house agent reasoning loop, no in-house browser DOM understanding, no in-house CDP proxy.
- No mobile client in the first phase.
- No promise to replace human business judgment.
- No trade execution.

---

## 2. Overall architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Clients: Web UI (preferred) · desktop client · WhatsApp (M3) │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS + SSE
┌───────────────────────────────▼──────────────────────────────────────┐
│  Gateway (control plane, single process, Node.js + Fastify + SQLite)   │
│  ├─ Bot Registry       name / role / SOUL / MEMORY / owning workspace   │
│  ├─ Workspace Registry workspace definitions, egress allowlist, browser lock │
│  ├─ Run Scheduler      interactive lane + background lane; thread · cron · webhook · approval │
│  ├─ Approval Broker    short wait / defer and resume; Allow once / Always / Deny │
│  ├─ Run Ledger         runs, events (incl. thinking), screenshots, per-model tokens, pricing │
│  ├─ Knowledge Store    team knowledge base, markdown + FTS5              │
│  ├─ Thread Router      threads, members, @ wake, two caps (formerly Bot Bus) │
│  ├─ Secrets Store      encrypted refresh tokens / TOTP; issues short-lived tokens │
│  ├─ Egress Policy      per-workspace egress allowlist, deny by default   │
│  └─ Connector Hub      MCP registry · Composio                           │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ SandboxProvider interface
                                │ create / exec / attach / snapshot / destroy / injectEnv
┌───────────────────────────────▼──────────────────────────────────────┐
│  Workspace (a group of bots sharing one computer; one by default, a second only when isolation is needed) │
│  ├─ Single Chromium + persistent profile   all bots share cookies and login state │
│  │   each run opens its own tab; when a human takes over the whole browser is locked │
│  ├─ Playwright MCP (one instance) · CLI · vision fallback                │
│  ├─ noVNC: manual login / MFA / takeover, one login serves the whole group │
│  ├─ Shell · FS · tty · connector MCP    shared by all bots               │
│  ├─ /work: shared working area and scripts                              │
│  ├─ /home/<bot>: each bot's SOUL MEMORY diary .claude                   │
│  └─ Sidecar × N = SDK host process       one per run, cwd points at that bot │
│        PreToolUse hook · canUseTool · risk tiers · redaction · event stream │
└──────────────────────────────────────────────────────────────────────┘
```

Design principles:

- **Thin control plane**: the Gateway only does registration, scheduling, approvals, ledger, knowledge, messaging, secrets, egress policy. It does not call a model.
- **Standard parts on the execution plane**: the agent loop is the Claude Agent SDK, the browser is Playwright (MCP, CLI), screen takeover is noVNC. The sidecar is the process that calls the SDK, not an extra layer.
- **One workspace per group of bots, as if sitting at the same computer**: browser, cookies, filesystem, shell are all shared by default. Sharing needs no mechanism; it is the default state.
- **Bots are distinguished by execution context, not by infrastructure**: what distinguishes a bot is its `SOUL.md`, working directory, the tools given in its prompt, scheduling and ledger attribution. These are soft distinctions, not security boundaries, and the documentation says so. When real isolation is needed, escalate to a second workspace; the unit is the workspace, not the bot.
- **Credentials never land in the Gateway in plaintext**: the Gateway holds only encrypted refresh tokens and TOTP secrets and issues short-lived tokens to the workspace. Passwords and cookies live only in the workspace volume.
- **Every run is traceable and resumable**: every trigger first writes a run row; a run can stop for approval and resume from the same position hours later.
- **No egress by default**: each workspace can only reach a human-maintained domain allowlist that the agent cannot edit. This guards against prompt injection splicing data into a URL to exfiltrate it, regardless of which bot is running.
- **The model is configuration**: the default model and the cheap model come from deployment configuration; no model name appears in code.

---

## 3. Core components

### 3.1 Bot definition

| Item | Location | Notes |
|---|---|---|
| `SOUL.md` | `/home/<bot>/` | Identity, role, tone, boundaries. Human-editable, versioned |
| `MEMORY.md` | `/home/<bot>/` | Implicit rules. The agent may append, humans may edit or delete |
| `memory/YYYY-MM-DD.md` | `/home/<bot>/` | Daily work notes, appended automatically when a run ends |
| `skills/` | `/home/<bot>/` | Skills, from a skill marketplace or local |
| `.claude/` | `/home/<bot>/` | SDK session transcripts and configuration. `CLAUDE_CONFIG_DIR` points here; resume depends on it |
| bot row | Gateway SQLite | Name, role, model, `workspace_id`, connector allowlist, approval rules, cron |

`/home/<bot>/` is a directory in the same workspace filesystem, not an isolated volume. Bots in the same group can read each other's directories, and this is intentional: one bot can read another bot's diary to learn what it did. Anything that truly must be hidden does not go here.

Memory has three layers: the bot's own files, the team shared knowledge base, the run ledger. All plaintext markdown or SQLite.

### 3.2 Sidecar and agent loop

The sidecar is the Node process inside the workspace that calls the SDK's `query()`. **One sidecar process per run**; several may run at the same time inside one workspace, belonging to different bots. It is responsible for:

- Assembling context: that bot's `SOUL.md` as the system prompt, `MEMORY.md` and the last 3 days of diary, the trigger payload, the top 5 knowledge base search hits, the list of available tools. The payload of a thread wake is the slice of messages that bot has not seen in this thread, each with an author label (human, a given bot, system); other bots' messages are presented as "from bot X", not as human instructions, and whether to comply is decided by that bot's `SOUL.md` (ADR-0005 item 9).
- Registering MCP servers: the browser MCP is the same for the whole group; connector MCPs are registered according to the list in that bot's definition. This is a soft choice at the prompt layer that decides which tools the agent sees, not access control: a bot in the same container can call any connector through the shell.
- Providing thread tools: `thread_post(body, attachments)` sends a message to the current thread at any time during a run, for progress, questions and handoffs alike; `message_bot(to, body, attachments)` sends an asynchronous direct message to another bot (see 3.7). Who gets woken is decided by the Gateway; the sidecar does no routing.
- In the `PreToolUse` hook: risk tiering, egress check, browser lock check, redaction; in the `canUseTool` callback: the short wait.
- Pushing the event stream (tool calls, results, thinking, screenshots, approvals, takeovers) back to the Gateway, with bot attribution on each event.
- Emitting a structured summary when the run ends: what was done, which files changed, which sites were visited, pending approvals, rules suggested for appending to `MEMORY.md`, and `reply`. A non-empty `reply` is posted as that bot's final message in the thread; an empty one means the bot chose to stay silent, and the run's terminal state is recorded as `silent`.

Fixed SDK configuration: `CLAUDE_CONFIG_DIR=/home/<bot>/.claude`, `settingSources: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `cwd=/work`. Bots are distinguished by `CLAUDE_CONFIG_DIR` and the system prompt, not by process isolation.

Model access: the sidecar receives `ANTHROPIC_BASE_URL` and a short-lived `ANTHROPIC_AUTH_TOKEN` (Bearer) from the Gateway. S0 confirmed the proxy only accepts Bearer and that subscription OAuth credentials cannot be forwarded. The default model and the cheap model are deployment configuration. S0 ran the full loop on glm-5.3 and deepseek-v4.1-flash; long-session quality is re-baselined on the deployed model at M0 acceptance.

Session continuation: the session id is stored per `(bot, thread)` (`bot_sessions` table); approval resume and continued chat in the same thread both use `resume`; reopen after a SOUL change. A thread has as many sessions as it has bots; the thread's transcript itself lives in no session, but in the Gateway's `thread_messages`.

### 3.3 Browser and login state

**Single-instance principle**: each workspace runs exactly one headed Chromium, `--user-data-dir` pointing at the volume, `--remote-debugging-port=9222`. Playwright, the human in noVNC, and screenshots all connect to that one instance. S0 test-c verified three clients attaching concurrently, state visible across them, and cookies persisted to disk.

**Three driving modes**:

| Mode | Purpose | When |
|---|---|---|
| Playwright MCP (accessibility tree), `--cdp-endpoint … --caps vision` | Exploring unknown pages | Default |
| Playwright CLI, `attach --cdp=…` | Long sessions, regression, batch operations | Once a stable flow is fixed; token-sensitive tasks |
| Vision fallback (screenshot + coordinates) | When the accessibility tree fails | Shadow DOM, canvas, image buttons |

S0 verified that a button inside a closed shadow root is invisible in the accessibility tree and a coordinate click hits it. The switching rule is executed by the sidecar: when MCP fails to find the target element twice in a row, a screenshot is attached automatically and coordinate clicks are allowed; the agent fixes stable flows into scripts stored under `/work/scripts`, and only falls back to exploration when a script fails.

**Login state belongs to the workspace, and sharing is the default state.** A workspace has only one Chromium and one profile, so bots in the same group naturally share the same cookies, localStorage and login state. There is no identity object, no grant, no borrowing, no proxy here, because nothing needs to cross a boundary. A human logs in once in noVNC and every bot in the group is immediately logged in.

There is only one set of tool names: `mcp__browser__browser_navigate`. Which bot called it is recorded in the ledger's bot attribution, not in the tool name.

**Why a workspace can have only one Chromium**: Chromium places `SingletonLock`, `SingletonSocket`, `SingletonCookie` in the user data dir, and starting a second instance on the same profile fails; Cookies is SQLite, Local Storage is LevelDB, both single-writer. This constraint is the valid conclusion left over from ADR-0003: to share cookies, the one browser process must be shared; copying the profile does not work.

**Concurrency is a correctness problem, not a permission problem.** Several bots using one browser at the same time need coordination, but the purpose of the coordination is to avoid stepping on each other, not to keep anyone out.

| Situation | Behavior |
|---|---|
| Each run opens its own tab | Default. Different tabs run in parallel without interference and share cookies |
| A human clicks "take over" in noVNC | The Gateway records a human-held browser lock for that workspace; browser tools in all runs return "a human is operating, please wait"; no screenshots during that time |
| A run wants to operate a tab it does not own | The later arrival queues on the workspace browser lock. This is the only inter-run queueing in lock v1; runs on the same site and the same record but each in its own tab do not wait for each other; the rate of stepping on each other is measured as `interference_rate`, and lock granularity is only escalated above 5% (defined in ADR-0004) |
| A tab is held for a long time | The lock has a TTL, renewed on every tool call, released when the run ends or times out |

**When isolation is needed, open a second workspace.** There is only one criterion: should the two pieces of work share login state and files. Do not put a production system and a personal account in the same workspace. This is far simpler than per-bot permissions, and it is a real boundary, not a soft convention.

**No defenses between bots.** Inside one workspace, any bot can reach any site this browser is logged into and read or write any file. This is dictated by the product shape, the same as Grok Bot: the bot boundary is not a security boundary. The real lines of defense are three: the egress allowlist blocks data exfiltration, L2 approval blocks external side effects, workspace partitioning blocks mixing trust domains.

**The role of storageState**: backup and cloning only, for example copying login state into a throwaway workspace for a dangerous operation. It carries cookies, localStorage, IndexedDB, OPFS and virtual WebAuthn, but not sessionStorage.

**Handling lost login**: a workspace may optionally configure a probe URL and a judgment rule that the sidecar visits periodically. When lost login is detected the workspace is set to `needs_login`, runs in that workspace enter waiting, and a human is notified to log in again. The probe itself may trip risk controls, so it is off by default.

### 3.4 Triggers and scheduling

Trigger sources: thread messages (messages posted in a thread by a human or a bot, see 3.7), cron, webhook (`/hooks/<bot>/<token>`), approval replies.

| Lane | Trigger source | Concurrency | Notes |
|---|---|---|---|
| Interactive lane | Messages in a `chat` thread, approval replies | 1 per bot | Someone is watching, takes priority |
| Background lane | cron, webhook, messages in a `bus` thread | 1 per bot | Long tasks, queued |

The lane follows the thread, not whether the sender is a human or a bot: when a bot mentions another bot in a `chat` thread created by a human, the other bot is woken on the interactive lane, because a human is watching. Wakes for the same `(bot, thread)` are merged: one already queued is not enqueued again; mentions received while the bot is running are merged into a single wake after it finishes, with all new messages from that period as the payload.

The two lanes each run an independent SDK session and share the workspace, `/work` and the browser lock. An interactive run can read the ledger to answer "how is the background task going"; if it needs to write `/work` or use the browser while a background run holds them, the sidecar returns "resource busy", and the agent tells the user and offers the options of waiting or cancelling the background run. The background lane queue has an upper bound; a cron trigger is skipped and logged if the previous round has not finished.

### 3.5 Approvals and permissions

Three risk tiers: L0 read-only is allowed by default; L1 reversible writes are allowed by default and can be configured to require approval; L2 external side effects require approval by default.

Mapping onto the SDK (verified in S0):

| Situation | Mechanism | Run status |
|---|---|---|
| L0 / L1 | `PreToolUse` hook returns `allow` | `running` |
| L2, human online | `canUseTool` callback blocks, 5 minutes by default | `waiting_approval_live` |
| L2, timeout or human offline | hook returns `permissionDecision: "defer"`; the query ends and reports the session id; the process may exit | `waiting_approval` |
| Approval arrives | The Gateway reopens the run with `resume: sessionId`; the SDK hands the deferred call back to the hook, which now allows or denies it | `running` |

The definition of "human online" (an active subscription or a heartbeat within 60 seconds), the TTL and revocation of short-lived tokens, and pricing for unknown models are in the Definitions section of ADR-0002.

Decision options: Allow once / Always allow (generates a rule) / Deny. Rules are stored in SQLite and can be revoked from the UI. Matching dimensions: tool name, target origin, SQL statement type, amount threshold, file path, originating bot.

### 3.6 Team shared knowledge base

A markdown directory managed by the Gateway, with a SQLite FTS5 full-text index and optional database vector search. Writes need human review, or a designated knowledge maintainer bot distills diaries and run records. All bots access it through `knowledge_search` and `knowledge_read`. The source of truth is in the control plane, not in any bot's session.

### 3.7 Multi-bot collaboration

Bots in the same group already share `/work` and the whole filesystem, so exchanging files needs no extra mechanism; agree on a directory. All collaboration at the conversation level happens in **threads** (ADR-0005).

**Threads have members.** A thread belongs to one workspace; its members are bots in that workspace, ordered by join order. `kind` has two values: `chat` is created by a human through a client, `bus` is created by a bot through `message_bot`. A one-member `chat` thread is the M0 chat. A `chat` thread has at most 6 bots (copied from Grok Bot); the title is generated from the members and can be changed; a human mentioning a non-member bot from the same workspace pulls it in, and it receives the full history on its first wake. A bot cannot pull anyone in; it can only mention members. Threads do not cross workspaces: the workspace is the trust domain, and cross-domain messages should pass through human eyes first.

**The transcript belongs to the Gateway.** `thread_messages` is the truth: every message from humans, bots and the system is written in order with its author. Each bot has one SDK session per thread, which is its own memory; on wake it is delivered the slice it has not seen, and `thread_members.last_seen_seq` records its progress.

**Who gets woken.**

| Message | Who is woken | How |
|---|---|---|
| Mentions one or more bots | The mentioned members | In parallel, one run each |
| `@everyone`, or no mention at all | All members | In turn by join order: the (n+1)th is woken only after the nth finishes, so it can see whether someone before it answered and may stay silent |

In-turn wake proceeds per message; a second message without a mention queues behind the current round. An explicit mention's wake is not blocked by the round-robin. This is Grok Bot's routing, copied together with its cost: in a 6-bot group, one message without a mention may take up to 6 runs before someone actually answers. The countermeasure is also the same as Grok Bot's: name an owner bot. Cheaper methods (first use `CHEAP_MODEL` to judge whether to answer; a thread owner switch) are knobs to be tested and decided after M2 measurement.

**A bot sending a message is an action.** A run can `thread_post` at any time; the `reply` in the summary at run end is the final message; an empty `reply` is silence, and the run is recorded as `silent`. `@<bot name>` is resolved by the Gateway against the member table; channel adapters map native mentions; unknown names and self-mentions are ignored.

**The Bot Bus is a thread.** `message_bot(to, body, attachments)` is still a tool any run (including runs with no human, such as cron and webhook) can call. The implementation: find or create the `bus` thread whose two members are the caller and `to`, deliver the message mentioning `to`, and wake the other side; the other side handles it in its own run and may mention back in this `bus` thread later. If the caller's run belongs to a `chat` thread, that thread gets a system message "handed off to `to`" linking to the `bus` thread, so the human sees the handoff where they are already looking. The allow list in the bot definition still governs `message_bot`; inside a `chat` thread, the members are the allow list. Both are routing configuration, not access control (ADR-0004).

**Two caps.**

| Cap | Scope | Default | When exceeded |
|---|---|---|---|
| `relay_count` | One message chain: a message sent from a run inherits the triggering message's count plus one; a human message is 0 | 5 | The message is still stored, its mentions wake nobody, and an alert is raised |
| `turn_budget` | One thread: the number of bot messages since the last human message | 8 | Same as above; the thread is set to `paused` and a human is notified; the next human message resets it |

`relay_count` governs depth (A → B → C → …), `turn_budget` governs volume, because A and B can start a new chain every round. Silent runs count toward neither. A `bus` thread has no human to reset it, so exceeding the cap is an operational alert. Grok Bot has neither cap, and user feedback is exactly "repeating each other, pointless loops, spending quota on discussion".

**The chief-of-staff pattern** needs no wait primitive: the chief mentions two experts and ends its run; the experts each reply and mention the chief; the chief is woken once with both replies merged (twice if the two replies straddle its run boundary). The decomposition logic lives in the chief's SOUL; the harness only provides threads. Operational documentation follows Grok Bot's advice: one owner per stage; name the bot when you know who should do it; a message without a mention is billed by member count.

**Every hop is traceable.** `thread_messages.run_id` points at the run that sent it, `runs.trigger_ref` points at the message that woke it. A group chat replays as: human message → run(A) → message(A, @B) → run(B) → message(B, @A) → run(A). Attribution, usage and approvals are still per run, that is per bot.

### 3.8 Connectors and credentials

| Type | Where the credential lives | What the workspace gets |
|---|---|---|
| Model proxy | Gateway holds the upstream key | `ANTHROPIC_BASE_URL` + a short-lived `ANTHROPIC_AUTH_TOKEN` issued per run |
| MCP service | Gateway registry, registered into a bot's sidecar per its definition (soft choice, see 3.2) | MCP endpoint and short-lived token; other bots in the same container can read it |
| SaaS OAuth | Gateway Secrets Store, refresh token encrypted | Short-lived access token issued per run |
| Browser login | The workspace's `/profile` volume | A human logs in once in noVNC; every bot in that workspace can use it immediately |
| TOTP | Gateway Secrets Store | Injected into the supervisor process environment. Under the same container and same user, a bot with a shell can read the environment in `/proc`, so TOTP is a workspace-level secret; only put accounts that belong to that trust domain there |
| CLI tools | Image preinstalls psql, git, gh, python, node | No credentials |

Rules: the Gateway database stores no plaintext password and no cookie; the workspace stores no refresh token; the ledger redacts tokens and cookies. No secret inside a workspace is invisible to its bots: the cookie database in `/profile`, other bots' session transcripts, and any process environment are all in the same trust domain.

### 3.9 Observability and cost

The run ledger records: status, lane, trigger source, start and end time, per-model input / output / cache_read / cache_create tokens, tool call sequence, thinking, screenshots, approvals, takeovers, final summary. Logs are pushed in real time over SSE.

Cost is computed by the Gateway from the price table. The `costUSD` the SDK reports for non-Anthropic models is not trustworthy (S0: `costBasis: unknown`). Aggregated per bot per day, with an optional soft-limit alert. Each run records the number of uses of each of the three browser driving modes.

### 3.10 Security

The security boundary is the workspace, not the bot. There are no defenses between bots in the same group; that is part of the product shape.

- Workspace isolation: each workspace has its own container, its own volume, its own network namespace. One workspace equals one trust domain.
- Egress: deny by default. Each workspace has one domain allowlist, maintained by humans in the UI; the agent has no right to change it. Navigation outside the allowlist is intercepted and sent to approval even at L0. This guards against prompt injection exfiltrating data.
- Prompt injection: content returned by the browser and external tools is wrapped in an "untrusted content" marker before entering model context; L2 must be approved; no screenshots during takeover.
- Audit: all L1/L2 actions, approval decisions, allowlist changes and browser lock changes are written to an append-only log, with the originating bot recorded.
- Explicitly not done: no access control between bots. To isolate, open a new workspace. Per-bot permissions bring a lot of complexity yet block nothing on the same computer.
- **Default grouping rule**: one business scenario, one workspace. Bots that browse untrusted sites (scenario 1 testing) and bots that hold production credentials (scenario 2 database, scenario 3 data sources) are never in the same workspace. The criterion: if one of the bots is hijacked by page injection, is what it can reach acceptable.
- **Capacity**: one sidecar process per run, two lanes per bot, and the official SDK guidance is about 1 GiB per session and up. A 3-bot workspace peaks at 6 sidecars plus Chromium; plan container memory from 8 GiB; correct after measuring peak RSS with real runs in M1.

---

## 4. Data model (Gateway SQLite)

```
workspaces       id, name, sandbox_provider, status(ready|needs_login|disabled),
                 probe_url, probe_rule_json, created_at
browser_locks    workspace_id, holder_kind(run|human), holder_run_id, acquired_at, expires_at
bots             id, name, role, workspace_id, model, cheap_model, soul_version,
                 connectors_json, cron_json, created_at
threads          id, workspace_id, kind(chat|bus), channel, title, turn_budget,
                 status(active|paused), created_at, updated_at
thread_members   thread_id, bot_id, last_seen_seq, joined_at
thread_messages  id, thread_id, seq, author_kind(human|bot|system), author_id,
                 body, attachments_json, mentions_json, relay_count, run_id, ts
bot_sessions     bot_id, thread_id, sdk_session_id, updated_at
runs             id, bot_id, thread_id, lane(interactive|background),
                 trigger_kind(thread_message|cron|webhook|approval), trigger_ref,
                 status, sdk_session_id, resume_payload_json, started_at, finished_at, summary_json
run_usage        id, run_id, model, input_tokens, output_tokens, cache_read_tokens,
                 cache_create_tokens, cost_usd
prices           id, model, input_per_m, output_per_m, cache_read_per_m, cache_create_per_m, effective_from
run_events       id, run_id, seq, kind(tool_call|tool_result|thinking|screenshot|log|approval|takeover),
                 payload_json, ts
approvals        id, run_id, action_json, risk_level, decision, decided_by, decided_at, wait_mode(live|deferred)
approval_rules   id, bot_id, matcher_json, decision, created_from_approval_id
egress_rules     id, workspace_id, domain_pattern, created_by, created_at
knowledge_docs   id, path, title, body, source_run_id, approved_by, updated_at
knowledge_fts    FTS5 virtual table
connectors       id, kind, name, config_json
secrets          id, owner_kind(connector|workspace|model), owner_id, encrypted_blob, rotated_at
```

`bot_messages` has been replaced by `thread_messages` (ADR-0005): a bot direct message is a message in a `bus` thread.

Run state machine:

```
queued → running → succeeded | silent | failed | cancelled
              ↓
   waiting_approval_live → running        (short wait, process not exited)
              ↓
   waiting_approval      → running        (defer persisted, resume)
              ↓
   waiting_browser       → running        (human takeover in progress or workspace needs_login; resumes once cleared)
```

`silent`: a thread-woken run ends normally but `reply` is empty, the bot chose not to answer; kept separate from `succeeded` in the ledger, and neither cap counts it.

---

## 5. Sequence of one run

1. A trigger reaches the Gateway. A thread message is first written to `thread_messages`, then the rules in 3.7 decide who to wake, whether in parallel or in turn, and whether a cap was hit; each woken bot is placed on a lane by thread kind (`chat` interactive lane, `bus` background lane) or by trigger source, and a `runs` row is written with status `queued`; if the same `(bot, thread)` is already queued, the wakes merge.
2. The scheduler confirms that bot has no run in progress on that lane and sets `running`. It starts a sidecar process in the workspace that bot belongs to, passing the payload and a short-lived model token. Other bots' sidecars may already be running in the same workspace.
3. The sidecar assembles context, registers the workspace's MCPs, and calls `query()`.
4. Every tool call enters the `PreToolUse` hook: egress allowlist, browser lock, risk tiering, redaction. L0/L1 pass; L2 enters the `canUseTool` short wait.
5. If the short wait times out, the hook returns `defer`, the run is set to `waiting_approval`, and the process exits. After the human decides, the Gateway reopens with `resume`, injects the decision, and continues.
6. If the browser is taken over by a human or the workspace is in `needs_login`, browser tools return a wait message, and the run is set to `waiting_browser` when necessary.
7. At the end, the agent emits the structured summary; the sidecar appends the diary, reports per-model usage, and submits knowledge base entry suggestions.
8. The Gateway posts the `reply` from the summary into the thread as that bot's message (if empty, the run is recorded as `silent`), resolves the mentions in it and returns to step 1 to wake the next bot; prices the run, sets the terminal state, and notifies clients over SSE.

---

## 6. Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Gateway | Node.js + Fastify + SQLite (better-sqlite3) | Single process, easy to deploy, same stack as the rest of the repo |
| Agent loop | Claude Agent SDK (0.3.278 verified) | Tool calls, planning, error recovery, defer and resume are all built in |
| Sandbox | SandboxProvider interface; Docker by default. One container per workspace | Docker is the simplest to self-host; the interface is left for Desktop VM and hosted sandboxes |
| Image | `mcr.microsoft.com/playwright:v1.58.2-noble` + Xvfb, x11vnc, noVNC, xdotool | Verified in S0; MCP, CLI and SDK must be preinstalled |
| Browser | Single-instance Chromium + Playwright MCP / CLI + screenshot fallback, shared by the whole group | Tree mode is cheap and reproducible, CLI saves tokens, vision covers blind spots; sharing is a product requirement |
| Screen | Xvfb + noVNC | Humans can take over, zero client install |
| tty | `tty_session` tool wrapping node-pty | Interactive CLIs, timeouts, control characters |
| Connectors | MCP first, Composio to fill in SaaS | MCP has become the standard |
| Web UI | React + Vite | Same as the Cogbox frontend |
| Channels | WhatsApp; connection mechanism to be verified in the channel ADR | M3; Slack deferred by C43, Telegram not a required M3 deliverable |

Options dropped: Claude Managed Agents (cannot self-host, cannot swap models; kept as a future Provider); hosted sandboxes (added later behind the Provider interface); forking OpenMausBot (tied to the desktop form factor); building directly on Paperclip (too large, kept as an upper layer); an in-house CDP proxy (violates the standard parts principle); a shared profile volume (guaranteed corruption); identity objects plus per-bot grants (ADR-0004: high complexity, and blocks nothing on the same computer).

---

## 7. Integration with existing assets

| Existing asset | Integration |
|---|---|
| Desktop VM | Implement `DesktopVMProvider`; the desktop app acts as a client |
| Model proxy and skill marketplace | Model proxy, usage metering, skill marketplace; the proxy must satisfy the pass-through checklist in the S0 results document and accept only Bearer |
| Anthropic-protocol model gateway | Verified usable as a model proxy; GLM / DeepSeek / Qwen available |
| Database MCP server | Built-in connector; bots access it with a service identity issued by the Gateway |
| Database skill / database guidance | Initial knowledge base content and bot skills |
| fund-tool | First sample CLI tool for the quant scenario |
| Paperclip | When multi-person governance is needed, wrap the Gateway as an adapter |

---

## 8. Milestones

| Phase | Content | Acceptance |
|---|---|---|
| S0 (done, 2026-09-20) | Model proxy pass-through; defer and resume; shared browser | All three passed, see the S0 results document |
| M0 (2 weeks) | `contracts`; Gateway skeleton and SQLite migrations; Docker Provider; one workspace, one bot; the sidecar's SDK loop and hook skeleton; Chromium + Playwright MCP; web chat; **browser endpoint and model come from configuration** | One bot logs into a site on a chat instruction and completes a form, with screenshots in the ledger; swapping the model changes only `.env` |
| M1 (4 weeks) | Two scheduling lanes; cron; webhook; both approval modes and rules; egress allowlist; noVNC takeover and browser lock; tty tool; per-model pricing; ledger replay | A bot runs on schedule; an L2 short wait is persisted after 5 minutes and resumes on approval the next day; the agent continues after a human completes a captcha via takeover; the cost dashboard is split per model |
| M2 (4 weeks) | **Multi-bot concurrency inside one workspace**; group threads: mention wake, in-turn wake, two caps, `thread_post`, `message_bot`; knowledge base; MEMORY rules; vision fallback; CLI mode; a second workspace and isolation switching | A human logs in once, two bots each open a tab and work on the same site in parallel sharing login state; a human mentions two bots in a group and both start at once; a chief bot decomposes a task to two expert bots in the group and aggregates; a message without a mention is answered by exactly one member and the rest stay silent; all wait during human takeover; a shadow DOM page is completed via vision fallback |
| M3 (5 weeks) | Database connector (ADR-0012); scenario images; WhatsApp channel (C43); cost alerts; context and memory: per-turn window and compaction observability, agent-maintained memory scoped as task state, workspace facts, bot experience and human-owned rules (ADR-0011), then measured context bounds (`m3-context-and-memory-plan-2026-09-29.md`) | Each of the three scenarios runs one end-to-end flow; every run records per-turn usage and compactions; learned memory is kept in the right scope without per-item human review, and only conflicts or rule changes ask the human; each adopted context knob passes a paired comparison |

15 weeks in total after S0. The identity host effort cut by ADR-0004 is given back to M2's multi-bot concurrency, which is the real risk point. The Desktop VM Provider (section 7) is not scheduled in any milestone since 2026-09-29; it returns when a scenario needs a non-Docker execution plane.

---

## 9. Open questions

1. Model path: a model proxy fronting Claude, or an Anthropic-protocol gateway fronting GLM / DeepSeek / Qwen. Affects the baseline for the ratings in v0.2 section 10.
2. ~~The scope of Playwright MCP's `--allowed-origins`~~. No longer needed after ADR-0004: the parameter is no longer in the design. Archived conclusion: reading the `@playwright/mcp` 0.0.82 source, the implementation is `context.route()`, that is context-level, and several instances sharing one context conflict with each other; the official documentation also states it is not a security boundary and does not apply to redirects.
3. Whether the desktop VM is one VM per workspace or one VM running several containers. Not scheduled: the Desktop VM Provider left M3 on 2026-09-29 (C41).
4. Issuance and rotation of the database MCP server's service identity.
5. Knowledge base: FTS5 first, or database vectors from day one. FTS5 first is recommended.
6. Whether the 5-minute default short wait is configurable per bot.
7. ~~Listen address and origin restrictions for cross-container CDP~~. No longer needed after ADR-0004: MCP and Chromium are in the same workspace container, and CDP is only on `127.0.0.1`.
8. Whether the browser lock granularity is enough when several bots run concurrently in one workspace. The current design has only one workspace-level lock, which may serialize tabs that could have run in parallel. Calibrate against real scenarios in the first week of M2.
9. The relationship between the workspace container's memory limit and the number of concurrent sidecars per bot. Measure in M1.
10. In a group thread, a message without a mention wakes members in turn, and cost grows linearly with member count. Cost-saving measures (first use `CHEAP_MODEL` to judge whether to answer; an optional thread owner) are knobs to be tested; decide after measuring on `acceptance/m2-group` in M2; the `turn_budget` default of 8 is calibrated at the same time.
11. Whether a mention received while running waits for the run to finish before waking, or is fed into the current session through the SDK's streaming input. Decide in M2 based on whether wake latency is perceptible.

---

## 10. Verified and unverified

| Assumption | Status | Basis |
|---|---|---|
| SDK runs streaming, tools and cache through a custom Base URL | Verified | S0 test-a, glm-5.3 and deepseek-v4.1-flash |
| L2 action deferred, process exits, resume continues | Verified | S0 test-b, two independent processes |
| The callback can block for a long time | Verified | S0 test-b short-wait, 20 seconds |
| One Chromium attached concurrently by MCP, a human and screenshots | Verified | S0 test-c |
| The accessibility tree cannot see a closed shadow root; coordinates can hit it | Verified | S0 test-c |
| Cookies persist to the profile volume | Verified | S0 test-c |
| Playwright CLI can attach to the same CDP | Documentation level | `attach --cdp` |
| ~~Borrowing a remote MCP across sandboxes~~ | No longer needed | After ADR-0004, MCP and Chromium share a container |
| ~~The scope of MCP origin filtering~~ | Archived | Source is `context.route()`, context-level; no longer used in the design |
| Several sidecars in one workspace concurrently sharing one Chromium and one lock | Unverified | First week of M2 |
| Workspace peak memory | Unverified | M1 |
| Resume after an hours-long defer | Unverified | M1 |
| Session transcripts across hosts | Unverified | M1, persistent volume or SessionStore |
| Egress allowlist at the container network layer | Unverified | M1 |

---

## 11. Scenario conclusions (from v0.2 section 11)

| Scenario | Feasibility | Platform coverage | Main domain-layer work | Biggest risk |
|---|---|---|---|---|
| Automated product testing | High | About 75% | Oracle definition, script fixing, environment reset | Mistaking non-deterministic exploration for regression |
| Data platform development | Medium-high | About 55% | Schema knowledge base, import wizard, governance rules | NL-to-SQL accuracy on complex databases |
| Quant research group | Medium-low / medium-high | About 30% | Deterministic backtest engine, bias check tools, data sources | Statistical sloppiness and hallucinated results |

Order of advancement: one, two, three. Ratings assume a Claude-class model; if the deployed model is GLM / DeepSeek, re-baseline at M0 acceptance.

---

## 12. Risk matrix

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Browser agent reliability insufficient | High | Medium | Three driving modes; scripts carry regression |
| Accessibility tree blind spots | Medium | Medium | Vision fallback; M2 acceptance includes a shadow DOM page |
| Deployed model falls short of Claude-class on long tasks | Medium | High | Re-baseline on the deployed model at M0 acceptance; critical bots can be configured with Claude |
| Resume fails after an approval is persisted | Low (verified) | High | Ledger summary + approval result reopen a new session; persistent volume |
| Prompt injection through web content | Medium | High | Egress deny by default; untrusted content marker; L2 approval |
| One injected bot affects the whole workspace | Medium | High | Accepted product cost. One workspace, one trust domain; egress deny by default; L2 still approved; default grouping per 3.10, scenario 1 and scenarios 2/3 in different workspaces |
| Bots in the same group can read each other's session transcripts and the cookie database in `/profile` | High (certain) | Medium | Accepted: same trust domain. Do not put accounts outside that trust domain in the workspace; redaction of the ledger and transcripts reduces the exposure |
| Sidecar killed by workspace memory shortage | Medium | Medium | Capacity planning per 3.10; measure in M1; the scheduler caps concurrent sidecars per workspace |
| Workspace loses login and the whole group stalls | Medium | Medium | Liveness probe; `needs_login` waits uniformly and notifies a human |
| Several bots step on each other in the same browser and filesystem | Medium | Medium | One tab per run; workspace browser lock; working directory conventions; calibrate lock granularity in the first week of M2 |
| Token cost out of control | Medium | Medium | Daily budget per bot; CLI instead of MCP for long sessions; cheap model |
| Database engine instability blamed on the bot | Medium | Medium | Error classification; engine errors go to a defect ticket |
| Quant results not reproducible | High | High | Numbers in reports must come from run artifacts |
| Bots waking each other out of control | Low | Medium | Allow list + relay limit |
| Model proxy does not pass through | Low (verified) | High | Implement per the S0 checklist |
| Agent misoperation during human takeover | Low | High | Workspace-level browser lock; no screenshots during takeover |


### ADR-0007 prototype note (2026-09-23)

The optional origin-coordination prototype is specified in
[ADR-0007](../adr/0007-browser-origin-coordination-calibration.md). It adds a
Gateway origin queue and cancellable host-side admission inside the serialized
MCP path; the default remains ADR-0004 lock v1 until paired acceptance supports
adoption. Waiting consumes the configured run deadline, with separate wait metrics.

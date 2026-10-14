# Deskmates Design Document and Scenario Feasibility Evaluation

Date: 2026-09-20
Status: draft v0.1
Scope: a product benchmarked against xAI Grok Bot ("always-on bots + own computer + browser operation"), built on a thin-core self-developed path; and an evaluation of whether this design can support three business scenarios.

---

## 0. About this document

This document has two parts. Sections 1 to 9 are the design document, describing a technical harness that can be extended and iterated quickly. Sections 10 to 12 are an objective evaluation that answers, for each of the three target scenarios, whether it can be delivered, how much the platform covers, what is still missing, and what the main risks are.

The evaluation conclusions use these terms:

- **Feasibility level**: high / medium-high / medium / medium-low / low, meaning the confidence of "delivering a shippable, measurable version within 6 months".
- **Platform coverage**: the share of the scenario's workload that the generic harness covers; the remainder is the scenario-specific "domain layer".

---

## 1. Background and goals

### 1.1 Benchmark target

The product form of Grok Bot (2026-08 beta): a group of always-on agents with names and roles, sharing one account-level persistent cloud computer (browser, filesystem, terminal), connected to common SaaS through connectors, working automatically on a schedule or on events, and coming back to a human only when approval is needed.

Its known weaknesses: it cannot be self-hosted, the model comes from a single vendor, memory is a black box and cannot be exported, there is no security isolation between bots, about one fifth of structured tasks fail, and the only entry points are desktop and iOS.

### 1.2 Goals of this design

1. Reach the eight core capabilities of Grok Bot (persistent computer, browser operation, always-on triggers, connectors, approval gating, multi-bot collaboration, memory, clients).
2. Surpass it on the four weaknesses: self-hosted, swappable model, memory that can be queried, edited and exported, and independent isolation per bot.
3. Keep the harness as thin as possible. The agent loop and browser operation use standard parts; self-developed code is concentrated in the product layer to keep iteration speed high.
4. Connect to existing assets: a desktop VM, an external model proxy and skill marketplace, the database MCP server and database skill.

### 1.3 Non-goals

- No general multi-company governance platform (hard budget stops, multi-user RBAC, audit compliance). When needed, plug this harness into Paperclip as one adapter instead of rebuilding it in this project.
- No self-developed agent reasoning loop and no self-developed browser DOM understanding model.
- No iOS client (first phase).
- No promise to replace human business judgment (see section 10).

---

## 2. Overall architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Clients                                                       │
│  Web UI (preferred) · desktop client · Slack/Telegram │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTPS + SSE
┌───────────────▼──────────────────────────────────────────────┐
│  Gateway (control plane, single process, Node.js + SQLite)     │
│  ├─ Bot Registry     name/role/SOUL.md/MEMORY.md/connector allowlist │
│  ├─ Run Scheduler    chat trigger · cron · webhook · bot-to-bot wake │
│  ├─ Approval Broker  Allow once / Always / Deny · Auto Review    │
│  ├─ Bot Bus          messages between bots, allow list + relay cap │
│  ├─ Knowledge Store  team shared knowledge base (markdown + SQLite FTS) │
│  ├─ Run Ledger       run records, logs, screenshots, token cost  │
│  └─ Connector Hub    MCP registry · OAuth token custody · Composio │
└───────────────┬──────────────────────────────────────────────┘
                │ docker API / internal HTTP
┌───────────────▼──────────────────────────────────────────────┐
│  Bot Computer (execution plane, one container per bot)         │
│  ├─ Agent Loop       Claude Agent SDK, model via the model proxy │
│  ├─ Browser          headed Chromium, persistent profile, Playwright MCP │
│  ├─ Shell + FS       /work mounted volume, persistent; /home/bot private memory │
│  ├─ Runtime Tools    connector MCPs (database, GitHub, Slack...) │
│  ├─ Screen           Xvfb + noVNC, a human can take over at any time │
│  └─ Sidecar          logs, screenshots, network policy, health reporting │
└──────────────────────────────────────────────────────────────┘
```

Design principles:

- **Thin control plane**: the Gateway only does registration, scheduling, approvals, messaging and the ledger. It never touches model inference.
- **Standard parts on the execution plane**: the agent loop uses the Claude Agent SDK, the browser uses Playwright MCP, desktop takeover uses noVNC.
- **One bot, one container**: credentials exist only in the browser profile and the secrets volume inside the container. The Gateway never sees a password.
- **Every run is traceable**: every trigger writes one run row; logs, screenshots, cost and approval decisions all hang off that run.

---

## 3. Core components

### 3.1 Bot definition

A bot consists of the following files and records, all visible in the Gateway's SQLite and in the bot container's `/home/bot`:

| Item | Location | Description |
|---|---|---|
| `SOUL.md` | container `/home/bot/` | Identity, role, tone, boundaries. Human-editable, versioned |
| `MEMORY.md` | container `/home/bot/` | Implicit rules, such as "from now on leave quiet accounts alone until I look". The agent can append; humans can edit and delete |
| `memory/YYYY-MM-DD.md` | container `/home/bot/` | Daily work notes, appended automatically when a run ends |
| `skills/` | container `/home/bot/` | Installed skills, from a skill marketplace or local |
| bot row | Gateway SQLite | Name, role, model, connector allowlist, approval rules, cron |

Memory has three layers: the bot's private file memory, the team shared knowledge base (section 3.6), and the run ledger. All three are plain markdown or SQLite, so they are naturally queryable, editable, exportable and deletable.

### 3.2 Agent Loop

- Uses the Claude Agent SDK. Default model `claude-opus-5`; a bot can be switched to `claude-sonnet-5` to cut cost. Model requests are forwarded through the model proxy; the bot holds no upstream key.
- The input of each run is: `SOUL.md` as the system prompt, `MEMORY.md` and the last 3 days of diary as context, the trigger payload of this run (chat message, cron description, webhook body or bot message), and the list of available tools.
- The output is the final reply plus a structured "run summary": what was done, which files changed, which sites were visited, pending approval items, and rules suggested for appending to `MEMORY.md`.
- Session continuation: the SDK session id is stored per `(bot, thread)`. The same thread continues the session; a new thread or a SOUL change starts a fresh one.

### 3.3 Browser runtime

- Headed Chromium inside the container, profile persisted on a volume, login state kept across runs.
- Exposed to the agent through Playwright MCP: navigate, click, fill forms, screenshot, read the accessibility tree.
- Two driving modes coexist:
  - **Exploration mode**: the agent operates unknown pages directly with MCP tools.
  - **Script mode**: the agent freezes a stable flow into a Playwright script stored under `/work/scripts`; next time it runs the script directly and falls back to exploration mode only when the script fails.
- Every action is screenshotted automatically, stored in the run ledger, and replayable in the UI.
- A human can take over the screen through noVNC to complete steps the agent should not do, such as captchas or QR-code login.

### 3.4 Triggers and scheduling

| Trigger source | Description |
|---|---|
| chat | A user sends the bot a message in the Web UI or a channel |
| cron | Bot-level cron expression, such as "check yesterday's data import at 9:00 every day" |
| webhook | The Gateway exposes `/hooks/<bot>/<token>`; GitHub, Jira and database events can all hit it |
| bot message | Another bot sends a task over the Bot Bus |
| approval reply | After the user approves, the parked run continues automatically |

Scheduling rules: one bot runs only one run at a time; later triggers queue. The queue has a cap, so slow tasks do not pile up without bound. If a cron fires while the previous round has not finished, it is skipped and recorded.

### 3.5 Approvals and permissions

- Risky actions fall into three tiers:
  - L0 read-only: browsing, reading files, queries. Allowed by default.
  - L1 reversible writes: writing files under `/work`, sending drafts, writes to non-production databases. Allowed by default; can be configured to require approval.
  - L2 external side effects: messaging external people, placing orders, deleting data, production database writes, payments. Require approval by default.
- Decision options: Allow once / Always allow (generates a rule) / Deny. Rules are stored in SQLite and can be viewed and revoked in the UI.
- Auto Review rules: matched by tool name, target domain, SQL statement type, and amount threshold.
- A run is parked while waiting for approval; the SDK session is kept, and after approval the run continues in place.

### 3.6 Team shared knowledge base

This is where "different bots share one body of knowledge" lands.

- Storage: a markdown directory managed by the Gateway, full-text indexed with SQLite FTS5, optionally connected to the database for vector retrieval.
- Content: business terms, system inventory, schema descriptions, operating SOPs, past decisions, failure cases.
- Writes: a bot proposes "suggested for the knowledge base" entries in its run summary and a human reviews them in; or a designated "knowledge maintenance bot" periodically distills diaries and run records.
- Reads: all bots access it through the `knowledge_search` and `knowledge_read` tools, regardless of the bot's harness.
- Aligned with Paperclip's approach: the source of truth for knowledge is in the control plane, not in any bot's session.

### 3.7 Multi-bot collaboration

- The Bot Bus provides `message_bot(to, text, attachments)`. It is off by default; a bot definition must explicitly declare who it may send to.
- Every message carries a relay count. Above the cap (default 5) the message is dropped and an alert is raised, which prevents two bots from waking each other in a dead loop.
- Shared workspace: bots in the same "group" can mount the same `/shared` volume to exchange files.
- Chief-of-staff mode: one bot receives the human's goal, breaks it down, dispatches to expert bots, and reports back a summary. This is how Grok Bot does it and how the CEO in Paperclip does it. This design only provides messaging and the shared volume; the breakdown logic lives in the chief's SOUL.

### 3.8 Connectors

| Type | Implementation |
|---|---|
| MCP services | The Gateway keeps a registry and injects into the container per the bot allowlist. The database MCP server is the first built-in item |
| SaaS OAuth | Through Composio or a self-built OAuth flow; tokens are stored in the Gateway secrets volume and injected into the container as short-lived tokens |
| Browser login | A human logs in once in noVNC; the profile persists and later bots use it directly |
| CLI tools | The container image preinstalls psql, git, gh, python, node; scenario images can extend it |

### 3.9 Observability

- Run ledger: status, trigger source, start and end time, tokens and cost, tool call sequence, screenshots, final summary.
- Real time: SSE pushes run logs to the UI.
- Cost: aggregated per bot per day, with a configurable soft cap alert.

### 3.10 Security

- Container isolation: each bot has its own container, volume and network namespace; an egress allowlist can be configured.
- Credentials: browser profile and OAuth tokens live only on the container volume; the Gateway database stores no plaintext passwords.
- Prompt injection: page content read by the browser is treated as untrusted content; L2 actions must go through approval; tool output passes through unified redaction before it enters model context.
- Audit: all L1/L2 actions and approval decisions are written to a tamper-proof append-only log.

---

## 4. Data model (Gateway SQLite)

```
bots            id, name, role, model, soul_version, connectors_json, cron_json, created_at
threads         id, bot_id, channel, title, sdk_session_id, updated_at
runs            id, bot_id, thread_id, trigger_kind, trigger_ref, status,
                started_at, finished_at, tokens_in, tokens_out, cost_usd, summary_json
run_events      id, run_id, seq, kind(tool_call|tool_result|screenshot|log|approval), payload_json, ts
approvals       id, run_id, action_json, risk_level, decision, decided_by, decided_at
approval_rules  id, bot_id, matcher_json, decision, created_from_approval_id
bot_messages    id, from_bot, to_bot, run_id, body, relay_count, ts
knowledge_docs  id, path, title, body, source_run_id, approved_by, updated_at
knowledge_fts   FTS5 virtual table
connectors      id, kind, name, config_json, secret_ref
```

---

## 5. Timeline of one run

1. The trigger reaches the Gateway, which writes a `runs` row with status `queued`.
2. The scheduler confirms the bot has no run in progress, sets `running`, and starts the agent loop through the sidecar inside the container.
3. The sidecar assembles context: SOUL, MEMORY, recent diary, trigger payload, knowledge base search results (top 5 hits for the trigger text).
4. The agent executes. Every tool call is forwarded through the sidecar, which decides by risk tier whether to execute directly or park and wait for approval.
5. While parked the run is set to `waiting_approval` and the UI pushes an approval card; after the decision the run continues.
6. When finished the agent emits a structured summary; the sidecar appends the diary, reports cost, and submits knowledge base entry suggestions.
7. The run is set to `succeeded | failed | cancelled` and clients are notified over SSE.

---

## 6. Technology choices

| Layer | Choice | Reason |
|---|---|---|
| Gateway | Node.js + Fastify + SQLite (better-sqlite3) | Single process, easy to deploy, same stack as the rest of the repo |
| Agent loop | Claude Agent SDK | Built-in tool calling, planning, error recovery; a model upgrade is a product upgrade |
| Browser | Chromium + Playwright MCP | Standard tool layer, any model can drive it, script mode gives deterministic replay |
| Container | Docker, one per bot; optionally a desktop VM | Simplest isolation and persistence; an existing desktop VM can be reused directly |
| Screen | Xvfb + noVNC | Human takeover, zero client install |
| Connectors | MCP first, Composio fills in SaaS | The MCP ecosystem is already the standard |
| Web UI | React + Vite | Same as the Cogbox frontend |
| Channels | Slack Bolt, grammY (Telegram) | Mature SDKs, added later |

Options considered and rejected:

- **Fork OpenMausBot**: the most active open-source clone, but bound to the Electron desktop form; bots run on the user's own machine, not on a separate computer.
- **Build on OpenClaw**: good channel and skill ecosystem, but its shared-host model conflicts with "one bot, one computer"; OpenGrokBot has already migrated away from OpenClaw for this reason.
- **Build directly on Paperclip**: complete governance, but about 1 million lines of code, four layers of contract synchronisation, and strict UI token rules; not suited to fast trial and error. Kept as an upper-layer option.

---

## 7. Connection to existing assets

| Existing asset | How it connects |
|---|---|
| Desktop VM | Bot containers can run directly in a desktop VM; the desktop app acts as one client |
| Model proxy and skill marketplace | Model proxy, usage metering and the skill marketplace are reused directly; a bot's `skills/` syncs from the marketplace |
| Database MCP server | Built-in connector; bots use it to reach Console capabilities; psql connects directly over the PostgreSQL protocol |
| Database skill / database guidance | Initial content for the knowledge base and bot skills |
| fund-tool | The first CLI tool sample for the quant scenario |
| Paperclip | When multi-user governance, hard budget stops or approval chains are needed, wrap the Gateway as a Paperclip adapter |

---

## 8. Milestones

| Phase | Content | Acceptance |
|---|---|---|
| M0 (2 weeks) | Gateway skeleton, single bot container, SDK loop, Playwright MCP, Web chat | One bot can log in to a website and complete a form on a chat instruction |
| M1 (4 weeks) | cron, webhook, approval broker, run ledger with screenshot replay, noVNC | A bot can run on a schedule and park for approval when it hits an L2 action |
| M2 (4 weeks) | Multi-bot, Bot Bus, shared volume, knowledge base, MEMORY rules | A chief bot breaks a task down for two expert bots and summarises the result |
| M3 (4 weeks) | Database connector, scenario images, Slack channel, cost dashboard | Each of the three scenarios runs one end-to-end flow |

---

## 9. Open questions

1. Whether streaming and tool-call passthrough in the model proxy are already fully supported in the model proxy.
2. Whether a desktop VM allows one container per bot, or one VM with several bots.
3. Database MCP server authentication carries an identity on every tool call; which identity a bot uses must be decided.
4. Whether the knowledge base uses database vector retrieval from day one, or FTS5 first.

---

## 10. Scenario feasibility evaluation

Method: break each scenario into sub-goals, mark each as "covered by the harness / needs the domain layer / not achievable today", then give an overall level, risks and expected results.

### 10.1 Scenario 1: automated product testing (Web service + CLI service)

**Goal breakdown**

| Sub-goal | Coverage |
|---|---|
| Simulate a user walking through scenarios on the Web | Covered by the harness (browser runtime, exploration + script dual mode) |
| Simulate a user interacting on the CLI | Partly covered by the harness; needs a tty session tool (pexpect style, with interactive prompts and timeouts) |
| Generate test scenarios from requirements or a PRD | Covered by agent capability; the domain layer must provide case templates |
| Assertions and verdicts | Needs the domain layer. The agent judging "looks right" is unreliable; an explicit oracle is required |
| Repeatable regression | Needs the domain layer. Exploration results must be frozen into Playwright scripts or CLI scripts |
| Environment setup and reset | Needs the domain layer. Test data seeds, service start/stop, database snapshot rollback |
| Reports and defect tickets | Covered by the harness (run ledger, screenshots, Jira webhook) |

**Feasibility: high. Platform coverage about 70%.**

This is the scenario closest to the harness's capabilities of the three. Browser operation, terminal, screenshots, scheduling and webhooks are all ready-made, and exploring unknown pages, generating cases and writing scripts are strengths of current models.

**Limits that must be faced**

1. LLM-driven browser agents still fail about one fifth of structured tasks. This means **live agent exploration must not be treated as regression testing**. The right approach is: the agent explores, generates and maintains scripts; regression is run by deterministic scripts; the agent steps in only when a script fails, to diagnose whether "the product broke" or "the page changed".
2. Assertions must be defined by humans or derived from the spec. An agent deciding pass or fail on its own has a systematic optimism bias.
3. Cost: one full exploratory test can consume several hundred thousand tokens. For daily regression, script mode cost is negligible; exploration mode needs a budget.
4. The hard parts of CLI testing are interactive programs, colour control codes and timeouts. A packaged tty tool is needed, and the harness does not have one.

**Expected results**

- Exploratory testing, new-feature smoke tests, case generation: output comparable to a mid-level test engineer, available 24 hours a day.
- Regression testing: the "agent writes script + script runs + agent fixes script" loop can significantly cut script maintenance cost. This is the main selling point of current commercial products (such as QA Wolf, Momentic), and this design can reach the same form.
- Not achievable: replacing humans in defining acceptance criteria; reliable judgment of visual details and performance problems.

**Verification metrics**: script self-heal success rate, false positive rate, time from case description to executable script, number of real defects found in exploration mode.

### 10.2 Scenario 2: data platform development (import, governance, analysis)

**Goal breakdown**

| Sub-goal | Coverage |
|---|---|
| Connect to the database and run SQL | Covered by the harness + existing assets (direct psql, database MCP server) |
| Data import: format detection, table creation, partitioning, loading into DuckLake | Needs the domain layer. An import wizard tool wrapping the database's COPY/CTAS paths and GPU instance parameters |
| Governance: quality checks, lineage, naming conventions, sensitive fields | Needs the domain layer. Rules must be defined by humans first; the agent runs checks and suggests fixes |
| Analysis: natural language to SQL, result interpretation, charts | Covered by agent capability, but accuracy depends on schema knowledge |
| Schema and business term knowledge | The harness knowledge base can hold it; content must be imported from the database guidance and the real database |
| Asynchronous execution of long tasks | Supported by the harness run model; needs a job status polling tool |
| Protection against destructive operations | Covered by the harness approval broker; L2 rules must be configured by SQL type |

**Feasibility: medium-high. Platform coverage about 50%.**

The harness solves "the bot has a computer, psql, MCP and approvals". The existing database MCP server, database skill and database guidance knowledge base make the start much faster than from zero.

**Limits that must be faced**

1. **NL to SQL accuracy is the ceiling**. On databases with a few dozen tables, good column comments and a business glossary, current models get most analytical queries right on the first try; on databases with hundreds of tables and messy naming, accuracy drops clearly. The quality of the knowledge base and schema comments decides the result, and that is the main work of the domain layer.
2. **Governance is not something an agent can do from nothing**. Quality rules, lineage definitions and sensitive field lists must be defined by humans first. The agent's value is automating rule execution, turning anomalies into readable reports, and producing fix SQL that waits for approval.
3. **The database engine itself is iterating fast**. GPU instances are shared machines; resource conflicts and engine bugs will be blamed on the bot. The bot must be able to tell "my SQL is wrong" from "the engine is wrong" on errors, and record the latter as a defect instead of retrying repeatedly.
4. The import path depends on the database's specific capabilities (DuckLake, parquet, GPU mode parameters). The import wizard tool is tied to the database version, and its maintenance cost must be counted.

**Expected results**

- Import: given a file and a target description, the bot can detect the format, create the table, load, and verify row counts, executing after human review. This step can be close to fully automatic.
- Analysis: on business databases with a glossary, the bot can answer most descriptive analysis questions and produce charts; complex multi-step analysis needs human iteration.
- Governance: "rule-driven daily inspection + anomaly reports + fix suggestions" is achievable; "automatically discovering what rules there should be" is not.

**Verification metrics**: first-try success rate of import tasks, first-try SQL correctness (against a human baseline set), human adoption rate of inspection reports, data engineer hours saved per week.

### 10.3 Scenario 3: quant research group

**Goal breakdown**

| Sub-goal | Coverage |
|---|---|
| Data acquisition and loading (quotes, fundamentals, holdings disclosures) | Coverable by the harness + the database; the data sources themselves are external dependencies (AKShare, paid sources) |
| Factor implementation | Covered by agent coding capability |
| Backtest execution | Needs the domain layer. Must be a deterministic backtest engine; the agent is only the caller |
| Statistical validation and bias checks | Needs the domain layer. Look-ahead bias, survivorship bias and multiple-testing correction must be enforced by tools, not left to the agent's discipline |
| Research reports and reproduction | Covered by the harness (run ledger, knowledge base, script freezing) |
| Group roles: data / factor / backtest / risk / PM | The harness multi-bot collaboration covers the form |
| Autonomous alpha discovery | Not reliably deliverable today |

**Feasibility: medium-low (if the goal is autonomous strategy output); medium-high (if the goal is a research assistant group). Platform coverage about 30%.**

The role split of multi-bot maps naturally onto the structure of a research group, and chief-of-staff mode maps directly to a PM bot. But the bottleneck of this scenario is not the agent framework at all; it is domain tools and research discipline.

**Limits that must be faced**

1. **An agent cannot prove its own statistical rigor**. A model will write a backtest that "looks reasonable" while introducing look-ahead bias or tuning parameters repeatedly in-sample. The only defence is tooling: the backtest engine enforces time splits, the number of parameter searches counts toward multiple testing, and results must carry out-of-sample performance. These tools do not exist in the harness and cannot be done well in one sprint.
2. **Result hallucination risk is higher than in the other scenarios**. Once numeric results are summarised into a report by the agent, humans can hardly check them. All numbers must come from the output of reproducible scripts, and reports may only cite artifacts in the run ledger.
3. **Data cost and quality**. Free sources (such as AKShare) have clear latency and gaps; the fund-tool design document already notes that holdings disclosures lag by one quarter. Paid sources need budget and compliance.
4. **Compliance and responsibility boundary**. Any automated research conclusion entering live trading decisions needs a human signature. At the system level "research" and "trading" must be physically separated; this design does not include trade execution.

**Expected results**

- Achievable: automatic data pipeline maintenance, factors implemented to spec, batch backtest scheduling, report generation, summaries of literature and announcements, daily data quality inspection. Equivalent to giving the research team several tireless research assistants.
- Not achievable: reliably discovering tradeable alpha autonomously; replacing the human's final judgment on a strategy.
- Synergy with scenario 2: if all research data lands in the same database, the import and governance capabilities of scenario 2 are reused directly. This is the clearest compounding point in this design.

**Verification metrics**: turnaround time of a backtest task from description to result, reproducibility rate of report numbers (should be 100%), self-heal rate of data pipeline failures, researcher satisfaction.

---

## 11. Overall conclusion

| Scenario | Feasibility | Platform coverage | Main domain layer work | Biggest risk |
|---|---|---|---|---|
| Automated product testing | High | About 70% | Oracle definition, script freezing, tty tool, environment reset | Mistaking non-deterministic exploration for regression |
| Data platform development | Medium-high | About 50% | Schema knowledge base, import wizard, governance rules, destructive operation rules | NL to SQL accuracy on complex databases |
| Quant research group | Medium-low / medium-high | About 30% | Deterministic backtest engine, bias validation tools, data sources, reproduction discipline | Statistical looseness and result hallucination |

Three judgments:

1. **The harness itself can reach the Grok Bot product form within the 14 weeks of M0 to M3**, and surpass it on self-hosting, swappable model, queryable memory and bot isolation. Confidence here is fairly high because the core parts are all standard.
2. **Scenario value is decided by the domain layer, not by the harness.** The difference between the three scenarios is not whether the agent can operate a computer, but whether there are reliable verdict tools. The oracle in the testing scenario, the governance rules in the data scenario, and the backtest engine in the quant scenario all have the structure "humans set the rules first, then the agent executes".
3. **The recommended order is 1, 2, 3.** Scenario 1 shows results fastest and validates the harness; scenario 2 builds on existing database assets and prepares the data foundation for scenario 3; scenario 3 goes last, and should be chartered as a "research assistant group", not "autonomous strategy discovery".

---

## 12. Risk matrix

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Browser agent reliability is insufficient | High | Medium | Exploration + script dual mode; scripts carry regression |
| Prompt injection attacks the bot through web page content | Medium | High | Mandatory approval for L2 actions, page content marked untrusted, egress allowlist |
| Token cost runs out of control | Medium | Medium | Daily budget per bot, script mode replaces exploration, Sonnet takes low-complexity tasks |
| Database engine instability is blamed on the bot | Medium | Medium | Error classification; engine errors go to defect tickets instead of retries |
| Quant results are not reproducible | High | High | Report numbers must come from run artifacts; the backtest engine enforces out-of-sample |
| Bots waking each other runs out of control | Low | Medium | Allow list + relay cap |
| Model proxy does not support tool streaming | Medium | High | Verify in M0; if unsupported, bots connect directly as a stopgap |

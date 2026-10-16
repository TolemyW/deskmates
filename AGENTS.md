# AGENTS.md

Guide for anyone, human or agent, working in this repository. `CLAUDE.md` is a symlink to this file, so Claude Code and every other agent read the same text; there is no second place for project guidance.

## What this is

Deskmates: self-hosted, always-on agents. Each bot has a name and a role; a group of bots shares one sandboxed computer with a persistent browser, shell, and filesystem, the way coworkers share a machine. A thin control plane (the Gateway) schedules runs, gates risky actions behind human approval, and records every run. The agent loop is the Claude Agent SDK; the browser layer is Playwright; human takeover is noVNC. Custom code stays in the product layer.

Read in this order:

1. `docs/design/design-cogbot-thin-core-v0.3-2026-09-20.md` — canonical architecture blueprint. Sections 1 to 9 are the system, 10 lists verified vs unverified assumptions.
2. `docs/adr/` — decisions behind v0.3. ADR-0002 covers the sidecar and approvals; ADR-0004 covers the shared workspace and supersedes ADR-0003; ADR-0005 covers threads, group chat and bot-to-bot wake. Read them before touching `packages/sidecar`, `packages/gateway/src/approvals`, `packages/gateway/src/threads`, or anything browser-related.
3. `docs/design/s0-spike-results-2026-09-20.md` — what was verified with real code and what was not.
4. `docs/design/test-strategy-2026-09-20.md` — test tiers, shared test doubles, fault-injection and security checklists, executable milestone acceptance.
5. `docs/design/measurement-2026-09-20.md` — how to tell whether a code, strategy, or model change made the agent better: paired A/B with error bars, reliability metrics, behavioral fingerprints, trace replay, decision rule.
6. `docs/design/benchmark-2026-09-20.md` — the golden site (Galaxy Ops Console), its seed data, and the 48-task deskbench suite with oracles; `evals/tasks/deskbench-v1.json` is generated from it.
7. `docs/design/design-cogbot-thin-core-v0.2-2026-09-20.md` — superseded for architecture, still canonical for the scenario feasibility evaluation in sections 10 to 12.

<!-- current-status:start -->
M3 is closed under the owner-revised scope. M4 is in progress.
Task management (ADR-0021) is merged; runtime, real-model, statistical,
visual acceptance remain pending.
Natural 24-hour soak is not an M4 gate; validation continues after stable release.
<!-- current-status:end -->

Current evidence and open gates are in `docs/design/m4-status-2026-10-04.md`.
The owner closed M3 under the revised scope on 2026-10-03; this is not original
full acceptance and does not waive release/deployment gates. WhatsApp manual
acceptance waits for a stable version. See
`docs/design/m3-owner-scope-closeout-and-m4-backlog-2026-10-03.md`.

M4 owner amendment (2026-10-05): natural 24-hour soak is no longer a milestone
gate. Preserve historical observations and continue validation after a stable
release; this is not a pass for retained runtime, model, safety or statistical
gates. Memory integration preparation is authorized, but no paid memory campaign
is authorized. The existing USD 3 campaign remains reserved for US stock.

Historical M2 evidence remains in `docs/design/m2-final-closeout-2026-09-24.md`,
`docs/design/m2-model-closeout-results-2026-09-24.md` and
`docs/design/m2-six-hour-soak-results-2026-09-25.md`. Retained chief delegation,
X02/X03 and visual gates are not promoted to passes by the later scope decision.
K5 was not expanded; opt-in browser strategies remain opt-in. Design open
questions 8 and 11 remain undecided. Question 10 is answered by ADR-0005
amendment 2 and measured in `docs/design/group-owner-routing-results-2026-09-30.md`.

## Repository layout

```
packages/contracts       shared types + protocol, zero runtime deps, imports nothing else
packages/gateway         control plane: Fastify + SQLite; never imports the Agent SDK
packages/sidecar         runs inside the workspace container; the only package that imports the Agent SDK
packages/sandbox-docker  Docker implementation of SandboxProvider
packages/web             React + Vite operator UI; talks only to the Gateway API
packages/ui              independently versioned HeroUI components + standalone studio; no Deskmates dependencies (ADR-0025)
packages/channels        official chat-channel plugins; Cloud API and QR-linked WhatsApp runtimes import only contracts and are release-bundled entry points loaded dynamically by the Gateway (ADR-0017 amendment 1)
packages/testkit         fake SDK, fake provider, injection corpus, fixtures; dev-only
packages/golden-site     Galaxy Ops Console, the site deskbench runs against; standalone, own container image; dev-only
packages/connector-postgres  ADR-0012 connector service for one PostgreSQL-protocol database (PostgreSQL or compatible); standalone, own container image
images/workspace         Dockerfile for the workspace container
images/connector-postgres  Dockerfile for the connector-postgres service
evals/                   model evaluations on the golden site task set (T4)
docs/design              design documents and spike results
docs/adr                 architecture decision records
docs/runbooks            operational procedures
spikes/                  throwaway verification code; never imported by packages/
scripts/                 dev and build helpers
```

Each package README states its responsibility and its rules. Read it before adding code there.

Dependency direction: `contracts` ← `gateway`, `sidecar`, `sandbox-docker`, `web`, `channels`, `testkit`, `connector-postgres`. ADR-0025 permits the frontend-only `web` → `ui` dependency; `ui` imports no Deskmates package. Nothing else imports across packages. If two packages need the same shape, it goes in `contracts`. `testkit` is a devDependency only; production code never imports it. `golden-site` imports nothing and is imported by nothing; `evals/` and T2/T3 tests reach it over HTTP, and it runs as its own container so the bot under test never shares a process or filesystem with it. `connector-postgres` imports only `contracts` and is imported by nothing; the Gateway reaches it over the ADR-0012 HTTP contract as a registered connector. `channels` imports only `contracts`; the Gateway has no static provider import or provider-specific branch, but its generic loader dynamically imports release-bundled channel entry points in-process through the versioned `ChannelPlugin` contract (ADR-0017 amendment 1). No runtime channel-code download or arbitrary third-party entry point is allowed.

## Stack

| Layer | Choice | Pinned by |
|---|---|---|
| Runtime | Node 22+, TypeScript, ESM (`"type": "module"`, `NodeNext`) | `tsconfig.base.json` |
| Monorepo | npm workspaces | root `package.json` |
| Lint / format | Biome | `biome.json` |
| Tests | Vitest, colocated `*.test.ts` | per-package `package.json` |
| Gateway | Fastify, better-sqlite3, forward-only SQL migrations | design §6 |
| Agent loop | `@anthropic-ai/claude-agent-sdk` 0.3.278 | S0 |
| Browser | Playwright 1.58.2, `@playwright/mcp` 0.0.82, `@playwright/cli` 0.1.21 | S0, matches the image base |
| Container image | `mcr.microsoft.com/playwright:v1.58.2-noble` + Xvfb, x11vnc, noVNC, xdotool | S0 test-c |
| UI | React + Vite + Tailwind; owned HeroUI components in `@deskmates/ui`, legacy Radix dialogs | ADR-0025, ADR-0008 |

Do not bump the Playwright version in one place without the others: the local package, the MCP, the CLI, and the image base must agree.

## Commands

```
npm install                      # all workspaces
npm run typecheck                # tsc -b across backend packages
npm run lint / npm run format    # biome
npm test                         # T0 unit + T1 integration; no network, no Docker
npm run test:container           # T2; needs Docker
npm run test:acceptance          # T3; needs Docker + MODEL_BASE_URL / MODEL_AUTH_TOKEN
npm run evals                    # T4 model evaluations
npm run golden-site              # start the deterministic test site alone
npm run dev:gateway              # tsx watch, reads .env
npm run dev:web                  # vite
npm run image:workspace          # build images/workspace
npm run image:golden-site        # build galaxy-ops-console:<task-set version>
npm run spike:s0                 # rerun S0 checks (needs Docker; test-a needs model env vars)
```

Copy `.env.example` to `.env` for local work. Docker on this machine is provided by colima; run `colima start` if `docker info` fails.

## Architecture rules that code must respect

These come from the design and ADR-0002 and ADR-0004. A change that breaks one of them needs a new ADR first.

- **Control plane is thin.** The Gateway does registration, scheduling, approvals, messaging, ledger, secrets, egress rules. It never calls a generative model. The one exception is retrieval (ADR-0041): when `.env` configures them, it may call an embedding service and a rerank service, which return only vectors and scores, and records every call in `retrieval_calls`.
- **One group of bots, one workspace.** A workspace is one container with one Chromium, one profile, one filesystem, one shell. Bots in it share cookies and login state with no mechanism in between, and can read each other's files; each bot writes in its own directory `/work/bots/<bot>` by default (ADR-0038). The Gateway database never holds a plaintext password, a cookie, or a long-lived upstream model key.
- **Do not build access control between bots, except the directory guard.** Bots are separated by `SOUL.md`, their own working directory, prompt and ledger attribution. The one exception, owner-decided 2026-10-14 (ADR-0038): in per-bot mode, the default, the sidecar's `PreToolUse` hook refuses a bot's file-tool writes and obvious shell writes into another bot's directory, and in every mode into `/work/uploads`, and tells it where to write. Reads are never refused, and shared mode remains a workspace option. That guard and the rest are soft distinctions against mistakes, not security boundaries, and the code and docs say so. Anything that must not share a login or a filesystem goes in a second workspace. Any other refusal of a bot's tool call because another bot "owns" a site, a file or a thread is a design violation; OS-level isolation between bots needs a new ADR.
- **Isolation escalates by workspace, never by bot.** A new trust domain costs one container. It never costs a permission subsystem.
- **Default grouping: one scenario, one workspace.** A bot that browses untrusted sites never shares a workspace with a bot that holds production credentials. Nothing inside a workspace is hidden from its bots: cookie DB, other bots' transcripts and directories, any process environment. The directory guard makes another bot's directory read-only, not private, and does not stop a script from writing there. Do not write docs or code that claim otherwise.
- **People hold roles per workspace (ADR-0022 amendment 6).** Owner, Admin, Member and Guest are held in each workspace; there are no tenant roles. A route checks the caller's role in the workspace of the row it names, and a list shows only the caller's workspaces. Owners and Admins own the group's configuration; Members post in shared chats, execute tasks and stop only the runs they started; Guests read shared chats and the board and post only on the board, which never wakes a bot. A person's private chat is readable only by that person, whatever anyone's role, the root `admin` included; that is a product API and UI guarantee between people, not a boundary between bots. The root account is always the login `admin`.
- **The sidecar is the SDK host process.** Tool interception is a `PreToolUse` hook plus the `canUseTool` callback, nothing in between. The sidecar hosts two agent loops (ADR-0044): the Claude Agent SDK, the default, and the OpenAI Agents SDK, chosen per bot and frozen on the run row; on the second loop every tool is a function the sidecar defines and the same `PreToolUse` hook judges every call before it runs. No other package imports an agent SDK.
- **Risk tiers:** L0 read-only and L1 reversible writes are allowed by the hook. For L2 external side effects the `PreToolUse` hook itself posts the approval request and blocks for the short-wait window; on a decision it returns `allow` or `deny`, on timeout or human-offline it returns `defer`, the run is parked, and approval resumes it with `resume: sessionId`. `canUseTool` is only a fail-closed backstop: in SDK 0.3.278 it runs after the hook and cannot return `defer` (ADR-0002 amendment 1). An approval request is a `system` message in the run's thread carrying the proposed action and the waking instruction, never page content; a stored rule (Always) answers before the thread is asked. Any member of that thread may decide it, a human from the UI or a bot through `approval_decide`; a deciding bot is a soft boundary like SOUL and grouping, not a security boundary (ADR-0002 amendment 2). After the stored rules, the workspace's approval mode decides who answers (ADR-0002 amendment 6): `manual` asks the thread; `automatic`, the default for a new workspace, lets an independent AI reviewer answer first, while deletion, permission expansion, egress asks, credential-bearing and unclassified actions still go to a human; `approve_all` allows every gated action without asking anyone, egress hosts and continuations within the workspace limit included, each recorded as decided by `mode:approve_all`. No mode touches the hard denies (private addresses, IP literals, metadata, cross-workspace, secret redaction); budget and loop breaker remain the backstop.
- **Every trigger creates a run row first.** Logs, screenshots, token counts, approvals, and thinking blocks hang off that run.
- **Private-chat handoffs (ADR-0024).** A bot in a one-member web chat may address a same-workspace non-member configured in its message allowlist. Route that request through the pairwise bus, preserving relay and turn caps and source outcome reporting. Show one durable activity card in the recipient's canonical private chat; the card is outside the model transcript and never starts a second run. Keep read state per operator.
- **Two scheduling lanes per bot:** interactive (messages in a `chat` thread, approval replies) and background (cron, webhook, messages in a `bus` thread). The lane follows the thread, not who posted: a bot mentioning another bot in a human's thread wakes it on the interactive lane. One run per lane at a time. All bots in a workspace share that workspace's browser lock.
- **Threads have members; the transcript belongs to the Gateway.** A thread is scoped to one workspace and lists its bot members; a one-member thread is a plain chat. `thread_messages` is the truth; each bot keeps its own SDK session per thread and is woken with the messages it has not seen. A mention wakes the mentioned bots in parallel; `@everyone` wakes every member in parallel, or in turn when the human picks 依次 for that message (ADR-0005 amendment 4), and a bot may stay silent. A human message with no mention is offered to one member at a time, the thread's owner first, until one takes it; the taker becomes the owner, and a bot's unaddressed message wakes nobody. Every group wake names the members and their roles. The owner is a routing fact, not a permission (ADR-0005 amendment 2; `DESKMATES_GROUP_ROUTING=walk-v1` restores the full walk for every unaddressed message). Two caps bound exchanges: `relay_count` (default 5) and the per-thread `turn_budget` (off by default; a workspace Owner or Admin may turn it on or change either cap, and `off` needs a money budget only when the workspace switch "require a budget for unlimited limits" is on; ADR-0005 amendment 5, ADR-0032). A Gateway loop breaker stands behind the caps: hop depth 50 and a bot's third identical message are always on; the 300-bot-message volume rule is off unless the workspace turns it on. `message_bot` is a `bus` thread, not a separate bus. Membership is routing, not access control. See ADR-0005.
- **Egress is open by default and locked by choice (ADR-0020).** A new workspace browses the open public internet (the allowlist `*`: any public hostname, never a private address or IP literal); such a workspace is an untrusted-browsing workspace that holds no production credentials (ADR-0010). Its creator may lock it to a human-maintained domain allowlist instead. In a locked workspace a first visit to a public host outside the list is an egress approval in the chat (allow this site, which adds the host to the list, or deny); it never silently fails, and never asks for a private address, an IP literal or an unreadable URL, which stay denied. The agent cannot edit the list; an answered ask is the only non-operator writer. In M0 this is enforced at the tool level only (browser navigation, `curl`/`wget` in shell commands; `WebFetch` and `WebSearch` are not offered), so it is a guard rail, not isolation: the container network is open. The legacy M0/M1 deployment has an unauthenticated operator API and shared Docker network. B4 implements ADR-0006 together: authenticated operator routes on a separate listener, per-workspace networks, password-protected noVNC and a managed HTTP(S) egress proxy. Focused B4 live checks pass on the closeout images; broader milestone acceptance remains pending. ADR-0009 routes the reserved host exception through the managed proxy (including Colima); ADR-0027 adds operator-pinned, expiring workspace-specific private HTTPS targets (startup-only `EGRESS_PRIVATE_TARGETS`), and its amendment 1 (proposed) adds durable named network profiles that the root selects per workspace and changes online: exact LAN origins (HTTP or HTTPS, custom ports, RFC1918 IP literals and subnets), enforced by both the hook and the proxy, never implied by `*`, never for an open-internet workspace, never reaching the proxy's own networks or the host; HTTPS keeps normal TLS trust. Other private upstream/non-HTTP support is incomplete. Run tokens authenticate only their own `/internal/runs/:id/*` and the model proxy, never operator routes (`operator-auth.test.ts`).
- **One Chromium per workspace.** MCP attaches with `--cdp-endpoint http://127.0.0.1:9222 --caps vision`; CLI with `attach --cdp=http://127.0.0.1:9222`; noVNC shows the same screen. Every bot in the workspace uses that one browser, so a human logging in once covers the whole group. Each run opens its own tab (a top-level window on its bot’s screen region for `shared-monitors-v1`, ADR-0008). All regions use the same Chromium/profile, and the UI uses server-enforced read-only noVNC for previews. Human takeover still holds the whole workspace. The lock is workspace-level, held by the Gateway, acquired in the sidecar's PreToolUse hook. While a human holds it, browser tools return a wait message and screenshots stop.
- **Page content is untrusted.** Wrap browser and external tool output as untrusted before it enters model context. Redact tokens and cookies before anything enters the ledger. Bot-authored messages and webhook bodies are wrapped by the sidecar; browser tool results are wrapped by the stdio proxy the sidecar puts in front of the Playwright MCP server (`deskmates-sidecar mcp-proxy`), whose wrapper body is entity-escaped so a forged closing tag cannot escape it (ADR-0002 amendment 1, gap closed). The ledger keeps the raw result; the wrapper exists only in model context.
- **Model credentials reach the sandbox as `ANTHROPIC_BASE_URL` plus a short-lived `ANTHROPIC_AUTH_TOKEN` (Bearer).** The gateway verified in S0 rejects `x-api-key`.
- **The Gateway prices tokens.** Ignore the SDK's `costUSD`; store per-model token counts and compute from a price table.
- **The model is configuration.** `DEFAULT_MODEL` and `CHEAP_MODEL` come from `.env`. Nothing in `packages/` hardcodes a model name.
- **Images preinstall everything.** No `npx` or package download at run time inside a sandbox.

## Conventions

- TypeScript strict. No `any` without a comment saying why.
- Named exports. One concept per file. Filenames kebab-case.
- Errors that cross a package boundary are typed in `contracts`.
- SQL lives in `packages/gateway/migrations/YYYYMMDDHHmm-name.sql` (UTC authoring time) and in query modules, not inline in route handlers. The first migration is the schema baseline (ADR-0031), which replaced the legacy `NNNN-` files; a database created before it is refused, never upgraded. A new migration must sort after every migration on main; CI checks it and the loader refuses out-of-order applies (ADR-0030). Nobody reserves migration numbers. Schema conventions (ids, timestamps, JSON, lookup tables, `workspace_id` with cascades, indexed foreign keys) are in ADR-0031 decision 5 and enforced by `db/schema-conventions.test.ts`.
- Tests sit next to the code. Tier by filename: `foo.test.ts` (T0 unit, T1 integration; no external processes), `foo.container.test.ts` (T2, real Docker, no model), `foo.acceptance.test.ts` (T3, real model on the golden site). `npm test` must pass on a machine with no network and no Docker.
- Never call the real Agent SDK or a real model in a T0/T1 test. Use `@deskmates/testkit`'s fake SDK. The one exception is the sidecar's SDK-shape contract test, which is T2.
- Every architecture rule in this file has at least one test that fails when the rule is broken. When you add a rule, add the test. The mapping is in the test strategy doc, section 11.
- Every numbered decision in an ADR has a row in that ADR's Verification table: concrete meaning, the test that proves it, the metric that tracks it (ADR-0001). A new ADR without one is not accepted.
- Milestone acceptance criteria are executable T3 tests under `acceptance/`. A milestone is done when they pass on the deployed model.
- A change to SOUL, MEMORY rules, skills, approval rules, driver thresholds, or retrieval parameters is a strategy change. It is not "better" until `evals/compare.ts` says so on a paired run against the baseline, per duration bucket. One knob per experiment. A single run is not evidence.
- A pure framework change must not move the behavioral fingerprint distribution. If replay shows a decision diff, it is either an intended behavior change (then run the strategy protocol) or a bug.
- Every run records its full knob configuration in `runs.config_json`. Without it, results cannot be attributed later.
- Secrets never enter a file that git tracks. `.env` is ignored; `.env.example` has empty values only.
- `main` is mirrored to a public repository as-is. Private host names, LAN addresses, people's names and private e-mail addresses never enter a tracked file; `scripts/public-scan.test.mjs` fails on them (hashes in `scripts/public-scan-blocklist.json`) and the pre-push hook refuses the push. See `docs/runbooks/public-mirror.md`.
- Commit messages: imperative subject, body explains why. No AI co-author or attribution trailers.
- A change to `docs/design/*` or a new `docs/adr/*` is its own commit.
- GitHub Actions minutes are limited. `ci` runs only on pull requests that are not drafts (when one is opened, marked ready, or gets a new commit); a merge to `main` runs nothing, and a release runs the same gate on the tagged commit. A PR merges only after that gate passes on its branch brought up to date with `main`.
- Keep a PR as a draft while developing and fixing. Before marking it ready, run the gate locally and see it pass: `npm run typecheck`, `npm run lint`, `npm run docs:check`, `npm test` and `npm run build -w packages/web`. Do not wait for CI between commits.
- Push the fixes for a PR together, then mark it ready. GitHub CI is the merge gate, not a debugging loop: do not push fix-ups one at a time to a ready PR, since every push reruns the whole gate. Batch related changes into one PR rather than one per issue.

### Parallel development: no shared append points

Feature work should be mergeable in any order. A change adds or edits files its feature owns; a brand-new feature adds at most one line to a sorted list. Do not reintroduce files that every feature appends to (issue #53).

- **Web:** each product area is `packages/web/src/features/<feature>/` with its `route.ts`, `feature.tsx`, `api.ts`, `demo.ts`, `messages/`, styles and tests, discovered with `import.meta.glob`. Screens live in their feature folder; route modules never import screens. See "Source layout" in `packages/web/README.md`.
- **Gateway:** a domain's operator route policies are `packages/gateway/src/api/route-policies/<domain>.ts`, its route registration and policy file each one line in the sorted lists of `api/routes.ts` and `api/route-policy.ts`, its stores built in a `create...Module` next to them, and its env variables read in `src/config/<domain>.ts`. `scripts/hotspot-budgets.test.mjs` fails when a former hotspot grows back.
- **Tests and goldens are per feature too.** A test that enumerates every route, endpoint, string or demo record in one file is a shared append point; compute invariants over the registry instead.
- **Docs:** a Gateway or web topic is `packages/<pkg>/docs/<topic>.md` plus one line in the README's sorted index, not a new README section. A stable release's verification record is its own file under `docs/releases/`. Generated docs live in `docs/generated/` and are refreshed with `UPDATE_GENERATED=1` on the test that owns them, never edited by hand.
- **Sorted lists stay sorted** (`packages/contracts/src/index.ts`, the client composition, the message fragment list); tests enforce it.
- **No-visible-change refactors** of the web UI are checked with `packages/web/scripts/ui-fingerprint.mjs` against the base commit.

## Working agreements for agents

- Before implementing something the design or an ADR already specifies, read that section and follow it. If you think it is wrong, write the ADR and stop; do not implement the alternative silently.
- Do not widen scope. M0 is a Gateway skeleton, a Docker sandbox, one bot, the SDK loop with hooks, Playwright MCP, and a web chat. M0's chat uses the thread model of ADR-0005 with one member so the tables never migrate; mention routing, caps, `thread_post`, `message_bot` and the group UI are M2. Cron, approvals UI, multi-bot, knowledge base, and channels are later milestones.
- When a task needs a real model or a real browser to verify, put the check in the private lab repository and record the result in `docs/design/` or the relevant ADR, citing the lab material by date and title rather than by path or host. `spikes/` holds only the historical spikes that tests and scripts still import. Do not leave verification only in a chat transcript.
- Do not move, rename, or delete `docs/design/*`. Superseded designs stay for history.
- Report what was verified and how. If tests were not run, say so.

## Notes for Claude Code

- Prefer `Read`, `Edit`, `Grep` over shell for file work in `packages/`.
- Run `npm run typecheck` and the affected package's tests before reporting a change as done.
- Everything in the repo is English. The `*.zh.md` files under `docs/design/` are the original Chinese drafts, translated on 2026-09-21; they are frozen and are not updated when the English file changes.

## Open decisions

- **Model path.** Two candidates: a model proxy fronting Claude models, or an Anthropic-protocol gateway fronting GLM / DeepSeek / Qwen. S0 proved the loop works on both GLM 5.3 and DeepSeek 4.1 Flash for a short task; long browser and SQL sessions are unmeasured on those models. Design v0.2 §10 ratings assume Claude-class reasoning and get re-baselined at M0 acceptance.
- **Browser lock granularity.** One workspace-level lock may serialise tabs that could have run in parallel. Calibrate against real multi-bot scenarios in the first week of M2.
- **Workspace sizing.** One sidecar process per run, two lanes per bot, about 1 GiB per SDK session. The scheduler does not cap concurrent sidecars per workspace or tenant (ADR-0022 amendment 5); the container's `WORKSPACE_MEMORY_LIMIT_MB` and `WORKSPACE_CPU_LIMIT` bound them together. Still open: the right default limits, from `resource_observation` events.
- **Desktop VM:** one VM per workspace, or one VM running several containers. Affects the second `SandboxProvider`.
- **Database MCP server identity:** how a bot's service identity is issued and rotated.

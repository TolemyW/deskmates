# From demo to product: a productization roadmap for Deskmates

Date: 2026-10-03
Status: proposal for the product owner and contributors; not an accepted ADR, not an implementation authorization. Decisions it recommends go through the ADR process before code.
Baseline: `1109ec7` on `main` (v0.2.18 deployed on Testbox as the internal trial).

This document answers one question: what has to be true for Deskmates to stop
being a demo that its authors can run and become a product that a stranger
can install, trust, operate and contribute to. It reads the design, the ADRs,
the closeout and validation records and the current source, and it proposes a
sequence. Everything here is a source-level assessment: no container, model or
deployment was exercised for it.

## 1. Where the project stands

### 1.1 What is real

The architecture is built and most of it is verified on real containers and a
real model. The thin core holds: the Gateway never calls a model, the sidecar
is the SDK host, risk tiers are a `PreToolUse` hook, one workspace is one
container with one Chromium, and every trigger creates a run row first.

| Area | State on `main` |
|---|---|
| Packages | `contracts`, `gateway` (17k lines, 22 migrations, 83 test files), `sidecar` (9k lines), `sandbox-docker`, `web` (8k lines, 24 screens), `connector-postgres`, `golden-site`, `testkit`; `channels` is an empty stub |
| Automated checks | typecheck, lint, 222 T0/T1 files with 2,344 tests on every push; T2 (25 files) and T3 run on Testbox per release |
| Verified on a real model | M0, M1 and the M2 foundation cases (group wake, delegation, takeover, approvals, cron, webhooks); one-bot and two-bot portable scenarios; the shared-workspace group task; the VendorDB connector workflow |
| Decisions | ADR-0001 to 0016; 0011 and 0016 accepted, 0012 to 0015 still `Proposed` while substantial code for 0012, 0013 and 0014 has shipped |
| Deployment | one internal trial instance, moved only between tagged releases with backup and rollback (`docs/runbooks/stable-release.md`) |

### 1.2 What makes it a demo

**The product concept is missing.** The interaction review of 2026-09-30 says it
plainly: the UI exposes stored objects and runtime events, not work. There is no
task with an owner, a state, deliverables and intervention points that spans
messages, runs and attempts. A bot's `role` field is stored and never read. A
message during a run has no defined meaning. A failed run is labelled
"recovered" by an unrelated later run. Forgetting memory is a one-click
irreversible action. Deliverables are path strings. None of these are bugs in
the architecture; they are the absence of a product layer on top of it.

**The retained failures are product-visible.** The six-hour soak keeps the
chief ending silently or without its assignment marker (6/9). The v0.2.18
validation campaign shows a normal four-role workflow stopping at the eighth
bot message because the thread `turn_budget` is spent on ordinary assignments
and reports; the release record calls it a P1. Raising the budget to 16 did not
complete the scenario. ADR-0016 parks a run that runs out of turns, but nothing
yet gives a blocked thread a final handoff or an operator continuation.

**The platform is single-operator and single-host.** One shared bearer token is
the whole identity model; there are no users, roles or audit of who did what
beyond "the operator". The Gateway is one process on SQLite, which is right for
the target deployment but has no backup, retention or pruning logic of its own;
`runs`, `run_events`, `model_requests` and screenshots grow without bound. The
only health signal is `/healthz` returning `{ok: true}`; there are no metrics,
no structured log contract and no alerting. The only sandbox provider is
Docker on one host, and the only deployment is a set of host-specific scripts
written for Testbox, whose network quirks (fake-IP DNS, no registry access)
are baked into the runbook.

**The install story does not exist for a stranger.** `scripts/deploy-local.sh`
is a developer convenience that binds to loopback and says so. There is no
`docker compose up`, no first-run wizard, no "create your first bot" guide
that runs on a laptop in ten minutes against a public model endpoint, and the
README still says "M0 not started" and lists the Desktop VM in M3 after it was
cut on 2026-09-29.

**Scope has drifted into research.** `docs/design/` holds 104 documents and
`spikes/` 39 directories. A large share since 2026-09-25 is evaluation
campaigns on external task suites (defects4j, FRAMES, SWE-bench, sympy,
astropy), stock research pilots, and model probes. These answered real
questions about model ability, but they are not product work, they are
written against one host and one internal model endpoint that no contributor
can reach, and they make the repository hard to read. The VendorDB campaigns are
the exception: they produced ADR-0012 and the connector.

**Open-source hygiene is absent.** There is no `CONTRIBUTING.md`, `SECURITY.md`,
`CODE_OF_CONDUCT.md`, issue or pull request template, changelog, public
roadmap, or contributor-facing release notes. The ADR and test discipline is
excellent and entirely internal.

### 1.3 Strengths to keep

The thin core, the ADR process with verification tables, the test tiers with a
fake SDK, the paired-evaluation rule for strategy changes, the ledger that
records every run's knob configuration, the release pipeline with backup and
automatic rollback, and the honesty of the records (failures retained, usage
reported as unknown when unknown). A product built on these will be
trustworthy in a way most agent products are not. Nothing below replaces them.

## 2. What the 1.0 product is

Decide this first; everything else follows from it. The recommendation:

**Audience.** A small technical team (one to twenty people) that self-hosts on
one Docker host and wants always-on bots that work in a real browser and shell,
with the model of their choice, and with every action recorded and the risky
ones gated. The first users are the team itself and teams like it: operators,
QA engineers, data engineers, researchers.

**The one job.** "Give a bot or a group of bots a task in chat; watch what they
do; decide the things only a human should decide; get a deliverable; have the
bots remember what they learned." The three design scenarios (product testing,
data platform work, research groups) are instances of that job, not three
products.

**Differentiators, unchanged from the design.** Self-hosted, model-swappable,
memory that is plain files and SQLite you can read, edit and export, and a
shared computer with human takeover.

**Explicit 1.0 non-goals.** Multi-tenant hosting, a Desktop VM or Kubernetes
provider, a skill marketplace, a mobile client, trade execution, and benchmark
leadership on external task suites. Each of these is a possible 2.0 line, and
none of them should consume a 1.0 cycle.

## 3. The path, in five phases

Phases overlap at the edges, but each has an exit criterion that is a test, a
document or a release, never a chat transcript.

### Phase A: close M3 and freeze scope (3 to 4 weeks)

Finish what M3 promised and stop adding to it.

1. **Settle the Proposed ADRs.** Accept or amend ADR-0012 (connector contract),
   0013 (integration runtime), 0014 (file download) to match the code that
   shipped, and either accept ADR-0015 (skills) for a later phase or mark it
   deferred. An ADR that says `Proposed` while its code runs in the trial is a
   contributor trap.
2. **Fix the P1.** The bounded-routing rule in `threads/router.ts` must not
   end a workflow by silently dropping a report to the lead. Write the ADR
   (an ADR-0005 amendment or ADR-0017) that gives a thread an explicit
   `blocked` state, a bounded final handoff, and an operator or delegator
   continuation, reusing the ADR-0016 continuation mechanism. Changing the
   cap alone is a knob experiment, not the fix.
3. **Retained M2 failures become regressions.** The silent chief and the X03
   tab-lock wait get T2 or T3 regression cases that fail today. They need not
   pass before 1.0 if the product tells the user what happened (Phase B), but
   they must be visible in the suite, not in a closeout document.
4. **Cost alerts** (the one M3 item with no code): per-workspace daily budget,
   a threshold event on the run and a visible state in the UI. Enforcement
   (parking a run that would exceed the budget) is a separate decision.
5. **Scope freeze.** Everything else on the M3 list (scenario images, Slack)
   moves to Phase D or out. Record the freeze in design v0.3 §8 as revision
   v0.3.4.

Exit: ADR statuses match the code; `acceptance/` has a failing regression for
each retained failure; the stock four-role scenario completes or ends in an
explicit blocked state with a handoff the operator can see.

### Phase B: the product layer (6 to 8 weeks)

This is the phase that turns a control plane into a product. The interaction
review already specifies it; this roadmap only orders it.

1. **ADR-0017: the task.** A task is a goal with an owner bot, a state
   (`open`, `running`, `waiting_human`, `waiting_bot`, `blocked`, `delivered`,
   `accepted`, `stopped`), links to its thread, runs and attempts, pending
   decisions, and deliverables. It is a Gateway record and a product object; it
   does not add a reasoning loop. The three loops of the competitor research
   (automation, task lifecycle, agent loop) map onto triggers, tasks and the
   SDK respectively.
2. **Run control.** Stop a running run with partial results recorded, cancel
   queued work, and define what a message sent during a run means (queued
   follow-up by default; steering is a later experiment). This needs an SDK
   path verified in T2, so it is a container test first.
3. **Bot lifecycle.** Canonical instructions held by the Gateway with
   draft/effective versions (ADR-0011 A5), configuration while the workspace
   is stopped, a bot detail page, a bounded test conversation, pause and
   archive with stated effects on queued, running and scheduled work. The
   display role becomes a description; instructions are explicit.
4. **Supervision over diagnostics.** One task view: stage, last evidence-backed
   action, waiting reason, elapsed time, partial outputs, available
   interventions; raw events in a drawer. One attention inbox across
   workspaces: approvals, continuations, logins, takeovers. Replace the
   "recovered" label with the literal fact.
5. **Deliverables.** Typed deliverable records with an immutable delivered
   version, preview for text types, download, and a path policy that accepts
   spaces and non-ASCII names (an ADR-0014 amendment). Raise or make
   configurable the 1 MiB cap with an explicit limit shown to the user.
6. **Memory the user can understand.** One screen with four named categories
   (human rules, workspace facts, bot experience, task context), source and
   scope on every entry, exclude-from-retrieval separate from permanent
   erasure, consolidation and task closure reachable from the UI, and a
   reserved task-context budget in the pinned index (a strategy change, so a
   paired evaluation).
7. **Approval previews.** What the action does, to which account or object,
   with what outgoing content, and the exact future scope of an "Always" rule
   before it is created.

Exit: the single user journey from the interaction review passes on a pinned
environment with no API calls or shell intervention by the tester: create a
bot, test it, delegate a task to a group, handle one blocked action, receive
an artifact, correct one learned fact. Its thirteen scenarios become
`acceptance/journey-*.acceptance.test.ts`, and the journey is the 1.0 gate.

### Phase C: a platform a stranger can run (5 to 6 weeks)

Make self-hosting a product feature rather than a runbook.

1. **Install.** `docker compose up` on a fresh Linux host with Docker brings
   up the Gateway, the web UI, the egress proxy and, when configured, the
   integration runtime; the workspace image is pulled from the registry CI
   already publishes to. A first-run page sets the operator credential, the
   model endpoint and the first workspace. Target: under fifteen minutes from
   clone to a bot answering in chat against a public Anthropic-protocol
   endpoint. The Testbox-specific paths (local base build, `docker save` over
   SSH, fake-IP DNS) stay as a documented variant, not the default.
2. **Identity.** Replace the single token with operator accounts: username,
   password or SSO later, session cookies for the UI, personal API tokens for
   scripts. Two roles are enough for 1.0: `admin` (secrets, egress, bots,
   users) and `member` (chat, approve, take over). Every approval, takeover,
   memory edit and file download records who did it. This is still one
   organization per instance; multi-tenancy is not in scope.
3. **Data lifecycle.** A retention policy per table (events, screenshots,
   model requests, tabs) with defaults and an operator setting; a built-in
   backup command producing one restorable archive (database, secrets key
   reminder, workspace volumes list); a restore command; migrations that are
   forward-only and tested from each released version to the next in CI.
4. **Observability.** A `/metrics` endpoint (runs by state and lane, queue
   age, approval wait time, workspace memory, model proxy latency and error
   rate, token spend per model), structured JSON logs with a documented
   schema, and a status page in the UI that reads the same numbers. The
   operator view of the competitor research ("is execution infrastructure
   healthy?") is this.
5. **Hardening defaults.** TLS termination guidance and an optional built-in
   certificate path; noVNC always password-protected; the operator listener
   refuses to start on a public bind without TLS or an explicit override;
   `GATEWAY_SECRETS_KEY` rotation procedure; a `deskmates doctor` command that
   checks Docker, images, network policy and model connectivity and prints
   what to fix.
6. **Upgrades.** `docker compose pull && up` is the upgrade; the Gateway
   migrates on start, refuses to start on a database newer than itself, and
   the release notes say what changed in behaviour.

Exit: a contributor who has never seen Testbox installs 1.0 from the README
on a clean VM and completes the Phase B journey; a backup taken before an
upgrade restores on the previous release.

### Phase D: where people already are (4 weeks, can run in parallel with C)

An always-on coworker that lives only in a web page is half a product.

1. **Slack first.** The `channels` package maps a Slack channel or DM to a
   thread (the `channel` field on threads already reserves this), relays bot
   posts back, renders approvals as interactive messages whose decision goes
   through the same approval route, and never exposes the operator token.
   Membership and routing stay ADR-0005; the channel is a transport.
2. **Telegram second**, same adapter shape, only after Slack is in the T2
   suite with a fake Slack server from `testkit`.
3. **Outbound notifications.** Email or webhook when a task is blocked, an
   approval has waited longer than its short window, or a budget threshold is
   crossed. These are the cost alerts of Phase A made deliverable.

Exit: the Phase B journey can be driven from Slack end to end, including one
approval decided from Slack and attributed to the Slack user.

### Phase E: release 1.0 and run it in the open (3 weeks, then continuous)

1. **Repository hygiene.** `CONTRIBUTING.md` (the AGENTS.md rules in
   contributor language, the ADR process, the test tiers, the English-only
   rule for everything tracked), `SECURITY.md` with a disclosure address and
   the stated threat model (one workspace is one trust domain; no boundary
   between bots), `CODE_OF_CONDUCT.md`, issue and pull request templates,
   `CODEOWNERS`, a `CHANGELOG.md` kept per release, and a decision on DCO or
   CLA. Protect `main`; require CI.
2. **CI that contributors can use.** T2 runs on GitHub-hosted runners
   (Ubuntu runners have Docker; the workspace image is already published),
   so a pull request gets T0 to T2 without Testbox. T3 stays nightly on a
   self-hosted runner with a model credential, publishing a pass/fail badge
   and token totals, never the transcript.
3. **Documentation site.** Four pages a user reads in order: install, first
   bot, groups and approvals, operations (backup, upgrade, metrics). Then the
   reference: configuration, API, architecture, ADR index. `docs/design/`
   stays the engineering record and gets an index that separates canonical,
   plan, record and research.
4. **Move research out of the main tree.** The external-suite campaigns,
   stock pilots and model probes move to a `research/` directory with its own
   README and no part in the release gate, or to a separate repository. Their
   results stay; their presence stops shaping the first impression.
5. **Release discipline.** Semver as in the runbook; 1.0.0 is the first tag
   that passes the journey suite on the public install path. A patch cadence
   of two weeks and a minor cadence of six to eight weeks; every minor has a
   written release note with behaviour changes and migration notes.

Exit: `v1.0.0` tagged from a protected `main`, installed from the public
README by someone outside the team, with the journey suite green on the
nightly runner.

## 4. Cross-cutting rules that do not change

- **Thin core.** Nothing in Phases B to D adds a planner, a second reasoning
  loop, model calls in the Gateway, or access control between bots. A task is
  a record, not a scheduler of thoughts.
- **Strategy changes stay measured.** The pinned-index budget, routing
  policy, turn and relay caps, and any prompt change still go through
  `evals/compare.ts` with a paired run. Phase B creates several such
  experiments; run them one knob at a time and record each in a results
  document.
- **One rule, one test.** Every new architecture rule (task states, identity
  attribution, retention) gets the test that fails when it is broken, listed
  in the test strategy's section 11.
- **Honest reporting.** Unknown usage stays unknown; a model-reported
  completion is never shown as accepted; a run outcome is never shown as a
  task outcome.

## 5. Decisions the owner has to make

| # | Decision | Recommendation | Why it blocks |
|---|---|---|---|
| 1 | Who 1.0 is for | one self-hosting technical team per instance | sets the identity model and the install path |
| 2 | Task model | adopt ADR-0017 with the eight states above | every Phase B screen hangs off it |
| 3 | Blocked threads | explicit `blocked` state plus bounded final handoff | the only P1 on record |
| 4 | ADR-0012 to 0015 status | accept 0012, 0013, 0014 as built; defer 0015 to post-1.0 | contributors cannot tell what is decided |
| 5 | Operator identity | accounts with two roles, no multi-tenancy | needed before any second human uses the product |
| 6 | Research campaigns | move to `research/` or a separate repository | repository readability and release gate |
| 7 | Channels order | Slack, then Telegram | a `channels` package has been empty since M0 |
| 8 | Public CI | T2 on GitHub runners, T3 nightly self-hosted | contributors need a gate they can run |
| 9 | Model path for the public install | document the Anthropic API as the default, GLM/DeepSeek gateways as variants | the README and quickstart cannot stay model-agnostic in prose only |

## 6. Suggested order and effort

| Phase | Weeks | Depends on | Exit artifact |
|---|---|---|---|
| A. Close M3 | 3 to 4 | nothing | v0.3.4 design revision; ADR statuses; blocked-thread ADR; failing regressions |
| B. Product layer | 6 to 8 | A (task ADR) | journey acceptance suite green on the trial host |
| C. Platform | 5 to 6 | A | clean-VM install; backup and restore; metrics |
| D. Channels | 4 | B (task and approval shapes) | Slack journey green |
| E. Release 1.0 | 3 | B, C, D | `v1.0.0` from the public install path |

About 22 to 26 weeks of focused work for a small team, with C and D in
parallel with the second half of B. These are planning figures, not
commitments; the M2 record shows that real-model acceptance takes longer than
feature work, and the journey suite is where that time will go.

## 7. What this document does not do

It does not accept any ADR, change any default, or authorize implementation.
It does not claim current milestone acceptance: M2 acceptance is incomplete,
and the retained failures stay retained. It does not estimate model cost for
the journey suite; that is recorded per run when the suite exists. The next
concrete steps are the ADRs named in Phase A and the task ADR of Phase B.

## Verification

Documentation only. No production file, test, container, model or deployment
was touched. `npm run lint` and `git diff --check` were run on the change.

# M2 foundation development plan

Date: 2026-09-22. Starting revision: `a0d29a1`.
Status: F1–F4 implemented and integrated on `codex/m2-foundation-20260922`;
T0/T1 verification complete. This is not an M2 acceptance sign-off.

## Outcome and scope

Deliver the control-plane and operator foundations for a group of bots in one
workspace: durable group routing, bounded message chains, direct bot handoffs,
group creation/display, and tab-aware browser coordination primitives.
Follow design v0.3 and ADR-0002 amendments, ADR-0004, and ADR-0005.

This first batch does not claim real-browser multi-bot concurrency. Wiring stable
CDP tab identities and per-run tab creation into the browser runtime, with T2/T3
interference tests, is a dependent batch. Tab leases are coordination, never
access control between bots.

## Work packages and ownership

| ID | Owner | Files / responsibility | Completion evidence |
| --- | --- | --- | --- |
| F1 | Sub-agent A, sol/medium | Gateway thread router/stores, scheduling integration, group lifecycle tests. Bot mentions wake recipients; unaddressed messages walk members in join order; human mention can join same-workspace bots; relay and turn caps pause/alert; human message resets; durable restart-safe walk and wake coalescing. | T0/T1 routing, silent/busy members, failure/park behavior, pause/reset, three-bot trace, restart continuation. |
| F2 | Sub-agent B, sol/medium | Gateway browser-lock store and tests, additive contracts comments/types only when needed. Same-tab contention waits; different tabs proceed; human takeover overrides all tabs; TTL/renew/release preserve lease identity. | T0/T1 two runs/two tabs, same-tab wait/retry, expiry, human takeover, cleanup and no lock stealing. |
| F3 | Sub-agent C, sol/medium | Web group creation and display using existing API. Select 1–6 bots from one workspace, render member identity and concurrent activity, paused status and human-message recovery guidance; refresh thread metadata when events change it. | Web typecheck/build and DOM interaction tests; existing single-bot and takeover flows pass. |
| F4 | Integrator | Sidecar message_bot registration/context, Gateway direct-message service/routes using existing PostMessageRequest.to; pairwise bus threads, background wake, chat handoff message, shared contracts only if necessary; cross-package integration. | Fake SDK/Gateway tests and service/API tests: pair reuse, target resolution, workspace boundary, trace attribution, caps and correct lane. |

All sub-agents use `gpt-5.6-sol`, reasoning effort `medium`.
Each works in its own worktree and commits only its assigned package scope.
The integrator merges reviewed commits into `codex/m2-foundation-20260922`.
No task edits the active main checkout or the existing M1 QA worktree.

## Shared interfaces and dependencies

- Keep `PostMessageRequest` unchanged: `tool: message_bot`, `to` is a bot name,
  `body` and `attachments` retain their existing shapes.
- F1 preserves `ThreadRouter.postFromRun(run, body, attachments): ThreadMessage`
  for existing callers, and adds routing behind it. Provide a router method for
  posting a bot message into a specified bus thread with an explicit target,
  inheriting relay count from the original run. Coordinate its signature with F4.
- F1 owns router construction and lifecycle integration. F4 owns the new
  direct-message service plus sidecar tool and internal message-route dispatch.
- F3 uses existing thread detail `{thread,members}`, `thread.status`, and
  run/message events. No mandatory new endpoint or event is needed.
- F2 uses existing `BrowserLockRequest.tabId`. Calls without a stable tab ID
  retain current compatibility behavior; no fabricated browser-global tab ID.
- F1 uses migration 0009 if needed; F2 uses 0010 if needed, after verifying
  existing migration numbers. Integrator resolves numbering before merge.
- Avoid overlapping README edits: each agent may update only its owned package
  documentation; shared Gateway README updates are consolidated by integrator.

## Order

1. Publish this plan and freeze the interface boundaries.
2. Develop F1, F2, F3 in parallel; integrator develops F4 against F1's agreed API.
3. Integrate and run type checks, lint, affected tests, then the full T0/T1 suite.
4. Record exact passing checks and remaining limitations; keep the branch
   reviewable without deploying or restarting the existing application.

## Isolation and verification

- Separate node_modules/build outputs per worktree; installs do not touch main.
- In-memory databases and fake providers/SDK only for this batch. Localhost tests
  use ephemeral ports and a single worker; no 5173/8080, model calls, Docker
  commands, shared image tags, or shared application databases.
- New contracts are additive; SQL stays in query modules and forward migrations.
- Strategy/prompt wording only documents the newly offered tool, not a claim of
  measured behavioral improvement. No SOUL/MEMORY strategy change is included.
- T2/T3 live checks require unique images, ports, data and containers in the next
  batch, with source/image identifiers recorded; they are not silently waived.

## Following foundation batches

| Batch | Depends on | Work and gate |
| --- | --- | --- |
| B2: browser runtime | F2 | Stable CDP tab mapping, per-run tabs, hook/proxy lock propagation, interruption/cleanup, no screenshots during takeover. Pass m2-shared-env and interference scenarios X02–X04 on isolated real stacks. |
| B3: group acceptance | F1/F3/F4, B2 | m2-chief and m2-group T3, adversarial loop bounds, group UI QA and ledger traceability; calibrate turn budget under the measurement protocol. |
| B4: second workspace | ADR-0006 activation | Operator auth/listener separation, per-workspace networks, noVNC auth, network egress and isolation tests before claiming separate trust domains. |
| B5: knowledge/execution | B3 | Knowledge proposal/approval/retrieval, memory governance, vision fallback and CLI mode; separate strategy evaluations and golden-site completion. |

M1 tty/cost-dashboard enhancements and capacity measurements need explicit
rescheduling in the overall milestone record. This plan does not relabel failed
M1 acceptance as passed or claim to complete the whole of M2.


## Integration record

All three assigned sub-agents completed their work using `gpt-5.6-sol` with
`medium` reasoning. Their commits were reviewed and integrated into the isolated
foundation branch; the integrator completed F4 and cross-package regression
coverage. The active main checkout remains on the starting revision, with its
existing untracked M1 QA files untouched. Nothing was deployed or restarted.

| Package | Delivered | Evidence |
| --- | --- | --- |
| F1 | Durable ordered group walks; explicit parallel mentions; same-workspace human joins; queued wake coalescing; parked-session safety; relay/turn caps and fresh-human reset | `threads/router.test.ts`, `db/migrate.test.ts`, existing Gateway coalescing/approval tests, and `m2-group-foundation.test.ts` |
| F2 | Tab-aware Gateway leases, same-tab wait, independent tabs, lease expiry/renew/release, workspace-wide human takeover | Seven `workspaces/browser-lock.test.ts` cases |
| F3 | One-to-six-member group creation, member activity, paused recovery guidance, handoff links, ordered metadata refresh and stale run snapshot protection | Web DOM and state tests, web typecheck and production build |
| F4 | Sidecar `message_bot`, configured same-workspace targets, reusable pairwise bus, background target wake, linked chat handoff, transactional event publication | Fake SDK `run-once.test.ts`, direct-message service/API tests, final-reply fault injection |

Integration review caught and fixed regressions before completion:

- A single-member thread still creates one queued wake immediately when a human
  messages a running or parked bot. Group unaddressed messages queue as durable
  walks; reserving a later group walk's first run could deadlock an earlier walk.
- Coalesced wakes use the maximum depth actually delivered, with a human message
  cutting off the old chain. Historical context cannot silently lower relay depth.
- Reaching the turn budget cancels queued wakes and completes pending walks;
  running calls may finish, but a fresh human message does not replay cancelled
  chains.
- Live events are buffered across outer write transactions. Failed handoffs and
  final replies leave neither partial rows nor phantom message/run notifications.
- Run activity does not move backwards when an older HTTP response arrives after
  a newer live status update; legitimate wait/resume transitions remain valid.

Verified in the integration worktree:

- `npm run typecheck`.
- `npm run typecheck -w packages/web`.
- `npm run lint`.
- `npm run build -w packages/web`.
- `npm test -- --maxWorkers=1`: 959 tests across 66 files passed.
- `git diff --check`.

The foundation merge checks above used in-memory or temporary databases, fake providers/SDK, and ephemeral
localhost ports where needed. No real model, Docker container, shared browser,
production database, or active 5173/8080 application was used. T2/T3, browser
runtime tab propagation, UI verification against a real stack, and the remaining
M2 batches above are still required before declaring M2 complete.


## Live-model follow-up

The subsequent real-model probe is recorded in
[m2-live-model-results-2026-09-22.md](m2-live-model-results-2026-09-22.md).
The final fixed matrix passed 7/8 cases on the configured model; duplicate
publication caused one failure, and an earlier expert incorrectly stayed silent.
This evidence does not change the milestone status to accepted.


## Messaging fixes — 2026-09-23

The follow-up in [m2-messaging-fixes-2026-09-23.md](m2-messaging-fixes-2026-09-23.md)
adds same-run/thread final-reply idempotency and factual recipient labels, without
changing role authorization or bot-message trust. The final code passes 966 T0/T1
tests and the final focused real-model matrix passes 20/20 (four scenarios, K=5).
Three attempted duplicate final publications were suppressed in that matrix.

The legacy-context control also passed 20/20; the first rejected context candidate
passed 17/20 and all its failures remain recorded. Thus the framework duplication
regression is closed and the final recipient-context regression sample passes,
but no statistically supported general role-following improvement is claimed.
B2 browser runtime and B3's full group acceptance remain open. The active app and
main checkout were neither updated nor restarted.

## Browser runtime follow-up — 2026-09-23

B2's runtime implementation is delivered in `4938dc0`: stable per-run CDP targets,
shared profile, serialized MCP dispatch, resumable target metadata, same-tab
contention and takeover screenshot fencing. See
[m2-browser-runtime-results-2026-09-23.md](m2-browser-runtime-results-2026-09-23.md)
for final image, reproducible checks and limitations. B2's X02/X03 K=5 calibration
and full X04/deferred-approval acceptance remain open; this update does not mark
B2's entire acceptance gate or M2 complete. B3 is the next development/acceptance
batch once those shared-environment gates are closed.

## Parallel browser hardening — 2026-09-23

Three Sol-medium subagents handled deferred approval, paired interference checks,
and final-reply diagnosis, with production integration by the parent agent. Runtime
commits `5eed80e` and `20daba1` validate actual targets after restore/select/capture
and validate the effects of new/close operations. The full local suite passes 995
tests. A dedicated T2 proves same-target parked approval resume, exactly one order,
and an unchanged peer; configured GLM-5.3 S01 and parked S11 also pass. This closes
the focused deferred-approval gap named above, not full X04 or M2 acceptance.

See [m2-browser-hardening-results-2026-09-23.md](m2-browser-hardening-results-2026-09-23.md)
for the paired dashboard probe, preserved failures, image identity, and remaining
X02/X03/X04/B3 gates. The probe cannot replace the unimplemented ticket/report
benchmark scenarios. Main application deployment remains outside this batch.


## B3 follow-up status (2026-09-23)

Group, chief, X01, caps, takeover and traceability gates now have passing evidence;
see [the B3 completion follow-up](m2-b3-completion-results-2026-09-23.md). B3 is
**not closed overall**: its B2 X02/X03 K5 dependency measured 1/10 interference,
above ADR-0004's 5% escalation rule. Proposed
[ADR-0007](../adr/0007-browser-origin-coordination-calibration.md) records the
origin-coordination investigation. B4/B5 remain separate. Production turn budget
stays 8; this isolated worktree has not been deployed to the main application.

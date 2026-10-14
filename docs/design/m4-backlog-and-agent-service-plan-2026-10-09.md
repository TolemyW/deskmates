# M4 backlog and the agent-facing service plan

Date: 2026-10-09. Status: working inventory for batch dispatch, not a decision
record. Source of truth for acceptance remains
[the M4 status ledger](m4-status-2026-10-04.md); ADR status is read from each
ADR header. Nothing here promotes an ADR or closes a gate.

## 1. Deskmates as a service for other agents

Decision taken in discussion on 2026-10-09: **no separate Job object.** The unit
of work is a thread, the durable outcome is a task (ADR-0021), an attempt is a
run. An external agent is a channel in the sense of ADR-0017: an operator-side
client that posts messages, consumes the SSE feed and reads the ledger. Every
capability a job queue would add maps onto an existing object:

| Job-queue need | Existing home | Gap |
|---|---|---|
| Identity and idempotency of a submission | thread `(channel, externalKey)` | none |
| Budget | thread `turn_budget`, `relay_count`; bot cost rules (ADR-0018) | deadline |
| Retry | a new message in the same thread | none |
| Transcript, usage | `thread_messages`, run usage | none |
| Delivered / accepted, artifacts | task states and references | bot cannot deliver |
| Terminal signal for a batch client | run status | `silent` is not an answer |
| Cancel | run state machine allows it | no route |
| Machine client identity | ADR-0022 principals | no service principal |

### Work items (lane A)

| # | Item | Depends on | Notes |
|---|---|---|---|
| A1 | ADR-0025: external agents as a channel. Service principals (tenant-scoped, role member, budget). Amend ADR-0021 decision 2: a sidecar `task_deliver` tool may move a task to `delivered` with artifacts and an optional schema-checked JSON output. `must_reply` flag on a message (a silent run is `failed` with reason `no_reply`). `deadline` on a thread. `POST /api/runs/:id/cancel`. Also answers permission-model finding C4. | owner reads | one agent; stop at the ADR |
| A2 | Service principal: migration, `auth/` principal kind, route-policy entries, CLI `create-service-principal`, quota per principal | A1 | |
| A3 | `POST /api/runs/:id/cancel` through run lifecycle; scheduler frees the lane; sidecar receives stop | A1 | independent of A2 |
| A4 | `must_reply` on `POST /api/threads/:id/messages`; `deadline` on thread create; scheduler enforces deadline as cancel | A1 | |
| A5 | Sidecar `task_deliver` tool; Gateway validates artifact refs and optional `outputSchema` stored on the task; Web shows bot-delivered tasks | A1 | amends ADR-0021 code and tests |
| A6 | Composite `POST /api/workspaces/:id/submit`: create thread with channel binding, post must-reply message, create linked task; idempotent on `externalKey` | A2, A4, A5 | |
| A7 | `packages/channels/deskmates-agent-mcp`: MCP server over the operator API (`list_bots`, `submit`, `get_task`, `wait`, `get_messages`, `post_message`, `cancel_run`, `list_approvals`, `decide_approval`, `download_artifact`); OpenAPI export | A6 | imports only contracts |
| A8 | `GET /api/capacity`: free lanes per bot, queue depth, browser-lock holder per workspace | none | can start now |

## 2. ADR inventory: what each still needs

| ADR | Header status | Code state | Remaining |
|---|---|---|---|
| 0006, 0009 | implementation in progress / accepted for implementation | B4 shipped | live acceptance on closeout images |
| 0012 connector contract | Proposed | `connector-postgres` shipped | owner promotion to Accepted |
| 0013 integration runtime | Proposed, amendments 1-3 | runtime, catalog token, Drive offline harness shipped (v0.3.5) | real Google account, OAuth grant, dedicated-folder trial; owner promotion |
| 0014 file download | Proposed | download and A1 text preview shipped | owner promotion |
| 0015 skills | Proposed | **no code** | full implementation or explicit deferral |
| 0016 turn-budget parks | accepted for implementation | unit checks pass | SDK/container (T2) and real-model acceptance |
| 0017 WhatsApp Cloud API | Proposed | adapter shipped | live-account rows; optional after QR |
| 0018 cost alerts | Proposed | routes and UI shipped | owner promotion |
| 0019 WhatsApp QR | accepted for implementation | adapter shipped | live phone after stable version |
| 0020 egress | accepted | shipped | none |
| 0021 tasks | Proposed | merged PR #3 | amendment by A1; owner promotion |
| 0022 tenancy | Proposed | P1 (PR #4 era) and P2-P4 (PR #8) merged | E2E-02 model-backed gate, MIG-01 migration rehearsal on a copy of the stable DB, findings C1-C8, then promotion; issue #5 |
| 0023 model selection | Proposed | **no code**; test plan SEL-01.. exists | implement three decisions; issue #10 |
| 0024 private-chat mentions | Accepted (2026-10-09) | merged as PR #12 on origin/main `cc60cd4`; issue #11 closed | runtime acceptance evidence only |

## 3. M4 acceptance gates (unchanged from the ledger)

Visual UI; Docker/runtime and domain T2/T3; real-model and memory; real SaaS
provider (Drive); statistical strategy; WhatsApp manual. See the ledger for the
evidence each requires. The memory runtime adapter and reset driver remain the
blocking component for the real-model gate; no paid memory campaign is
authorized.

## 4. Owner decisions that block work

1. Permission-model findings C1 to C8 (C4 is settled by A1 if accepted).
2. Promote ADR-0012, 0014, 0018, 0021 to Accepted, or say what is missing.
3. ADR-0015 skills: build now or defer out of M4.
4. Google account and folder for the Drive trial.
5. Phone for the WhatsApp QR acceptance.
6. Design open questions 8 and 11.

## 5. Dispatch plan

Independent lanes that can start today, one agent each:

- **Lane A1**: write ADR-0025 and the ADR-0021 amendment. Stop at the ADR.
- **Lane A8**: `GET /api/capacity`.
- **Lane A3**: cancel-run route (design v0.3 §4 already allows the transition; the ADR only names the route).
- **Lane B**: ADR-0023 decisions 1-3 with the SEL test plan. Offline-testable.
- **Lane C**: done; PR #12 merged on 2026-10-09 (ADR-0024). Local `main` must be fast-forwarded.
- **Lane D**: ADR-0022 MIG-01 rehearsal on a Testbox copy of the stable database; E2E-02 on the internal gateway.
- **Lane E**: ADR-0016 T2 container acceptance.

After A1 is accepted: A2, A4, A5 in parallel; then A6; then A7.

Deferred until an owner input arrives: Drive live trial, WhatsApp live, ADR-0015.

# ADR-0004: A group of bots shares one environment by default; separation comes from execution context

Date: 2026-09-20
Status: Accepted
Supersedes: ADR-0003
Source: product decision, 2026-09-20

## Context

ADR-0003 and design v0.3 gave every bot its own sandbox and introduced identity hosts so that bots could share a browser profile. That produced four tables, a second container role, per-grant Playwright MCP instances, origin allowlists, identity leases and a login probe, all to let two bots use one logged-in browser.

The product target is the opposite shape. Bots should behave like coworkers sitting at one machine. Grok Bot states this plainly: bots share one account-scoped computer and bot boundaries are not security boundaries. Separation, when it is needed, should come from what a bot is told to do and where it works, not from infrastructure.

The v0.3 machinery was built to answer a question nobody asked: how to stop bot A from using bot B's logged-in account inside a shared browser. In a shared-computer product, that is not a threat to defend against with infrastructure. It is a configuration mistake to avoid by not putting two trust domains on one machine.

## Decision

1. **The unit of environment is a Workspace, not a bot.** A workspace is one container: one Chromium with one persistent profile, one filesystem, one shell, one noVNC screen, one egress allowlist. A group of bots runs inside it.

2. **Sharing is the default and requires no mechanism.** Bots in a workspace share cookies and login state because they share the browser. They share files because they share the filesystem. Nothing is borrowed, granted, proxied or leased.

3. **Bots are separated by execution context, not infrastructure.** What distinguishes a bot is its `SOUL.md`, its working directory, the tools named in its prompt, its schedule, and its attribution in the ledger. These are soft distinctions and are documented as such.

4. **Identity as a first-class object is removed.** Deleted: `identities`, `identity_grants`, `identity_leases`, `identity_events`, the identity host container role, per-grant MCP instances, `--allowed-origins` as a grant mechanism, and the `waiting_identity` run state. The workspace is the identity.

5. **Isolation escalates by workspace, never by bot.** Work that must not share a login or a filesystem goes in a second workspace. The provider interface already supports this; it costs one container, not a subsystem.

6. **Browser concurrency is a correctness problem, not a permission problem.** Each run owns its own tab. A human takeover locks the whole workspace browser. Two runs touching one stateful page serialize on a workspace-level lock. No origin dimension.

7. **The boundaries that remain are boundaries against mistakes and against the outside, not between bots.** L2 approval still gates outward side effects. The egress allowlist is per workspace and still defaults to deny, because it defends against prompt injection exfiltrating data, which is unrelated to which bot is running. Ledger attribution still records which bot did what.

## Consequences

- ADR-0003's open item about `--allowed-origins` scope is moot. The flag is no longer part of the design. For the record, reading `@playwright/mcp` 0.0.82 showed it is implemented as `context.route()`, so it is context-scoped and would have collided across instances sharing one context; Playwright's own documentation also states it is not a security boundary and does not affect redirects.
- `packages/sidecar` loses the `identity` role and the lease client's origin dimension. One role remains.
- `packages/gateway` loses the Identity Registry and four tables; it gains a small `workspaces` table.
- `packages/sandbox-docker` provisions workspaces rather than per-bot sandboxes. The provider interface is unchanged.
- M2 loses the identity host work and the origin spike. The freed time goes to multi-bot coordination inside one workspace, which is now the real risk.
- New risk to watch: several bots acting in one browser and one filesystem can interfere. This is handled by tab ownership, working-directory convention and the workspace lock, and is accepted as the cost of the product shape.
- AGENTS.md rules change: "one bot, one sandbox" becomes "one group, one workspace"; "one identity, one profile" is deleted; "one Chromium per sandbox" becomes "one Chromium per workspace".
- **Goal impact, confirmed by the product owner on 2026-09-20:** design goal 2 drops from "surpass Grok Bot on four points" to three. Isolation is now at parity with Grok Bot's account-level computer; multiple workspaces are a configuration option, not a differentiator. Nothing inside a workspace is secret from its bots, including the cookie database, other bots' transcripts, and process environments such as the supervisor's TOTP secret.

## Definitions added on review (2026-09-20)

- **Browser lock, version 1.** Decision 6 says two runs "touching one stateful page" serialize, but nothing can detect a stateful page. The rule that is implementable and that the test strategy already encodes is tab ownership: every run opens its own tab and the Gateway records which run owns which tab. The lock is taken in two cases only: a human takeover holds it exclusively for the whole workspace; a run that acts on a tab it does not own queues on it. The lock is held per run with a TTL renewed on every browser tool call and released when the run ends. Runs working in their own tabs never wait for each other, even on the same site or the same record. This is version 1; it is the cheapest rule that makes the M2 acceptance scenarios pass, and open question 8 in design v0.3 (lock granularity) is decided by the metric below, not by argument.
- **Fully isolated** (decision 5) means four assertions between workspaces A and B: a cookie set in A is absent in B; a file written in A is absent in B; A's processes are not visible from B; A's network namespace is not reachable from B.
- **Interference.** Two runs in one workspace interfere when, in a paired execution, one run's oracle fails or the golden site's state shows a lost update (one run's write overwritten by the other's) that does not occur when the same tasks run alone. Measured on benchmark tasks X02 and X03 at K = 5.

## Verification

| Item | Means | Test | Metric |
|---|---|---|---|
| 1 | one container per `workspaces` row; inside it exactly one Chromium process tree, one CDP listener on 9222, one profile directory, one egress allowlist | T2 provider create/destroy (§4.4); T2 process-count assertion added to the same test | none |
| 2 | after bot A logs in, bot B's fresh tab is already authenticated; a file A writes under `/work` is readable by B, with no Gateway call in between | T2 shared cookie and file (§4.4) | none |
| 3 | 100% of `runs`, `run_events` and bot-authored `thread_messages` carry the acting `bot_id`; no code path rejects a tool call on the ground that another bot owns a resource | T1 attribution assertions in the three-bot thread test (§4.2); T0 static rule (§11) | none |
| 4 | no table, type, run state or config key named `identity*` or `waiting_identity` | T0 static schema test over `migrations/` and `contracts` | none |
| 5 | the four assertions above | T2 isolation (§4.4, §6) | none |
| 6 | lock version 1 as defined; per-run tab ownership recorded in the ledger; takeover blocks all browser tools and screenshots | T0 lock algorithm (§4.2); T1 takeover (§4.3, §6); `acceptance/m2-shared-env`; benchmark X02 to X04 | `lock_wait_ms` per run; `interference_rate`. Calibration rule for open question 8: if `interference_rate` exceeds 5% over X02 + X03 at K = 5, escalate to a per-origin lock by a new ADR; otherwise keep version 1 |
| 7 | L2 still requires approval for every bot; egress denied outside the workspace allowlist at L0; attribution as in item 3 | `acceptance/m1-egress`; `acceptance/m1-approval-defer`; §6 "shared environment still approves L2" | unrequested L2 attempts, egress blocks (measurement §3.2) |
| goal impact | the three claimed advantages are each a passing test: self-hosted = M0 acceptance passes from `docker compose up` on a clean machine, later `acceptance/m3-desktop-vm`; model-swappable = `acceptance/m0-model-swap`; memory inspectable, editable, exportable = `acceptance/m2-knowledge` plus a T1 Gateway API test that reads, edits and exports `MEMORY.md` and knowledge rows. Parity on isolation = item 5 | as listed | none |
| risk: bots interfere | accepted cost, bounded by the calibration rule in item 6 | X02, X03 | `interference_rate` |

## Amendment 1 — an opt-in per-bot working directory (2026-10-12)

Status: Proposed (needs product-owner sign-off). Decisions 1 to 7 are unchanged. This amendment gives decision 3's "working directory" a concrete, optional form. Source: issue #88. ADR-0036 (proposed) extends decision 8 with a per-workspace setting and would replace decisions 10 and 13.

### Context

Decision 3 names the working directory as one of the things that tell bots apart, but every run so far has started in the shared `/work`. In the long-horizon campaign of 2026-10-11 (four bots, seven hours, one shared git checkout) the team logged a commit that swept in a teammate's in-flight lines, a red-first check that captured a teammate's stub, two concurrent runs of one bot overwriting another bot's files, and duplicated work. They converged on manual rules (explicit staging, isolated `git worktree`s for checks) but never on one worktree per bot.

### Decision

8. **A per-bot working directory is a knob, off by default.** `DESKMATES_BOT_WORKDIR` is `shared` (default) or `per-bot`. Under `shared` a run starts in `/work` and its system prompt is byte-identical to the one before the knob. Under `per-bot` a run starts in `/work/bots/<bot name>`, which the sidecar creates on first use; if it cannot, the run logs a warning and starts in `/work`.
9. **The prompt states the convention; nothing enforces it.** Under `per-bot` the guidance names the bot's own directory, says that `/work`, that directory included, is shared with every bot and that keeping to it is a convention, not a boundary, and asks the bot to make its own `git worktree` inside its directory instead of editing a shared checkout, integrating by an explicit merge or cherry-pick. No hook, callback, lock or permission looks at which directory a tool call touches (AGENTS.md, decision 3 above).
10. **The platform creates no git worktree.** Whether and when to make one is the bot's decision, guided by the prompt.
11. **The mode is recorded per run and survives resume.** The Gateway writes `botWorkdir` to `runs.config_json` when the run row is created and sends `workdirMode: "per-bot"` on every process of that run from the row, not from its current configuration, so an approval resume starts where the first process did.
12. **Adoption is a strategy decision.** `per-bot` changes the prompt and the starting directory, so it is a strategy change. It becomes the default only after a paired `evals/compare.ts` campaign on a multi-bot code task says so. That campaign is not authorized at the time of writing.
13. **Not in this amendment:** lane awareness (telling a run that its bot's other lane is live, issue #88 item 3). It stays a separate proposal.

### Consequences

- Known, unverified risk: the SDK stores session transcripts per working directory. A thread session created under one mode may not resume under the other after an operator switches the knob; such a run would start a fresh session. Measure before relying on a switch mid-conversation.
- A bot rename moves its directory name; files under the old name stay where they are.

### Verification

| Item | Means | Test | Metric |
|---|---|---|---|
| 8 | default `shared`, unknown values rejected; with no `workdirMode` the run starts in `/work`, creates no bot directory and the system prompt hash equals the pre-knob value; `per-bot` starts in `/work/bots/<bot>` after creating it | T0 `packages/gateway/src/config.test.ts`; T1 `packages/sidecar/src/run-once.test.ts` "runOnce: working directory"; T0 `packages/sidecar/src/context.test.ts` "buildContext working directory" | none |
| 9 | under `per-bot` the prompt names the bot's directory, the shared `/work`, "not a boundary" and a `git worktree` under the bot's directory; a write into another bot's directory and into `/work` is allowed by the hook exactly as before | T0 `context.test.ts`; T1 `run-once.test.ts` (hook decisions `allow`) | none |
| 10 | no code path runs `git worktree` | review; no Gateway or sidecar command builds one | none |
| 11 | `runs.config_json.botWorkdir` recorded at creation; thread run, thread-less trigger and approval resume each get the row's mode after the configuration changed | T1 `packages/gateway/src/scheduler/run-lifecycle.test.ts` "the bot working-directory knob travels with the run"; T0 `packages/sidecar/src/start-run-request.test.ts` round trip | none |
| 12 | `per-bot` is not the default until a paired campaign | `config.test.ts` default assertion | `evals/compare.ts` paired team-campaign outcome per duration bucket, plus the campaign's collision count (commits touching another bot's in-flight files); not yet measured |
| 13 | lane awareness is outside this knob: neither mode's prompt says whether the bot's other lane is live | T0 `context.test.ts` pins the default prompt's hash; review for the `per-bot` guidance | none |

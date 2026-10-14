# ADR-0015: Skills: bots may author them, they prove themselves before they spread

Date: 2026-09-29
Status: Accepted for implementation (product owner, 2026-10-10); T2 rows recorded below; real-model acceptance pending
Source: `docs/design/m3-context-memory-research-2026-09-29.md` (OpenClaw, Hermes Agent, Claude Code, Letta, SkillsBench, ClawHub incidents). Builds on ADR-0011 (learned memory scopes and amendment 1), ADR-0004 (the workspace is the trust boundary) and the AGENTS.md rule that a change to skills is a strategy change.

## Context

Design v0.3 §3.1 lists `skills/` in each bot's home, "from a skill marketplace or local". Nothing reads it: the sidecar starts the SDK with `settingSources: []` and no `skills` or `plugins` option, so no run has ever had a skill. ADR-0011 gives bot experience the authority `procedure` but says nothing about the executable form of a procedure.

SDK 0.3.278 can deliver skills exactly: `plugins: [{type: 'local', path}]` loads skills from a directory, and `skills: string[]` enables only the named ones for the session. The typings call `skills` "a context filter, not a sandbox": unlisted skill files stay readable on disk.

What the field does (research §3 and the self-update survey):

- OpenClaw and Hermes create or patch skills from a background review gated by deterministic counters (at least 10 model or tool iterations in the triggering work); the model decides the content. In their default autonomous modes, agent-authored skills skip the security scan (OpenClaw `auto`, Hermes `guard_agent_created: false`).
- Nobody tests an agent-authored skill against tasks before it goes live. The only paired evaluation (Claude Code's skill-creator, `claude plugin eval`) is started by a human.
- SkillsBench (arXiv 2602.12670): skills the model wrote for itself changed success by −1.3 points on average, curated skills by +16.2, and curated skills still hurt 16 of 84 tasks. A skill's sign is not known in advance.
- Hermes retires unused skills by usage: stale after 14 days, archived after 30, never deleted.
- ClawHub audits found 341 of 2,857, later 824 of about 10.7k, third-party skills malicious. OpenClaw now requires a per-skill opt-in with a scan state.

## Definitions

- **Skill**: a directory in the Agent Skills format (`SKILL.md` with `name` and `description`, optional files). Identified by name and the SHA-256 of its content.
- **Origin**: `installed` (a human added it) or `authored` (a consolidation run wrote it).
- **Stage**: `provisional` (enabled for its author bot only), `active` (enabled for the bots it is assigned to), `stale` (not listed, kept), `archived` (not listed, kept, restorable). Nothing is deleted.
- **Skill set**: the exact names and content hashes enabled for a run.

## Decision

1. **The Gateway holds skills; runs receive them.** Skill content and versions live in the Gateway, per workspace. For each run the sidecar writes the run's skill set into a local plugin directory and starts the SDK with that plugin and `skills` listing exactly that set. Files in `/home/<bot>/skills` are not read. The skill set goes into `runs.config_json`.

2. **Bots author skills only in consolidation.** A consolidation run (ADR-0011 decision 8, triggered by amendment 1 A1) may write a new skill or a new version of one its bot used, when its input contains a closed episode that ended `succeeded`, used at least 10 tool calls, and is `trusted`. No skill is written during an ordinary run. An episode that is untrusted, or a skill whose text the ADR-0011 classifiers mark as imperative about duties, approvals, risk tiers or egress, or as a do-not-learn item (amendment 1 A2), goes to "needs your confirmation" instead.

3. **An authored skill starts provisional and spreads only by evidence or by a human.** A provisional skill is enabled for its author bot alone. It becomes `active` for other bots of the workspace in one of two ways: a paired `evals/compare.ts` run of those bots with and without it meets the plan's strategy decision rule, or a human assigns it. A skill never leaves its workspace; copying it into another workspace is a human action that carries its provenance.

4. **Humans install third-party skills by hash.** An installed skill is pinned to its content hash; a new upstream version is a new install. Installed skills are human-assigned and start `active`.

5. **Every skill is scanned before any run sees it, whatever its origin.** The scan is deterministic: links and commands that reach hosts outside the workspace allowlist, credential-shaped strings, instructions about approvals, egress, risk tiers or SOUL, and executable files are findings. A skill with findings waits in "needs your confirmation". Agent-authored skills get the same scan as installed ones.

6. **Use is measured by the harness, not reported by the model.** The sidecar records a `skill_used` event from the `PreToolUse` hook on the `Skill` tool. A skill no bot used for 14 days becomes `stale`, for 30 days `archived`. A human can pin a skill against both.

7. **Replayable and reversible.** Every skill write is an immutable version; undo restores the previous version; a human can move a skill to any stage. Replay restores the skill set recorded in `runs.config_json`.

## Alternatives

- Keep skills human-only: rejected. It leaves the procedural half of what bots learn with nowhere to go, and ADR-0011 already accepts automatic learning with a confirmation gate.
- Let an authored skill go workspace-wide at once, as OpenClaw's `auto` and Hermes do: rejected. SkillsBench shows a self-authored skill is as likely to hurt as to help, and a workspace-wide skill changes every bot's behaviour, which AGENTS.md makes a strategy change.
- Author skills in the hot path of a run: rejected. It costs turns in the run that needs them (the board trial of 2026-09-29 already lost three expert runs to the turn limit) and skips the trust rule that consolidation applies.
- Treat `skills` filtering as isolation: rejected. The SDK says it is not; the boundary stays the workspace.

## Amendment 1 (2026-10-11): release-bundled Starter Skills are workspace defaults

The original decisions describe installed and bot-authored Skills, but not Skills that are part of
the Deskmates product itself. Issue #46 first proposed presenting those Skills as another catalog that
each workspace would install, review and assign. The owner instead selected a built-in capability
library shared by every Bot in a new workspace.

S1. **A Starter Skill is a release asset, not a workspace installation.** Its files ship in the
Deskmates release and workspace image. Creating a workspace makes every Starter Skill in that release
available without another install, review or per-Bot assignment. Runtime download and arbitrary
third-party plugin loading are not part of this path.

S2. **All Bots in the workspace share the built-in library and load content on demand.** Every run
offers the release's Starter Skill names through the SDK's Skill mechanism; the SDK loads a Skill's
full body only when the model invokes it. This is a context filter and behavior configuration, never
an access boundary. `runs.config_json` records the exact Starter Skill names, versions and hashes so
the run remains attributable and replayable.

S3. **Trust moves to the release gate.** Each bundled Skill has an origin, license, version and
content hash in a checked-in manifest. The deterministic ADR-0015 scanner runs over every bundled
Skill during tests/build, and a release fails on an unreviewed finding or a missing manifest entry.
Workspace users do not repeat that review. User-created, bot-authored and externally installed
Skills still follow decisions 2 through 7 unchanged.

S4. **Credentials belong to Connections, never to a Skill.** A Starter Skill contains no account
credential and does not claim that the Integrations catalog supplies one. When a procedure needs an
external account, it uses the workspace's existing Integrations/Connections contract. If no usable
connection exists, it stops with a clear setup instruction. The credential remains in the owning
secret/connection subsystem.

S5. **Default availability is a strategy change, not evidence of quality.** Landing the library and
its deterministic tests does not justify saying a Bot is better. Stable activation records the
exact pack version and follows the repository's paired strategy-evaluation rule before making a
quality claim. A harmful Skill can be removed in a later release; replay uses the hashes recorded on
the historical run.

## Verification

In the original decisions, row 1 is the only row with a T2 and rows 2 to 7 rest on the T0/T1
tests named. Amendment row S2 requires additional Starter Skill category smoke tests. No real model,
no paired `evals/compare.ts` run and no metric in this table has been measured for the amendment.

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | A run's SDK options carry exactly one local plugin with the run's skill set and a `skills` list equal to it; a file dropped into `/home/<bot>/skills` does not appear; `runs.config_json` names each skill and hash | T0 `packages/sidecar/src/run-once.test.ts` ("runOnce: the run's skill set"); T1 `packages/gateway/src/skills/stages.test.ts` (start request and `runs.config_json`); T2 `packages/sidecar/src/sdk-shape.container.test.ts` ("real SDK skill set"): **pass** 2026-10-10, 0.9 s / 0.5 s (two runs alone), source `4ea18e9` plus the test; no model, a loopback scripted upstream. The sidecar's `materializeSkillPlugin` writes two enabled skills as one local plugin and the real SDK 0.3.278 is started with the sidecar's `settingSources: []`, `plugins` and `skills`; decoys sit in `<home>/skills`, `<home>/.claude/skills`, `<cwd>/.claude/skills` and, unlisted, in the plugin directory. Observed: `init.plugins` is exactly the run's plugin; the model's skill listing on every request is exactly the two enabled names and carries no decoy text; the `Skill` tool refuses the unlisted plugin skill ("not in this session's skills allowlist") and loads an enabled one. `init.skills` is the CLI's discovered list, not the enabled one: it also names the CLI's bundled skills and the unlisted plugin skill, so it is not an oracle for this row; the home, user and project decoys are not discovered at all. Runs the host's platform build of SDK 0.3.278 (darwin-arm64 on the workstation), as the file's other cases do, not the build inside the workspace image | none |
| 2 | A fake consolidation over a trusted 12-call succeeded episode may store a skill; over an untrusted one, a failed one or a 9-call one it produces a pending item; an ordinary run's summary cannot create a skill | T1 `packages/gateway/src/skills/authoring.test.ts` | authored skills per week (reported) |
| 3 | A provisional skill is in its author's skill set and in no other bot's; promotion without a compare result or a human action is refused | T1 `packages/gateway/src/skills/stages.test.ts`; over HTTP T1 `packages/gateway/src/api/skill-routes.test.ts` | paired success difference per promoted skill |
| 4 | An installed skill whose content hash changes upstream is not updated in place | T1 `packages/gateway/src/skills/stages.test.ts` ("install by hash") | none |
| 5 | A fixture of skills with an off-allowlist URL, a credential string, an approval instruction and a script is held pending, authored and installed alike | T0 `packages/gateway/src/skills/scanner.test.ts`; held when authored: T1 `packages/gateway/src/skills/authoring.test.ts`; held when installed: T1 `packages/gateway/src/skills/stages.test.ts`, `packages/gateway/src/api/skill-routes.test.ts` | scan findings per skill (reported) |
| 6 | `skill_used` events come only from the hook; 14 and 30 days of no use move a skill to `stale` and `archived` with a fake clock; a pinned skill stays | T0 `packages/sidecar/src/run-once.test.ts` ("records skill_used from the hook on the Skill tool only"); T1 `packages/gateway/src/skills/lifecycle.test.ts` | skills never used after 30 days (share) |
| 7 | Undo restores the previous version byte for byte; replay rebuilds the recorded skill set | T1 `packages/gateway/src/skills/versions.test.ts`; T0 `evals/replay.test.ts` ("replay restores the run's skill set") | none |
| S1 | a new workspace has the complete release-bundled Starter Skill set without install/review/assignment rows, and no run downloads code | T1 workspace creation and run-start tests; static test rejects runtime package/download calls in the built-in path | none |
| S2 | two Bots in one workspace receive the same Starter Skill names and hashes, while the SDK loads a Skill body only after its Skill-tool call; run config records the complete set | T0 sidecar fake-SDK test; T1 Gateway run-config test; one T2 smoke per Starter Skill category | Skill-tool calls per built-in Skill |
| S3 | every bundled directory has manifest origin/license/version/hash, passes the scanner, and changing bytes without updating the hash fails | T0 manifest completeness, hash and scanner tests | scan findings at release |
| S4 | a Starter Skill fixture contains no credential and, without a required connection, returns setup guidance without attempting a secret write; with a fake connection it uses only the integration proxy | T0 content/static scan; T1 fake-connection run | missing-connection stops |
| S5 | the release/run configuration identifies the exact pack; deterministic implementation acceptance makes no quality claim | T0 config serialization; paired `evals/compare.ts` receipt before any quality claim | paired success difference by duration bucket |

## Consequences

- Skills become a Gateway store with migrations and a "Skills" section next to "Learned memory" in the UI.
- The sidecar gains plugin materialisation and the `skill_used` hook; the design §3.1 row for `skills/` changes to "delivered by the Gateway per run".
- Promotion depends on `evals/compare.ts` and a task set that exercises the skill; until the golden-site memory suite exists, promotion is by human assignment only.
- A workspace that only browses untrusted sites authors no skills without human confirmation, by the same logic as ADR-0011's consequence for bot experience.

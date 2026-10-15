# ADR-0036: Per-workspace working-directory settings, platform-prepared git worktrees and lane notes

Date: 2026-10-14
Status: Proposed (engineering proposal on issue #88; no decision below has owner sign-off. Open owner questions: whether a workspace-level setting is the right scope (decision 1), whether the platform should prepare worktrees at all (decision 4), one worktree per bot rather than per lane (decision 6), and whether to authorize the paired campaign in decision 8.)

## Context

Issue #88 reports what a four-bot team logged in seven hours on one shared git checkout: a commit that swept in a teammate's in-flight lines, a red-first check that captured a teammate's stub, two concurrent runs of the same bot overwriting another bot's files, and duplicated work. ADR-0004 amendment 1 (Proposed, 2026-10-12) added a Gateway-wide knob, `DESKMATES_BOT_WORKDIR=per-bot`, that starts a run in `/work/bots/<bot>` and tells the bot to make its own `git worktree` there. It left three things out: the knob is one value for the whole Gateway, so a code team and a browsing team on the same Gateway cannot differ (owner question on the issue); the platform creates no worktree (its decision 10), so every bot must remember to; and a bot whose interactive and background lanes run at once is told nothing about the other run (its decision 13).

The rules this ADR must keep are AGENTS.md's: bots in one workspace share one filesystem; a working directory is a soft distinction, not a security boundary; no tool call is rejected because another bot "owns" a path; and a change to the prompt is a strategy change that needs a paired `evals/compare.ts` campaign before it becomes a default.

## Decision

1. **A workspace stores its own working-directory settings; nothing is stored by default.** Three independent settings, each absent unless an Admin sets it:
   - `mode`: `shared` or `per-bot`. Absent inherits `DESKMATES_BOT_WORKDIR` (ADR-0004 amendment 1, decision 8), so a Gateway that never sets it behaves as before.
   - `worktreeRepo`: the absolute path of one git repository under `/work` that the team works on. Absent means the platform prepares no worktree.
   - `laneNotice`: `true` or absent (off).

   `GET /api/workspaces/:id/workdir` is open to Members, `PUT` to Admins (ADR-0022 amendment 6); a field sent as `null` clears it. Every change writes one `workspace.workdir_set` audit row with before and after values in the same transaction. The setting is workspace-level, not per bot: a workspace is one scenario (AGENTS.md default grouping), and the bots of one code team should follow one convention. A per-bot override is not proposed.

2. **A worktree repository is a plain path under `/work` and needs `per-bot`.** `worktreeRepo` must be an absolute path below `/work` (not `/work` itself), at most 200 characters, made of segments of `[A-Za-z0-9._-]` that are neither `.` nor `..`, and not under `/work/bots/`. It can be stored only together with a stored `mode` of `per-bot`; storing `mode: shared` clears it. The Gateway validates it when it is set, and the sidecar validates it again when it parses a start request.

3. **A run freezes its settings at first start.** On a run's first process the Gateway resolves the settings and writes `botWorkdir` (`shared` or `per-bot`), `botWorkdirSource` (`workspace` or `gateway`), `worktreeRepo` (a path or `null`), `laneNotice` (boolean) and `workdirVersion: 1` to `runs.config_json`, replacing the `botWorkdir` the row was created with. A workspace that stores no mode keeps the Gateway mode the row recorded at creation, not the Gateway's current one (ADR-0004 amendment 1 decision 11). Every later process of the run (approval resume, continuation) sends what the row holds, as ADR-0004 amendment 1 decision 11 already does for the mode. A row without `workdirVersion` is a run from before this ADR and keeps its creation-time `botWorkdir`.

4. **With `worktreeRepo` set, the sidecar prepares one worktree per bot before the query.** The worktree is `/work/bots/<bot>/<last segment of worktreeRepo>` on branch `bots/<bot>`. The sidecar runs the image's preinstalled `git` (never `npx` or a download) with a 30-second timeout per command:
   - a directory that already holds a `.git` entry is reused as it is;
   - otherwise it runs `git -C <repo> worktree prune` (drops registrations whose directory is gone), then `git -C <repo> worktree add <path> bots/<bot>` when the branch exists, or `git -C <repo> worktree add -b bots/<bot> <path>` from the repository's current `HEAD` when it does not.

   "Refresh" means only the prune and the re-creation of a missing directory from the existing branch. The platform never resets, cleans, pulls, rebases, checks out over, merges or removes a worktree or a branch: integrating work stays an explicit act of a bot. The outcome (`created`, `reused` or `failed` with the reason) is a `workdir` log event in the run's ledger. A failure, including a path that is not a git repository, never fails the run: the run starts in the bot directory, and its first user turn says the worktree could not be prepared and why.

5. **The prompt says where everyone works; the default prompt does not change.** Under `per-bot` the system prompt's working-directory lines also say that each teammate's directory is `/work/bots/<their name>`. With a worktree it names the worktree path and the branch the platform keeps for the bot, says the shared checkout at `worktreeRepo` is for integration, and keeps the explicit merge or cherry-pick rule. These lines depend only on the bot name and the frozen settings, so the system prompt stays byte-stable from run to run. With nothing stored and `DESKMATES_BOT_WORKDIR` unset the system prompt is byte-identical to the one before this ADR (`context.test.ts` pins its hash).

6. **Lane awareness is a note, not a lock, and both lanes share one worktree.** When `laneNotice` is frozen on and, at the moment a process of the run starts, the same bot has another run on its other lane in a lane-holding status, the start request carries that run's id, lane, trigger kind, thread id (when it has one) and start time. The sidecar adds one paragraph after the trigger in the run's prompt naming that run and saying that both runs share the bot's directory and worktree, so it should look at `git status` before editing, stage only its own files and say in its reply what it changed. The run that starts second is the one told; the earlier run is not interrupted. One worktree per bot, not one per lane: a second worktree would give one persona two branches to integrate with itself and doubles the disk and setup cost, while the observed collisions were between bots. If the paired campaign shows same-bot collisions remain, a per-lane worktree is a later knob.

7. **A convention, never a boundary.** No hook, callback, lock or permission reads these settings or looks at which directory a tool call touches. A bot can still read and write every path under `/work`, including another bot's directory and worktree, and the prompt says so.

8. **Each setting is a strategy knob and none is a default.** `mode`, `worktreeRepo` and `laneNotice` change the prompt or the starting state, so each is a separate strategy change, recorded separately on the run row so a campaign can vary exactly one. None becomes a default until a paired `evals/compare.ts` campaign on a multi-bot code task says so, per duration bucket. That campaign is not authorized at the time of writing.

9. **Relation to ADR-0004 amendment 1.** This ADR extends its decision 8 (a workspace value overrides the Gateway knob), and, if accepted, replaces its decision 10 (the platform prepares a worktree when, and only when, a workspace opts in) and its decision 13 (lane awareness is decision 6 here). Its decisions 9, 11 and 12 stand.

## Alternatives considered

- **Per-bot settings.** More flexible, but a mixed team (some bots in worktrees, some in the shared checkout) reintroduces the collisions for everyone; deferred until a team needs it.
- **A per-lane worktree.** Rejected for now, decision 6.
- **A lock on the worktree or the bot directory.** Rejected: it is access control between bots or between one bot's runs, which AGENTS.md forbids, and a stuck lock costs more than the note.
- **The Gateway creates the worktree through a container exec.** The sidecar already runs in the container at the right moment and has the run's ledger; a Gateway exec would add a second path into the container for a file operation.

## Consequences

- A workspace that sets `worktreeRepo` gets a `bots/<bot>` branch per bot in that repository. Renaming a bot creates a new directory and branch; the old ones stay.
- Known, unverified risk carried over from ADR-0004 amendment 1: the SDK keys session transcripts by working directory, so switching `mode` mid-conversation may start fresh sessions.
- The worktree is prepared as the sidecar's user. Every bot runs as that user in the workspace, so ownership does not separate bots, as intended.

## Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1 | a new workspace stores nothing and its runs record the Gateway mode; a Member reads, a Member's PUT is 403, an Admin's PUT stores and writes one `workspace.workdir_set` audit row; `null` clears | T1 `packages/gateway/src/workdir/workdir-settings.test.ts`; T1 `packages/gateway/src/api/workdir-routes.test.ts` | none |
| 2 | relative paths, `/work`, `..`, `/work/bots/...`, bad characters and a repo without `per-bot` are refused with `validation`; `mode: shared` clears the repo; the sidecar parser refuses the same paths | T0 `packages/contracts/src/workdir-settings.test.ts`; T0 `packages/sidecar/src/start-run-request.test.ts` | validation refusals on workdir settings |
| 3 | first start writes the five keys; a resume after the setting changed sends the frozen values; a row without `workdirVersion` keeps its creation mode | T1 `packages/gateway/src/scheduler/run-lifecycle.test.ts` "workspace working-directory settings freeze at first start" | none |
| 4 | reuse when `.git` exists; prune then add with `-b` for a new branch, without `-b` for an existing one; only `git` is spawned, never `npx`; a failing command logs `failed`, starts the run in the bot directory and adds the first-turn line; no reset, clean, pull, checkout or remove argument is ever built | T0 `packages/sidecar/src/worktree.test.ts`; T1 `packages/sidecar/src/run-once.test.ts` "runOnce: prepared worktree" | `workdir` log outcomes per run |
| 5 | `per-bot` prompt names teammates' directories; with a repo it names the worktree and branch; the default prompt hash is unchanged | T0 `packages/sidecar/src/context.test.ts` | none |
| 6 | with `laneNotice` and a live other-lane run the request carries it and the prompt names it; without the setting, or with no live run, nothing is added | T1 `run-lifecycle.test.ts` "lane notice"; T0 `context.test.ts` "lane notice" | same-bot collision count in the paired campaign; not yet measured |
| 7 | a write into another bot's worktree and into the shared checkout is allowed by the hook under every setting | T1 `run-once.test.ts` "runOnce: prepared worktree" (hook decision `allow`) | none |
| 8 | all three settings are absent on a new workspace and recorded per run | `workdir-settings.test.ts` default assertion; `run-lifecycle.test.ts` | `evals/compare.ts` paired team-campaign outcome per duration bucket per knob, plus collisions (commits touching another bot's in-flight files); not yet measured |
| 9 | ADR-0004 amendment 1's mode knob still applies when a workspace stores no mode | `run-lifecycle.test.ts` "the bot working-directory knob travels with the run" | none |

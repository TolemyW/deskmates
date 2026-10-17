# ADR-0043: A bot is editable after creation

Date: 2026-10-16
Status: Accepted for the scope the owner wrote in issue #10 (every field editable, SOUL/MEMORY version history with restore, edit while busy, diary view, pause, "Run now", rule edit). The engineering choices inside it are proposed and await owner review: decision 1's directory move and its refusal while the bot has a live or parked run, decision 3's session rule, decision 4's refusal while the bot has a live run, and the audit contents of decisions 2 and 4. Pause is recorded as ADR-0026 amendment 1.
Source: GitHub issue #10
Builds on: ADR-0004 (one workspace, shared files), ADR-0011 A5 (canonical SOUL and MEMORY), ADR-0023 (model fields), ADR-0026 (Trash), ADR-0031 (schema conventions), ADR-0038 (per-bot directories)

## Context

Configuring one bot was spread over six screens and several of its fields could not be changed at
all once it existed. `name`, `role`, `connectors` and `messageAllowlist` were create-time only, so
changing a role meant recreating the bot. SOUL.md was one column with a counter: its audit row
kept two hashes and no text, so an operator could neither compare two saved versions nor go back
to one, nor recover the SOUL a past run used, even though `runs.config_json.canonicalSoulVersion`
names it. The MEMORY.md write left no audit row at all. Editing either file while the bot had a
live or parked run was refused (409 `lane_busy` / `invalid_transition`), although the sidecar
rewrites both files from the canonical copies at the start of every attempt
(`packages/sidecar/src/canonical-files.ts`), so a saved edit already reached the next attempt and
the refusal protected nothing. The bot's own diary, `/home/<bot>/memory/YYYY-MM-DD.md`, which
opens every run, was invisible to the operator. Cron entries could not be started on demand and
approval rules could be created and deleted but not edited.

## Decision

1. **Every field but the workspace is editable.** `PATCH /api/bots/:id` takes `name`, `role`,
   `connectors` and `messageAllowlist` next to the model, reasoning (`effort`, `thinking`),
   avatar and cron fields it already took; each key is independent and applies from the bot's
   next run, a live run keeping the configuration its row froze. The workspace stays create-time:
   it is a trust domain, not a setting (ADR-0004). A new name keeps the rules of create: it
   matches `[A-Za-z0-9_-]+` and is unique in the workspace case-insensitively, bots in Trash
   included. A name is also a directory, so a rename:
   - is refused while the bot has a live run (`lane_busy`) or a parked one
     (`invalid_transition`): a run's home and working directory are fixed when it starts, and a
     parked run resumes in the ones it started in. The scheduler holds the bot's other runs while
     the rename is in progress;
   - first moves `/home/<old>` (SOUL.md, MEMORY.md, the diary, the SDK's stored sessions) and
     `/work/bots/<old>` (ADR-0038) to the new name inside the workspace container through the
     fixed command `deskmates-sidecar bot-rename`, starting a stopped workspace for it. Every check
     runs before the first move, so a refusal moves nothing: a target directory that holds files,
     or a source that is a symlink or not a directory, is an error and the name is not changed;
   - then, in one transaction, writes the name, rewrites the old name to the new one in every
     workspace peer's message allowlist, gives each thread title the Gateway made from member
     names (the private chat's title is the bot's name) the new name, and records the change in
     the audit log. A title a person typed is left alone. Stored messages keep their text.

   This supersedes ADR-0038's consequence that "a bot rename gives the bot a new directory; the
   old one becomes read-only to every bot until a person moves it": the directory moves with the
   name.

2. **SOUL.md and MEMORY.md keep every saved version.** A new append-only table
   `bot_rule_versions` (bot, file `soul` or `memory`, version, body, author, time, and the version
   a restore came from) gains a row, numbered 1, 2, 3... per bot and file, from every write: a hand
   edit, an applied SOUL proposal, the SOUL given at create, the import of an older bot's physical
   file, and a restore. The migration makes each existing non-empty body version 1. A trigger
   refuses any UPDATE; permanent deletion of the bot cascades (ADR-0026 decision 5).
   - Members read the list (newest first, at most 200, without bodies), one version's body, and a
     line diff between two versions computed with the SOUL-proposal `diffSoulLines`; an Admin
     restores one, which writes its body through the same version-checked canonical write as a
     hand edit, so it becomes a new version and history is never rewritten.
   - Every run records the numbers its attempt was given, `canonicalSoulRevision` and
     `operatorMemoryRevision`, in `runs.config_json` next to the hash `canonicalSoulVersion`; the
     list names the version the bot's last started run used (for a run from before the numbers,
     the newest version whose body has the recorded hash).
   - The audit row of a SOUL or MEMORY write records the before and after hashes and the new
     version number, never the text; the MEMORY write now writes one as the SOUL write did. The
     text lives in the version table, readable by the same roles as the file itself.

3. **An edit under a live or parked run is saved for the next run.** A SOUL or MEMORY write (hand
   edit, proposal apply, restore) is no longer refused because a run of the bot is live or parked.
   It answers 200 with `appliesFromNextRun: true` when one was. The running attempt keeps the files
   it started with; the bot's next run, or the parked run's next attempt, is given the new body,
   because the sidecar rewrites both files at the start of every attempt. The write still clears
   the bot's SDK sessions; a run that was live during the save does not store its session when it
   ends (its recorded revisions differ from the current ones), so the next run starts a fresh
   session under the new rules, as it did when the edit had to wait.

4. **The diary is readable, and deletable one line at a time.** `GET /api/bots/:id/diary` lists
   the bot's `YYYY-MM-DD.md` days, newest first, and `GET .../diary/:day` reads one as lines with
   the file's hash, through the fixed command `deskmates-sidecar diary`, which opens nothing but
   `/home/<bot>/memory/<day>.md` and refuses a symlinked home, memory directory or day file. An
   Admin deletes one line by index, exact text and the day's hash, so a line the bot appended or
   changed since it was read is never the one removed; the delete is refused while the bot has a
   live run, whose end appends to today's file. Each delete is an audit row `bot.diary_edit` with
   the day, the line index and the line's hash and length, never its text. The diary lives in the
   workspace container: a stopped workspace answers `sandbox_unavailable`, and reading never
   starts one. Nothing here writes a diary line.

5. **"Run now" and rule edits close the management gaps.** `POST /api/bots/:id/cron/:entry/run`
   creates a normal background run of that entry with the new trigger kind `manual` and the
   entry's prompt and schedule in its payload, plus who asked; it is queued behind the bot's lane
   like a cron round and refused for a paused bot. The sidecar receives it as the cron prompt.
   `PATCH /api/approval-rules/:id` edits a rule's matcher or decision in place under the same
   validation as a new rule: it keeps its id and its place in the oldest-first order, so which rule
   answers a call changes only by what it says, and writes an `approval_rule.update` audit row with
   both sides.

6. **These are configuration and routing, not access control.** Name, role, connectors and the
   allowlist remain what they were at create: routing and prompt-level choices between bots in one
   workspace (ADR-0004, ADR-0005 item 5). Nothing here adds a check that refuses one bot's tool call
   because of another bot.

### Not decided here

Deferred by issue #10: an assembled-prompt preview or dry run (the assembly needs the workspace
container), bot clone and templates, and per-bot limits or budgets (ADR-0032 keeps budgets per
workspace).

## Alternatives considered

- **Keep the directory name when renaming** (a stored home name next to the display name). No
  files move, but `/home/<name>` would no longer name the bot, which every prompt, peer and
  operator relies on; the ADR-0038 consequence showed the cost of a directory that does not
  follow the name.
- **Rename lazily at the next run start.** The rename route would not need the container, but a
  bot created under the old name before that run could claim the old directory.
- **Store a diff per version instead of the body.** Smaller, but a restore or a diff of two old
  versions would need the whole chain; bodies are at most 64 KiB.
- **Keep refusing an edit under a live run.** The refusal protected nothing the sidecar did not
  already guarantee, and on a busy bot made an edit a matter of timing.

## Consequences

- A rename starts a stopped workspace's container and waits for the bot to be idle; an operator
  who renames a running bot is told to wait.
- `bot_rule_versions` grows with every save, at most 64 KiB a row; nothing prunes it yet.
- `runs.config_json` gains `canonicalSoulRevision` and `operatorMemoryRevision` (ADR-0001: every
  run records its knobs).
- A diary line deleted here may already be in a run's context; the delete affects the next run.

## Verification

| Decision | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | PATCH of role, connectors, allowlist, effort and thinking persists and the next run's start request and `config_json.reasoning` carry it; a rename moves both directories first (exec `bot-rename` with `{from, to}`), retitles the private chat, rewrites peers' allowlists so `message_bot` to the new name routes and the old name does not; bad or duplicate names are 400; a live or parked run refuses it; a refused move commits nothing; the move refuses a non-empty target or a symlink before moving anything | T1 `packages/gateway/src/api/bot-editing.test.ts`; T0 `packages/sidecar/src/bot-rename.test.ts` | `bot.update` audit rows with `name` |
| 2 | two SOUL saves are versions 1 and 2, the diff route returns `diffSoulLines` of them, restoring 1 is version 3 with version 1's body and `restoredFrom: 1`, the next run records `canonicalSoulRevision` 3 and the list's `lastRun` names it; UPDATE on the table fails; MEMORY saves are versions and write `bot.update` audit rows with hashes and numbers and no text | T1 `packages/gateway/src/api/bot-config-routes.test.ts` "rule-file versions"; T1 `packages/gateway/src/api/memory-routes.test.ts`; T0 `db/schema-conventions.test.ts` | versions per bot |
| 3 | a SOUL save while a run is live answers 200 with `appliesFromNextRun`, the live attempt's request kept the old body and revision, that run does not store its session, and the next run gets the new body and no resumed session; a MEMORY save under a live and a parked run is 200; a proposal apply under a live run is 200 and leaves the run running | T1 `bot-config-routes.test.ts` "editing while busy"; T1 `memory-routes.test.ts`; T1 `memory-governance-routes.test.ts`; T1 `packages/gateway/src/model-jobs/soul-proposals.test.ts` | saves with `appliesFromNextRun` |
| 4 | days list newest first and only `YYYY-MM-DD.md`; a delete names index, text and hash and is refused after an append; symlinks and bad names are refused; the route reports a stopped workspace; the audit row has no line text | T0 `packages/sidecar/src/diary-file.test.ts`; T1 `bot-config-routes.test.ts` "diary" | `bot.diary_edit` audit rows |
| 5 | "Run now" creates a `manual` background run with the entry's prompt that the sidecar receives as a cron trigger, 404 for a missing entry, refused when paused; a rule edit keeps id, order and `createdAt`, writes `approval_rule.update` with both sides and refuses an invalid matcher or decision | T1 `bot-config-routes.test.ts` "Run now"; T1 `packages/gateway/src/bots/bot-pause.test.ts`; T1 `packages/gateway/src/api/approval-rule-edit.test.ts` | runs with trigger `manual` |
| 6 | no route or hook added here refuses a bot's tool call because of another bot | review; the existing `run-once.test.ts` and route-policy tests are unchanged | none |

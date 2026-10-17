# Context and prompt-cache observability (ADR-0023 amendment 5)

Issue #8 found that a run's first request was about 57k tokens while the sidecar's own sections
were under 10k, and that two workspaces never hit the prompt cache. This page covers what the
ledger now records about that, the system-prompt split, and the knobs that trim the CLI surface.
Showing that cache hits actually improve on a real model is a separate Testbox measurement. Nothing
here proves it.

## What the ledger records

Sidecar `log` events (no new event kind):

| `source` / `kind` | When | Payload |
|---|---|---|
| `context` / `context_sections` | once per attempt | section sizes, `systemPromptSha256`, plus `systemPromptStaticSha256` and, when there is one, `systemPromptDynamicSha256` |
| `context` / `context_usage` | `detail: "full"` once after `system/init` (`turn: 0`); `detail: "summary"` after each model response except the last | the CLI's `query.getContextUsage()` answer: `totalTokens`, `maxTokens`, `percentage`, every category `{name, kind, tokens}`, MCP tools per server (per tool on `full`), built-in tools (per tool on `full`), memory files, skills, the message breakdown |
| `context` / `context_usage` with `level: "warn"` | the first time the CLI cannot answer | the error. No more samples are taken in that process |
| `sdk` / `session_start` | the `SessionStart` hook | `sessionSource` (`startup`, `resume`, `compact`, ...) and, on a resume, `contextTokens`, `promptCacheLikelyExpired`, `secondsSinceLastResponse` |

`model_switch` events gain `promptCacheWarm` and `contextTokens` from the `PostModelSwitch` hook.

`model_requests` (migration `202610151811-model-request-shape.sql`) records each forwarded
request's shape: counts and hashes only, never text. A column is NULL when the body could not be
read, and on rows from before the migration.

| Column | Meaning |
|---|---|
| `cache_control_blocks` | `cache_control` markers anywhere in `system`, `tools` and `messages` |
| `system_blocks`, `system_chars` | block count (1 for a string) and text length of `system` |
| `system_static_sha256` | canonical sha256 of the system blocks up to and including the last one carrying `cache_control`, which is the prefix the request marks cacheable. NULL when no block carries a marker |
| `system_dynamic_sha256` | the same over the blocks after it. NULL when there are none |
| `system_block_hashes_json` | the first 16 hex digits of each system block's hash, in order |
| `tools_count`, `tools_chars` | tool definitions and the length of their JSON |
| `messages_count` | entries in `messages` |

## `GET /api/runs/:id/context`

Every existing field is unchanged. The new fields are optional in the `RunContextMetrics` type, and
the Gateway always fills them:

- `systemPromptStaticSha256`, `systemPromptDynamicSha256`: from the latest `context_sections` event.
- `contextUsage`: `{samples, first, latest}`. `first` is normally the `full` breakdown at start.
- `sessionStarts`: one entry per `session_start` event.
- `requestShapes`: over the forwarded `messages` requests that carried a shape. Fields: `measured`,
  `withCacheControl`, `distinctStaticHashes`, `distinctDynamicHashes`, `staticChangedWithinAttempt`,
  `changedSystemBlocks` (positions whose hash took more than one value) and the largest system,
  tool and message sizes. It is null when no request carried a shape.

## The system-prompt split

The sidecar passes the system prompt as `{type: "custom", prompt: [static, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamic], snapshot: true}`.
The static part is SOUL.md plus the workspace guidance. The dynamic part holds the sections chosen
per run, which today is only the withheld-image notice. Joined with a blank line, the blocks are the
string every earlier run sent, so `systemPromptSha256` does not move. Memory, diary, pinned index
and knowledge stay in the first user turn (ADR-0011 decision 9). `runs.config_json` records
`systemPromptStaticSha256` next to `systemPromptSha256`.

## Trimming the CLI surface

These are strategy knobs. Each is empty by default, which changes nothing. They are read by
`src/config/cli-surface.ts` and documented in `.env.example`:

| Variable | Effect |
|---|---|
| `DESKMATES_CLI_DISALLOWED_TOOLS` | comma-separated built-in tool names (PascalCase) withheld on top of the sidecar's fixed `DISALLOWED_TOOLS`. An MCP name is refused at startup |
| `DESKMATES_CLI_DISABLE_BUNDLED_SKILLS` | `true` or `false`, passed as `settings.disableBundledSkills` |
| `DESKMATES_CLI_INCLUDE_GIT_INSTRUCTIONS` | `true` or `false`, passed as `settings.includeGitInstructions` |
| `DESKMATES_CLI_SKILL_LISTING_MAX_DESC_CHARS` | a positive integer, passed as `settings.skillListingMaxDescChars` |

Every run row records `cliSurface: {version: 1, disallowedTools, disableBundledSkills, includeGitInstructions, skillListingMaxDescChars}`,
with `null` for the CLI's default. Every process of the run reads the field back from its own row,
so a resumed session keeps the tool set it started with. The start request carries `cliSurface`
only when something is set. A change is not "better" until a paired evaluation says so (AGENTS.md).

# Agent runtimes (ADR-0042)

A bot's runs use one of two agent loops, both hosted by the sidecar: the Claude Agent SDK (the
default, and every run before the knob existed) or the OpenAI Agents SDK. The runtime is a knob
like the model: an installation default, a per-bot override, and a value frozen on every run row
so `evals/compare.ts` can pair runs that differ in it alone.

## Configuration

- `DEFAULT_RUNTIME` in `.env`: `claude-agent-sdk` (empty) or `openai-agents`
  (`src/config/runtime.ts`).
- `POST /api/bots` and `PATCH /api/bots/:id` accept `runtime`; `null` on PATCH clears the
  override. The bot's effective model must be served by an upstream of the runtime's protocol
  (`anthropic` for the Claude SDK, `openai` for the OpenAI Agents SDK), or the request is refused
  with `validation`. The cheap model is not checked: model jobs and summaries run on the Claude
  SDK whatever the bot's runtime, so it must stay on an `anthropic` upstream.
- `MODEL_UPSTREAMS` entries may carry `"protocol": "openai"`: an OpenAI Chat Completions endpoint.
  The proxy forwards `POST /v1/chat/completions` only to such an upstream and `/v1/messages` only
  to an `anthropic` one; a mismatch is `503 model_upstream_missing` naming both protocols. The
  frozen-model check, the token swap, budget admission and the `model_requests` row are the same
  for both paths; usage is read from the OpenAI shape (`prompt_tokens`, `completion_tokens`,
  `prompt_tokens_details.cached_tokens`) and `image_url` parts count as image blocks.

## What the Gateway records

- `runs.config_json.runtime`, written at run start beside `model` and `cheapModel`, kept on
  resume. `StartRunRequest.runtime` carries it to the sidecar.
- `bot_sessions.runtime`: the loop that wrote the stored session. A run resumes a session only
  when its runtime matches; a bot moved to the other runtime starts a new session.
- `ledger`: every run logs `{source: "runtime", runtime}` once; the `system/init` log names the
  runtime in place of the CLI version.

## What the OpenAI runtime does differently

The sidecar's PreToolUse hook judges every tool call on both runtimes. On the OpenAI runtime a
`deny` is returned to the model as the tool's result, a `defer` parks the run with its serialised
state in the bot's home directory, and a resume applies the human's decision through the same hook.
The file and shell tools (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `LS`) are the sidecar's
own, with the Claude SDK's parameter names, so the tier tables apply unchanged; the `deskmates`
tools and the browser `mcp-proxy` are attached through MCP clients under their usual
`mcp__<server>__<tool>` names.

Not on this runtime yet: compaction, the reply-preview stream, per-turn `turn_usage` events,
image tool results (a notice replaces the image), `Skill`, subagents, a fallback model. A thread
that outgrows the model's context ends on the model's error, and the run row says so.

Switching a bot's runtime is a strategy change (AGENTS.md): measure it with `evals/compare.ts`
on a paired run before calling either runtime better.

# Context and memory in other agent frameworks: what Deskmates should learn

Date: 2026-09-29. Input to `m3-context-and-memory-plan-2026-09-29.md`.

Method: web research over product docs, engineering posts and papers, plus
checks against the installed Agent SDK typings (§1, §6). Evidence grades used
below: **measured** (a controlled study with numbers), **vendor** (a vendor's
own docs or internal eval), **docs** (documented behavior, no effect numbers),
**abstract** (a 2026 preprint read at abstract or summary level only; verify
before relying on it). Nothing here was run against Deskmates except the typings
checks in §1 and §6.

## 1. Finding verified in our own dependency

`@anthropic-ai/claude-agent-sdk` 0.3.278, `sdk.d.ts` `systemPrompt.snapshot`:
by default (a bare string, as `run-once.ts` passes) the system prompt is
recorded on a conversation's first request and reused verbatim on every later
request and `resume`, "a different `append` or `prompt` passed on a later launch
of the same session is ignored until compaction or a new session". The same
typings say recording is rolling out and has no effect where not enabled.

Consequence if it is active behind our proxy: a resumed thread run sees the
MEMORY.md, diary and knowledge hits of the thread's **first** run, not the
current ones, until an invisible auto-compaction. A SOUL change already clears
`bot_sessions` (`gateway/src/knowledge/bot-file-governance.ts`); MEMORY edits,
applied memory suggestions, diary lines and per-run knowledge retrieval do not.
Whether it is active is unverified: it needs a model-proxy check of the system
prompt hash per request on a resumed session. Either way the fix is the same one
the SDK docs and every framework below recommend: keep the system prompt stable
and send changing context in the conversation.

The typings also confirm the observability hooks we lack: an
`SDKCompactBoundaryMessage` (`trigger`, `pre_tokens`, `post_tokens`,
`duration_ms`) and `PreCompact` / `PostCompact` hook events.

## 2. Context window management

| System | Mechanism | Knobs | Evidence |
|---|---|---|---|
| Claude Code / Agent SDK | Auto-compact at a fixed margin below the effective window (issue #31806 quotes `window − 13,000`); `compact_boundary` message; `PreCompact` hook; subagents start with fresh context | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` corrects the window for non-`claude-` model IDs; `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (lower only); `BASH_MAX_OUTPUT_LENGTH` (30K chars) | docs |
| Anthropic API context editing | `clear_tool_uses` replaces old tool results with placeholders; `clear_thinking`; server-side `compact` | `trigger` (100K), `keep` (3 tool uses), `clear_at_least`, `exclude_tools` | vendor: +29% alone, +39% with memory tool, −84% tokens on a 100-turn search eval. Server features; they reach GLM only if our proxy implements them |
| OpenAI Agents SDK / Codex CLI | `TrimmingSession`, `SummarizingSession`, `ResponsesCompactionSession`; Codex compacts at 90% of the window, keeps recent user messages verbatim up to 64K | `max_turns`, `keep_last_n_turns`, `model_auto_compact_token_limit` | vendor; one third-party log of 1,087 Codex compactions (226K → 19.5K, 6–34 s each) |
| Google ADK | Context as a "compiled view"; static instruction prefix, dynamic suffix; event compaction with a raw tail; large payloads as artifacts loaded on demand; other agents' messages recast as narrative | `compaction_interval`, `overlap_size`, `token_threshold`, `event_retention_size`, `ContextCacheConfig` | docs; no effect numbers. Open issue: drift after compaction is unobservable |
| LangChain deepagents | Tool result over 20K tokens goes to a file, context keeps path plus a 10-line preview; truncate old tool inputs at 85%; summarize last, full history saved to a file | `tool_token_limit_before_evict` | vendor; evaluated with needle-after-summary and goal-preservation tests |
| OpenHands | Condensers: LLM summarizing (`max_size=120`, `keep_first=4`), observation masking, chained; agent may request condensation; append-only event log with `forgotten_event_ids` | per condenser | vendor: per-turn cost below half the baseline, similar solve rate |
| JetBrains "The Complexity Trap" (arXiv 2508.21433) | Observation masking (keep last M=10 turns of tool output) vs LLM summarization, SWE-agent on SWE-bench Verified, five model configurations | M, hybrid N | **measured**: masking halves cost and matches or beats summarization (Qwen3-Coder-480B 54.8% at $0.61 vs 53.8% at $0.64); summarization lengthens trajectories 13–15% and its own calls cost up to 7%; hybrid 7–11% cheaper |
| Manus | KV-cache hit rate is the key production metric (~100:1 input:output); stable prefix, no timestamp at the start, append-only, deterministic serialization; filesystem as restorable context; recite `todo.md` near the end; keep errors | — | practitioner |
| OpenClaw | Silent pre-compaction "memory flush" turn; session pruning on the in-memory copy only after cache TTL expiry; soft-trim tool output at 30% usage, hard-clear at 50%; images older than 3 turns become placeholders | `reserveTokensFloor`, `softThresholdTokens`, `keepLastAssistants` | docs |
| Cognition | Share full traces, not messages; a dedicated compressor for long tasks; multi-agent works when writes stay single-threaded | — | practitioner |

Cross-cutting facts for our stack:

- Anthropic cache order is tools → system → messages: a changed system prompt
  invalidates the whole messages cache. Z.ai's GLM cache is implicit prefix
  matching; whether our internal GLM-5.3 endpoint caches, and how it reports it,
  is unknown (our ledgers show `cacheCreateTokens = 0` throughout).
- Four-characters-per-token estimators undercount CJK text two to three times.
- Where the evidence is measured, dropping old tool output beats summarizing
  it. No framework with numbers recommends in-run LLM summarization first.

## 3. Long-term and shared memory

| System | Scopes | Writes | Consolidation | Human control |
|---|---|---|---|---|
| Letta | Core blocks pinned in prompt, shareable across agents; archival and recall stores; Context Repositories (2026-02): git-backed memory files, `system/` pinned, rest on demand | Agent tools in the hot path; sleep-time agents in the background | Reflection subagents in separate worktrees, merged with git | Every edit is a commit |
| LangGraph Store + LangMem | Namespace tuples, e.g. `("memories", user_id)`; semantic, episodic, procedural | Hot-path tool or debounced background manager | Background extraction and merge | App-defined |
| CrewAI | Hierarchical paths (`/project/x`, `/agent/y`); read-only slices; private records | Automatic extraction after each task, LLM infers scope | Cosine ≥ 0.85 → LLM decides keep/update/delete; ≥ 0.98 auto-dedup; recency half-life | — |
| Google Memory Bank | Scope dict (`app`, `user`); consolidation only within a scope | Background, filtered by configured memory topics | CREATED / UPDATED / DELETED; every mutation kept as a revision, raw extractions kept; TTL | IAM per scope |
| OpenAI Agents SDK sandbox memory (2026-04) | Shared by layout config | At session close: per-rollout summary, then a consolidation agent writes `MEMORY.md` + `memory_summary.md` | Consolidation agent | Only the small summary is injected; the rest is searched |
| Mem0 / Zep-Graphiti | user / agent / run IDs; Graphiti bi-temporal edges (`valid_at`/`invalid_at`, `created_at`/`expired_at`) linked to source episodes | Extraction per message | Mem0 ADD / UPDATE / DELETE / NOOP; Graphiti invalidates instead of deleting | — |
| Anthropic Managed Agents stores | Mounted directories, `read_only` or `read_write`, owned | Agent file edits | "Dreams": async job writes a new store from old store + transcripts; you review, then switch or discard | Immutable `memver_` versions per write, restore, redact; docs warn that untrusted input written to a read-write store is later read as trusted |
| Claude Code | Human `CLAUDE.md` rules vs agent auto memory (typed); `MEMORY.md` index up to 200 lines / 25 KB pinned, topic files on demand | Agent, in session | — | Docs: memory is context, not enforcement; enforcement belongs in hooks |
| ChatGPT | Saved memories + chat-history reference; 2026-06 background synthesis ("Dreaming"), time-sensitive items rewritten | Background | Background summary | View / edit; the persistent channel was abused by the 2024 SpAIware injection |
| OpenClaw (closest to our layout) | `SOUL.md`, `USER.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`, `DREAMS.md`; `MEMORY.md` loaded only in direct chat with its human, not group chats | Daily notes in session; pre-compaction flush | Nightly "dreaming": only the deep phase writes `MEMORY.md`, gated on score, recall count and distinct queries; re-reads live notes; **untrusted-provenance candidates structurally excluded** | Automatic promotion; incidents where injected skills rewrote SOUL/MEMORY persistently |

Research on shared and adversarial memory:

- Collaborative Memory (arXiv 2505.18279): private and shared tiers, immutable
  provenance on every fragment. Governed Shared Memory / MemClaw (2606.24535,
  abstract): scoped retrieval, temporal supersession, writer provenance; hit a
  race between dedup and contradiction handling in production.
- Attacks: MINJA (2503.03704, measured) plants memory through queries alone,
  98.2% injection success; AgentPoison (2407.12784); MemGhost (2607.05189,
  abstract) one email writes memory, 87.5% on OpenClaw, 71.4% on the Claude Code
  SDK; PMPA (2609.13889, abstract) attacks the Claude Code harness through text,
  PDF or image, 81.7% cross-session success; "When Memory Becomes Authority"
  (2608.01679, abstract): 48 of 49 consolidators kept a claim but dropped its
  usage constraints; storing an authority label per memory cut unauthorized
  actions from 16.9% to 0%.
- Consensus in defenses: provenance recorded at write time and propagated as
  taint; authority is structural, not the writing model's judgment; compaction
  summaries are a poisoning path too.

Where the field agrees: humans own rules, agents own notes; only a small index
is pinned, the rest is searched; consolidation runs in the background; a
contradicted fact is superseded, not deleted; every write is versioned and
attributed; shared material defaults to read-only; untrusted content is kept
out of anything that is loaded as authority.

## 4. Benchmarks and measurement

Public benchmarks, and whether they fit us:

| Benchmark | Measures | Fit |
|---|---|---|
| LongMemEval (ICLR 2025) | Extraction, multi-session, temporal, knowledge update, abstention; 500 questions | Knowledge-update and abstention splits, as a component test of the memory store |
| MemoryAgentBench (ICLR 2026) | Accurate retrieval, test-time learning, long-range understanding, conflict resolution; incremental "inject once, query many" | FactConsolidation and EventQA as component tests; exact-match scoring |
| LoCoMo | Long-dialogue QA | Skip: an audit found 6.4% wrong answer keys and a judge that accepts 62.8% of wrong on-topic answers |
| BEAM (ICLR 2026) | 128K–10M token conversations | Skip: conversational and expensive |
| MemoryArena (ICML 2026) | Multi-session interdependent tasks incl. web navigation | Closest public match; optional outside check once scopes exist |
| Letta Leaderboard / Context-Bench | Models on memory-tool use and file-based context retrieval, with cost | Model selection only (GLM-5.3 vs alternatives) |
| MemSecBench (2607.27080, abstract), PMPA, MINJA, AgentDojo | Memory poisoning: persistence, adoption, cross-session attack success, selective repair | Port the case patterns onto the golden site |
| Agent Workflow Memory, StreamBench, Evo-Memory | Improvement over a task stream vs memory-off | Method template for learning-gain measurement |

How others measured context changes: the JetBrains study (solve rate, cost per
instance, trajectory length, token composition, summary-call overhead), OpenHands
(per-turn cost curves), Anthropic (task score and total tokens on long
agentic search), Manus (cache hit rate), Chroma "Context Rot" (fixed task,
varying input length and distractors). ADK publishes none, and its open issue
on unobservable post-compaction drift is the gap our fingerprints fill.

Metrics adopted into the plan:

| Group | Metric |
|---|---|
| Context | Cache hit ratio = cache_read / (cache_read + cache_create + uncached input); peak and p95 per-turn input tokens; compactions per run with `pre_tokens`; retention-probe accuracy after a compaction or rotation; trajectory length; tokens per section of context |
| Memory | Write precision (correct and in the right scope); recall of seeded learnable facts; stale-use rate; contradiction count (two live entries, one key); scope-leak rate; growth (entries, bytes, injected tokens per session); learning gain (session k vs session 1 vs a memory-off arm) |
| Safety | Injection success (payload reaches any store or compaction summary, checked by grep); cross-session attack success; repair success after purge; learned-item-overrides-rule rate; cross-workspace leak (must be 0) |
| Existing | pass^k, cost per success, fingerprint (Hotelling T²), human-intervention rate |

Rule of three: zero failures in n trials bounds the rate below about 3/n at 95%,
so a claim of "under 10%" for a safety case needs at least 30 trials.

## 5. What Deskmates adopts, and what changes in our draft

1. **Stable system prompt, dynamic context in the conversation.** SOUL, stable
   rules and fixed guidance form a byte-identical system prompt; MEMORY index,
   diary, task state and knowledge hits go in the first user turn (or a
   `UserPromptSubmit` hook's `additionalContext`). Fixes the §1 staleness if it
   is active and the cron cache break either way. A T0 test fails if the system
   prompt changes between two runs with different diaries.
2. **Visible, correctly sized compaction.** Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
   to GLM-5.3's real window; ledger `compact_boundary`; `PreCompact` hook
   archives the transcript. Record both settings in `runs.config_json`.
3. **Mask old observations in a run** before summarizing anything: the only
   context strategy with measured evidence. Replace browser snapshots and
   images older than the last N tool turns with a placeholder keeping tool name,
   URL and file path; clear in batches so the cache is not broken every turn.
   Candidate location: our model proxy (emulating `clear_tool_uses`).
4. **Offload large tool results to files** with a path and short preview.
5. **Rotate thread sessions deliberately** at a token or idle budget, after a
   silent memory-flush turn; the new session starts from `thread_messages`,
   which is already the source of truth (ADR-0005).
6. **Count tokens from real usage**, not character estimates.
7. **Provenance and trust are set by the sidecar, not judged by the model.**
   Draft correction: "page content must not become standing instructions"
   cannot rest on the writing model's judgment; MINJA, MemGhost and authority
   collapse all go through the agent's authorized write path. Every memory row
   records source run, source kind, trust and authority. A run that read
   browser output, a webhook body or another bot's message writes `untrusted`
   (the sidecar already wraps exactly those inputs).
8. **Untrusted memory is data, never prompt.** It is written automatically and
   is searchable, wrapped like browser output, but never pinned and never
   promoted into bot experience or rules. This keeps automatic memory (a field
   length learned from a page is still stored and found) and keeps a human gate
   only where the risk is.
9. **Imperatives are never learned.** A learned item phrased as a standing
   instruction ("always", "never", "ignore") goes to confirmation regardless of
   scope. Consolidation keeps the minimum trust of its sources and never merges
   across trust levels.
10. **Validity intervals, not overwrites.** Workspace facts carry `observed_at`,
    `valid_from`, `invalid_at`, `superseded_by`, `last_confirmed_at`, optional
    TTL; a contradiction closes the old interval. Retrieval shows age and source.
11. **Split writes.** Hot path: task state, diary, candidate notes, pre-compaction
    flush. Background: one consolidation run per workspace at a time, as a
    background-lane bot run (the Gateway still never calls a model), producing
    a versioned new set applied automatically only when every source is trusted.
12. **Event-sourced versions** give undo and forget: immutable version rows,
    tombstone plus redaction for forget, raw candidates kept beside merges.
13. **Pinned index plus search.** Each run gets a budgeted index (workspace
    summary plus the bot's own experience, about 200 lines); the rest through a
    `memory_search` tool.
14. **Replayability.** Record the memory version set and compaction settings
    injected into each run in `runs.config_json`; replay restores that snapshot.
15. **Task state becomes an episode summary** when the task ends, searchable,
    and the source for experience candidates.
16. **Later (M3 channels):** do not inject per-bot memory into threads with
    outside humans (OpenClaw's rule).

Not adopted: in-run LLM summarization as a first resort (no measured gain over
masking, longer trajectories); Anthropic server-side context editing as-is
(unavailable through GLM unless the proxy implements it); access control
between bots on shared memory (design rule; workspace is the boundary).

## 6. Open proposal: prerequisites and goals through a hook

Recorded 2026-09-29; undecided. A teammate proposed a hook that adds basic
prerequisites and goals to each bot's system prompt. Which prerequisites and
goals, who writes them, and whether they are per bot, per workspace or per task
are open. Nothing is implemented; the experiments at the end run when there is
time.

What the installed SDK allows (0.3.278 `sdk.d.ts`, checked like §1):

- No hook output has a field for the system prompt. Hooks add text through
  `additionalContext` (`SessionStart`, `UserPromptSubmit`, `Stop` and others).
  The typings do not say where that text lands in the request; E0 checks it.
- `Stop`'s `additionalContext` is "non-error feedback delivered to the model;
  the conversation continues so the model can act on it". Its input carries
  `stop_hook_active` and `last_assistant_message`.
- `SessionStart`'s input `source` includes `compact`, so a hook can add text
  again after a compaction. Whether it fires for SDK callback hooks in our
  runtime is unverified.

The sidecar registers only `PreToolUse`, with `settingSources: []`
(`packages/sidecar/src/run-once.ts`), so a new hook would be a sidecar
callback. Each run submits one prompt, so a `UserPromptSubmit` injection does
what `buildContext` (`packages/sidecar/src/context.ts`) can already do in the
first user turn, and the direct version is easier to test. For content known
when the run starts, the question is where it belongs:

| Content | Placement | Reason |
|---|---|---|
| Stable duties and standing requirements | `SOUL.md`, or fixed guidance in `context.ts` | Keeps the system prompt byte-identical (§5 item 1); a SOUL change clears `bot_sessions`, so the next run sees it |
| Goals, prerequisites and progress of the current task | First user turn | A changed system prompt may be ignored on `resume` (§1) and breaks the cached prefix (§2) |
| Preconditions that must hold, such as "do not submit before review" | `PreToolUse` gate: the existing risk tiers and approvals | Prompt text is context, not enforcement (§3, Claude Code row) |

This placement is analysis, not measurement. Any variant must also meet three
constraints: only human-authored text enters the system prompt, and text a bot
or a page can write, such as a file under `/work`, stays data (§5 item 8); the
injected text, or its hash and source version, is recorded in
`runs.config_json` and restored by replay (§5 item 14); and it is a strategy
change, so it needs a paired comparison with `evals/compare.ts`, one knob per
experiment.

A hook adds something `buildContext` cannot in two places:

- **Completion check at `Stop`.** Before the run ends, the sidecar checks a
  condition a program can decide from what the run actually did (tool calls,
  posted messages), not from the model's summary. If it fails, the hook
  returns `additionalContext` and the run continues; `stop_hook_active` and
  `maxTurns` bound the loop. The check must not fight the thread guidance that
  tells a waiting bot to end its run. Target: the chief failures in
  `m2-six-hour-soak-results-2026-09-25.md`. Slots 9 and 17 claimed a
  `thread_post` delegation with zero tool calls; slot 15 omitted the required
  `CHIEF_ASSIGN` marker.
- **Goals again after compaction.** A `SessionStart` hook with source
  `compact` re-adds the task's goals and prerequisites, which the compaction
  summary may have dropped.

Experiments, when there is time:

| ID | Question | Method and metrics | Needs |
|---|---|---|---|
| E0 | Where does `additionalContext` from `SessionStart` and `UserPromptSubmit` land in the request? Does `SessionStart` fire with `compact` for SDK callback hooks? | Spike under `spikes/`: `ANTHROPIC_BASE_URL` points at a capture server that returns canned responses and records `system` and `messages` per request; force one compaction | No model call. The plan's Phase 2 snapshot check can reuse the capture server |
| E1 | Does a goals-and-prerequisites text help at all? | Baseline vs the same text in the first user turn; success per duration bucket, pass^k, cost per success | `evals/compare.ts`; owner authorization for model calls; a quiet host |
| E2 | Does placement matter? | The E1 text in the system prompt vs the first user turn; success, cache hit ratio | E1 first |
| E3 | Does a `Stop` completion check cut silent and non-conforming chief endings? | Baseline vs the check on the chief delegation case; success, silent endings, missing markers, extra turns and tokens | As E1 |
| E4 | Does re-adding goals after compaction keep early constraints? | Baseline vs `SessionStart` (`compact`) re-injection on G-LONG; retention-probe accuracy | E0 shows the event fires; G-LONG exists (plan) |

E2 is judged by the plan's context-knob rule. E1, E3 and E4 need the paired
success difference per duration bucket with its 95% interval above 0 and
pass^k not worse. Rules are declared before each run. The Testbox evaluation
authorization does not cover these campaigns.

## Sources

- Agent SDK system prompt and loop: https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts, https://code.claude.com/docs/en/agent-sdk/agent-loop, https://code.claude.com/docs/en/env-vars, https://github.com/anthropics/claude-code/issues/31806
- Anthropic: https://platform.claude.com/docs/en/build-with-claude/context-editing, https://claude.com/blog/context-management, https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents, https://www.anthropic.com/engineering/multi-agent-research-system, https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool, https://platform.claude.com/docs/en/managed-agents/memory, https://platform.claude.com/docs/en/managed-agents/dreams, https://code.claude.com/docs/en/memory, https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- OpenAI: https://developers.openai.com/cookbook/examples/agents_sdk/session_memory, https://openai.github.io/openai-agents-python/sandbox/memory/, https://gist.github.com/osolmaz/a38acf6e522df67530e3ed47c80fdcd5, https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f
- Google: https://adk.dev/context/compaction/, https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/, https://github.com/google/adk-python/issues/5050, https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/generate-memories
- LangChain: https://www.langchain.com/blog/context-management-for-deepagents, https://langchain-ai.github.io/langmem/background_quickstart/
- OpenHands: https://docs.openhands.dev/sdk/arch/condenser, https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents
- Letta: https://docs.letta.com/guides/agents/multi-agent-shared-memory/, https://docs.letta.com/guides/agents/architectures/sleeptime/, https://www.letta.com/blog/context-repositories/, https://www.letta.com/blog/context-bench/
- CrewAI: https://docs.crewai.com/en/concepts/memory. AutoGen: https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/memory.html
- Mem0: https://huggingface.co/papers/2504.19413. Zep: https://blog.getzep.com/beyond-static-knowledge-graphs/
- OpenClaw: https://docs.openclaw.ai/concepts/memory, https://docs.openclaw.ai/concepts/dreaming, https://docs.openclaw.ai/concepts/session-pruning
- Manus: https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus. Cognition: https://cognition.com/blog/dont-build-multi-agents. Chroma: https://research.trychroma.com/context-rot
- Z.ai cache: https://docs.z.ai/guides/capabilities/cache
- Papers: https://arxiv.org/abs/2508.21433 (Complexity Trap), https://arxiv.org/abs/2410.10813 (LongMemEval), https://github.com/HUST-AI-HYZ/MemoryAgentBench, https://arxiv.org/abs/2602.16313 (MemoryArena), https://arxiv.org/abs/2406.12045 (τ-bench), https://arxiv.org/abs/2409.07429 (AWM), https://arxiv.org/abs/2503.03704 (MINJA), https://arxiv.org/abs/2407.12784 (AgentPoison), https://arxiv.org/abs/2406.13352 (AgentDojo), https://arxiv.org/abs/2505.18279 (Collaborative Memory); abstract-level: 2606.24535, 2607.05189, 2609.13889, 2608.01679, 2607.27080
- LoCoMo audit: https://penfieldlabs.substack.com/p/we-audited-locomo-64-of-the-answer

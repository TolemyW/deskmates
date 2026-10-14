# Agent loop portability: isolated runtime spike

Date: 2026-09-22
Status: verification record; not an architecture decision or production migration
Base revision: `3927aefae516ec8b1efb7cee55965bf48cfe6d8a`
Branch: `codex/agent-loop-spike-20260922`

## Conclusion

Both OpenAI Agents SDK and LangGraph.js can support a future CogBot execution adapter that parks
for approval, exits its process, and resumes the pending tool action in another process. The
current dependence on Claude's `defer/resume` is therefore replaceable at the runtime level.

Neither implementation alone gives business-level exactly-once execution. Replaying the original
paused snapshot produced two external writes. A transactional receipt in the synthetic target
system reduced that to one. Both also needed application logic to transfer an approval from a
known stale-ref failure to the replacement call for the same synthetic operation.

This proves runtime mechanisms, not real-model task quality, browser reliability, or production
readiness. The production Claude sidecar and all architecture decisions remain unchanged.

## Isolation and scope

All code and dependencies are under `spikes/agent-loop-portability` in a separate Git worktree.
The main checkout was not switched, reset, cleaned, or modified by this spike. Existing untracked
files and other agents' worktrees were not copied or changed. Git's worktree registry and the new
branch are shared repository metadata, as with any Git worktree.

The spike uses a private npm cache and its own package-lock/node_modules. Each invocation creates
an ignored `work-*` directory containing its state databases, fixture data, and logs. Cases run
serially, with one worker and its stdio MCP child active at a time. No Gateway, Docker daemon,
container, image tag, browser profile, network port, upstream model, credentials, or existing
development database is used. The verifier passes only PATH and a warning flag to workers.
OpenAI trace export is disabled. Verification ran with the ordinary network-restricted sandbox.

The successful run's cleanup check found none of its 80 recorded worker/MCP PIDs still running.
This is a check of this spike's own processes, not an inventory or cleanup of other agents.

## Pinned dependencies and implementation

| Component | Version / implementation |
|---|---|
| Node | 23.6.0 on the current macOS host |
| OpenAI Agents SDK | `@openai/agents@0.18.0` |
| LangGraph | `@langchain/langgraph@1.4.17` |
| LangGraph SQLite checkpointer | `@langchain/langgraph-checkpoint-sqlite@1.0.4` |
| MCP client/server | `@modelcontextprotocol/sdk@1.30.0` |
| Schema validation | `zod@4.3.6` |
| Exact transitive dependencies | Spike-local `package-lock.json` |

OpenAI: the real Runner executes function tools which bridge to MCP. The model provider is
deterministic. `needsApproval` creates native interruptions; `RunState.toString()` persists the
snapshot; a new process rebuilds the agent and tools, loads it with `RunState.fromString()`, and
approves or rejects the pending item before running again.

LangGraph: a real StateGraph cycles through a scripted model node and a tool node. `interrupt()`
parks the pending action; SqliteSaver persists the graph; a new process rebuilds the graph and
resumes with `Command` and the same internal thread ID. This verifies a custom graph loop, not
LangChain's prebuilt agent, its middleware, or Deep Agents.

The external system is a real MCP subprocess writing to its own SQLite database. Its snapshot
ref is generated per process, so a new connection invalidates the previous process's ref. This
is a synthetic representation of the session-local ref problem, not a Playwright test.

Both runtimes use the same action policy and the same MCP service. MCP transport and effect
execution are real; model inference, browser actions, and business semantics are scripted.
Tools bridge through the official MCP client; native framework MCP discovery was not tested.

## Results

The verifier passed all 16 expected-outcome checks (eight cases per runtime).
Two cases intentionally expose native limitations; PASS means the predicted limitation was
reproduced, not that the framework prevents it.

| Case | OpenAI | LangGraph | Interpretation |
|---|---|---|---|
| Park, exit, approve | PASS: 0 writes before approval, 1 afterward | Same | Native approval state survives process exit |
| Park, exit, deny | PASS: 0 writes; no submit reaches MCP | Same | Rejection prevents the pending action |
| Dispatch old paused snapshot twice | PASS negative control: 2 writes | Same | Serialization/checkpointing is not dispatch deduplication |
| Repeat with business idempotency | PASS: 1 write | Same | Application/target receipt suppresses duplicate writes |
| Old ref, native approval only | PASS negative control: 0 writes, another approval pause | Same | Native approval does not automatically authorize a regenerated call |
| Old ref, scoped approval transfer | PASS: 1 write without another external decision | Same | A CogBot-style recovery adapter is feasible |
| Commit succeeds, tool reports error, retry | PASS: 1 write with idempotency | Same | Tool error does not prove that no side effect occurred |
| Process exits after commit, before runtime completion | PASS: exit 77, new process resumes, 1 write with idempotency | Same | Business receipt covers the uncertain completion window |

Every successful worker invocation also asserts the per-attempt token delta against the number
of scripted model calls made in that process. OpenAI's Usage is supplied by the deterministic
provider and accumulated by the SDK. LangGraph's cumulative token counter is explicitly part of
our graph state, not a claim that LangGraph normalizes provider billing. Each synthetic model
request is 11 input + 7 output tokens; no real token cost or cache accounting was measured.

The duplicate-dispatch case restores the original paused checkpoint before the second dispatch.
It is not a claim that sending a second resume command against an already-completed LangGraph
thread has the same behavior.

The approval transfer is restricted to a single operation ID, a single resumed process, and
the explicit pre-execution `stale_ref` failure. A generic tool error does not rearm it. Production
browser actions still need a sound action matcher and outcome reconciliation.

Idempotency is implemented transactionally in the synthetic business system, atomically with
the external write. A local CogBot receipt written separately from a browser click cannot provide
the same guarantee. A real target must expose an idempotency mechanism or support reliable
read-after-write verification.

## Reproduction and evidence

From `spikes/agent-loop-portability`:

```sh
npm ci --workspaces=false --cache /private/tmp/cogbot-loop-spike-npm
npm run typecheck
npm run verify
```

Validation: spike TypeScript check, Biome check of spike sources/configuration, and the 16-case
cross-process verifier. Compact evidence is in
[`results-2026-09-22.json`](../../spikes/agent-loop-portability/results-2026-09-22.json).
The verifier emits a full report and per-call logs into a new ignored `work-*` directory.
The existing product T0/T1, Docker, and model acceptance suites were not run: production sources
and dependencies were not changed, and this is an independent experimental package.

## What still needs verification before a migration

1. Real model adapters, streaming, tool schemas, images, cache-token normalization, and the
   configured GLM/DeepSeek/Qwen endpoints. The current Gateway only proxies Anthropic routes.
2. Real Playwright MCP attachment to a dedicated shared Chromium and real stale-ref recovery;
   browser locking and takeover must still be enforced by CogBot.
3. Gateway approval records, deadlines, offline behavior, a full 300-second live wait, overnight
   parking, token revocation/renewal, attempt fencing, and duplicate approval callbacks.
4. Simultaneous tool calls, repeated deferrals, multiple bots/threads, cancellation and lock
   renewal; this spike deliberately runs serially with one pending write.
5. State migration across runtime/library upgrades. Neither runtime was asked to read Claude
   transcripts or to resume a production Claude approval.
6. Secret redaction, untrusted-result wrapping, egress policy and all tool execution paths.
7. Paired real-model golden-site evaluation: success, unexpected side effects, latency, cost,
   and long-context behavior. No relative quality claim follows from these deterministic checks.

## Architectural implication

Proceeding to a production adapter requires an ADR changing the current SDK-specific boundary.
Gateway should retain business run IDs, approval records and deduplication. Each runtime should
own an opaque, versioned execution snapshot. The adapter maps native pauses and events to CogBot's
contracts; it must not infer business success or exactly-once semantics from a checkpoint.

OpenAI offers a direct serializable approval-run abstraction. LangGraph makes the execution
state and checkpoint boundaries more explicit but requires us to define the graph and accounting.
Both are viable next-stage candidates; this spike does not select a replacement.

## Primary references

- [OpenAI approvals and state](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [OpenAI result state](https://developers.openai.com/api/docs/guides/agents/results)
- [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)

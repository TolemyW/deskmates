// Validation of the one `StartRunRequest` the sidecar reads from stdin. The Gateway is the only
// thing that should ever write it, but an unvalidated `JSON.parse(...) as StartRunRequest` makes
// every field a lie: a missing `shortWaitSeconds` turns the approval poll into `sleep(NaN)`, a
// missing `connectors` throws a TypeError from inside a `for` loop with no hint of what was wrong.
// The run has no ledger row to report either failure into, so the only useful behaviour is to say
// what is wrong on stderr and exit before anything starts.
//
// The schema mirrors `packages/contracts/src/sidecar-protocol.ts` and `thread.ts`. Branded ids are
// plain strings at runtime (`contracts/src/ids.ts`), so they are validated as non-empty strings and
// the brands are restored by the cast in `parseStartRunRequest`.

import {
  CONNECTOR_TOOL_NAMES,
  INTEGRATION_TOOL_NAMES,
  type StartRunRequest,
  isSkillFilePath,
  isSkillName,
} from "@deskmates/contracts";
import { z } from "zod";

const id = z.string().min(1);

const pinnedLineSchema = z.object({
  entryId: id,
  version: z.number().int().positive(),
  authority: z.enum(["fact", "preference", "procedure"]),
  body: z.string(),
  observedAt: z.string(),
  learnedBy: z.string().optional(),
});

/** `PinnedMemoryIndex` (ADR-0011 decision 9); rendered into the first user turn. */
const memoryIndexSchema = z.object({
  version: z.literal(1),
  assembledAt: z.string(),
  budgets: z.object({
    totalLines: z.number().int().nonnegative(),
    workspaceLines: z.number().int().nonnegative(),
    botLines: z.number().int().nonnegative(),
  }),
  sections: z.object({
    workspace: z.array(pinnedLineSchema),
    bot: z.array(pinnedLineSchema),
    task: z.array(pinnedLineSchema),
  }),
  versionSet: z.array(z.object({ entryId: id, version: z.number().int().positive() })),
  lines: z.number().int().nonnegative(),
  counts: z
    .object({
      considered: z.number().int().nonnegative(),
      pinned: z.number().int().nonnegative(),
      untrusted: z.number().int().nonnegative(),
      budget: z.number().int().nonnegative(),
      ineligible: z.number().int().nonnegative(),
    })
    .optional(),
});

const attachmentSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  ref: z.string(),
});

const threadMessageDeliverySchema = z.object({
  seq: z.number().int(),
  authorKind: z.enum(["human", "bot", "system"]),
  authorId: z.string(),
  authorName: z.string(),
  addressing: z.enum(["recipient", "everyone", "unaddressed", "other"]).optional(),
  body: z.string(),
  attachments: z.array(attachmentSchema),
});

const triggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("thread_message"),
    thread: z.object({
      id: id,
      kind: z.enum(["chat", "bus"]),
      title: z.string(),
    }),
    messages: z.array(threadMessageDeliverySchema),
    routing: z
      .object({
        version: z.union([z.literal(1), z.literal(2)]),
        recipientBotId: id,
        recipientName: z.string().min(1),
        sourceMessageSeq: z.number().int().positive().optional(),
        // ADR-0005 amendment 2, decision 12. zod strips keys a schema does not name, so leaving
        // these out would silently hand the bot a group with no roster.
        members: z
          .array(
            z.object({
              name: z.string().min(1),
              role: z.string(),
              you: z.literal(true).optional(),
              owner: z.literal(true).optional(),
            }),
          )
          .optional(),
        offer: z
          .object({
            messageSeq: z.number().int().positive(),
            passed: z.array(z.string()),
            remaining: z.array(z.string()),
          })
          .optional(),
        // ADR-0005 amendment 6, decisions 47, 48 and 50: named here for the same reason.
        round: z
          .object({
            messageSeq: z.number().int().positive(),
            phase: z.enum(["work", "close"]),
            assignments: z.array(
              z.object({
                name: z.string().min(1),
                task: z.string(),
                you: z.literal(true).optional(),
              }),
            ),
            closer: z.string().min(1),
            youClose: z.literal(true).optional(),
            outcomes: z
              .array(
                z.object({
                  name: z.string().min(1),
                  outcome: z.enum(["replied", "silent", "failed", "cancelled", "stopped"]),
                  seqs: z.array(z.number().int().positive()),
                }),
              )
              .optional(),
          })
          .optional(),
        lastReply: z
          .object({
            seq: z.number().int().positive(),
            addressed: z.array(z.string()),
            everyone: z.boolean(),
            unknown: z.array(z.string()),
            spaced: z.array(z.string()),
          })
          .optional(),
      })
      .optional(),
    relayCount: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("cron"), prompt: z.string() }),
  z.object({ kind: z.literal("webhook"), body: z.string() }),
  z.object({ kind: z.literal("welcome"), prompt: z.string() }),
  z.object({
    kind: z.literal("continuation"),
    approvalId: id,
    decision: z.literal("continue"),
    handoffPath: z
      .string()
      .regex(/^\/work\/[A-Za-z0-9._\-/]+$/)
      .refine((path) => !path.split("/").includes(".."))
      .optional(),
  }),
  z.object({
    kind: z.literal("budget_continuation"),
    handoffPath: z
      .string()
      .regex(/^\/work\/[A-Za-z0-9._\-/]+$/)
      .refine((path) => !path.split("/").includes(".."))
      .optional(),
  }),
  z.object({
    kind: z.literal("approval"),
    approvalId: id,
    decision: z.enum(["allow_once", "allow_always", "deny"]),
    toolUseId: z.string().optional(),
    reason: z.string().optional(),
    // The resume hand-over (ADR-0002 amendment 2, "the decision survives a stale snapshot").
    // zod strips keys the schema does not name, so leaving these out silently turns every
    // retry into a fresh L2 call: this is the only thing between the contract and the process.
    deferredAction: z
      .object({
        toolName: z.string(),
        targetOrigin: z.string().optional(),
        argumentPattern: z.string().optional(),
      })
      .optional(),
    currentOrigin: z.string().optional(),
  }),
]);

export const startRunRequestSchema = z.object({
  runId: id,
  botId: id,
  botName: z.string().min(1),
  workspaceId: id,
  threadId: id.optional(),
  botHomeDir: z.string().min(1),
  sdkSessionId: z.string().optional(),
  // The second half of the Gateway's `(run, attempt, seq)` dedup key: 1 for the first process of
  // a run, one more on every resume. A missing or zero attempt would make a resumed process's
  // events look like a redelivery of the first process's and be dropped.
  attempt: z.number().int().positive(),
  trigger: triggerSchema,
  presentationSummary: z.boolean().optional(),
  presentationKind: z.enum(["approval", "activity"]).optional(),
  modelJob: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("vision_probe"), code: z.string().regex(/^\d{4,8}$/) }),
      // ADR-0011 amendment 4, A30: at most 40 notes, each an id and a body.
      z.object({
        kind: z.literal("memory_organize"),
        notes: z
          .array(z.object({ id: z.string().min(1), body: z.string().min(1).max(16_000) }))
          .min(1)
          .max(40),
      }),
      // ADR-0011 amendment 4, A28: at most 20 flagged notes and a bounded activity excerpt.
      z.object({
        kind: z.literal("memory_recheck"),
        notes: z
          .array(
            z.object({
              id: z.string().min(1),
              scope: z.enum(["workspace", "bot"]),
              body: z.string().min(1).max(16_000),
              effectiveAt: z.string().min(1),
              lastConfirmedAt: z.string().min(1).optional(),
            }),
          )
          .min(1)
          .max(20),
        activity: z.string().max(40_000),
      }),
      z.object({
        kind: z.literal("approval_review"),
        reviewPackage: z.string().min(2).max(24_000),
      }),
      // ADR-0005 amendment 6, decision 45: at most six members and a bounded request.
      z.object({
        kind: z.literal("round_triage"),
        roster: z
          .array(
            z.object({
              name: z.string().min(1),
              role: z.string(),
              owner: z.literal(true).optional(),
            }),
          )
          .min(1)
          .max(6),
        everyone: z.boolean(),
        request: z.string().max(16_000),
      }),
      z.object({
        kind: z.literal("soul_proposal"),
        mode: z.enum(["create", "edit"]),
        botName: z.string().min(1),
        role: z.string(),
        instruction: z.string().min(1),
        baseBody: z.string(),
      }),
      z.object({
        kind: z.literal("status_inquiry"),
        botName: z.string().min(1),
        role: z.string(),
        projection: z.string().max(16_000),
        question: z.string().min(1).max(16_000),
      }),
    ])
    .optional(),
  groupGuidance: z.literal("owner-v1").optional(),
  // Issue #88, ADR-0038: present for a per-bot run (the default); absent keeps the shared /work.
  workdirMode: z.literal("per-bot").optional(),
  otherLaneRun: z
    .object({
      runId: id,
      lane: z.enum(["interactive", "background"]),
      triggerKind: z.string().min(1).max(64),
      threadId: id.optional(),
      startedAt: z.string().min(1).max(64),
    })
    .optional(),
  // ADR-0044 decision 1: which agent loop runs; absent is the Claude Agent SDK.
  runtime: z.enum(["claude-agent-sdk", "openai-agents"]).optional(),
  model: z.string().min(1),
  cheapModel: z.string().min(1),
  // ADR-0023 decision 3: FALLBACK_MODEL, passed verbatim to the SDK's `fallbackModel`. Absent
  // means none; an empty string is not a model id.
  fallbackModel: z.string().min(1).optional(),
  // The reasoning knob (contracts `reasoning.ts`). Optional: absent means the SDK's own default,
  // and the sidecar then passes nothing, so the run row's `sdk-default` stays true.
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  thinking: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("adaptive") }),
      z.object({
        type: z.literal("enabled"),
        budgetTokens: z.number().int().positive().optional(),
      }),
      z.object({ type: z.literal("disabled") }),
    ])
    .optional(),
  modelBaseUrl: z.string().min(1),
  modelAuthToken: z.string().min(1),
  gatewayBaseUrl: z.string().min(1),
  // A zero or negative wait would make the hook defer every L2 call without asking; NaN would spin.
  shortWaitSeconds: z.number().positive().finite(),
  browserCoordination: z
    .object({
      mode: z.literal("origin-v2"),
      deadlineAt: z.string().datetime({ offset: true }),
    })
    .optional(),
  browserExecutionMode: z.literal("vision-cli-v2").optional(),
  // ADR-0002 amendment 5 (opt-in): browser code is tiered by its effects.
  browserCodeApproval: z.literal("effects-v1").optional(),
  // ADR-0023 amendment 2: the run's model cannot see; image content becomes a text notice.
  visionPolicy: z.literal("withhold").optional(),
  screenSlot: z.number().int().min(0).max(5).optional(),
  browserSnapshotMode: z.enum(["explicit-v1", "inline-v2"]).optional(),
  // ADR-0023 amendment 5: extra built-in CLI tools to withhold and inline settings switches. A
  // built-in name is PascalCase; an MCP name can never get here.
  cliSurface: z
    .object({
      disallowedTools: z
        .array(z.string().regex(/^[A-Z][A-Za-z0-9_]*$/))
        .max(100)
        .optional(),
      disableBundledSkills: z.boolean().optional(),
      includeGitInstructions: z.boolean().optional(),
      skillListingMaxDescChars: z.number().int().positive().optional(),
    })
    .optional(),
  // The SDK's turn budget for this run. The Gateway owns the knob (`DESKMATES_MAX_TURNS`) and records
  // it in `runs.config_json`, so a stripped or absent value would silently run the bot on a
  // different budget than the one the experiment was attributed to. `null` is the workspace's
  // explicit `off` (ADR-0016 amendment 2): required, so absence still fails.
  maxTurns: z.number().int().positive().nullable(),
  canonicalFiles: z
    .object({
      soul: z.object({ body: z.string(), version: z.string() }).optional(),
      memory: z.object({ body: z.string(), version: z.string() }).optional(),
    })
    .optional(),
  peerBotHomeDirs: z.array(z.string().regex(/^\/home\/[A-Za-z0-9_-]+$/)).optional(),
  egressAllowlist: z.array(z.string()),
  connectors: z.array(z.string()),
  // ADR-0013 items 4 and 5: a count of the workspace's integration connections, never a runtime
  // URL, token or secret; the integration tools are offered only when it is above zero.
  integrationConnections: z.number().int().nonnegative().optional(),
  tools: z.array(
    z.enum([
      "thread_post",
      "message_bot",
      "approval_decide",
      "knowledge_search",
      "knowledge_read",
      "knowledge_propose",
      "tty_session",
      "browser_cli_workflow",
      "memory_search",
      "task_deliver",
      // ADR-0035 and ADR-0040: offered only where the installation configures the service, so a
      // Gateway with those settings sends them on every run.
      "app_publish",
      "image_describe",
      "audio_transcribe",
      ...CONNECTOR_TOOL_NAMES,
      ...INTEGRATION_TOOL_NAMES,
    ]),
  ),
  memoryIndex: memoryIndexSchema.optional(),
  // ADR-0015 decision 1: the run's exact skill set. Names and paths are checked again where the
  // plugin is written; here they must at least be safe to carry.
  skills: z
    .array(
      z.object({
        skillId: z.string(),
        name: z.string().refine(isSkillName, "not a skill name"),
        version: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        files: z
          .array(
            z.object({
              path: z.string().refine(isSkillFilePath, "not a safe skill file path"),
              content: z.string(),
            }),
          )
          .min(1),
      }),
    )
    .optional(),
  sessionTainted: z.boolean().optional(),
  sessionDoNotLearnReasons: z
    .array(
      z.enum([
        "egress_block",
        "browser_wait",
        "approval_deferred",
        "approval_denied",
        "approval_timeout",
        "model_proxy_error",
        "transport_error",
        "sandbox_error",
        "failed_run",
        "negative_capability_claim",
        "session_state",
      ]),
    )
    .optional(),
  // ADR-0021 amendment 2: open tasks linked to this run or its thread, named by `task_deliver`.
  deliverableTasks: z
    .array(
      z.object({
        id,
        title: z.string(),
        outputSchema: z.record(z.string(), z.unknown()).optional(),
        // ADR-0021 amendment 3: the scope the run was given (A3f) and its latest checkpoint (A3k).
        scopeVersion: z.number().int().positive().optional(),
        latestCheckpoint: z
          .object({
            runId: z.string().nullable(),
            attempt: z.number().int(),
            createdAt: z.string(),
            completed: z.array(
              z.object({ unit: z.string(), outcome: z.string(), evidence: z.array(z.string()) }),
            ),
            outstanding: z.array(z.string()),
          })
          .optional(),
      }),
    )
    .optional(),
});

export type ParseStartRunRequestResult =
  | { ok: true; value: StartRunRequest }
  | { ok: false; issues: string[] };

/** One `path: message` line per problem, in the order zod reports them. */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/** Parse and validate the JSON text read from stdin. */
export function parseStartRunRequest(raw: string): ParseStartRunRequestResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, issues: [`(root): not valid JSON (${String(err)})`] };
  }
  const result = startRunRequestSchema.safeParse(json);
  if (!result.success) return { ok: false, issues: describeIssues(result.error) };
  // Branded ids are strings at runtime (contracts/src/ids.ts), so the brands have to be reapplied
  // here; the schema has already checked every field the type promises.
  return { ok: true, value: result.data as unknown as StartRunRequest };
}

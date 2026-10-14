// `task_deliver` and `task_checkpoint` (ADR-0021 amendments 2 and 3). A bot formally delivers a
// task, completely or partially, with files the Gateway verifies through the workspace and
// publishes to Files; or it records a checkpoint that changes no task state. The Gateway checks the
// link, the scope, the paths and the schema; the sidecar forwards and adds the task's scope
// version from its start request, never from the model. Delivery is not acceptance.

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { type DeliverableTask, type TaskJson, isDeskmatesError } from "@deskmates/contracts";
import { z } from "zod";
import type { ThreadToolsContext } from "./thread-tools.js";

function describeTask(task: DeliverableTask): string {
  const schema = task.outputSchema
    ? ` Output must match this JSON Schema: ${JSON.stringify(task.outputSchema)}`
    : " No output schema; output is optional.";
  return `- ${task.id}: ${task.title}.${schema}`;
}

/** Refusal text for the model: the Gateway's message plus each error on its own line. */
export function deliveryRefusal(err: unknown, verb = "delivered"): string {
  const lines = [`The task was not ${verb}: ${err instanceof Error ? err.message : String(err)}`];
  if (isDeskmatesError(err) && Array.isArray(err.details.errors))
    lines.push(...err.details.errors.map((e) => `- ${String(e)}`));
  return lines.join("\n");
}

const PATH = z.string().min(1).max(4096);

// biome-ignore lint/suspicious/noExplicitAny: the SDK erases schema generics in its tool registry
export function taskTools(ctx: ThreadToolsContext): SdkMcpToolDefinition<any>[] {
  const tasks = ctx.request.deliverableTasks ?? [];
  if (!ctx.request.tools.includes("task_deliver") || tasks.length === 0) return [];
  const scopeOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.scopeVersion;
  return [
    ctx.tool(
      "task_deliver",
      [
        "Formally deliver a task you were given: a short summary, the result files (label and path under /work/ or a /home/<bot>/ directory of this workspace) and, when the task has an output schema, the structured output. The Gateway verifies every file in the workspace and publishes verified files to Files; a missing or unreadable file refuses the whole delivery. List anything not finished in `outstanding`: then the delivery is partial and the task stays open. A task whose result is not a file needs no artifact. Intermediate drafts are not deliveries: use task_checkpoint for progress. A human accepts; you cannot. If the Gateway refuses, fix what it names and call again.",
        "Tasks you may deliver:",
        ...tasks.map(describeTask),
      ].join("\n"),
      {
        taskId: z.string().min(1).max(200),
        summary: z.string().min(1).max(2000),
        artifacts: z
          .array(z.object({ label: z.string().min(1).max(200), path: PATH }))
          .max(50)
          .optional(),
        outstanding: z.array(z.string().min(1).max(500)).max(50).optional(),
        output: z.unknown().optional(),
      },
      async (args) => {
        const artifacts = args.artifacts ?? [];
        try {
          const scopeVersion = scopeOf(args.taskId);
          const { task, delivery } = await ctx.client.deliverTask({
            taskId: args.taskId,
            summary: args.summary,
            artifacts,
            ...(args.outstanding?.length ? { outstanding: args.outstanding } : {}),
            ...(scopeVersion === undefined ? {} : { scopeVersion }),
            // Whatever the model passed is JSON from its tool call; the Gateway checks the shape.
            ...(args.output === undefined ? {} : { output: args.output as TaskJson }),
          });
          ctx.sink.emit("log", {
            source: "task_deliver",
            taskId: task.id,
            kind: delivery.kind,
            artifacts: artifacts.length,
            published: delivery.publications.length,
            hasOutput: args.output !== undefined,
          });
          const text =
            delivery.kind === "partial"
              ? `Partial delivery recorded for task ${task.id}: ${delivery.publications.length} verified file(s) published; the task stays open with ${delivery.outstanding.length} outstanding item(s).`
              : `Task ${task.id} delivered (version ${task.version}); ${delivery.publications.length} verified file(s) published. It awaits human acceptance; delivering does not accept it.`;
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          ctx.sink.emit("log", {
            source: "task_deliver",
            taskId: args.taskId,
            level: "warn",
            error: String(err),
          });
          return {
            content: [{ type: "text" as const, text: deliveryRefusal(err) }],
            isError: true,
          };
        }
      },
    ),
    ctx.tool(
      "task_checkpoint",
      "Record durable progress on a task you were given, after each completed unit and before long steps: the units you completed with their outcome and evidence paths, and what is still outstanding. It changes no task state and publishes nothing; the next wake or continuation shows the latest checkpoint.",
      {
        taskId: z.string().min(1).max(200),
        completed: z
          .array(
            z.object({
              unit: z.string().min(1).max(500),
              outcome: z.string().min(1).max(2000),
              evidence: z.array(PATH).max(20).optional(),
            }),
          )
          .max(100),
        outstanding: z.array(z.string().min(1).max(500)).max(100).optional(),
        note: z.string().max(2000).optional(),
      },
      async (args) => {
        try {
          const { checkpoint } = await ctx.client.checkpointTask({
            taskId: args.taskId,
            completed: args.completed.map((u) => ({ ...u, evidence: u.evidence ?? [] })),
            ...(args.outstanding ? { outstanding: args.outstanding } : {}),
            ...(args.note === undefined ? {} : { note: args.note }),
          });
          ctx.sink.emit("log", {
            source: "task_checkpoint",
            taskId: checkpoint.taskId,
            completed: checkpoint.completed.length,
            outstanding: checkpoint.outstanding.length,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Checkpoint recorded for task ${checkpoint.taskId} (run ${checkpoint.runId}, attempt ${checkpoint.attempt}).`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: deliveryRefusal(err, "checkpointed") }],
            isError: true,
          };
        }
      },
    ),
  ];
}

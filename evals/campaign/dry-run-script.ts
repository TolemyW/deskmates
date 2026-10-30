// What the scripted upstream of a dry run answers (protocol amendment 1 A4). The executor sets the
// task about to run; the script answers each request from that task's reference: for comparison R
// the bot calls the task's search tool with the question, then answers the task's value; for
// comparison C a model job answers the case's reference output with the Gateway's ids in place of
// the fixture keys, and a consolidation run reports the reference items as learned. Every other
// request (a run with tools that is not under test, the CLI's own side requests) gets a silent
// reply. Pure: a T0 test drives it with request bodies shaped like the CLI's.

import {
  type FakeTurn,
  type RecordedUpstreamRequest,
  assistantText,
} from "../../acceptance/support/fake-model-upstream.js";
import { referenceReply } from "../cheap-model/reference.js";
import type { CheapTask } from "../cheap-model/task-set.js";
import { type RetrievalItem, requiredTool } from "../retrieval/task-set.js";

type Body = RecordedUpstreamRequest["body"];

/** Names of the tools a request declares. */
export function declaredTools(body: Body): string[] {
  const tools = Array.isArray(body?.tools) ? (body.tools as { name?: unknown }[]) : [];
  return tools.map((t) => (typeof t?.name === "string" ? t.name : "")).filter((n) => n !== "");
}

/** Whether the conversation already holds a tool result (the tool call was answered). */
export function hasToolResult(body: Body): boolean {
  return JSON.stringify(body?.messages ?? []).includes('"tool_result"');
}

/** The declared name of a Deskmates tool: `mcp__deskmates__memory_search` for `memory_search`. */
export function toolNamed(body: Body, tool: string): string | undefined {
  return declaredTools(body).find((n) => n === tool || n.endsWith(`__${tool}`));
}

const SILENT: FakeTurn = { kind: "text", text: assistantText("") };

/** Comparison R: one search with the question, then the answer line. */
export class RetrievalDryScript {
  current: RetrievalItem | undefined;

  turn(body: Body): FakeTurn {
    const item = this.current;
    if (!item || declaredTools(body).length === 0) return { kind: "text", text: "dry run" };
    const tool = toolNamed(body, requiredTool(item));
    // A run without the search tool answers anyway, so the grader shows `tool_not_called`.
    if (tool && !hasToolResult(body))
      return { kind: "tool_use", name: tool, input: { query: item.question } };
    return { kind: "text", text: assistantText(`answer: ${item.answer.value}`) };
  }
}

const mapId = (ids: Readonly<Record<string, string>>, key: string) => ids[key] ?? key;

/**
 * The reference reply with every fixture key replaced by the id the Gateway gave that note, which
 * is what the job's prompt shows the model and what its reply must name.
 */
export function dryRunReply(task: CheapTask, ids: Readonly<Record<string, string>>): string {
  const reply = referenceReply(task);
  if (task.case.kind === "memory_organize") {
    const parsed = JSON.parse(reply) as {
      labels: { id: string; label: string }[];
      splits: { id: string; parts: string[] }[];
    };
    return JSON.stringify({
      labels: parsed.labels.map((l) => ({ ...l, id: mapId(ids, l.id) })),
      splits: parsed.splits.map((s) => ({ ...s, id: mapId(ids, s.id) })),
    });
  }
  if (task.case.kind === "memory_recheck") {
    const parsed = JSON.parse(reply) as { verdicts: { id: string }[] };
    return JSON.stringify({
      verdicts: parsed.verdicts.map((v) => ({ ...v, id: mapId(ids, v.id) })),
    });
  }
  return reply;
}

/** A consolidation run's final text: the summary block with the reference items as learned. */
export function consolidationText(task: CheapTask): string {
  const learned = task.case.kind === "memory_consolidation" ? (task.case.reference ?? []) : [];
  const summary = {
    done: "Consolidated the episodes (dry run).",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    learned: learned.map((body) => ({ body, scope: "workspace", authority: "fact", turn: 1 })),
    reply: "",
  };
  return `Done.\n\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
}

/** Comparison C: the current task's reference, through the job that runs it. */
export class CheapDryScript {
  task: CheapTask | undefined;
  /** Fixture key → Gateway id of what the current task seeded; set by the driver before the job. */
  ids: Record<string, string> = {};

  turn(body: Body): FakeTurn {
    const task = this.task;
    if (!task) return { kind: "text", text: "dry run" };
    // Model jobs and activity summaries are one turn with no tools (ADR-0023 amendment 1).
    if (declaredTools(body).length === 0)
      return { kind: "text", text: dryRunReply(task, this.ids) || "dry run" };
    if (task.case.kind === "memory_consolidation")
      return { kind: "text", text: consolidationText(task) };
    // Triage workers and any other run: silent; the executor cancels them.
    return SILENT;
  }
}

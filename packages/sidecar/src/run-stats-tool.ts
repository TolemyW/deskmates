// `run_stats` (ADR-0050): the bot's own recent runs, failure classes, durations, spend, pending
// approvals, parked runs and tasks, offered only to a run that froze `runStats: "self-v1"`. L0:
// it reads the Gateway's ledger through the run's own route and changes nothing. The run token is
// the scope, so the tool takes no bot, workspace or run parameter. The titles of the bot's open
// tasks are the only free text in the answer; they leave the JSON and reach the model wrapped as
// untrusted (decision 4).

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import {
  RUN_STATS_TOOL,
  RUN_STATS_WINDOW_DAYS_MAX,
  type RunStatsReport,
  isDeskmatesError,
} from "@deskmates/contracts";
import { z } from "zod";
import type { ThreadToolsContext } from "./thread-tools.js";
import { wrapTaskContent } from "./untrusted.js";

const DESCRIPTION = [
  "Your own run statistics from the Gateway's ledger: your runs by status, failure classes and durations, your spend (priced as the Gateway prices it; unpriced usage stays unpriced), your pending approvals, parked runs and tasks, for the last windowDays days (default 7) against the window before.",
  "Only your own runs in this workspace; never another bot's. Read-only.",
].join(" ");

/** What the model reads: the figures as JSON, then the task titles as untrusted data. */
export function describeRunStats(report: RunStatsReport): string {
  const items = report.now.tasks.open.items;
  const figures: RunStatsReport = {
    ...report,
    now: {
      ...report.now,
      tasks: {
        ...report.now.tasks,
        open: {
          ...report.now.tasks.open,
          items: items.map(
            ({ title: _title, ...task }) => task,
          ) as RunStatsReport["now"]["tasks"]["open"]["items"],
        },
      },
    },
  };
  const json = JSON.stringify(figures);
  if (items.length === 0) return json;
  const titles = items.map((t) => `${t.taskId} (${t.status}): ${t.title}`).join("\n");
  return `${json}\nTitles of your open tasks:\n${wrapTaskContent(titles)}`;
}

// biome-ignore lint/suspicious/noExplicitAny: the SDK erases schema generics in its tool registry
export function runStatsTools(ctx: ThreadToolsContext): SdkMcpToolDefinition<any>[] {
  if (!(ctx.request.tools as readonly string[]).includes(RUN_STATS_TOOL)) return [];
  return [
    ctx.tool(
      RUN_STATS_TOOL,
      DESCRIPTION,
      { windowDays: z.number().int().min(1).max(RUN_STATS_WINDOW_DAYS_MAX).optional() },
      async (args) => {
        try {
          const report = await ctx.client.runStats(args.windowDays);
          return { content: [{ type: "text" as const, text: describeRunStats(report) }] };
        } catch (err) {
          const code = isDeskmatesError(err) ? err.code : "unavailable";
          const message = err instanceof Error ? err.message : String(err);
          ctx.sink.emit("log", { source: RUN_STATS_TOOL, level: "warn", code, error: message });
          return {
            content: [
              { type: "text" as const, text: `run_stats was refused (${code}): ${message}` },
            ],
            isError: true,
          };
        }
      },
    ),
  ];
}

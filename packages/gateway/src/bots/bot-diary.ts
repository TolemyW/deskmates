// The bot's own diary, `/home/<bot>/memory/YYYY-MM-DD.md` (ADR-0043 decision 4): the sidecar
// appends a line when a run ends and every run's first turn carries the last three days. The
// operator reads it and deletes single lines; nothing here writes a line. The files live in the
// workspace container, so a stopped workspace has no diary to show until it runs again.

import {
  type BotDefinition,
  type BotDiaryDay,
  type BotDiaryDaySummary,
  DIARY_DAY_PATTERN,
  DeskmatesError,
  type SandboxHandle,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { execSidecarJson } from "../workspaces/sidecar-json.js";

async function runningSandbox(ctx: GatewayContext, bot: BotDefinition): Promise<SandboxHandle> {
  const handle = await ctx.sandboxes.peek(bot.workspaceId);
  if (!handle)
    throw new DeskmatesError(
      "sandbox_unavailable",
      "The workspace is not running; its bots' diaries are in its filesystem",
    );
  return handle;
}

export function assertDiaryDay(day: string): void {
  if (!DIARY_DAY_PATTERN.test(day))
    throw new DeskmatesError("validation", "day must be YYYY-MM-DD", { day });
}

export async function listDiaryDays(
  ctx: GatewayContext,
  bot: BotDefinition,
): Promise<BotDiaryDaySummary[]> {
  const answer = await execSidecarJson(ctx, await runningSandbox(ctx, bot), "diary", {
    op: "list",
    botName: bot.name,
  });
  const days = answer.days;
  if (!Array.isArray(days)) throw invalid();
  return days.map((entry) => {
    const day = entry as { day?: unknown; bytes?: unknown };
    if (typeof day.day !== "string" || typeof day.bytes !== "number") throw invalid();
    return { day: day.day, bytes: day.bytes };
  });
}

export async function readDiaryDay(
  ctx: GatewayContext,
  bot: BotDefinition,
  day: string,
): Promise<BotDiaryDay> {
  assertDiaryDay(day);
  return diaryDayOf(
    await execSidecarJson(ctx, await runningSandbox(ctx, bot), "diary", {
      op: "read",
      botName: bot.name,
      day,
    }),
  );
}

/**
 * Delete one line, named by its index, its exact text and the file's version: a line the bot
 * appended or changed since the operator read the day is never the one removed.
 */
export async function deleteDiaryLine(
  ctx: GatewayContext,
  bot: BotDefinition,
  input: { day: string; line: number; text: string; version: string },
): Promise<BotDiaryDay> {
  assertDiaryDay(input.day);
  return diaryDayOf(
    await execSidecarJson(ctx, await runningSandbox(ctx, bot), "diary", {
      op: "delete-line",
      botName: bot.name,
      ...input,
    }),
  );
}

function diaryDayOf(answer: Record<string, unknown>): BotDiaryDay {
  if (
    typeof answer.day !== "string" ||
    !Array.isArray(answer.lines) ||
    !answer.lines.every((line) => typeof line === "string") ||
    typeof answer.version !== "string"
  )
    throw invalid();
  return { day: answer.day, lines: answer.lines as string[], version: answer.version };
}

function invalid(): DeskmatesError {
  return new DeskmatesError("sandbox_unavailable", "diary returned an invalid response");
}

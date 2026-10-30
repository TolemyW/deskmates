// The workspace default bot's tools (ADR-0051 decision 4): `bot_create`, `bot_update` and
// `group_create`, offered only to a run that froze `workspaceAssistant: "assistant-v1"`. L1: each
// is a Gateway-side record a person can undo (Trash restores a bot, a SOUL version restores). The
// Gateway checks again that the run's bot is still the default bot, so the tool list is a prompt
// choice, not the guard. The answers hold only what the bot itself sent and ids.

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { type DefaultBotToolName, isDeskmatesError } from "@deskmates/contracts";
import { z } from "zod";
import type { ThreadToolsContext } from "./thread-tools.js";

const cronSchema = z
  .array(
    z.object({
      schedule: z.string().min(1),
      prompt: z.string().min(1),
      misfire: z.enum(["skip", "run_once"]).optional(),
    }),
  )
  .max(20);

const BOT_CREATE = [
  "Create a new teammate bot in this workspace at once.",
  "name: short, letters, digits, - or _ only. role: one line. soul: its first instructions, in the second person (goal, how to work, what to report).",
  "Reuse an existing teammate when it fits. Afterwards tell the person who you created; ask only for missing information that materially changes the work. Use group_create with message to start delegated work.",
].join(" ");
const BOT_UPDATE = [
  "Change another bot of this workspace: its one-line role, its SOUL (full new text replaces the old one) and/or its schedules (cron entries replace all existing ones).",
  "You cannot change its model, connectors, approval rules or credentials, and you cannot change yourself.",
].join(" ");
const GROUP_CREATE =
  "Open a group chat in this workspace with you and the named bots. Supply message to start collaboration. Required startWith: names of the workers to start now; [] starts all teammates. For dependent work, startWith must contain only the first worker; tell it to hand its result to the next worker by @mention, and tell the last worker to report to you by @mention. startWith, not names mentioned in the assignment text, decides the initial workers. Without message this only creates a chat. The same request in this run reuses the chat. Share its Markdown group link with the person; thread_post cannot post into a different thread. In introductions and completion summaries, write plain bot names without @: mentions dispatch work, even in a final reply.";

function offered(ctx: ThreadToolsContext, name: DefaultBotToolName): boolean {
  return (ctx.request.tools as readonly string[]).includes(name);
}

async function call<T>(
  ctx: ThreadToolsContext,
  name: DefaultBotToolName,
  describe: (result: T) => string,
  run: () => Promise<T>,
) {
  try {
    const result = await run();
    ctx.sink.emit("log", { source: name, result });
    return { content: [{ type: "text" as const, text: describe(result) }] };
  } catch (err) {
    // A refusal is an answer to the model: a taken name, an unknown bot, a run that is no longer
    // the default bot's.
    const code = isDeskmatesError(err) ? err.code : "unavailable";
    const message = err instanceof Error ? err.message : String(err);
    ctx.sink.emit("log", { source: name, level: "warn", code, error: message });
    return {
      content: [{ type: "text" as const, text: `${name} was refused (${code}): ${message}` }],
      isError: true,
    };
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the SDK erases schema generics in its tool registry
export function defaultBotTools(ctx: ThreadToolsContext): SdkMcpToolDefinition<any>[] {
  // biome-ignore lint/suspicious/noExplicitAny: same as the return type
  const tools: SdkMcpToolDefinition<any>[] = [];
  if (offered(ctx, "bot_create"))
    tools.push(
      ctx.tool(
        "bot_create",
        BOT_CREATE,
        {
          name: z.string().min(1).max(64),
          role: z.string().max(200),
          soul: z.string().optional(),
        },
        (args) =>
          call(
            ctx,
            "bot_create",
            (r) =>
              `Created ${r.bot.name} (${r.bot.role || "no role"}), bot ID: ${r.bot.id}. To delegate work now, call group_create with bots ["${r.bot.name}"] and message containing the assignment. Use plain names without @ when telling the person who you created; a mention attempts to dispatch work.`,
            () =>
              ctx.client.assistantCreateBot({
                name: args.name,
                role: args.role,
                ...(args.soul === undefined ? {} : { soul: args.soul }),
              }),
          ),
      ),
    );
  if (offered(ctx, "bot_update"))
    tools.push(
      ctx.tool(
        "bot_update",
        BOT_UPDATE,
        {
          bot: z.string().min(1),
          role: z.string().max(200).optional(),
          soul: z.string().optional(),
          cron: cronSchema.optional(),
        },
        (args) =>
          call(
            ctx,
            "bot_update",
            (r) =>
              `Updated @${r.bot.name}: role "${r.bot.role}", ${r.bot.cron.length} schedule(s)${r.soulChanged ? ", new SOUL saved" : ""}.`,
            () =>
              ctx.client.assistantUpdateBot(args.bot, {
                ...(args.role === undefined ? {} : { role: args.role }),
                ...(args.soul === undefined ? {} : { soul: args.soul }),
                ...(args.cron === undefined
                  ? {}
                  : {
                      cron: args.cron.map(({ schedule, prompt, misfire }) => ({
                        schedule,
                        prompt,
                        ...(misfire === undefined ? {} : { misfire }),
                      })),
                    }),
              }),
          ),
      ),
    );
  if (offered(ctx, "group_create"))
    tools.push(
      ctx.tool(
        "group_create",
        GROUP_CREATE,
        {
          bots: z.array(z.string().min(1)).min(1).max(10),
          title: z.string().max(120).optional(),
          message: z.string().trim().min(1).max(16_000).optional(),
          startWith: z.array(z.string().min(1)).max(10),
        },
        (args) =>
          call(
            ctx,
            "group_create",
            (r) =>
              `Group chat [${r.thread.title}](#/threads/${r.thread.id}), with ${r.members.join(", ")}.${r.messageId ? ` Initial assignment posted (${r.messageId}); follow execution in the group.` : " No assignment posted; creating a group alone starts no work."}`,
            () =>
              ctx.client.assistantCreateGroup({
                bots: args.bots,
                ...(args.title === undefined ? {} : { title: args.title }),
                ...(args.message === undefined ? {} : { message: args.message }),
                startWith: args.startWith,
              }),
          ),
      ),
    );
  return tools;
}

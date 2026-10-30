import type {
  ChannelMenuCommand,
  ChannelMenuRequest,
  ChannelMenuResult,
} from "@deskmates/contracts";
import type { TelegramBotApi } from "./bot-api.js";

export const TELEGRAM_COMMANDS: readonly ChannelMenuCommand[] = [
  { command: "start", description: "About this ongoing Agent conversation" },
  { command: "help", description: "Communication, results and approvals" },
  { command: "status", description: "Current work and message synchronization" },
  { command: "settings", description: "Open authorized Web settings" },
];

export async function telegramCommandMenu(
  api: TelegramBotApi,
  input: ChannelMenuRequest,
  signal: AbortSignal,
): Promise<ChannelMenuResult> {
  const target = {
    scope:
      input.scope === "chat"
        ? { type: "chat", chat_id: input.chatId }
        : { type: input.scope === "private" ? "all_private_chats" : "default" },
    language_code: input.languageCode ?? "",
  };
  const buttonTarget = input.scope === "chat" ? { chat_id: input.chatId } : {};
  if (input.operation === "sync") {
    await api.call("setMyCommands", { ...target, commands: TELEGRAM_COMMANDS }, signal);
    if (input.replaceMenuButton)
      await api.call(
        "setChatMenuButton",
        { ...buttonTarget, menu_button: { type: "commands" } },
        signal,
      );
  }
  const commands = await api.call<ChannelMenuCommand[]>("getMyCommands", target, signal);
  const button = await api.call<{ type: string }>("getChatMenuButton", buttonTarget, signal);
  return { commands, menuButton: button.type };
}

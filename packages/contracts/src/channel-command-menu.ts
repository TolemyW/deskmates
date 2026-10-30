// Optional operator-managed command menus (ADR-0047 amendment 3).
import { DeskmatesError } from "./errors.js";

export interface ChannelMenuCommand {
  command: string;
  description: string;
}
export interface ChannelMenuRequest {
  operation: "inspect" | "sync";
  scope: "default" | "private" | "chat";
  chatId?: string;
  languageCode?: string;
  replaceMenuButton?: boolean;
}
export interface ChannelMenuResult {
  commands: ChannelMenuCommand[];
  menuButton: string;
}
export function parseChannelMenuRequest(value: unknown): ChannelMenuRequest {
  const input = value as Partial<ChannelMenuRequest> | null;
  if (
    !input ||
    !["inspect", "sync"].includes(input.operation ?? "") ||
    !["default", "private", "chat"].includes(input.scope ?? "") ||
    (input.languageCode !== undefined && !/^(?:[a-z]{2})?$/.test(input.languageCode)) ||
    (input.scope === "chat" &&
      (typeof input.chatId !== "string" || !/^[1-9][0-9]{0,15}$/.test(input.chatId))) ||
    (input.scope !== "chat" && input.chatId !== undefined) ||
    (input.replaceMenuButton !== undefined && typeof input.replaceMenuButton !== "boolean")
  )
    throw new DeskmatesError("validation", "invalid command menu target");
  return {
    operation: input.operation as ChannelMenuRequest["operation"],
    scope: input.scope as ChannelMenuRequest["scope"],
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.languageCode ? { languageCode: input.languageCode } : {}),
    ...(input.replaceMenuButton !== undefined
      ? { replaceMenuButton: input.replaceMenuButton }
      : {}),
  };
}

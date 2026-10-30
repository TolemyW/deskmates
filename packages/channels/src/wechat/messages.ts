import { type ThreadMessage, isApprovalAttachmentMime } from "@deskmates/contracts";
import { approvalInstruction } from "../whatsapp/commands.js";

export interface WechatMessage {
  id: string;
  sender: string;
  text: string;
  context?: string;
  media: boolean;
}

/** A missing, unsafe numeric id or group envelope is not a private message. */
export function privateMessage(value: unknown): WechatMessage | undefined {
  if (!value || typeof value !== "object") return;
  const msg = value as Record<string, unknown>;
  if (
    msg.group_id ||
    msg.message_type !== 1 ||
    msg.delete_time_ms ||
    (msg.message_state !== undefined && msg.message_state !== 2) ||
    typeof msg.from_user_id !== "string" ||
    !msg.from_user_id ||
    msg.from_user_id.length > 128 ||
    !Array.isArray(msg.item_list)
  )
    return;
  const id = msg.message_id;
  if (
    !(typeof id === "string" && id.length > 0 && id.length <= 128) &&
    !(typeof id === "number" && Number.isSafeInteger(id) && id >= 0)
  )
    return;
  const texts: string[] = [];
  let media = false;
  for (const item of msg.item_list) {
    if (!item || typeof item !== "object") {
      media = true;
      continue;
    }
    const part = item as { type?: unknown; text_item?: { text?: unknown } };
    if (part.type === 1 && typeof part.text_item?.text === "string")
      texts.push(part.text_item.text);
    else media = true;
  }
  const context =
    typeof msg.context_token === "string" && msg.context_token.length <= 16_384
      ? msg.context_token
      : undefined;
  return {
    id: String(id),
    sender: msg.from_user_id,
    text: texts.join("\n"),
    media,
    ...(context ? { context } : {}),
  };
}

/** Conservative client chunk size, not a claim about Tencent's undocumented server quota. */
export function chunks(text: string): string[] {
  const points = Array.from(text);
  const result: string[] = [];
  for (let i = 0; i < points.length; i += 2000) result.push(points.slice(i, i + 2000).join(""));
  return result;
}

export function render(message: ThreadMessage): string {
  return [
    message.body,
    ...message.attachments.map((attachment) =>
      isApprovalAttachmentMime(attachment.mimeType)
        ? approvalInstruction(attachment.ref)
        : `(attachment not sent here: ${attachment.name})`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

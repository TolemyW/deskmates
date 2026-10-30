// What a relayed thread message looks like in Telegram. Replies go out as plain text (no
// `parse_mode`), so nothing the model writes is interpreted as Markdown or HTML and nothing needs
// escaping. A message longer than Telegram's limit is split into several.

import { type ThreadMessage, isApprovalAttachmentMime } from "@deskmates/contracts";
import { approvalInstruction } from "../whatsapp/commands.js";

/** Telegram's limit for one text message, in characters after entity parsing. */
export const TELEGRAM_TEXT_MAX = 4096;

/**
 * Split at the last newline, then the last space, before the limit; hard cut as the last resort,
 * never inside a UTF-16 surrogate pair. Length is counted in UTF-16 code units, which is never
 * fewer than Telegram's character count, so every chunk fits.
 */
export function chunkTelegramText(text: string, max = TELEGRAM_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    const head = rest.slice(0, cut).trimEnd();
    if (head) out.push(head);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * The text of one relayed message: its body, the approval grammar line for an approval request
 * (ADR-0017 decision 7), and the names of other attachments, which this version does not send.
 * Empty when there is nothing to say.
 */
export function renderForTelegram(message: ThreadMessage): string {
  const lines = [message.body.trim()];
  for (const attachment of message.attachments) {
    if (isApprovalAttachmentMime(attachment.mimeType))
      lines.push(approvalInstruction(attachment.ref));
    else lines.push(`(attachment not sent here: ${attachment.name})`);
  }
  return lines.filter((line) => line.length > 0).join("\n");
}

// What a relayed thread message looks like in a Discord DM: the body, plus the approval grammar's
// instruction for an approval request (ADR-0017 decision 7), split into Discord's 2000-character
// messages. The bot is the connection's identity, so a reply carries no name prefix.

import { type ThreadMessage, isApprovalAttachmentMime } from "@deskmates/contracts";
import { approvalInstruction } from "../whatsapp/commands.js";

/** Discord's limit for a message's `content`. */
export const DISCORD_TEXT_MAX = 2000;

/**
 * Split at the last newline, then the last space, before the limit; hard cut as the last resort.
 * A cut never splits a UTF-16 surrogate pair. Every chunk is non-empty and at most `max` long.
 */
export function chunkDiscordText(text: string, max = DISCORD_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
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
  if (rest) out.push(rest);
  return out;
}

/** The text a thread message is relayed as; empty only when there is nothing to send. */
export function renderDiscordMessage(message: ThreadMessage): string {
  const approval = message.attachments.find((a) => isApprovalAttachmentMime(a.mimeType));
  const files = message.attachments.filter((a) => !isApprovalAttachmentMime(a.mimeType)).length;
  const parts = [message.body.trim()];
  if (files > 0 && message.authorKind === "bot")
    parts.push(
      files === 1
        ? "(The assistant attached a file; files are not delivered on Discord.)"
        : `(The assistant attached ${files} files; files are not delivered on Discord.)`,
    );
  if (approval) parts.push(approvalInstruction(approval.ref));
  return parts.filter((part) => part.length > 0).join("\n");
}

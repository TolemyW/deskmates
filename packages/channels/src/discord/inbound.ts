// Reduce a Discord `MESSAGE_CREATE` to what this version handles (ADR-0047 decision 12, owner
// rulings of 2026-10-17): a person's direct message with text and up to four images. A message in
// a server (guild) channel or thread, a bot's or webhook's message, the bot's own message and
// system messages are ignored: no thread, no message, no run. Other media (voice messages, video,
// files, stickers) is counted so the plugin can refuse it with a notice.

import {
  CHANNEL_INBOUND_IMAGES_MAX,
  CHANNEL_INBOUND_IMAGE_MAX_BYTES,
  CHANNEL_INBOUND_IMAGE_TYPES,
} from "@deskmates/contracts";
import type { DiscordAttachment, DiscordMessage } from "./rest.js";

/** Message types a person's own message has: DEFAULT and REPLY. */
const PERSON_MESSAGE_TYPES = new Set([0, 19]);

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export type DiscordIgnoreReason = "guild" | "bot" | "self" | "webhook" | "system" | "malformed";

export interface DiscordImageToFetch {
  attachment: DiscordAttachment;
  mimeType: string;
}

export type DiscordInbound =
  | { kind: "ignore"; reason: DiscordIgnoreReason }
  | {
      kind: "direct";
      channelId: string;
      messageId: string;
      senderId: string;
      senderName: string;
      text: string;
      images: DiscordImageToFetch[];
      /** Images refused before download: too large, or beyond the per-message maximum. */
      imagesRefused: number;
      /** Attachments and stickers that are not images. */
      otherMedia: number;
    };

/** The image type of an attachment, from its declared type or else its file extension. */
export function imageType(attachment: DiscordAttachment): string | undefined {
  const declared = attachment.content_type?.split(";")[0]?.trim().toLowerCase();
  if (declared) return CHANNEL_INBOUND_IMAGE_TYPES.includes(declared) ? declared : undefined;
  const extension = attachment.filename.split(".").pop()?.toLowerCase() ?? "";
  return TYPE_BY_EXTENSION[extension];
}

export function classifyDiscordMessage(message: DiscordMessage, selfId: string): DiscordInbound {
  if (typeof message?.id !== "string" || typeof message.channel_id !== "string")
    return { kind: "ignore", reason: "malformed" };
  if (message.guild_id) return { kind: "ignore", reason: "guild" };
  if (message.webhook_id) return { kind: "ignore", reason: "webhook" };
  const author = message.author;
  if (!author || typeof author.id !== "string") return { kind: "ignore", reason: "malformed" };
  if (author.id === selfId) return { kind: "ignore", reason: "self" };
  if (author.bot) return { kind: "ignore", reason: "bot" };
  if (message.type !== undefined && !PERSON_MESSAGE_TYPES.has(message.type))
    return { kind: "ignore", reason: "system" };
  const images: DiscordImageToFetch[] = [];
  let imagesRefused = 0;
  let otherMedia = message.sticker_items?.length ?? 0;
  for (const attachment of message.attachments ?? []) {
    const mimeType = imageType(attachment);
    if (!mimeType) otherMedia += 1;
    else if (
      images.length >= CHANNEL_INBOUND_IMAGES_MAX ||
      !(attachment.size > 0) ||
      attachment.size > CHANNEL_INBOUND_IMAGE_MAX_BYTES
    )
      imagesRefused += 1;
    else images.push({ attachment, mimeType });
  }
  return {
    kind: "direct",
    channelId: message.channel_id,
    messageId: message.id,
    senderId: author.id,
    senderName: author.global_name || author.username || author.id,
    text: typeof message.content === "string" ? message.content : "",
    images,
    imagesRefused,
    otherMedia,
  };
}

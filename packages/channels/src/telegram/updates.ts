// What one Bot API update means for the connection (ADR-0047, owner rulings of 2026-10-17): only a
// person's message in a private (1:1) chat with the bot is admitted. Groups, supergroups,
// channels and topic messages are ignored: no thread, no wake, no reply. A message carries text
// (or a caption), images (the largest size of a photo, or an image document), and anything else
// is "other media", which the connection refuses with a notice.

import { CHANNEL_INBOUND_IMAGE_TYPES } from "@deskmates/contracts";
import type { TelegramMessage, TelegramUpdate } from "./bot-api.js";

export interface TelegramImageRef {
  fileId: string;
  name: string;
  /** What Telegram says; the bytes are sniffed again after download. */
  mimeType: string;
  fileSize?: number;
}

export type ClassifiedUpdate =
  | {
      kind: "ignored";
      reason: "not_a_message" | "not_private" | "topic" | "from_bot" | "no_sender";
    }
  | {
      kind: "message";
      /** The private chat id: the conversation key. */
      conversationKey: string;
      /** The person's user id: the blocklist key and the channel author id. */
      senderId: string;
      /**
       * `<chat id>:<message id>`, unique per bot for good. Not the `update_id`: the Bot API may
       * restart update ids at a random value after a week without updates, so an update id is not
       * a lasting deduplication key.
       */
      externalId: string;
      text: string;
      images: TelegramImageRef[];
      /** The message held something other than text and images (voice, video, a file…). */
      otherMedia: boolean;
    };

/** Message fields that carry a medium this version does not receive. */
const OTHER_MEDIA_FIELDS = [
  "animation",
  "audio",
  "contact",
  "dice",
  "game",
  "invoice",
  "location",
  "paid_media",
  "poll",
  "sticker",
  "story",
  "venue",
  "video",
  "video_note",
  "voice",
] as const;

function largestPhoto(message: TelegramMessage): TelegramImageRef | undefined {
  const sizes = Array.isArray(message.photo) ? message.photo : [];
  let best: (typeof sizes)[number] | undefined;
  for (const size of sizes) {
    if (!size || typeof size.file_id !== "string") continue;
    if (!best || size.width * size.height > best.width * best.height) best = size;
  }
  if (!best) return undefined;
  return {
    fileId: best.file_id,
    name: `photo-${message.message_id}.jpg`,
    mimeType: "image/jpeg",
    ...(typeof best.file_size === "number" ? { fileSize: best.file_size } : {}),
  };
}

export function classifyUpdate(update: TelegramUpdate): ClassifiedUpdate {
  const message = update.message;
  if (!message || typeof message !== "object" || !message.chat)
    return { kind: "ignored", reason: "not_a_message" };
  if (message.chat.type !== "private") return { kind: "ignored", reason: "not_private" };
  if (message.is_topic_message === true) return { kind: "ignored", reason: "topic" };
  const from = message.from;
  if (!from || typeof from.id !== "number") return { kind: "ignored", reason: "no_sender" };
  if (from.is_bot) return { kind: "ignored", reason: "from_bot" };

  const images: TelegramImageRef[] = [];
  let otherMedia = OTHER_MEDIA_FIELDS.some((field) => message[field] !== undefined);
  const photo = largestPhoto(message);
  if (photo) images.push(photo);
  // An animation also fills `document` for backward compatibility; it is other media.
  const document = message.document;
  if (document && message.animation === undefined) {
    const mimeType = (document.mime_type ?? "").toLowerCase();
    if (CHANNEL_INBOUND_IMAGE_TYPES.includes(mimeType) && typeof document.file_id === "string")
      images.push({
        fileId: document.file_id,
        name: document.file_name?.trim() || `image-${message.message_id}`,
        mimeType,
        ...(typeof document.file_size === "number" ? { fileSize: document.file_size } : {}),
      });
    else otherMedia = true;
  }
  const text = typeof message.text === "string" ? message.text : (message.caption ?? "");
  return {
    kind: "message",
    conversationKey: String(message.chat.id),
    senderId: String(from.id),
    externalId: `${message.chat.id}:${message.message_id}`,
    text: typeof text === "string" ? text : "",
    images,
    otherMedia,
  };
}

/** The image type the bytes actually are, or undefined. Telegram's own claim is not trusted. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.byteLength >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
    return "image/webp";
  return undefined;
}

/** Honor Telegram's command entity; older transports without entities use a leading slash. */
export function isTelegramCommand(update: TelegramUpdate): boolean {
  const message = update.message;
  if (!message?.text) return false;
  if (!Array.isArray(message.entities)) return message.text.trim().startsWith("/");
  return message.entities.some((entity: unknown) => {
    if (!entity || typeof entity !== "object") return false;
    const value = entity as { type?: unknown; offset?: unknown; length?: unknown };
    return (
      value.type === "bot_command" &&
      value.offset === 0 &&
      typeof value.length === "number" &&
      value.length > 1
    );
  });
}

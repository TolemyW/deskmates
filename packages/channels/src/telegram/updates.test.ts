// T0: which Telegram updates reach the Gateway (ADR-0047, owner rulings of 2026-10-17).

import { describe, expect, it } from "vitest";
import type { TelegramUpdate } from "./bot-api.js";
import { classifyUpdate, isTelegramCommand, sniffImageType } from "./updates.js";

const person = { id: 42, is_bot: false, first_name: "P" };
const privateChat = { id: 42, type: "private" };

function update(message: Record<string, unknown>): TelegramUpdate {
  return { update_id: 1, message: { message_id: 7, ...message } } as TelegramUpdate;
}

describe("classifyUpdate", () => {
  it("admits a private text message, keyed by chat and message id", () => {
    expect(classifyUpdate(update({ from: person, chat: privateChat, text: "hi" }))).toEqual({
      kind: "message",
      conversationKey: "42",
      senderId: "42",
      externalId: "42:7",
      text: "hi",
      images: [],
      otherMedia: false,
    });
  });

  it("ignores groups, channels, topics, bots and updates that are not messages", () => {
    for (const type of ["group", "supergroup", "channel"])
      expect(classifyUpdate(update({ from: person, chat: { id: -1, type }, text: "x" }))).toEqual({
        kind: "ignored",
        reason: "not_private",
      });
    expect(
      classifyUpdate(
        update({ from: person, chat: privateChat, text: "x", is_topic_message: true }),
      ),
    ).toEqual({ kind: "ignored", reason: "topic" });
    expect(
      classifyUpdate(update({ from: { ...person, is_bot: true }, chat: privateChat, text: "x" })),
    ).toEqual({ kind: "ignored", reason: "from_bot" });
    expect(classifyUpdate({ update_id: 2, edited_message: {} } as TelegramUpdate)).toEqual({
      kind: "ignored",
      reason: "not_a_message",
    });
  });

  it("picks the largest photo, takes image documents, and flags other media", () => {
    const photo = classifyUpdate(
      update({
        from: person,
        chat: privateChat,
        caption: "c",
        photo: [
          { file_id: "big", width: 800, height: 600, file_size: 5 },
          { file_id: "small", width: 80, height: 60 },
        ],
      }),
    );
    expect(photo).toMatchObject({
      text: "c",
      images: [{ fileId: "big", mimeType: "image/jpeg", fileSize: 5 }],
      otherMedia: false,
    });
    expect(
      classifyUpdate(
        update({
          from: person,
          chat: privateChat,
          document: { file_id: "d", file_name: "a.webp", mime_type: "image/webp" },
        }),
      ),
    ).toMatchObject({ images: [{ fileId: "d", name: "a.webp" }], otherMedia: false });
    for (const media of [
      { voice: {} },
      { sticker: {} },
      { location: {} },
      { video: {} },
      { document: { file_id: "p", mime_type: "application/pdf" } },
      // An animation also fills `document`; it is other media, not an image.
      { animation: {}, document: { file_id: "g", mime_type: "image/gif" } },
    ])
      expect(classifyUpdate(update({ from: person, chat: privateChat, ...media }))).toMatchObject({
        images: [],
        otherMedia: true,
      });
  });
});

describe("sniffImageType", () => {
  it("knows the four image types and nothing else", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("%PDF-1.7"))).toBeUndefined();
  });
});

it("distinguishes command entities from literal code or prose", () => {
  expect(
    isTelegramCommand(
      update({
        text: "/help@alpha_bot",
        entities: [{ type: "bot_command", offset: 0, length: 15 }],
      }),
    ),
  ).toBe(true);
  expect(
    isTelegramCommand(
      update({ text: "/stop", entities: [{ type: "code", offset: 0, length: 5 }] }),
    ),
  ).toBe(false);
  expect(
    isTelegramCommand(
      update({ text: "Try /stop", entities: [{ type: "bot_command", offset: 4, length: 5 }] }),
    ),
  ).toBe(false);
  expect(isTelegramCommand(update({ text: "/help" }))).toBe(true);
});

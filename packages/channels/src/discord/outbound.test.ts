// T0: Discord's 2000-character chunking and how a thread message is rendered for a DM.

import {
  APPROVAL_ATTACHMENT_MIME,
  type MessageId,
  type ThreadId,
  type ThreadMessage,
} from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { DISCORD_TEXT_MAX, chunkDiscordText, renderDiscordMessage } from "./outbound.js";

function message(input: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: "m" as MessageId,
    threadId: "t" as ThreadId,
    seq: 1,
    authorKind: "bot",
    authorId: "bot-1",
    body: "",
    attachments: [],
    mentions: [],
    relayCount: 0,
    ts: "2026-10-17T00:00:00.000Z" as ThreadMessage["ts"],
    ...input,
  };
}

describe("chunkDiscordText", () => {
  it("keeps a message at the limit whole and splits one character over", () => {
    expect(chunkDiscordText("x".repeat(DISCORD_TEXT_MAX))).toHaveLength(1);
    const split = chunkDiscordText("x".repeat(DISCORD_TEXT_MAX + 1));
    expect(split.map((c) => c.length)).toEqual([DISCORD_TEXT_MAX, 1]);
  });

  it("prefers a newline, then a space, and never splits a surrogate pair", () => {
    const text = `${"a".repeat(1500)}\n${"b".repeat(1000)}`;
    expect(chunkDiscordText(text)).toEqual(["a".repeat(1500), "b".repeat(1000)]);
    const emoji = `${"c".repeat(DISCORD_TEXT_MAX - 1)}😀tail`;
    const chunks = chunkDiscordText(emoji);
    expect(chunks[0]).toBe("c".repeat(DISCORD_TEXT_MAX - 1));
    expect(chunks[1]).toBe("😀tail");
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(DISCORD_TEXT_MAX);
  });

  it("returns nothing for blank text", () => {
    expect(chunkDiscordText("  \n ")).toEqual([]);
  });
});

describe("renderDiscordMessage", () => {
  it("appends the approval grammar to an approval request", () => {
    const text = renderDiscordMessage(
      message({
        authorKind: "system",
        authorId: "",
        body: "Send the e-mail?",
        attachments: [
          { name: "a", mimeType: APPROVAL_ATTACHMENT_MIME, ref: "approval_0123456789abcdef" },
        ],
      }),
    );
    expect(text).toBe(
      'Send the e-mail?\nReply "approve approval_0123456789abcdef" or "deny approval_0123456789abcdef [reason]".',
    );
  });

  it("says a Bot's files are not delivered instead of sending an empty message", () => {
    const text = renderDiscordMessage(
      message({
        attachments: [{ name: "r.pdf", mimeType: "application/pdf", ref: "/work/r.pdf" }],
      }),
    );
    expect(text).toBe("(The assistant attached a file; files are not delivered on Discord.)");
  });
});

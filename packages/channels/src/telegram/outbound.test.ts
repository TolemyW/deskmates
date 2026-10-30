// T0: Telegram reply rendering and chunking.

import { APPROVAL_ATTACHMENT_MIME, type ThreadMessage } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { TELEGRAM_TEXT_MAX, chunkTelegramText, renderForTelegram } from "./outbound.js";

function message(body: string, attachments: ThreadMessage["attachments"] = []): ThreadMessage {
  return { body, attachments } as unknown as ThreadMessage;
}

describe("chunkTelegramText", () => {
  it("keeps a short text whole and returns nothing for an empty one", () => {
    expect(chunkTelegramText("hello")).toEqual(["hello"]);
    expect(chunkTelegramText("")).toEqual([]);
  });

  it("splits at newlines or spaces and never exceeds the limit", () => {
    const text = `${"a".repeat(3000)}\n${"b ".repeat(2000)}`;
    const chunks = chunkTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expect(chunks[0]).toBe("a".repeat(3000));
  });

  it("never cuts a surrogate pair in a hard cut", () => {
    const text = `${"x".repeat(9)}${"\u{1F600}".repeat(10)}`;
    const chunks = chunkTelegramText(text, 10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
      expect(chunk).not.toMatch(/[\ud800-\udbff]$/);
      expect(chunk).not.toMatch(/^[\udc00-\udfff]/);
    }
    expect(chunks.join("")).toBe(text);
  });
});

describe("renderForTelegram", () => {
  it("adds the approval grammar and names attachments it does not send", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(
      renderForTelegram(
        message("Approval needed.", [
          { name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: id },
          { name: "report.pdf", mimeType: "application/pdf", ref: "/work/bots/a/report.pdf" },
        ]),
      ),
    ).toBe(
      `Approval needed.\nReply "approve ${id}" or "deny ${id} [reason]".\n(attachment not sent here: report.pdf)`,
    );
    expect(renderForTelegram(message("  "))).toBe("");
  });
});

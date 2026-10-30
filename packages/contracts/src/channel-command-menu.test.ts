import { expect, it } from "vitest";
import { parseChannelMenuRequest } from "./channel-command-menu.js";
it("accepts explicit private-chat and language targets and rejects malformed ones", () => {
  expect(
    parseChannelMenuRequest({ operation: "sync", scope: "chat", chatId: "42", languageCode: "zh" }),
  ).toEqual({ operation: "sync", scope: "chat", chatId: "42", languageCode: "zh" });
  for (const input of [
    null,
    {},
    { operation: "delete", scope: "default" },
    { operation: "sync", scope: "chat" },
    { operation: "sync", scope: "chat", chatId: "-42" },
    { operation: "sync", scope: "default", languageCode: "zh-CN" },
    { operation: "sync", scope: "private", chatId: "42" },
  ])
    expect(() => parseChannelMenuRequest(input)).toThrow();
});

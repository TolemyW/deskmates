import { describe, expect, it } from "vitest";
import { isBotName, suggestBotName } from "./bot.js";

describe("bot mention names", () => {
  it("accepts only the handle alphabet and suggests a valid readable name", () => {
    expect(isBotName("Sales_Helper-2")).toBe(true);
    expect(isBotName("Sales Helper!")).toBe(false);
    expect(suggestBotName(" Sales Helper! ")).toBe("Sales-Helper");
    expect(suggestBotName("résearch café")).toBe("research-cafe");
    expect(suggestBotName("💡")).toBe("bot");
  });
});

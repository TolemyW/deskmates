import { describe, expect, it } from "vitest";
import {
  BOT_MESSAGE_INJECTION_CORPUS,
  renderBotMessageInjection,
  validateBotMessageInjectionCorpus,
} from "./bot-message.js";

describe("bot-message injection corpus", () => {
  it("has four valid, uniquely attributable cases", () => {
    expect(() => validateBotMessageInjectionCorpus(BOT_MESSAGE_INJECTION_CORPUS)).not.toThrow();
    expect(BOT_MESSAGE_INJECTION_CORPUS).toHaveLength(4);
    expect(new Set(BOT_MESSAGE_INJECTION_CORPUS.map((item) => item.id)).size).toBe(4);
    expect(new Set(BOT_MESSAGE_INJECTION_CORPUS.map((item) => item.canary)).size).toBe(4);
  });

  it("renders the factual recipient and local site without leaving template fields", () => {
    for (const item of BOT_MESSAGE_INJECTION_CORPUS) {
      const body = renderBotMessageInjection(item, "receiver", "http://golden.test/");
      expect(body).toContain("@receiver");
      expect(body).toContain(item.canary);
      expect(body).not.toContain("{recipient}");
      expect(body).not.toContain("{siteOrigin}");
    }
  });

  it("rejects duplicate ids and carrier/action mismatches", () => {
    const first = BOT_MESSAGE_INJECTION_CORPUS[0];
    if (!first) throw new Error("missing fixture");
    expect(() => validateBotMessageInjectionCorpus([first, first])).toThrow("duplicate corpus id");
    expect(() =>
      validateBotMessageInjectionCorpus([
        { ...first, id: "wrong-carrier", bodyTemplate: "@{recipient} harmless" },
      ]),
    ).toThrow("body does not carry canary");
  });
});

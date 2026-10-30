// T0 (ADR-0051 decision 11): which language the default bot's welcome is written in.

import { describe, expect, it } from "vitest";
import { assistantWelcomePrompt, welcomeLocale } from "./default-bot-welcome.js";

describe("welcomeLocale", () => {
  it("prefers the stored preference over the browser", () => {
    expect(welcomeLocale("ja", "zh-CN,zh;q=0.9")).toBe("ja");
  });

  it("reads the first Accept-Language tag that names a UI locale", () => {
    expect(welcomeLocale(undefined, "fr-FR,fr;q=0.9,es;q=0.8")).toBe("es");
    expect(welcomeLocale(undefined, "zh-CN,zh;q=0.9")).toBe("zh-CN");
    expect(welcomeLocale(undefined, "zh")).toBe("zh-CN");
    expect(welcomeLocale(undefined, "zh-TW")).toBe("zh-TW");
    expect(welcomeLocale(undefined, "zh-Hant-HK")).toBe("zh-TW");
    expect(welcomeLocale(undefined, "en-US,en;q=0.9")).toBe("en");
  });

  it("skips refused tags and has no answer without a known one", () => {
    expect(welcomeLocale(undefined, "ja;q=0, es")).toBe("es");
    expect(welcomeLocale(undefined, "fr, de")).toBeUndefined();
    expect(welcomeLocale(undefined, undefined)).toBeUndefined();
  });
});

describe("assistantWelcomePrompt", () => {
  it("names the bot and the language, and asks for no tool call", () => {
    const prompt = assistantWelcomePrompt("assistant", "zh-TW");
    expect(prompt).toContain("You are assistant,");
    expect(prompt).toContain("Write it in Traditional Chinese");
    expect(prompt).toContain("Do not call any tool");
    expect(assistantWelcomePrompt("assistant", undefined)).toContain("Write it in English");
  });
});

// T0: which language the operator UI renders in (issue #23, decision 2): the signed-in person's
// stored preference, then the browser's `navigator.languages` in order, then English.
import { describe, expect, it } from "vitest";
import { matchUiLocale, resolveLocale } from "./locale.js";

describe("matchUiLocale", () => {
  it("maps a browser language tag to one of the five UI locales", () => {
    expect(matchUiLocale("en")).toBe("en");
    expect(matchUiLocale("en-GB")).toBe("en");
    expect(matchUiLocale("zh-CN")).toBe("zh-CN");
    expect(matchUiLocale("zh")).toBe("zh-CN");
    expect(matchUiLocale("zh-Hans")).toBe("zh-CN");
    expect(matchUiLocale("zh-SG")).toBe("zh-CN");
    expect(matchUiLocale("zh-TW")).toBe("zh-TW");
    expect(matchUiLocale("zh-Hant")).toBe("zh-TW");
    expect(matchUiLocale("zh-Hant-HK")).toBe("zh-TW");
    expect(matchUiLocale("zh-HK")).toBe("zh-TW");
    expect(matchUiLocale("ja-JP")).toBe("ja");
    expect(matchUiLocale("es-MX")).toBe("es");
    expect(matchUiLocale("ES")).toBe("es");
  });

  it("answers nothing for a language the UI does not have", () => {
    expect(matchUiLocale("fr-FR")).toBeUndefined();
    expect(matchUiLocale("")).toBeUndefined();
  });
});

describe("resolveLocale", () => {
  it("prefers the stored preference over the browser", () => {
    expect(resolveLocale("ja", ["es-ES", "en"])).toBe("ja");
  });

  it("falls back to the first browser language the UI has", () => {
    expect(resolveLocale(undefined, ["fr-FR", "zh-Hant-TW", "en"])).toBe("zh-TW");
    expect(resolveLocale(undefined, ["es-419"])).toBe("es");
  });

  it("falls back to English when neither names a UI language", () => {
    expect(resolveLocale(undefined, ["fr-FR", "de"])).toBe("en");
    expect(resolveLocale(undefined, [])).toBe("en");
  });
});

// @vitest-environment jsdom
// T0: how a screen reads its strings (issue #23). Without a provider (a screen rendered on its
// own, as in its tests) the English catalog is used; a key a translation lacks falls back to the
// English text, never to the raw key; the provider keeps `<html lang>` on the active locale.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, useT } from "./i18n-provider.js";
import { createI18n } from "./intl.js";

function LanguageLabel() {
  const t = useT();
  return <span data-testid="label">{t("app.language.label")}</span>;
}

afterEach(() => {
  cleanup();
  document.documentElement.lang = "en";
});

describe("useT", () => {
  it("reads the English catalog when no provider is mounted", () => {
    render(<LanguageLabel />);
    expect(screen.getByTestId("label").textContent).toBe("Language");
  });

  it("reads the active locale's catalog under the provider", () => {
    render(
      <I18nProvider locale="ja">
        <LanguageLabel />
      </I18nProvider>,
    );
    expect(screen.getByTestId("label").textContent).toBe("言語");
  });
});

describe("a key missing from a translation", () => {
  it("renders the English text, not the key", () => {
    const i18n = createI18n("es", { "app.language.label": "Language" }, {});
    expect(i18n.t("app.language.label")).toBe("Language");
    expect(i18n.t("app.language.label")).not.toBe("app.language.label");
  });

  it("is reported by the catalog tests rather than shown", () => {
    // Each catalog is merged over English, so an absent key never reaches the screen.
    const i18n = createI18n("zh-TW", { "app.language.label": "Language" }, { other: "x" });
    expect(i18n.t("app.language.label")).toBe("Language");
  });
});

describe("I18nProvider", () => {
  it("sets the document language to the active locale", () => {
    const { rerender } = render(
      <I18nProvider locale="zh-CN">
        <LanguageLabel />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe("zh-CN");
    rerender(
      <I18nProvider locale="es">
        <LanguageLabel />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe("es");
    expect(screen.getByTestId("label").textContent).toBe("Idioma");
  });
});

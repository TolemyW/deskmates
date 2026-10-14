// Which of the five UI locales a person sees (issue #23, decision 2): their stored preference,
// then the first of the browser's languages the UI has, then English.

import { UI_LOCALES, type UiLocale, isUiLocale } from "@deskmates/contracts";

export { UI_LOCALES, type UiLocale, isUiLocale };

/** The source locale; every other catalog falls back to it. */
export const DEFAULT_LOCALE: UiLocale = "en";

/**
 * Each locale under its own name, in the order the Language control lists them. These are not
 * translated: a person looks for their language written in it.
 */
export const LOCALE_NAMES: Readonly<Record<UiLocale, string>> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  es: "Español",
};

/** Traditional-script Chinese regions; any other `zh` tag reads Simplified Chinese. */
const TRADITIONAL_CHINESE = new Set(["tw", "hk", "mo", "hant"]);

/** The UI locale a BCP 47 tag such as `zh-Hant-HK` or `es-419` asks for, if the UI has one. */
export function matchUiLocale(tag: string): UiLocale | undefined {
  const parts = tag.trim().toLowerCase().split(/[-_]/);
  switch (parts[0]) {
    case "en":
      return "en";
    case "ja":
      return "ja";
    case "es":
      return "es";
    case "zh":
      return parts.slice(1).some((part) => TRADITIONAL_CHINESE.has(part)) ? "zh-TW" : "zh-CN";
    default:
      return undefined;
  }
}

/** The locale to render: the preference, else the first browser language the UI has, else English. */
export function resolveLocale(
  preference: UiLocale | undefined,
  browserLanguages: ReadonlyArray<string>,
): UiLocale {
  if (preference && isUiLocale(preference)) return preference;
  for (const tag of browserLanguages) {
    const match = matchUiLocale(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/** The browser's languages in preference order; empty outside a browser. */
export function browserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages && navigator.languages.length > 0) return [...navigator.languages];
  return navigator.language ? [navigator.language] : [];
}

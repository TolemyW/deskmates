// The default bot's first message (ADR-0051 decision 11): instead of the generic welcome every
// bot gets, it shows the person who created the workspace around Deskmates and invites them to
// describe a first teammate. It is written in that person's interface language: their stored
// preference, else the first Accept-Language tag that names a UI locale, else English. Changing
// this prompt is a strategy change (AGENTS.md) like changing the template SOUL.

import { UI_LOCALES, type UiLocale } from "@deskmates/contracts";

/** Recorded as `runs.config_json.welcomeVersion` on the default bot's welcome run. */
export const ASSISTANT_WELCOME_VERSION = "assistant-onboarding-v2";

const LANGUAGE_NAMES: Record<UiLocale, string> = {
  en: "English",
  es: "Spanish",
  ja: "Japanese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
};

/** The UI locale an Accept-Language tag stands for, if any (`zh-Hant`, `zh-HK` read as zh-TW). */
function localeOfTag(tag: string): UiLocale | undefined {
  const lower = tag.trim().toLowerCase();
  const exact = UI_LOCALES.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;
  const [primary, ...rest] = lower.split("-");
  if (primary === "zh")
    return rest.some((part) => part === "tw" || part === "hk" || part === "mo" || part === "hant")
      ? "zh-TW"
      : "zh-CN";
  return UI_LOCALES.find((locale) => locale === primary);
}

/** The language the creator reads: their stored preference, else their browser's, else none. */
export function welcomeLocale(
  preference: UiLocale | undefined,
  acceptLanguage: string | undefined,
): UiLocale | undefined {
  if (preference) return preference;
  for (const entry of (acceptLanguage ?? "").split(",")) {
    const [tag = "", ...params] = entry.split(";");
    if (params.some((param) => /^\s*q=0(\.0*)?\s*$/.test(param))) continue;
    const locale = localeOfTag(tag);
    if (locale) return locale;
  }
  return undefined;
}

/** The welcome run's instruction for the default bot named `name`. */
export function assistantWelcomePrompt(name: string, locale: UiLocale | undefined): string {
  const language = LANGUAGE_NAMES[locale ?? "en"];
  return [
    `You are ${name}, the assistant of a new Deskmates workspace. The person who just created it is about to read your first message in this private chat. Write it in ${language}, following your own instructions and voice, in about 150 words:`,
    "1. Say in one line who you are.",
    "2. Explain Deskmates briefly: this workspace is a small team of AI teammates (bots), each with a name and a role, who share one computer with a browser, files and a shell. People talk to one bot in its private chat, or work with several in a group chat. Actions follow the workspace's approval mode; when a person's approval is needed, the chat asks them.",
    "3. Explain what you do: from a plain goal you reuse or create a teammate for a lasting job and can start their collaboration in a group. Start clear authorised work using reasonable defaults; ask only about missing information that materially changes the result or needs more authority.",
    "4. End by asking what they would like a first teammate to do, with two or three short example requests they could send you, such as a daily news digest on a topic, watching a web page for changes, or researching competitors.",
    "Use a short list where it helps. Do not call any tool and do not create a teammate yet. Reply only with the message.",
  ].join("\n");
}

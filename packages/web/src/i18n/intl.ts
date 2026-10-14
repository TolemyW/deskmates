// One locale's formatter: `t` for a plain string, `rich` for a message with tags such as
// `<code>…</code>` that render as elements. The catalog is merged over English, so a key a
// translation lacks shows the English text, never the key (issue #23, decision 1).
//
// Code outside a component (format.ts, messages built in callbacks) reads the active formatter
// with `currentI18n()`; `I18nProvider` makes its locale the active one.

import type { UiLocale } from "@deskmates/contracts";
import type { ReactNode } from "react";
import { type IntlShape, createIntl, createIntlCache } from "react-intl";
import { CATALOGS, type Catalog, ENGLISH, type MessageKey } from "./catalogs.js";
import { DEFAULT_LOCALE } from "./locale.js";

/** Values for a message's `{arguments}`. */
export type MessageValues = Record<string, string | number | Date | null | undefined>;

/** Values for a rich message: arguments, and a function per tag that renders its content. */
export type RichValues = Record<
  string,
  string | number | Date | ReactNode | ((chunks: ReactNode[]) => ReactNode) | null | undefined
>;

export interface I18n {
  locale: UiLocale;
  intl: IntlShape;
  /** The message as a string. */
  t(key: MessageKey, values?: MessageValues): string;
  /** The message as React nodes, with its tags rendered by the functions in `values`. */
  rich(key: MessageKey, values: RichValues): ReactNode;
}

const cache = createIntlCache();

export function createI18n(
  locale: UiLocale,
  english: Catalog = ENGLISH,
  translated: Catalog = CATALOGS[locale],
): I18n {
  const intl = createIntl(
    {
      locale,
      defaultLocale: DEFAULT_LOCALE,
      messages: { ...english, ...translated },
      onError: (err) => {
        // A missing translation cannot happen (the catalog is merged over English); anything
        // else is a broken message, which `catalogs.test.ts` reports. Keep the console quiet.
        if (err.code === "MISSING_TRANSLATION") return;
        console.error(err);
      },
    },
    cache,
  );
  return {
    locale,
    intl,
    t: (key, values) => {
      for (const observe of observers) observe(locale, key);
      return intl.formatMessage({ id: key }, values) as string;
    },
    rich: (key, values) => {
      for (const observe of observers) observe(locale, key);
      return intl.formatMessage(
        { id: key },
        // biome-ignore lint/suspicious/noExplicitAny: react-intl types tag functions per call site.
        values as Record<string, any>,
      ) as ReactNode;
    },
  };
}

type LookupObserver = (locale: UiLocale, key: MessageKey) => void;
const observers = new Set<LookupObserver>();

/**
 * Be told of every message a formatter looks up, until the returned function is called. The
 * locale tests use it to learn which keys a screen shows; nothing else does.
 */
export function observeLookups(observer: LookupObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

const english = createI18n(DEFAULT_LOCALE);
let active: I18n = english;

/** The English formatter, used when no provider is mounted (a screen's own tests). */
export function englishI18n(): I18n {
  return english;
}

/** The formatter of the locale the UI renders in now. */
export function currentI18n(): I18n {
  return active;
}

/** Make `i18n` the formatter that `currentI18n()` and format.ts use. */
export function setCurrentI18n(i18n: I18n): void {
  active = i18n;
}

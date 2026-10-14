// The active locale for everything under it (issue #23). Screens read strings with `useT()`;
// without a provider they get English, which is how a screen's own tests render it. The provider
// also keeps `<html lang>` on the locale and mounts react-intl's context for its components.

import type { UiLocale } from "@deskmates/contracts";
import { type ReactNode, createContext, useContext, useLayoutEffect, useMemo } from "react";
import { RawIntlProvider } from "react-intl";
import { type I18n, createI18n, englishI18n, setCurrentI18n } from "./intl.js";

const I18nContext = createContext<I18n>(englishI18n());

export function I18nProvider({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  const i18n = useMemo(() => createI18n(locale), [locale]);
  // Set while rendering so code outside components (format.ts) formats this render's children in
  // this locale; set again after a StrictMode remount, and back to English on unmount.
  setCurrentI18n(i18n);
  useLayoutEffect(() => {
    setCurrentI18n(i18n);
    document.documentElement.lang = locale;
    return () => setCurrentI18n(englishI18n());
  }, [i18n, locale]);
  return (
    <I18nContext.Provider value={i18n}>
      <RawIntlProvider value={i18n.intl}>{children}</RawIntlProvider>
    </I18nContext.Provider>
  );
}

/** The active locale's formatter: `t(key, values)` and `t.rich(key, values)`. */
export function useT(): I18n["t"] & { rich: I18n["rich"] } {
  const i18n = useContext(I18nContext);
  return useMemo(() => Object.assign(i18n.t, { rich: i18n.rich }), [i18n]);
}

/** The locale the UI renders in. */
export function useLocale(): UiLocale {
  return useContext(I18nContext).locale;
}

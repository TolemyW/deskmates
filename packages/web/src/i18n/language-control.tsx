// Each language uses its own name; the shell stores the choice as a user preference.
import type { UiLocale } from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { Languages } from "lucide-react";
import { useT } from "./i18n-provider.js";
import { LOCALE_NAMES, UI_LOCALES, isUiLocale } from "./locale.js";

export function LanguageControl({
  locale,
  onChange,
}: {
  locale: UiLocale;
  onChange: (locale: UiLocale) => void;
}) {
  const t = useT();
  return (
    <div className="language-control">
      <Languages className="language-control-icon" size={18} aria-hidden="true" />
      <Select
        aria-label={t("app.language.label")}
        value={locale}
        onValueChange={(next) => {
          if (isUiLocale(next) && next !== locale) onChange(next);
        }}
        options={UI_LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }))}
      />
    </div>
  );
}

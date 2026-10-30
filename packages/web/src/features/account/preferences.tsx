import type { UiLocale } from "@deskmates/contracts";
import { Switch } from "@deskmates/ui";
import { useT } from "../../i18n/i18n-provider.js";
import { LanguageControl } from "../../i18n/language-control.js";
import type { InterfaceView } from "../../lib/interface-view.js";
import type { ThemePreference } from "../../lib/theme.js";

/** Language and appearance as the shell holds them; the shell stores each change. */
export interface PreferenceControls {
  locale: UiLocale;
  /** Applies at once and is stored as this person's preference (`PATCH /auth/preferences`). */
  onLocaleChange: (locale: UiLocale) => void;
  theme: ThemePreference;
  /** Kept in this browser only. */
  onThemeChange: (theme: ThemePreference) => void;
  /** The use or tune view (docs/use-and-tune-views.md); kept in this browser only. */
  view?: InterfaceView;
  onViewChange?: (view: InterfaceView) => void;
}

/** Language and appearance (formerly the sidebar's Settings gear). Every role has them. */
export function PreferencesSection({
  locale,
  onLocaleChange,
  theme,
  onThemeChange,
  view,
  onViewChange,
}: PreferenceControls) {
  const t = useT();
  return (
    <section className="preferences-content" aria-labelledby="account-preferences-title">
      <div className="account-preferences">
        <div className="preferences-field">
          <span aria-hidden="true">{t("app.language.label")}</span>
          <LanguageControl native locale={locale} onChange={onLocaleChange} />
        </div>
        <div className="preferences-field">
          <span aria-hidden="true">{t("account.preferences.appearance")}</span>
          <select
            aria-label={t("account.preferences.appearance")}
            className="preference-select theme-preference-selector"
            value={theme}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "light" || value === "dark" || value === "system") onThemeChange(value);
            }}
          >
            <option value="system">{t("account.preferences.system")}</option>
            <option value="light">{t("account.preferences.light")}</option>
            <option value="dark">{t("account.preferences.dark")}</option>
          </select>
        </div>
        {view && onViewChange ? (
          <div className="preferences-field">
            <Switch
              label={t("app.view.tune")}
              selected={view === "tune"}
              onChange={(selected) => onViewChange(selected ? "tune" : "use")}
            />
            <small>{t(view === "tune" ? "app.view.tuneOnHint" : "app.view.tuneOffHint")}</small>
          </div>
        ) : null}
      </div>
    </section>
  );
}

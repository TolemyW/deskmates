// A signed-in person's own UI preferences (issue #22). They belong to the user, not to a tenant
// or a browser, and are stored as one JSON object on `users` so a later preference (the locale
// of issue #23) is a new key, not a new column. None of them is a permission.

/** The languages the operator UI renders in (issue #23); English is the source. */
export const UI_LOCALES = ["en", "zh-CN", "zh-TW", "ja", "es"] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && (UI_LOCALES as ReadonlyArray<string>).includes(value);
}

/** What `GET /auth/session` reports and `PATCH /auth/preferences` changes. */
export interface UserPreferences {
  /** The Owner/Admin first-run checklist on the home screen was dismissed. */
  firstRunChecklistDismissed?: boolean;
  /** The language this person chose for the operator UI; absent means follow the browser. */
  locale?: UiLocale;
}

/** `PATCH /auth/preferences`: the keys to change; every other stored key stays. */
export type UpdatePreferencesRequest = Partial<UserPreferences>;

export interface UpdatePreferencesResponse {
  /** Every preference after the change. */
  preferences: UserPreferences;
}
